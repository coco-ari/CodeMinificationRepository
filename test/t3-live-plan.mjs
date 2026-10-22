import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
if(process.env.T3_PLAN_LIVE!=='1')throw Error('Set T3_PLAN_LIVE=1 for real planning acceptance')
const origin=process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887';assert.notEqual(new URL(origin).port,'8787')
const c=new T3LiveClient(origin),other=new T3LiveClient(origin),report={origin,startedAt:new Date().toISOString(),kind:'real-native-plan-and-authorized-save'}
try{
 await c.login();await c.connect();await other.login('lin');const threadId=randomUUID();report.threadId=threadId
 await c.http('/autoops/thread-bindings','POST',{threadId,projectId:'p-autoops',environmentId:'env-test',agentId:'a-project',visibility:'private'})
 await c.rpc('orchestration.launchThread',{commandId:randomUUID(),threadId,projectId:'p-autoops',title:'T3真实Plan验收',generateTitle:false,modelSelection:c.bootstrap.fixedModel,runtimeMode:'approval-required',interactionMode:'plan',workspaceStrategy:{type:'root'},initialMessage:{messageId:randomUUID(),text:'先只制定一个三步的测试环境只读检查计划，不执行检查。已确定：当前项目AutoOps工作台、环境env-test，步骤为读取环境检查手册、查询演示环境只读快照、保存Markdown检查报告。不能发布、部署、修改数据库，无需继续提问。请按计划模式提交最终proposed_plan。',attachments:[]}})
 let p,start=Date.now();while(Date.now()-start<180000){p=(await c.http(`/api/orchestration/threads/${threadId}`)).projection;if(p.runs.at(-1)&&['completed','failed','interrupted'].includes(p.runs.at(-1).status))break;await new Promise(r=>setTimeout(r,800))}
 report.projection=p;assert.equal(p.runs.at(-1)?.status,'completed')
 const plan=p.plans.find(x=>x.kind==='proposed_plan');assert.ok(plan,'No actual proposed_plan artifact')
 const input={threadId,name:'只读环境检查计划.md',contents:plan.markdown.trimEnd()+'\n'}
 const first=await c.http('/autoops/plan-materials','POST',input),again=await c.http('/autoops/plan-materials','POST',input);assert.equal(first.id,again.id)
 const response=await fetch(origin+first.sourceUrl,{headers:{cookie:c.cookie,origin}});assert.equal(response.status,200);assert.equal(await response.text(),input.contents)
 const denied=await other.http('/autoops/plan-materials','POST',input).then(()=>0,e=>e.status);assert.ok([403,404].includes(denied))
 const altered=await c.http('/autoops/plan-materials','POST',{...input,contents:'# 伪造内容\n'}).then(()=>0,e=>e.status);assert.equal(altered,409)
 report.material={...first,privateOtherStatus:denied,alteredStatus:altered};report.status='passed'
}catch(error){report.status='failed';report.error=error.message;report.detail=error.detail;process.exitCode=1}finally{c.close();other.close();report.completedAt=new Date().toISOString();await writeFile('.test-artifacts/t3-live/plan-v7.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,threadId:report.threadId}))}
