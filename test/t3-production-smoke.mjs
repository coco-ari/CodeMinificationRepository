import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
if(process.env.T3_PRODUCTION_SMOKE!=='1')throw Error('T3_PRODUCTION_SMOKE=1 required; this creates and deletes one fresh private test thread')
const origin=process.env.AGENT_DEMO_URL||'http://192.168.31.157:8787',client=new T3LiveClient(origin)
const report={kind:'post-cutover-real-model-new-private-thread',origin,startedAt:new Date().toISOString(),status:'running',existingUserThreadsMutated:false}
const terminal=r=>['completed','failed','interrupted','cancelled'].includes(r.status)
let threadId
try{
 const health=await (await fetch(origin+'/api/agent-demo/health')).json();assert.equal(health.engine,'t3');assert.equal(health.workerReachable,true);report.health=health
 await client.login();await client.connect()
 const shell=await client.http('/api/orchestration/shell');report.visibleThreadsBefore=shell.threads.length
 const created=await client.createThread('请先实际调用 list_project_materials，然后严格根据本轮列表中的真实ID读取环境检查手册，并查询本会话固定的测试环境快照。不要发布、部署、修改资源或生成报告。最后用三句话给出资料标题、采集时间和一项观察，明确这是演示数据。',{title:'迁移后正式入口验证（自动清理）'});threadId=created.threadId;report.threadId=threadId
 const started=Date.now();let projection
 while(Date.now()-started<180000){projection=(await client.http('/api/orchestration/threads/'+threadId)).projection;if(projection.runs.length&&projection.runs.every(terminal))break;await new Promise(r=>setTimeout(r,500))}
 assert.equal(projection.runs.length,1);assert.equal(projection.runs[0].status,'completed')
 report.run=projection.runs[0];report.nativeThreads=projection.providerThreads.map(x=>x.nativeThreadRef);assert(report.nativeThreads.some(x=>x?.nativeId))
 report.tools=projection.turnItems.filter(x=>x.type==='dynamic_tool').map(x=>({id:x.id,toolName:x.toolName,status:x.status,outputOmitted:x.outputOmitted}))
 for(const name of ['list_project_materials','read_project_document','query_environment'])assert(report.tools.some(x=>x.status==='completed'&&x.toolName?.includes(name)),'Missing successful '+name)
 assert(!report.tools.some(x=>x.status==='failed'))
 report.answer=projection.messages.filter(x=>x.role==='assistant'&&x.runId===report.run.id).map(x=>x.text).join('\n');assert(report.answer.includes('演示'))
 await client.rpc('orchestration.dispatchCommand',{type:'thread.delete',threadId,commandId:randomUUID()});report.testThreadDeleted=true
 const after=await client.http('/api/orchestration/shell');assert.equal(after.threads.length,report.visibleThreadsBefore);report.visibleThreadsAfter=after.threads.length
 for(const old of ['/api/agent-demo/events','/api/agent-demo/conversations']){const response=await fetch(origin+old,{headers:{cookie:client.cookie}});assert.equal(response.status,410)}report.retiredRoutesRejected=true
 report.status='passed'
}catch(error){report.status='failed';report.error=error.message;report.detail=error.detail;process.exitCode=1;if(threadId){try{const p=await client.projection(threadId);if(p.runs.some(r=>!terminal(r)))await client.rpc('orchestration.dispatchCommand',{type:'thread.stop',threadId,commandId:randomUUID()});report.failedTestThreadRetained=true}catch{}}}
finally{client.close();report.completedAt=new Date().toISOString();await mkdir('.test-artifacts/t3-final',{recursive:true});await writeFile('.test-artifacts/t3-final/production-smoke.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,threadId,error:report.error,testThreadDeleted:report.testThreadDeleted,tools:report.tools?.map(({toolName,status})=>({toolName,status}))}))}
