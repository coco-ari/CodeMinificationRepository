import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
const c=new T3LiveClient(process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887')
const report={startedAt:new Date().toISOString(),kind:'real-native-rpc-mcp-questions',limitations:['真实CPA/Grok与业务ask_user；不是浏览器按钮测试','业务ask_user为单字段问题，多字段映射由原生协议回放另验'],steps:[],errors:[]}
const output=process.env.T3_QUESTIONS_REPORT||'.test-artifacts/t3-live/questions.json'
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),terminal=r=>['completed','failed','cancelled','interrupted'].includes(r.status)
const save=async()=>{await mkdir('.test-artifacts/t3-live',{recursive:true});await writeFile(output,JSON.stringify(report,null,2))}
const command=(type,extra={})=>({type,threadId,commandId:randomUUID(),...extra})
const dispatch=cmd=>c.rpc('orchestration.dispatchCommand',cmd,{timeout:60000})
let threadId
async function wait(test,label,timeout=180000){let last;const start=Date.now();while(Date.now()-start<timeout){last=await c.projection(threadId);if(test(last))return last;await sleep(350)}report.timeoutEvidence=last;throw new Error('Timed out: '+label)}
function evidence(p){return{threadId:p.thread.id,requests:p.runtimeRequests,turnItems:p.turnItems.filter(i=>['user_input_request','tool_call','dynamic_tool_call','dynamic_tool'].includes(i.type)),runs:p.runs,providerThreads:p.providerThreads.map(t=>({id:t.id,nativeThreadRef:t.nativeThreadRef})),providerTurns:p.providerTurns.map(t=>({id:t.id,runId:t.runId,nativeTurnRef:t.nativeTurnRef,status:t.status})),messages:p.messages.map(m=>({id:m.id,runId:m.runId,role:m.role,text:m.text?.slice(-2000)}))}}
async function step(name,fn){const row={name,startedAt:new Date().toISOString()};report.steps.push(row);try{row.result=await fn();row.status='passed'}catch(e){row.status='failed';row.error=e.message;row.detail=e.detail;report.errors.push({name,error:e.message})}await save();console.log(JSON.stringify({name,status:row.status,error:row.error}));return row}
async function pending(){const p=await wait(p=>p.runtimeRequests.some(r=>r.kind==='user_input'&&r.status==='pending'),'real MCP user input');const request=p.runtimeRequests.find(r=>r.kind==='user_input'&&r.status==='pending');const item=p.turnItems.find(i=>i.type==='user_input_request'&&i.requestId===request.id);if(!item||item.canDecline!==true)throw new Error('Expected real cancellable MCP form');return{p,request,item}}
async function ensureIdle(){const p=await c.projection(threadId);if(p.runs.some(r=>!terminal(r)))await dispatch(command('thread.stop'));await wait(p=>p.runs.every(terminal),'idle')}
try{
 await c.login();await c.connect();report.model=c.bootstrap.fixedModel
 await step('answer-live-mcp-form',async()=>{
  ({threadId}=await c.createThread('我们准备制作发布准备报告，但请先使用 ask_user 工具询问我“本次报告先检查哪种范围？”，选项为“测试环境”和“生产环境”。必须等待我在表单中选择，不要默认回答，也暂时不要生成文件。拿到选择后只用一句话确认。',{title:'MCP真实问答验收'}));report.threadId=threadId;await save()
  const {p,request,item}=await pending();report.initialQuestionEvidence=evidence(p);await save();const question=item.questions[0];if(!question)throw new Error('No actual question')
  const selected=question.options?.find(o=>o.label.includes('测试'))?.label;if(!selected)throw new Error('Actual form missing requested test environment option')
  const receipt=await dispatch(command('runtime-request.respond',{requestId:request.id,answers:{[question.id]:[selected]}}))
  const final=await wait(p=>p.runs.every(terminal),'answer completion')
  const resolved=final.runtimeRequests.find(r=>r.id===request.id)
  const assertions={requestResolved:resolved?.status==='resolved',savedActualAnswer:JSON.stringify(resolved?.answers).includes(selected),hasNativeTurn:final.providerTurns.some(t=>t.nativeTurnRef?.nativeId),acknowledged:final.messages.some(m=>m.role==='assistant'&&m.text?.includes('测试'))}
  if(!Object.values(assertions).every(Boolean)){report.answerEvidence=evidence(final);throw new Error('Actual answer evidence incomplete')}
  return{assertions,requestId:request.id,questions:item.questions,receipt,before:evidence(p),final:evidence(final)}
 })
 if(threadId)await step('decline-live-mcp-form',async()=>{
  await ensureIdle();await c.send(threadId,'现在还需要确认另一个独立事项：请使用 ask_user 工具询问我“报告需要Markdown还是PDF？”，给出Markdown和PDF选项，等待表单回答。若我拒绝或取消，就明确说明未选择格式并结束，不要追问或生成文件。')
  const {request,item}=await pending();const receipt=await dispatch(command('runtime-request.respond',{requestId:request.id,decision:'decline'}));const final=await wait(p=>p.runs.every(terminal),'decline completion')
  const resolved=final.runtimeRequests.find(r=>r.id===request.id);if(resolved?.status!=='resolved'||resolved.decision!=='decline')throw new Error('Decline was not persisted')
  return{requestId:request.id,questions:item.questions,receipt,final:evidence(final)}
 })
 if(threadId)await step('stop-pending-and-reject-late-answer',async()=>{
  await ensureIdle();await c.send(threadId,'接下来我想补充发布报告的负责人。请使用 ask_user 工具向我询问负责人姓名，必须等待表单回答后才能继续，不要推测姓名。')
  const {request,item}=await pending();await dispatch(command('thread.stop'));const final=await wait(p=>p.runs.every(terminal)&&!p.runtimeRequests.some(r=>r.id===request.id&&r.status==='pending'),'stop question expiry')
  let lateAccepted=false,lateError;try{await dispatch(command('runtime-request.respond',{requestId:request.id,answers:{[item.questions[0].id]:['迟到回答']}}));lateAccepted=true}catch(e){lateError={message:e.message,detail:e.detail}}
  if(lateAccepted)throw new Error('Expired question accepted a late answer')
  return{requestId:request.id,lateAccepted,lateError,final:evidence(final)}
 })
}catch(e){report.errors.push({fatal:e.message,detail:e.detail})}finally{
 if(threadId){try{await ensureIdle()}catch(e){report.errors.push({cleanup:e.message})}}
 c.close();report.completedAt=new Date().toISOString();await save();if(report.errors.length)process.exitCode=1;console.log(JSON.stringify({report:output,steps:report.steps.map(x=>({name:x.name,status:x.status})),errors:report.errors}))
}
