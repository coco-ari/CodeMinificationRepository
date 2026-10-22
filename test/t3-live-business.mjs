import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
import {extractBusinessAttachment} from '../agent-demo/t3-adapters/business-documents.mjs'

// Calls the actual configured provider. Run only against an isolated stage.
if(process.env.T3_BUSINESS_LIVE!=='1')throw new Error('Set T3_BUSINESS_LIVE=1 for real provider acceptance')
const origin=new URL(process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887').origin
assert.notEqual(new URL(origin).port,'8787','Do not mutate production from this harness')
const selected=new Set((process.env.T3_BUSINESS_CASES||'pdf,office,html,fork,compact,subagent').split(','))
const output=process.env.T3_BUSINESS_REPORT||'.test-artifacts/t3-live/business.json'
const report={startedAt:new Date().toISOString(),origin,kind:'actual-provider',cases:[]}
const client=new T3LiveClient(origin),other=new T3LiveClient(origin)
let currentCase
async function createThread(text,options){
 const result=await client.createThread(text,options)
 if(currentCase){currentCase.threadId=result.threadId;await writeFile(output,JSON.stringify(report,null,2))}
 console.log(JSON.stringify({createdBusinessThread:result.threadId,case:currentCase?.name}))
 return result
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function snapshot(threadId){return (await client.http(`/api/orchestration/threads/${encodeURIComponent(threadId)}`)).projection}
async function finish(threadId,ordinal=1,timeout=240000){
  const started=Date.now()
  while(Date.now()-started<timeout){const p=await snapshot(threadId),r=p.runs.find(x=>x.ordinal===ordinal)
    if(r&&['completed','failed','cancelled','interrupted'].includes(r.status)){assert.equal(r.status,'completed',JSON.stringify(r));return p}await sleep(800)}
  throw new Error(`Native turn did not settle: ${threadId}/${ordinal}`)
}
async function step(name,run){if(!selected.has(name))return
  const row={name,startedAt:new Date().toISOString()};report.cases.push(row);currentCase=row
  try{row.result=await run();row.status='passed'}catch(e){row.status='failed';row.error=e.message;row.detail=e.detail;process.exitCode=1}
  row.completedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({name,status:row.status,error:row.error}))
}
const tools=(p)=>p.turnItems.filter(x=>x.type==='dynamic_tool')
async function toolDetails(p){return Promise.all(tools(p).map(async item=>item.outputOmitted?(await client.rpc('orchestration.getTurnItem',{threadId:p.thread.id,itemId:item.id})).item:item))}
async function bytesAt(path,actor=client){return fetch(new URL(path,origin),{headers:{cookie:actor.cookie,origin}})}
let baseThread
try{
  await mkdir(new URL('../.test-artifacts/t3-live/',import.meta.url),{recursive:true});await client.login();await client.connect();await other.login('lin');await other.connect()
  await step('pdf',async()=>{
    const {threadId}=process.env.T3_BUSINESS_PDF_THREAD?{threadId:process.env.T3_BUSINESS_PDF_THREAD}:await createThread('请调用 create_report 生成 PDF，文件名为“迁移验收报告.pdf”，正文必须包含“迁移验收：真实中文PDF，禁止生产发布”。必须真正调用工具保存文件，返回下载链接，不要仅口头说明。',{title:'T3真实PDF验收'})
    baseThread=threadId;const p=await finish(threadId)
    const successful=(await toolDetails(p)).filter(x=>x.status==='completed'&&x.toolName?.includes('create_report'))
    assert.ok(successful.length,'No successful native create_report event')
    const body=JSON.stringify(successful),match=body.match(/report-[a-f0-9]{64}/);assert.ok(match,'No actual persisted report ID')
    const response=await bytesAt(`/api/agent-demo/t3/autoops/files/${match[0]}`);assert.equal(response.status,200)
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-')
    const parsed=await extractBusinessAttachment({id:match[0],name:'验收.pdf',mime:'application/pdf',bytes});assert.ok(parsed.content?.includes('真实中文PDF'))
    const denied=await bytesAt(`/api/agent-demo/t3/autoops/files/${match[0]}`,other);assert.ok([403,404].includes(denied.status))
    await writeFile(output.replace(/\.json$/,'.pdf'),bytes)
    return{threadId,nativeThread:p.providerThreads[0]?.nativeThreadRef,reportId:match[0],bytes:bytes.length,privateOtherStatus:denied.status}
  })
  await step('office',async()=>{
    const bytes=await readFile(new URL('./t3-business-documents-fixtures/release.docx',import.meta.url))
    const metadata={type:'file',name:'release.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',sizeBytes:bytes.length}
    const upload=await client.rpc('attachments.createUploadUrl',metadata)
    const response=await fetch(origin+'/api/agent-demo/t3'+upload.relativeUrl,{method:'POST',headers:{cookie:client.cookie,origin,'content-type':'application/octet-stream','x-demo-csrf':client.bootstrap.csrfToken},body:bytes});assert.ok(response.ok,`Upload ${response.status}`)
    const {threadId}=await createThread('接下来将上传一份检查文档，请先只回复“准备读取”。',{title:'T3真实Office验收'});await finish(threadId)
    await client.rpc('orchestration.dispatchCommand',{type:'message.dispatch',createdBy:'user',creationSource:'web',commandId:randomUUID(),threadId,messageId:randomUUID(),text:'请实际调用附件读取工具读取这份DOCX，回答文档中的负责人姓名和一个检查项。不要根据文件名猜测。',attachments:[{...metadata,id:upload.attachmentId}],modelSelection:client.bootstrap.fixedModel,dispatchMode:{type:'start_immediately'}})
    const p=await finish(threadId,2),answer=p.messages.filter(x=>x.role==='assistant'&&x.runId===p.runs.at(-1).id).map(x=>x.text).join('\n')
    assert.match(answer,/林涛/);assert.ok(tools(p).some(x=>x.status==='completed'&&x.toolName?.includes('read_attachment')))
    const attachments=p.messages.filter(x=>x.role==='user').flatMap(x=>x.attachments||[]);assert.equal(attachments.length,1)
    const file=await bytesAt(`/api/agent-demo/t3/autoops/attachments/${encodeURIComponent(attachments[0].id)}`);assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes)
    const denied=await bytesAt(`/api/agent-demo/t3/autoops/attachments/${encodeURIComponent(attachments[0].id)}`,other);assert.ok([403,404].includes(denied.status))
    return{threadId,attachmentId:attachments[0].id,bytes:bytes.length,privateOtherStatus:denied.status}
  })
  await step('html',async()=>{
    const {threadId}=await createThread('请用 html_preview 和 html_render 生成一个小型交互计数器，按钮文字“验收加一”、计数初始为0，点击加一。HTML必须完全内联，不访问网络，不读取服务器路径。先预览再真正交付。如果预览浏览器正在安装，请如实说明。',{title:'T3真实HTML验收'})
    const p=await finish(threadId,1,300000),events=tools(p)
    assert.ok(events.some(x=>x.status==='completed'&&x.toolName?.includes('html_preview')),'Native html_preview did not complete')
    assert.ok(events.some(x=>x.status==='completed'&&x.toolName?.includes('html_render')),'Native html_render did not complete')
    return{threadId,tools:events.map(({toolName,status})=>({toolName,status})),attachments:p.messages.flatMap(x=>x.attachments||[]).map(({id,name,mimeType})=>({id,name,mimeType}))}
  })
  await step('fork',async()=>{
    if(!baseThread){const created=await createThread('请记住验收标记：青竹七号。只回复已记住。',{title:'T3原生分支验收'});baseThread=created.threadId;await finish(baseThread)}
    const source=await snapshot(baseThread),targetThreadId=randomUUID()
    await client.rpc('orchestration.dispatchCommand',{type:'thread.fork',createdBy:'user',creationSource:'web',commandId:randomUUID(),sourceThreadId:baseThread,targetThreadId,sourcePoint:{type:'latest_stable'},title:'T3原生分支验收副本'})
    const child=await snapshot(targetThreadId)
    const binding=await client.http(`/autoops/thread-bindings/${targetThreadId}`);assert.equal(binding.binding.visibility,'private')
    // T3 persists a pending context transfer and creates the native fork when
    // the first child message is sent, not when its sidebar row is created.
    await client.send(targetThreadId,'用一句话说明上一轮保存的内容或验收标记，不调用工具。');const p=await finish(targetThreadId,(child.runs.at(-1)?.ordinal||0)+1)
    assert.ok(p.providerThreads.some(x=>x.nativeThreadRef?.nativeId));assert.notEqual(p.providerThreads[0].nativeThreadRef.nativeId,source.providerThreads[0].nativeThreadRef.nativeId)
    assert.ok(p.contextTransfers.some(x=>x.type==='fork'&&x.resolution?.strategy==='native_fork'))
    return{sourceThreadId:baseThread,targetThreadId,sourceNative:source.providerThreads[0].nativeThreadRef,nativeThread:p.providerThreads[0].nativeThreadRef,visibility:binding.binding.visibility}
  })
  await step('compact',async()=>{
    const {threadId}=await createThread('压缩验收标记为“松针二号”，请记住并只回复收到。',{title:'T3真实压缩验收'});await finish(threadId)
    await client.send(threadId,'/compact');const p=await finish(threadId,2,300000)
    assert.ok(p.turnItems.some(x=>x.type==='compaction'&&x.status==='completed'),'No real completed native compaction item')
    await client.send(threadId,'只回答刚才的压缩验收标记。');const after=await finish(threadId,3);assert.match(after.messages.filter(x=>x.runId===after.runs.at(-1).id&&x.role==='assistant').map(x=>x.text).join(''),/松针二号/)
    return{threadId,compactions:p.turnItems.filter(x=>x.type==='compaction').map(({status,driver})=>({status,driver})),runs:after.runs.length}
  })
  await step('subagent',async()=>{
    const {threadId}=await createThread('请明确启动一个内置子Agent（explorer角色），只让它读取当前项目资料目录并给出一条检查建议，等待它结束后用一句话汇总。这是内置子任务验收，请实际使用spawn_agent/wait_agent，不要模拟子任务，不执行shell或任何服务器修改。',{title:'T3真实内置子任务验收'})
    const p=await finish(threadId,1,300000),children=p.turnItems.filter(x=>x.type==='subagent')
    assert.ok(children.length,'No real native subagent event');assert.ok(children.some(x=>x.status==='completed'))
    const child=children.find(x=>x.childThreadId);assert.ok(child,'No authorized child navigation identity')
    const childProjection=await snapshot(child.childThreadId)
    const denied=await other.http(`/api/orchestration/threads/${child.childThreadId}`).then(()=>false,e=>[403,404].includes(e.status));assert.equal(denied,true)
    return{threadId,children:children.map(({childThreadId,status,origin})=>({childThreadId,status,origin})),childModel:childProjection.runs.map(x=>x.modelSelection)}
  })
}finally{client.close();other.close();report.completedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2))}
