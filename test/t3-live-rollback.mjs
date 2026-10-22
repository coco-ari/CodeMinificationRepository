import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
const c=new T3LiveClient(process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887')
const output=process.env.T3_ROLLBACK_REPORT||'.test-artifacts/t3-live/rollback.json'
const report={startedAt:new Date().toISOString(),kind:'real-native-rpc-protected-history-edit',limitations:['真实Codex fork/revert与应用持久化验证；共享确认的浏览器流程另测','丢回复/写盘失败的uncertain冻结由故障注入单测覆盖，本轮不破坏真实运行器模拟'],errors:[]}
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),terminal=r=>['completed','failed','cancelled','interrupted'].includes(r.status)
let threadId
const dispatch=cmd=>c.rpc('orchestration.dispatchCommand',cmd,{timeout:60000})
async function wait(test,label,timeout=180000){let p;const at=Date.now();while(Date.now()-at<timeout){p=await c.projection(threadId);if(test(p))return p;await sleep(350)}report.timeoutEvidence=p;throw new Error('Timed out: '+label)}
const save=async()=>{await mkdir('.test-artifacts/t3-live',{recursive:true});await writeFile(output,JSON.stringify(report,null,2))}
try{
 await c.login();await c.connect();const batch=`AO-${randomUUID().slice(0,8)}`
 const first='我们准备一个尚未执行的发布方案，批次名称为'+batch+'。先仅确认这个批次名称，后续分析会围绕它展开；不要生成文件或执行变更。'
 ;({threadId}=await c.createThread(first,{visibility:'project',title:'共享历史编辑真实验收'}));report.threadId=threadId;await save()
 await wait(p=>p.runs.length>0&&p.runs.every(terminal),'first completion')
 await c.send(threadId,'为此发布方案补充一个暂定条件：窗口拟定为周六上午，尚未批准。请只复述这一条待确认事项。')
 const before=await wait(p=>p.runs.length>=2&&p.runs.every(terminal),'second completion');report.before=before
 const target=before.checkpoints.find(cp=>cp.status==='ready'&&cp.appRunOrdinal===1)
 if(!target)throw new Error('No actual ready checkpoint for the first completed run')
 const base={type:'checkpoint.rollback',commandId:randomUUID(),threadId,scopeId:target.scopeId,checkpointId:target.id,restoreFiles:false}
 let unconfirmedAccepted=false;try{await dispatch(base);unconfirmedAccepted=true}catch(e){report.unconfirmedRejection={message:e.message,detail:e.detail}}
 if(unconfirmedAccepted)throw new Error('Shared history edit accepted without explicit acknowledgment')
 const command={...base,commandId:randomUUID(),confirmSharedHistoryEdit:true};report.receipt=await dispatch(command)
 const after=await wait(p=>['complete','uncertain'].includes(p.thread.rollbackSafety?.status),'protected native rollback');report.after=after
 if(after.thread.rollbackSafety?.status!=='complete')throw new Error('Rollback outcome is uncertain; history remains frozen')
 const safety=after.thread.rollbackSafety
 report.duplicateReceipt=await dispatch(command)
 const duplicate=await c.projection(threadId)
 const assertions={unconfirmedRejected:!unconfirmedAccepted,actualProtection:safety.protectedNativeThreadId&&safety.protectedNativeThreadId!==safety.sourceNativeThreadId,sourceNativeUnchanged:before.providerThreads.some(t=>t.nativeThreadRef?.nativeId===safety.sourceNativeThreadId)&&after.providerThreads.some(t=>t.nativeThreadRef?.nativeId===safety.sourceNativeThreadId),secondMessageRemoved:!after.messages.some(m=>m.role==='user'&&m.text.includes('周六上午')),firstMessagePreserved:after.messages.some(m=>m.role==='user'&&m.text.includes(batch)),duplicateSameReceipt:report.receipt.sequence===report.duplicateReceipt.sequence,duplicateNoNewBackup:duplicate.thread.rollbackSafety?.protectedNativeThreadId===safety.protectedNativeThreadId}
 report.assertions=assertions
 if(!Object.values(assertions).every(Boolean))throw new Error('Native/app rollback evidence mismatch')
 await c.send(threadId,'请告诉我这个方案最初约定的发布批次名称。只回答名称，不调用工具。')
 const final=await wait(p=>p.runs.every(terminal)&&p.messages.some(m=>m.role==='user'&&m.text.includes('最初约定')),'continuation after edit');report.final=final
 const newest=final.runs.filter(r=>r.status==='completed').sort((a,b)=>b.ordinal-a.ordinal)[0]
 report.continuedNativeMemory=final.messages.some(m=>m.role==='assistant'&&m.runId===newest?.id&&m.text.includes(batch))
 if(!report.continuedNativeMemory)throw new Error('Post-revert continuation did not confirm original native memory')
}catch(e){report.errors.push({error:e.message,detail:e.detail});process.exitCode=1}finally{
 if(threadId){try{const p=await c.projection(threadId);if(p.runs.some(r=>!terminal(r)))await dispatch({type:'thread.stop',commandId:randomUUID(),threadId})}catch(e){report.errors.push({cleanup:e.message})}}
 c.close();report.completedAt=new Date().toISOString();await save();console.log(JSON.stringify({report:output,assertions:report.assertions,errors:report.errors}))
}
