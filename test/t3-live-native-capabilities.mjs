import {mkdir,writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
// Run only against the authorized staging server. The skill must already be
// registered by its administrator; this test never installs a skill or plugin.
const origin=process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887'
const output=process.env.T3_NATIVE_CAPABILITIES_REPORT||'.test-artifacts/t3-live/native-capabilities.json'
const client=new T3LiveClient(origin),report={startedAt:new Date().toISOString(),origin,kind:'real-native-skills-subagent-rpc',limitations:['原生RPC/模型能力验证，不代替浏览器交互验收'],steps:[]}
const terminal=run=>['completed','failed','interrupted','cancelled'].includes(run.status)
const until=async(threadId,predicate,label)=>{const start=Date.now();while(Date.now()-start<180000){const p=await client.projection(threadId);if(predicate(p))return p;await new Promise(resolve=>setTimeout(resolve,500))}throw Error(label+'：180秒内未取得所需原生状态')}
const wait=threadId=>until(threadId,p=>p.runs.length&&p.runs.every(terminal),'原生轮次终态')
const record=async(name,fn)=>{const row={name,status:'running',startedAt:new Date().toISOString()};report.steps.push(row);await save();try{row.evidence=await fn();row.status='passed'}catch(error){row.status='failed';row.error=error.message;row.detail=error.detail;process.exitCode=1}await save()}
const save=async()=>{await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2))}
let threadId
try{
 await client.login();await client.connect();report.model=client.bootstrap.fixedModel
 await record('registered-native-skill',async()=>{
  const skill=process.env.T3_TEST_SKILL,expected=process.env.T3_TEST_SKILL_EXPECTED_CODE
  if(!skill||!/^autoops-[a-z0-9-]+$/.test(skill)||!expected)throw Error('需要已注册T3_TEST_SKILL及仅写入技能正文的T3_TEST_SKILL_EXPECTED_CODE，不能用提示词伪造技能证据')
  ;({threadId}=await client.createThread(`$${skill}\n请按这个技能读取当前项目已经授权的资料，输出技能要求的检查结果。不要运行shell，不要创建报告。`,{title:'原生技能与子任务验收'}))
  const p=await wait(threadId);report.threadId=threadId
  const text=p.messages.filter(message=>message.role==='assistant').map(message=>message.text).join('\n')
  if(p.runs.at(-1).status!=='completed'||!text.includes(expected)||!p.turnItems.some(item=>item.type==='dynamic_tool'&&item.toolName==='t3-code.read_project_document'&&item.status==='completed'))throw Error('技能实际指令标记或真实只读工具未在完成结果中出现；不能据此认定已执行')
  return p
 })
 await record('native-subagent-fixed-model-and-readonly-view',async()=>{
  const prompt='请真正使用当前运行器内置 spawn_agent 创建1个 default 子任务，委派它使用当前已授权的只读业务工具，列出项目资料并读取一份资料，返回实际来源和一个风险点。你等待该子任务结束后总结。不要模拟子任务、不要创建新外部Agent、不要写报告，不指定其他模型；如果工具不存在直接说明。'
  if(threadId)await client.send(threadId,prompt);else ({threadId}=await client.createThread(prompt,{title:'原生子任务验收'}))
  const p=await wait(threadId),tasks=p.subagents||[];report.threadId=threadId
  if(p.runs.at(-1).status!=='completed'||!tasks.length)throw Error('未观察到真实provider_native子任务记录')
  if(tasks.some(task=>task.origin!=='provider_native'||task.model!==client.bootstrap.fixedModel.model||!task.childThreadId))throw Error('子任务原生来源、固定模型或childThreadId证据不完整')
  const children=[],other=new T3LiveClient(origin)
  await other.login('lin');await other.connect()
  try{
  for(const task of tasks){
   const child=await client.projection(task.childThreadId)
   let mutationRejected=false;try{await client.send(task.childThreadId,'不得执行此消息；这是只读访问验证')}catch{mutationRejected=true}
   if(!mutationRejected)throw Error('子任务只读入口未阻止直接发送')
   let outsideActorRejected=false;try{await other.projection(task.childThreadId)}catch{outsideActorRejected=true}
   if(!outsideActorRejected)throw Error('私有父会话的子任务对其他成员泄漏')
   children.push({task,child,mutationRejected,outsideActorRejected})
  }
  }finally{other.close()}
  return {parent:p,children}
 })
 await record('codex-parent-stop-interrupts-native-child',async()=>{
  if(!threadId)throw Error('缺少测试会话')
  const prior=await wait(threadId),known=new Set((prior.subagents||[]).map(task=>task.id))
  await client.send(threadId,'请使用运行器原生 spawn_agent 再创建1个 default 子任务：它读取授权项目资料后，详细逐条分析发布检查与回滚核验的所有步骤和依据，约3000字。你必须等待子任务完成再作总结，不要创建报告，不要指定其他模型。')
  const running=await until(threadId,p=>(p.subagents||[]).some(task=>!known.has(task.id)&&task.status==='running'&&task.childThreadId),'真实子任务运行中')
  const active=running.subagents.filter(task=>!known.has(task.id)&&task.status==='running'),started=Date.now()
  const receipt=await client.rpc('orchestration.dispatchCommand',{type:'thread.stop',threadId,commandId:randomUUID()})
  const settled=await wait(threadId),children=[]
  for(const task of active){const child=await until(task.childThreadId,p=>p.providerTurns.length>0&&p.providerTurns.every(terminal),'子任务原生provider turn终态');if(child.nodes.some(node=>node.status==='running'))throw Error('父会话停止后子任务仍运行');children.push(child)}
  const after=await client.projection(threadId)
  if(after.subagents.some(task=>active.some(item=>item.id===task.id)&&task.status==='running'))throw Error('整体停止后原生子任务状态仍running')
  return {receipt,elapsedMs:Date.now()-started,active,before:running,settled:after,children}
 })
}catch(error){report.fatal=error.message;process.exitCode=1}finally{
 if(threadId&&client.socket?.readyState===1){try{const p=await client.projection(threadId);if(p.runs.some(run=>!terminal(run)))await client.rpc('orchestration.dispatchCommand',{type:'thread.stop',threadId,commandId:randomUUID()})}catch{}}
 report.completedAt=new Date().toISOString();await save();client.close();console.log(JSON.stringify({output,steps:report.steps.map(({name,status,error})=>({name,status,error})),fatal:report.fatal}))
}
