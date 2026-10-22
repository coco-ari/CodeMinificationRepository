import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
const origin=process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887', c=new T3LiveClient(origin)
const report={startedAt:new Date().toISOString(),kind:'real-native-rpc-controls',origin,limitations:['RPC执行用于证明服务与真实运行器控制；不是WebUI体验测试','断线是实际终止WebSocket并重新连接，不是服务器网络隔离','保护性回退和MCP表单由独立真实测试报告覆盖'],steps:[],threads:[],errors:[]}
const output=process.env.T3_CONTROLS_REPORT||'.test-artifacts/t3-live/controls.json'
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)), terminal=r=>['completed','failed','interrupted','cancelled'].includes(r.status)
const save=async()=>{await mkdir('.test-artifacts/t3-live',{recursive:true});await writeFile(output,JSON.stringify(report,null,2))}
const summary=p=>({threadId:p.thread.id,runs:p.runs.map(r=>({id:r.id,status:r.status,ordinal:r.ordinal,queuePosition:r.queuePosition,queueHeld:r.queueHeld,startedAt:r.startedAt,completedAt:r.completedAt,userMessageId:r.userMessageId})),messages:p.messages.map(m=>({id:m.id,role:m.role,runId:m.runId,inputIntent:m.inputIntent,text:m.text?.slice(-2000)})),nativeThreads:p.providerThreads.map(t=>({id:t.id,nativeThreadRef:t.nativeThreadRef})),nativeTurns:p.providerTurns.map(t=>({id:t.id,runId:t.runId,nativeTurnRef:t.nativeTurnRef,status:t.status})),requests:p.runtimeRequests})
async function wait(threadId,predicate,label,timeout=180000){const start=Date.now();while(Date.now()-start<timeout){const p=await c.projection(threadId);if(predicate(p))return p;await sleep(350)}throw new Error(`Timeout: ${label}`)}
async function step(name,fn){const row={name,startedAt:new Date().toISOString()};report.steps.push(row);try{row.result=await fn();row.status='passed'}catch(e){row.status='failed';row.error=e.message;row.detail=e.detail;report.errors.push({name,error:e.message})}await save();console.log(JSON.stringify({name,status:row.status,error:row.error}));return row}
const command=(threadId,type,extra={})=>({type,threadId,commandId:randomUUID(),...extra})
const dispatch=payload=>c.rpc('orchestration.dispatchCommand',payload,{timeout:60000})
async function message(threadId,text,mode){const payload=command(threadId,'message.dispatch',{createdBy:'user',creationSource:'web',messageId:randomUUID(),text,attachments:[],modelSelection:c.bootstrap.fixedModel,dispatchMode:mode});await dispatch(payload);return payload}
const answer=p=>p.messages.filter(m=>m.role==='assistant').map(m=>m.text).join('\n')
let threadId
try{
 await c.login();await c.connect();report.model=c.bootstrap.fixedModel
 const marker=`AO-${randomUUID().slice(0,8)}`
 await step('steer-queue-edit-reorder-cancel-promote',async()=>{
  ({threadId}=await c.createThread(`我们在准备一个尚未执行的发布批次，名称为${marker}，后续请沿用此批次名称。请先读取项目的发布检查手册和最新测试环境快照，撰写一份详细的发布准备建议，逐项分析检查依据、风险、负责人和待确认事项，尽量完整，约3000字。`,{title:'原生控制专项-引导排队'}));report.threads.push(threadId);await save()
  let p=await wait(threadId,p=>p.runs.some(r=>r.status==='running')&&p.providerTurns.length>0,'native running');const active=p.runs.find(r=>r.status==='running')
  const steer=await message(threadId,'当前补充：分析时优先关注回滚准备，其余发布检查继续，暂时不要创建报告文件。',{type:'steer_active',targetRunId:active.id})
  const qa=await message(threadId,`调整当前任务：先停止展开，简短解释“发布准入”的含义，并保留当前发布批次名称，然后结束本轮。`,{type:'queue_after_active'})
  const qb=await message(threadId,`下一轮简短解释备份检查的含义。`,{type:'queue_after_active'})
  const qc=await message(threadId,`下一轮分析项目资料的分类方式。`,{type:'queue_after_active'})
  p=await c.projection(threadId);const ar=p.runs.find(r=>r.userMessageId===qa.messageId),br=p.runs.find(r=>r.userMessageId===qb.messageId),cr=p.runs.find(r=>r.userMessageId===qc.messageId)
  if(![ar,br,cr].every(r=>r?.status==='queued'))throw new Error('Queue controls were not exercised while all queued; timing inconclusive')
  await dispatch(command(threadId,'queued-run.edit',{runId:br.id,text:`下一轮简短解释“回滚核验”的含义，并说明本次发布批次名称。`,attachments:[]}))
  await dispatch(command(threadId,'queued-run.reorder',{runId:br.id,beforeRunId:ar.id}))
  const reordered=summary(await c.projection(threadId))
  const cancellationReceipt=await dispatch(command(threadId,'queued-run.cancel',{runId:cr.id}));const afterCancellation=summary(await c.projection(threadId))
  const promoted=await dispatch(command(threadId,'queued-message.promote-to-steer',{queuedRunId:ar.id,targetRunId:active.id}))
  p=await wait(threadId,p=>p.runs.every(terminal),'queue finished',240000)
  const assertions={queueReordered:reordered.runs.find(r=>r.id===br.id)?.queuePosition<reordered.runs.find(r=>r.id===ar.id)?.queuePosition,queuedStartedAfterActive:Date.parse(p.runs.find(r=>r.id===br.id)?.startedAt)>=Date.parse(p.runs.find(r=>r.id===active.id)?.completedAt),directSteerRecorded:p.messages.some(m=>m.id===steer.messageId),editedQueueBody:p.messages.some(m=>m.id===qb.messageId&&m.text.includes('回滚核验')),cancelled:!p.runs.some(r=>r.id===cr.id)&&!p.messages.some(m=>m.id===qc.messageId)&&!p.providerTurns.some(t=>t.runId===cr.id),promotedPlaceholderRemoved:!p.runs.some(r=>r.id===ar.id)&&p.messages.some(m=>m.id===qa.messageId&&m.runId===active.id)&&!p.providerTurns.some(t=>t.runId===ar.id),editedExecuted:p.runs.find(r=>r.id===br.id)?.status==='completed',promotionTopic:p.messages.some(m=>m.role==='assistant'&&m.runId===active.id&&m.text?.includes('发布准入')),editedTopic:p.messages.some(m=>m.role==='assistant'&&m.runId===br.id&&m.text?.includes('回滚')),singleNativeThread:new Set(p.providerThreads.map(t=>t.nativeThreadRef?.nativeId).filter(Boolean)).size===1}
  report.controlAssertions=assertions
  if(!Object.values(assertions).every(Boolean)){report.controlEvidence={reordered,cancellationReceipt,afterCancellation,promoted,final:summary(p)};throw new Error('One or more real control assertions failed')}
  return {assertions,reordered,cancellationReceipt,afterCancellation,promoted,final:summary(p)}
 })
 await step('dedup-disconnect-replay-stop-continue',async()=>{
  if(!threadId)throw new Error('No isolated test thread')
  let p=await c.projection(threadId);if(p.runs.some(r=>!terminal(r)))await dispatch(command(threadId,'thread.stop'))
  await wait(threadId,p=>p.runs.every(terminal),'idle before reconnect')
  const payload=command(threadId,'message.dispatch',{createdBy:'user',creationSource:'web',messageId:randomUUID(),text:'请继续查阅当前项目的真实发布检查手册和环境快照，详细展开各项风险和检查步骤，约3000字；先在对话中说明，不创建文件。',attachments:[],modelSelection:c.bootstrap.fixedModel,dispatchMode:{type:'start_immediately'}})
  const first=await dispatch(payload),duplicate=await dispatch(payload)
  p=await wait(threadId,p=>p.runs.some(r=>r.userMessageId===payload.messageId&&r.status==='running'),'disconnect active')
  let run=p.runs.find(r=>r.userMessageId===payload.messageId);const before=summary(p),eventsBefore=c.events.length
  c.rpc('orchestration.subscribeThread',{threadId},{timeout:600000}).catch(()=>{})
  await sleep(800);const sequence=c.events.slice(eventsBefore).reduce((n,e)=>Math.max(n,e.value.sequence??e.value.snapshotSequence??e.value.snapshot?.snapshotSequence??0),0)
  c.socket.terminate();const disconnectedAt=Date.now();await sleep(4000);await c.connect();const reconnectedAt=Date.now()
  const resumedEvents=[];c.rpc('orchestration.subscribeThread',{threadId,afterSequence:sequence,requestCompletionMarker:true},{timeout:600000,onValue:value=>resumedEvents.push(value)}).catch(()=>{})
  p=await c.projection(threadId);const afterDisconnect=summary(p)
  let separateStopRun=false
  if(terminal(p.runs.find(r=>r.id===run.id))){
   separateStopRun=true
   const extra=await message(threadId,'请根据现有资料继续详细编写发布风险分析，逐项展开每个风险的处理步骤和核验依据。',{type:'start_immediately'})
   p=await wait(threadId,p=>p.runs.some(r=>r.userMessageId===extra.messageId&&r.status==='running'),'separate stop run')
   run=p.runs.find(r=>r.userMessageId===extra.messageId)
  }
  const stop=command(threadId,'run.interrupt',{runId:run.id,holdQueue:true,reason:'真实控制验收主动停止'}),stopStart=Date.now();await dispatch(stop);await dispatch(stop)
  p=await wait(threadId,p=>terminal(p.runs.find(r=>r.id===run.id)),'stop terminal');const stoppedMs=Date.now()-stopStart,finalText=answer(p)
  await sleep(3000);const settled=await c.projection(threadId)
  const noGrowth=answer(settled)===finalText
  const next=await message(threadId,'我们继续讨论同一发布准备工作。请告诉我最初约定的发布批次名称，并简要说明目前仍待确认的事项；不用调用工具。',{type:'start_immediately'})
  p=await wait(threadId,p=>p.runs.some(r=>r.userMessageId===next.messageId&&terminal(r)),'continued')
  const assertions={positiveResumeCursor:sequence>0,sameReceiptSequence:first.sequence===duplicate.sequence,oneUserMessage:p.messages.filter(m=>m.id===payload.messageId).length===1,oneRun:p.runs.filter(r=>r.userMessageId===payload.messageId).length===1,stoppedNoGrowthFor3s:noGrowth,stopStatus:settled.runs.find(r=>r.id===run.id).status==='interrupted',resumedStreamProducedData:resumedEvents.length>0,continuedMemory:p.messages.some(m=>m.role==='assistant'&&m.runId===p.runs.find(r=>r.userMessageId===next.messageId)?.id&&m.text?.includes(marker))}
  report.reconnectAssertions=assertions
  const result={assertions,first,duplicate,separateStopRun,stopRunId:run.id,stoppedMs,offlineMs:reconnectedAt-disconnectedAt,sequence,resumeEventKinds:[...new Set(resumedEvents.map(e=>e.kind))],before,afterDisconnect,final:summary(p)}
  if(!Object.values(assertions).every(Boolean)){report.reconnectEvidence=result;throw new Error('One or more real reconnect/stop assertions failed')}
  return result
 })
}catch(e){report.errors.push({fatal:e.message,detail:e.detail});process.exitCode=1}finally{
 if(threadId){try{const p=await c.projection(threadId);if(p.runs.some(r=>!terminal(r)))await dispatch(command(threadId,'thread.stop'))}catch{}}
 report.completedAt=new Date().toISOString();await save();c.close();if(report.errors.length)process.exitCode=1;console.log(JSON.stringify({report:output,steps:report.steps.map(s=>({name:s.name,status:s.status})),errors:report.errors}))
}
