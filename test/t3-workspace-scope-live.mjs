import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
const origin=process.env.BASE_URL||'http://192.168.31.157:18887'
if(new URL(origin).port==='8787'&&process.env.T3_PRODUCTION_SMOKE!=='1')throw Error('正式入口验收需要显式设置 T3_PRODUCTION_SMOKE=1')
const output=process.env.ARTIFACT_DIR||'.test-artifacts/workspace-scope/live'
await mkdir(output,{recursive:true})
const admin=new T3LiveClient(origin),guest=new T3LiveClient(origin),owned=[],report={origin,cases:[],cleanup:[]}
async function raw(client,path){return fetch(origin+path,{headers:{cookie:client.cookie,origin,'x-t3-orchestration-protocol':'2'}})}
async function denied(client,path){const r=await raw(client,path);assert([403,404].includes(r.status),`${path}: ${r.status}`);return r.status}
async function step(name,fn){const value=await fn();report.cases.push({name,status:'passed',...value});console.log(JSON.stringify({name,status:'passed'}));await writeFile(output+'/report.json',JSON.stringify(report,null,2))}
async function waitDone(id,count){const end=Date.now()+180000;while(Date.now()<end){const p=(await guest.http('/api/orchestration/threads/'+id)).projection;const run=p.runs.at(-1);if(p.runs.length>=count&&run&&['completed','failed','cancelled','interrupted'].includes(run.status)){assert.equal(run.status,'completed',JSON.stringify(run));return p}await new Promise(r=>setTimeout(r,700))}throw Error('真实问答超时')}
let internal,external,id
try{
 await admin.login();await guest.login('guest');await Promise.all([admin.connect(),guest.connect()])
 const overview=await admin.http('/autoops/projects/p-autoops/workspaces')
 internal=overview.internalVersions.find(v=>v.isExample&&v.status==='published');external=overview.externalVersions.find(v=>v.isExample&&v.status==='published'&&v.sourceVersionId===internal?.id)
 assert(internal&&external,'必须已发布合成示例工作区')
 await step('external-permission-and-metadata',async()=>{
  assert.equal(guest.bootstrap.projects.length,1);const project=guest.bootstrap.projects[0];assert.equal(project.membership.workspaceAccess,'external');assert.deepEqual(project.environments.map(x=>x.id),['env-test'])
  const state=await guest.http('/autoops/projects/p-autoops/workspaces');assert.equal(state.internalVersions.length,0);assert.equal(state.releases.length,0);assert.equal(state.tasks.length,0)
  for(const v of state.externalVersions){assert(!('sourceVersionId'in v));assert.deepEqual(v.source.repositories,[])}
  const prefix='/api/agent-demo/t3/autoops/projects/p-autoops/workspaces'
  for(const suffix of ['/tree','/search?query=env','/content?path=WORKSPACE.md','/download?path=WORKSPACE.md&metadata=1'])await denied(guest,prefix+'/versions/'+internal.id+suffix)
  await denied(guest,'/api/agent-demo/t3/autoops/resources?path='+encodeURIComponent(`autoops/p-autoops/workspaces/${internal.id}/WORKSPACE.md`))
  await denied(guest,'/api/agent-demo/projects/p-autoops/documents/doc-runbook')
  if(overview.releases[0])await denied(guest,prefix+'/packages/'+overview.releases[0].id+'/manifest')
  await assert.rejects(()=>guest.http('/autoops/projects/p-autoops/workspaces/external','POST',{sourceVersionId:internal.id}))
  return{default:'external',environment:'env-test',internalDataDenied:true}
 })
 await step('draft-reservation-and-explicit-rejection',async()=>{
  id=randomUUID();owned.push(id)
  const scope={threadId:id,projectId:'p-autoops',environmentId:'env-test',agentId:'a-project',visibility:'private',workspaceType:'external',workspaceVersionId:external.id}
  const saved=await guest.http('/autoops/thread-bindings','POST',scope);assert.equal(saved.binding.scopeState,'draft')
  await assert.rejects(()=>guest.http('/autoops/thread-bindings','POST',{...scope,workspaceType:'internal',workspaceVersionId:internal.id}))
  await assert.rejects(()=>guest.http('/autoops/thread-bindings','POST',{...scope,environmentId:'env-prod'}))
  const launch={commandId:randomUUID(),threadId:id,projectId:'p-autoops',title:'范围联动合成验收',generateTitle:false,modelSelection:guest.bootstrap.fixedModel,runtimeMode:'approval-required',interactionMode:'default',workspaceStrategy:{type:'root'}}
  await assert.rejects(()=>guest.rpc('orchestration.launchThread',{...launch,modelSelection:{instanceId:'codex',model:'unknown-model'},initialMessage:{messageId:randomUUID(),text:'不得执行的校验',attachments:[]}}))
  assert.equal((await guest.http('/autoops/thread-bindings/'+id)).binding.scopeState,'draft')
  await guest.rpc('orchestration.launchThread',launch)
  assert.equal((await guest.http('/autoops/thread-bindings/'+id)).binding.scopeState,'draft','原生空shell不锁定')
  const updated=await guest.http('/autoops/thread-bindings','POST',{...scope,visibility:'project'});assert.equal(updated.binding.visibility,'project');assert.equal(updated.binding.scopeState,'draft')
  return{threadId:id,emptyShellEditable:true,invalidModelNotAccepted:true}
 })
 await step('real-first-message-lock-and-second-turn',async()=>{
  await guest.send(id,'请实际调用资料读取工具读取固定工作区 backend/.env.example，仅回答 SERVICE_HOST 的值和工作区类型。不要猜测。这是虚构示例。')
  const binding=(await guest.http('/autoops/thread-bindings/'+id)).binding;assert.equal(binding.scopeState,'locked');assert.equal(binding.scopeLocked,true)
  await assert.rejects(()=>guest.http('/autoops/thread-bindings','POST',{...binding,visibility:'private'}))
  const first=await waitDone(id,1);assert(first.turnItems.some(x=>x.type==='dynamic_tool'&&x.status==='completed'&&/read_project_document|read_project_material/.test(x.toolName)), '必须实际读取文件，不能只列目录')
  const answer=first.messages.filter(x=>x.role==='assistant').map(x=>x.text).join('\n');assert(!answer.includes('192.168.99.10'));assert.match(answer,/脱敏|external/)
  await guest.send(id,'根据刚才实际读取的结果，用一句话再确认本对话的工作区类型和环境，不生成文件。')
  const second=await waitDone(id,2);assert.equal(second.runs.length,2);assert.equal((await guest.http('/autoops/thread-bindings/'+id)).binding.workspaceVersionId,external.id)
  assert(!JSON.stringify(second).includes('/home/tao/'), '外部wire元数据不得暴露宿主目录')
  await writeFile(output+'/synthetic-conversation.json',JSON.stringify({binding,projection:second},null,2))
  return{threadId:id,realTurns:2,immutableVersion:external.id,sharedVisibleToAuthorizedAdmin:!!(await admin.http('/autoops/thread-bindings/'+id)).binding}
 })
 report.status='passed'
}catch(error){report.status='failed';report.error=error.stack;report.detail=error.detail;process.exitCode=1}
finally{for(const threadId of owned){try{const p=(await guest.http('/api/orchestration/threads/'+threadId)).projection;if(p.runs.some(r=>!['completed','failed','cancelled','interrupted'].includes(r.status))){await guest.rpc('orchestration.dispatchCommand',{type:'thread.stop',commandId:randomUUID(),threadId,createdAt:new Date().toISOString()});await new Promise(r=>setTimeout(r,1000))}await guest.rpc('orchestration.dispatchCommand',{type:'thread.delete',commandId:randomUUID(),threadId,createdAt:new Date().toISOString()});report.cleanup.push({threadId,removed:true})}catch(error){report.cleanup.push({threadId,removed:false,error:error.message})}}admin.close();guest.close();await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))}
