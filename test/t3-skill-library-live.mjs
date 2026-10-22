import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {zipSync} from 'fflate'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
const origin=process.env.BASE_URL||'http://192.168.31.157:18897'
if(new URL(origin).port!=='18897')throw Error('仅允许独立技能管理预览实例')
const output=process.env.ARTIFACT_DIR||'.test-artifacts/skill-library-live'
await mkdir(output,{recursive:true})
const clients=[],admin=new T3LiveClient(origin),guest=new T3LiveClient(origin),chen=new T3LiveClient(origin),lin=new T3LiveClient(origin)
clients.push(admin,guest,chen,lin)
const ownedThreads=[],ownedSkills=[],report={origin,steps:[],cleanup:[]},suffix=randomUUID().slice(0,8),name='live-'+suffix,first='SKILL_REFERENCE_ONE_'+suffix,second='SKILL_REFERENCE_TWO_'+suffix
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),terminal=r=>['completed','failed','cancelled','interrupted','rolled_back'].includes(r.status)
const save=()=>writeFile(output+'/report.json',JSON.stringify(report,null,2))
async function step(name,fn){const item={name};report.steps.push(item);try{item.result=await fn();item.status='passed'}catch(e){item.status='failed';item.error=e.stack;item.detail=e.detail;throw e}finally{await save();console.log(JSON.stringify({name,status:item.status,error:item.error}))}}
async function change(body){const catalog=await admin.http('/autoops/skill-library');return admin.http('/autoops/skill-library','POST',{revision:catalog.revision,...body})}
const contents=`---\nname: ${name}\ndescription: 按附带参考文件完成校验并查阅当前工作区\ndisplay-name: 技能闭环验收 ${suffix}\n---\n\n使用 read_project_material 读取本技能 references/验收.md 的授权资源路径，原样给出该文件的校验词。随后实际调用 list_project_materials 查看当前项目资料。不得猜测文件正文。`
function archive(marker){return Buffer.from(zipSync({'SKILL.md':Buffer.from(contents),'references/验收.md':Buffer.from('校验词：'+marker+'\n仅来自技能包的参考文件。')})).toString('base64')}
async function done(id,count=1){for(let n=0;n<260;n++){const p=await admin.projection(id);if(p.runs.length>=count&&p.runs.every(terminal)){assert(p.runs.every(r=>r.status==='completed'),JSON.stringify(p.runs));return p}await sleep(700)}throw Error('真实模型执行超时')}
async function launch(version){const id=randomUUID();ownedThreads.push(id);await admin.http('/autoops/thread-bindings','POST',{threadId:id,projectId:'p-autoops',environmentId:'env-test',agentId:'a-project',visibility:'private',workspaceType:'internal',workspaceVersionId:version.id});await admin.rpc('orchestration.launchThread',{commandId:randomUUID(),threadId:id,projectId:'p-autoops',title:'技能闭环测试 '+suffix,generateTitle:false,modelSelection:admin.bootstrap.fixedModel,runtimeMode:'approval-required',interactionMode:'default',workspaceStrategy:{type:'root'},initialMessage:{messageId:randomUUID(),text:`$autoops-${name} 按技能执行，简短回复。`,attachments:[]}},{timeout:60000});return id}
async function verifyReference(p,expected){const details=[];for(const item of p.turnItems.filter(i=>i.type==='dynamic_tool'))details.push(item.outputOmitted?(await admin.rpc('orchestration.getTurnItem',{threadId:p.thread.id,itemId:item.id})).item:item);const answers=p.messages.filter(m=>m.role==='assistant').map(m=>m.text||'').join('\n');assert(answers.includes(expected),'真实答复应包含只存在于技能参考文件的校验词');assert(details.some(t=>t.status==='completed'&&t.toolName==='t3-code.read_project_material'&&JSON.stringify(t).includes(expected)),'必须存在读取技能文件的真实成功工具事件');return {answer:answers,tools:details.map(t=>({name:t.toolName,status:t.status}))}}
try{
 await admin.login();await guest.login('guest');await chen.login('chen');await lin.login('lin');await lin.connect();await admin.connect();await guest.connect();await chen.connect()
 const original=await admin.http('/autoops/skill-library');report.originalIds=original.skills.map(s=>s.id);report.model=admin.bootstrap.fixedModel
 const overview=await admin.http('/autoops/projects/p-autoops/workspaces'),internal=overview.internalVersions.find(v=>v.status==='published');assert(internal)
 const scope={projectId:'p-autoops',agentId:'a-project',environmentId:'env-test',workspaceType:'internal',workspaceVersionId:internal.id}
 const context=c=>c.http('/autoops/skill-library/context?'+new URLSearchParams(scope))
 let skill,oldVersion,locked,id
 await step('import-assign-native-discovery-and-principal-isolation',async()=>{
  const catalog=await change({action:'import-archive',archiveBase64:archive(first),fileName:name+'.zip'});skill=catalog.skills.find(s=>s.name===name);assert(skill);ownedSkills.push(skill.id);oldVersion=skill.latestVersionId
  assert(!(await context(admin)).skills.some(s=>s.name==='autoops-'+name),'未分配不得出现')
  await change({action:'assign',skillId:skill.id,versionId:oldVersion,targetType:'project',targetId:'p-autoops',workspaceTypes:['internal']})
  const ctx=await context(admin);assert(ctx.skills.some(s=>s.name==='autoops-'+name))
  const native=await admin.rpc('server.refreshProviders',{instanceId:'codex',cwd:ctx.cwd,fresh:true},{timeout:60000})
  const snapshot=native.providers.find(p=>p.instanceId==='codex').workspaceSnapshots.find(s=>s.cwd===ctx.cwd);assert(snapshot?.skills.some(s=>s.name==='autoops-'+name),'原生skills/list应发现包')
  assert(native.providers.every(p=>!p.skills.length),'全局目录必须为空')
  await assert.rejects(context(guest),e=>e.status===403||e.status===404)
  await assert.rejects(guest.rpc('server.refreshProviders',{instanceId:'codex',cwd:ctx.cwd,fresh:true}))
  await assert.rejects(chen.http(`/autoops/skill-library/${skill.id}/versions/${oldVersion}/content?path=SKILL.md`),e=>e.status===404)
  const shared=await guest.rpc('server.getConfig');assert(!JSON.stringify(shared.providers).includes('autoops-'+name),'provider缓存不能泄漏内部技能')
  return {scope:ctx.cwd,globalSkillsEmpty:true,guestAndOtherProjectDenied:true,nativeName:'autoops-'+name}
 })
 await step('configured-model-real-skill-reference-and-workspace',async()=>{id=await launch(internal);const p=await done(id);locked=await admin.http('/autoops/skill-library/context?threadId='+id);await writeFile(output+'/first-round.json',JSON.stringify(p,null,2));return {threadId:id,...await verifyReference({...p,thread:{id}},first)}})
 await step('new-version-does-not-rewrite-existing-session',async()=>{
  skill=(await change({action:'import-archive',archiveBase64:archive(second),fileName:name+'.zip',skillId:skill.id})).skills.find(s=>s.id===skill.id)
  await change({action:'assign',skillId:skill.id,versionId:skill.latestVersionId,targetType:'project',targetId:'p-autoops',workspaceTypes:['internal']})
  const old=await admin.http('/autoops/skill-library/context?threadId='+id),fresh=await context(admin)
  await assert.rejects(lin.http(`/autoops/skill-library/contexts/${locked.snapshotId}/files/autoops-${name}?path=SKILL.md&metadata=1`), e=>e.status===403);
  const memberConfig=await lin.rpc('server.getConfig');assert(!JSON.stringify(memberConfig.providers).includes(locked.cwd),'同项目新成员不得看到旧私有快照');
  assert.equal(old.snapshotId,locked.snapshotId);assert.equal(old.skills.find(s=>s.name==='autoops-'+name).versionId,oldVersion);assert.equal(fresh.skills.find(s=>s.name==='autoops-'+name).versionId,skill.latestVersionId)
  await admin.send(id,`$autoops-${name} 再次实际读取技能参考文件，给出文件中的校验词。`);const p=await done(id,2);await verifyReference({...p,thread:{id}},first)
  const newId=await launch(internal),next=await done(newId);await verifyReference({...next,thread:{id:newId}},second)
  return {oldVersion,newVersion:skill.latestVersionId,oldSessionKeepsVersion:true,newSessionUsesUpdatedReference:true}
 })
 await step('disable-rejects-stale-picker-and-existing-session',async()=>{
  await change({action:'set-enabled',skillId:skill.id,enabled:false});assert(!(await context(admin)).skills.some(s=>s.name==='autoops-'+name))
  await assert.rejects(admin.rpc('server.refreshProviders',{instanceId:'codex',cwd:locked.cwd,fresh:true}))
  await assert.rejects(admin.http(`/autoops/skill-library/contexts/${locked.snapshotId}/files/autoops-${name}?path=references%2F%E9%AA%8C%E6%94%B6.md`),e=>e.status===403)
  const before=(await admin.projection(id)).runs.length
  try{await admin.send(id,`$autoops-${name} 再次执行。`)}catch(e){report.revokeRejection=e.message}
  await sleep(1800);const p=await admin.projection(id)
  assert(p.runs.length===before||p.runs.slice(before).every(r=>['failed','cancelled'].includes(r.status)),'撤回后不得开始新的模型执行')
  return {newInvocationBlocked:true,stalePreviewDenied:true}
 })
 report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;report.detail=e.detail;process.exitCode=1}
finally{
 for(const threadId of ownedThreads)try{const p=await admin.projection(threadId);if(p.runs.some(r=>!terminal(r))){await admin.rpc('orchestration.dispatchCommand',{type:'thread.stop',threadId,commandId:randomUUID()});await sleep(1000)}await admin.rpc('orchestration.dispatchCommand',{type:'thread.delete',threadId,commandId:randomUUID()});report.cleanup.push({threadId,removed:true})}catch(e){report.cleanup.push({threadId,error:e.message})}
 for(const skillId of ownedSkills)try{let c=await admin.http('/autoops/skill-library');for(const a of c.assignments.filter(a=>a.skillId===skillId))await change({action:'unassign',assignmentId:a.id});await change({action:'delete',skillId});report.cleanup.push({skillId,removed:true})}catch(e){report.cleanup.push({skillId,error:e.message})}
 for(const c of clients)c.close();report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,error:report.error,cleanup:report.cleanup}))
}
