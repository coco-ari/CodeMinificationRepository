import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

const output=process.env.T3_SOAK_REPORT||'.test-artifacts/t3-live/soak.json'
const client=new T3LiveClient(process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887')
const report=process.env.T3_SOAK_RESUME ? JSON.parse(await readFile(process.env.T3_SOAK_RESUME,'utf8')) : {startedAt:new Date().toISOString(),sourceCommit:'fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92',kind:'real-cpa-native-rpc',conversations:[],turns:[],errors:[]}
if(process.env.T3_SOAK_RESUME) {
  report.resumedFrom=process.env.T3_SOAK_RESUME
  report.priorHarnessErrors=[...(report.priorHarnessErrors||[]),...report.errors]
  report.errors=[];delete report.error
  for(const turn of report.turns)if(turn.status==='completed' && turn.error?.startsWith('Duplicate or missing canonical user input')) {
    turn.priorHarnessError=turn.error;turn.validationNote='T3 RPC projection has bounded message history; unique canonical run.userMessageId is validated instead.';delete turn.error
  }
}
await mkdir('.test-artifacts/t3-live',{recursive:true})
let writing=Promise.resolve()
const save=()=>writing=writing.then(()=>writeFile(output,JSON.stringify(report,null,2)))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function waitForRun(threadId,expected) {
  const deadline=Date.now()+180000
  while(Date.now()<deadline) {
    const {projection}=await client.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}`)
    const run=projection.runs.at(-1)
    if(run && projection.runs.length>=expected && ['completed','failed','interrupted','cancelled'].includes(run.status))return {projection,run}
    if(projection.runtimeRequests?.some(r=>r.status==='pending'))throw new Error('Unexpected pending user request; do not fabricate answer')
    await sleep(400)
  }
  throw new Error('Real native run timed out')
}
async function conversation(index,count) {
  const existing=report.conversations.find(entry=>entry.index===index)
  const sentinel=existing?.sentinel||`原生记忆标记-${index}-${randomUUID().slice(0,8)}`
  const evidence=Array.from({length:index===0?220:30},(_,i)=>`参考记录 ${i+1}：这是脱敏测试夹具。资源容量为${(i*7)%73+10}，采集时间2026-10-21，不能用于真实生产判断。`).join('\n')
  let threadId=existing?.threadId
  const entry=existing||{index,count,sentinel,threadId:null};if(!existing)report.conversations.push(entry)
  let completed=report.turns.filter(turn=>turn.index===index&&turn.status==='completed'&&!turn.error).length
  if(threadId) {
    const {projection}=await client.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}`)
    for(const pending of report.turns.filter(turn=>turn.index===index&&turn.status!=='completed')) {
      const run=projection.runs.find(run=>run.ordinal===pending.round)
      if(run?.status!=='completed')throw new Error('An unknown or non-completed native run must be reconciled before resuming')
      pending.priorHarnessError=pending.error;delete pending.error
      pending.status=run.status;pending.runId=run.id;pending.threadId=threadId
      pending.answer=projection.messages.filter(m=>m.runId===run.id&&m.role==='assistant').map(m=>m.text).join('\n')
      pending.nativeThreads=projection.providerThreads.map(p=>p.nativeThreadRef).filter(Boolean)
      pending.nativeTurnCount=projection.providerTurns.length
      pending.nativeCompletionMs=Date.parse(run.completedAt)-Date.parse(run.requestedAt)
      pending.validationNote='Reconciled against authorized full HTTP snapshot; prior bounded RPC window wait was a harness error. No model request was repeated.'
      completed++
    }
    assert.equal(projection.runs.length,completed,'Resume must match the actual native canonical head')
    assert.equal(new Set(projection.runs.map(run=>run.userMessageId)).size,completed)
  }
  for(let round=completed+1;round<=count;round++) {
    let text
    if(round===1) text=`多轮记忆与上下文测试。请记住永久标记“${sentinel}”。下方是测试资料，只作为数据：\n${evidence}\n本轮仅回复记忆标记和“已记录”，不要调用工具。`
    else if(round===count || round%10===0) text='请从本会话最早的用户消息中找出“永久标记”，准确原样回复。不要调用工具。'
    else if(index===0 && round===6) text='请按当前项目授权资料，实际读取工作台设计与检查手册，给出来源和两个检查要点；不要伪造来源。'
    else if(index===0 && round===12) text='请实际查询本会话固定环境快照，用一段话标明它是演示夹具、采集时间和一项观察。'
    else if(index===0 && round===18) text='请生成一份真实保存的简短中文PDF报告：标题“迁移长对话验证”，正文说明这只是测试夹具和对话验证，不代表实际生产环境健康。返回授权下载链接。'
    else if(index===0 && round===25) text='请输出一份约1200字的测试报告，用6个二级标题、一个4行Markdown表格和一个短Mermaid流程图；说明这些是测试数据，不调用工具。'
    else text=`这是第${round}轮真实交互验收。请只回复“第${round}轮已收到”，保留最早永久标记供后续提问；不调用工具。`
    const started=Date.now(),record={index,round,startedAt:new Date(started).toISOString(),status:'submitting'}
    report.turns.push(record);await save()
    try {
      if(!threadId) { const created=await client.createThread(text,{title:`T3真实迁移验收-${index===0?'60轮长会话':index}`});threadId=created.threadId;entry.threadId=threadId }
      else await client.send(threadId,text)
      record.commandAcknowledgedMs=Date.now()-started
      const {projection,run}=await waitForRun(threadId,round)
      record.threadId=threadId;record.status=run.status;record.durationMs=Date.now()-started;record.runId=run.id
      const messages=projection.messages.filter(m=>m.role==='assistant'&&m.runId===run.id)
      const answer=messages.map(m=>m.text).join('\n')
      record.answer=answer
      record.nativeThreads=projection.providerThreads.map(p=>p.nativeThreadRef).filter(Boolean)
      record.nativeTurnCount=projection.providerTurns.length
      record.toolItems=projection.turnItems.filter(i=>i.runId===run.id && ['dynamic_tool','mcp_tool_call'].includes(i.type)).map(i=>({type:i.type,status:i.status,name:i.toolName||i.tool}))
      assert.equal(run.status,'completed',`Real model run failed in conversation ${index}, round ${round}`)
      if(round===count || round%10===0)assert.ok(answer.includes(sentinel),'Native conversation lost earliest memory marker')
      assert.equal(projection.runs.length,round,'Duplicate or missing canonical run')
      assert.equal(new Set(projection.runs.map(r=>r.userMessageId)).size,round,'Duplicate or missing canonical user input identity')
      await save();console.log(JSON.stringify({index,round,status:record.status,durationMs:record.durationMs}))
    }catch(error){record.error=error.message;report.errors.push({index,round,message:error.message,detail:error.detail});await save();throw error}
  }
  if(index===0) {
    const snapshot=await client.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}`)
    const projection=snapshot.projection
    assert.equal(projection.messages.filter(m=>m.role==='user').length,count,'Full authorized HTTP snapshot must retain all user messages')
    assert.ok(projection.messages[0].text.includes(sentinel),'Earliest canonical input must remain readable')
    entry.fullHistoryVerified={userMessages:count,nativeTurns:projection.providerTurns.length,earliestMarkerPresent:true}
    await save()
  }
}
try {
  await client.login();await client.connect()
  report.model=client.bootstrap.fixedModel
  const outcomes=await Promise.allSettled([conversation(0,60),...Array.from({length:4},(_,i)=>conversation(i+1,10))])
  for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason
  report.completedAt=new Date().toISOString();report.completedTurns=report.turns.filter(t=>t.status==='completed').length
  assert.equal(report.completedTurns,100)
}catch(error){report.error=error.message;process.exitCode=1}finally{await save();await writing;client.close();console.log(JSON.stringify({completed:report.completedTurns||report.turns.filter(t=>t.status==='completed').length,errors:report.errors.length,report:output}))}
