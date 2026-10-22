import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
const origin=process.env.BASE_URL||'http://192.168.31.157:18887'
if(new URL(origin).port==='8787'&&process.env.T3_PRODUCTION_SMOKE!=='1')throw Error('正式入口测试需显式授权')
const output=process.env.ARTIFACT_DIR||'.test-artifacts/workspaces/live'
await mkdir(output,{recursive:true})
const client=new T3LiveClient(origin),owned=[],report={origin,cases:[],cleanup:[]}
const pause=ms=>new Promise(done=>setTimeout(done,ms))
async function finish(id,count=1){
 const end=Date.now()+180000
 while(Date.now()<end){const p=(await client.http('/api/orchestration/threads/'+id)).projection;const run=p.runs.at(-1)
  if(p.runs.length>=count&&run&&['completed','failed','cancelled','interrupted'].includes(run.status)){assert.equal(run.status,'completed',JSON.stringify(run));return p}
  await pause(700)
 }
 throw Error('真实工作区问答超时')
}
async function launch(version){
 const threadId=randomUUID();owned.push(threadId)
 await client.http('/autoops/thread-bindings','POST',{threadId,projectId:'p-autoops',environmentId:'env-test',agentId:'a-project',visibility:'private',workspaceType:version.type,workspaceVersionId:version.id})
 const prompt='请实际调用项目资料工具，读取固定工作区的 backend/.env.example 和 WORKSPACE.md，两个文件都必须读取。只用三行回复：工作区类型；SERVICE_HOST 的值；WORKSPACE.md 中的项目代号。这些文件是明确标识的虚构示例，不要根据文件名猜测，也不要访问工作区之外的目录。'
 await client.rpc('orchestration.launchThread',{commandId:randomUUID(),threadId,projectId:'p-autoops',title:'工作区真实读取验证-'+version.type,generateTitle:false,modelSelection:client.bootstrap.fixedModel,runtimeMode:'approval-required',interactionMode:'default',workspaceStrategy:{type:'root'},initialMessage:{messageId:randomUUID(),text:prompt,attachments:[]}},{timeout:60000})
 const p=await finish(threadId),tools=[]
 for(const entry of p.turnItems.filter(x=>x.type==='dynamic_tool'))tools.push(entry.outputOmitted?(await client.rpc('orchestration.getTurnItem',{threadId,itemId:entry.id})).item:entry)
 const details=JSON.stringify(tools),answer=p.messages.filter(m=>m.role==='assistant').map(m=>m.text||'').join('\n')
 assert(tools.some(x=>x.status==='completed'&&/read_project_document|read_project_material/.test(x.toolName)),'必须存在实际完成的读取工具')
 assert(details.includes('backend/.env.example')&&details.includes('WORKSPACE.md'))
 if(version.type==='internal'){assert(details.includes('192.168.99.10'));assert.match(answer,/192\.168\.99\.10/)}
 else {assert(!details.includes('sk-example-workspace-not-real-1234567890'));assert(!details.includes('example-password-not-real'));assert(!details.includes('192.168.99.10'));assert(details.includes('已脱敏'));assert(!answer.includes('192.168.99.10'))}
 const binding=(await client.http('/autoops/thread-bindings/'+threadId)).binding
 assert.equal(binding.workspaceVersionId,version.id)
 const result={type:version.type,threadId,versionId:version.id,status:'passed',runId:p.runs.at(-1).id,toolEvents:tools.map(x=>({toolName:x.toolName,status:x.status})),answer}
 report.cases.push(result);console.log(JSON.stringify({type:version.type,status:'passed',toolCalls:tools.length}))
 await writeFile(output+'/'+version.type+'.json',JSON.stringify({binding,projection:p,tools},null,2))
 return threadId
}
try{
 await client.login();await client.connect()
 const overview=await client.http('/autoops/projects/p-autoops/workspaces')
 const internal=overview.internalVersions.find(v=>v.isExample&&v.status==='published')
 const external=overview.externalVersions.find(v=>v.isExample&&v.status==='published'&&v.sourceVersionId===internal?.id)
 assert(internal&&external,'先生成发布示例外部版本再运行真实问答')
 await launch(internal);await launch(external)
 report.status='passed'
}catch(error){report.status='failed';report.error=error.message;report.detail=error.detail;process.exitCode=1}
finally{
 for(const threadId of owned){try{let p=(await client.http('/api/orchestration/threads/'+threadId)).projection
  if(p.runs.some(r=>!['completed','failed','cancelled','interrupted'].includes(r.status))) {await client.rpc('orchestration.dispatchCommand',{type:'thread.stop',commandId:randomUUID(),threadId,createdAt:new Date().toISOString()});await pause(1000)}
  await client.rpc('orchestration.dispatchCommand',{type:'thread.delete',commandId:randomUUID(),threadId,createdAt:new Date().toISOString()});report.cleanup.push({threadId,removed:true})
 }catch(error){report.cleanup.push({threadId,removed:false,error:error.message})}}
 client.close();report.finishedAt=new Date().toISOString();await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,cleanup:report.cleanup}))
}
