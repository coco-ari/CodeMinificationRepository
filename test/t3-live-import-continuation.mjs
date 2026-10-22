import assert from 'node:assert/strict'
import {writeFile,mkdir} from 'node:fs/promises'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
const origin=process.env.AGENT_DEMO_URL||'http://192.168.31.157:18987'
if(new URL(origin).port!=='18987')throw Error('This harness is restricted to the migrated-data copy on port 18987')
const threadId=process.env.T3_IMPORTED_THREAD||'b14b019e-f082-4684-9de1-5393444788e4'
const c=new T3LiveClient(origin),report={origin,threadId,startedAt:new Date().toISOString(),kind:'real-imported-native-continuation'}
try{
 await c.login();await c.connect();const before=(await c.http(`/api/orchestration/threads/${threadId}`)).projection
 report.beforeNative=before.providerThreads.map(x=>x.nativeThreadRef)
 const ordinal=before.runs.at(-1).ordinal+1
 await c.send(threadId,'这是新版迁移副本的续接复测。请实际调用当前项目资料列表工具，然后从本轮列表返回的 documents 中任选一份资料，严格使用列表中真实存在的 id 调用读取工具，简短回答实际资料标题及其中一个检查项。不存在的资料不需要查找，不得猜测 id。必须本轮成功读取，工具失败时如实说明，不要引用旧读取结果代替。')
 let after,started=Date.now()
 while(Date.now()-started<240000){after=(await c.http(`/api/orchestration/threads/${threadId}`)).projection;const r=after.runs.find(x=>x.ordinal===ordinal);if(r&&['completed','failed','interrupted','cancelled'].includes(r.status))break;await new Promise(r=>setTimeout(r,900))}
 const run=after.runs.find(x=>x.ordinal===ordinal);assert.equal(run?.status,'completed',JSON.stringify(run))
 report.run=run;report.afterNative=after.providerThreads.map(x=>x.nativeThreadRef)
 assert.deepEqual(report.afterNative,report.beforeNative,'Continuation changed native thread identity')
 report.tools=after.turnItems.filter(x=>x.runId===run.id&&x.type==='dynamic_tool').map(({toolName,status,input,output})=>({toolName,status,input,output}))
 assert.ok(report.tools.some(x=>x.status==='completed'&&x.toolName?.includes('read_project_document')),'No actual successful document read in resumed native turn')
 assert.ok(!report.tools.some(x=>x.status==='failed'),'Resumed tool call failed')
 report.answer=after.messages.filter(x=>x.runId===run.id&&x.role==='assistant').map(x=>x.text)
 report.status='passed'
}catch(error){report.status='failed';report.error=error.message;report.detail=error.detail;process.exitCode=1}finally{
 c.close();report.completedAt=new Date().toISOString();await mkdir('.test-artifacts/t3-live',{recursive:true});await writeFile(process.env.T3_IMPORT_REPORT||'.test-artifacts/t3-live/import-continuation.json',JSON.stringify(report,null,2));console.log(JSON.stringify({threadId,status:report.status,error:report.error,tools:report.tools?.map(({toolName,status})=>({toolName,status}))}))
}
