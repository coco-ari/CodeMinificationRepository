import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync,writeFileSync,chmodSync,mkdirSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fork} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {zipSync} from 'fflate'
import {createSkillLibrary} from '../agent-demo/t3-adapters/skill-library.mjs'
import {prepareScopedBusinessSkills,resolveBusinessSkillContext,authorizeBusinessSkillCwd,readScopedSkillResource,readScopedSkillResourceForThread,filterBusinessProviderResult,scopedBusinessSkillPolicy} from '../agent-demo/t3-adapters/scoped-skills.mjs'
import {resolveBusinessSkillMentions,filterBusinessSkills} from '../agent-demo/t3-adapters/skills.mjs'
import {createAutoOpsAccess,initializeAutoOpsAccessSchema} from '../agent-demo/t3-adapters/access.mjs'
const markdown=(name,body='读取 references/check.md 后整理报告。')=>`---\nname: ${name}\ndescription: 测试技能\n---\n${body}\n`
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'scoped-skills-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const library=createSkillLibrary(directory)
 const binding={threadId:'thread-one',projectId:'p-one',agentId:'a-one',environmentId:'env-one',workspaceType:'internal',workspaceVersionId:'version-one',ownerId:'user-one',visibility:'private',scopeState:'locked'}
 const principal={id:'user-one'},bindings=new Map([[binding.threadId,binding]])
 const access={bootstrap:()=>({projects:[{id:'p-one',agents:[{id:'a-one'},{id:'a-other'}]}]}),requireWorkspace:(_p,p,type)=>{if(p!=='p-one'||type!=='internal')throw Error('denied')},requireEnvironment:()=>{},requireThread:(viewer,id)=>{const binding=bindings.get(id);if(!binding||binding.ownerId!==viewer.id&&(binding.visibility!=='project'||binding.scopeState!=='locked'))throw Error('denied');return binding},requireToolThread:id=>({binding:access.requireThread(principal,id)})}
 const importSkill=(name='sample',body,files={})=>{library.importArchive({revision:library.catalog().revision,archiveBase64:Buffer.from(zipSync(Object.fromEntries(Object.entries({'SKILL.md':markdown(name,body),'references/check.md':'固定参考内容',...files}).map(([k,v])=>[k,Buffer.from(v)])))).toString('base64')});return library.catalog().skills.find(s=>s.name===name)}
 const assign=(skill,targetType='agent',targetId='a-one',versionId=skill.versions.at(-1).id,workspaceTypes=['internal'])=>library.assign({revision:library.catalog().revision,skillId:skill.id,versionId,targetType,targetId,workspaceTypes})
 return {directory,library,binding,principal,access,bindings,importSkill,assign,env:{AUTOOPS_T3_DATA_DIR:directory}}
}
test('同一中央包按助手/项目与内部外部范围隔离；原生列表与typed $使用同一清单',t=>{
 const f=fixture(t),skill=f.importSkill();f.assign(skill)
 const c=prepareScopedBusinessSkills(f.directory,f.binding)
 assert.equal(c.skills.length,1);assert.match(readFileSync(c.skills[0].path,'utf8'),/name: autoops-sample/)
 assert.equal(resolveBusinessSkillMentions('$autoops-sample 请检查',f.env,f.binding)[0].path,c.skills[0].path)
 assert.throws(()=>resolveBusinessSkillMentions('$autoops-sample',f.env),e=>e.code==='SKILL_SCOPE_REQUIRED')
 for(const changes of [{agentId:'a-other'},{workspaceType:'external'}])assert.throws(()=>resolveBusinessSkillMentions('$autoops-sample',f.env,{...f.binding,...changes,threadId:'other'}),e=>e.code==='SKILL_NOT_AVAILABLE')
 f.assign(skill,'project','p-one');assert.equal(resolveBusinessSkillMentions('$autoops-sample',f.env,{...f.binding,agentId:'a-other',threadId:'different'}).length,1)
 assert.throws(()=>resolveBusinessSkillMentions('$autoops-sample',f.env,{...f.binding,projectId:'p-two',agentId:'a-other',threadId:'another'}))
 const entries=[...c.skills,{...c.skills[0],path:'/other/SKILL.md'}]
 assert.equal(filterBusinessSkills(entries,f.env,c.physicalCwd).length,1);assert.deepEqual(filterBusinessSkills(entries,f.env),[])
})
test('分配升级后新旧对话均采用当前版本，历史技能文件不改写',t=>{
 const f=fixture(t),skill=f.importSkill();f.assign(skill);const before=prepareScopedBusinessSkills(f.directory,f.binding)
 f.library.importMarkdown({revision:f.library.catalog().revision,skillId:skill.id,contents:markdown('sample','第二版指令')})
 const updated=f.library.catalog().skills.find(s=>s.id===skill.id);f.assign(updated)
 const continued=prepareScopedBusinessSkills(f.directory,f.binding),fresh=prepareScopedBusinessSkills(f.directory,{...f.binding,threadId:'new-thread'})
 assert.notEqual(continued.snapshotId,before.snapshotId);assert.equal(fresh.snapshotId,continued.snapshotId)
 assert.match(readFileSync(before.skills[0].path,'utf8'),/references\/check.md/);assert.match(readFileSync(continued.skills[0].path,'utf8'),/第二版/);assert.match(readFileSync(fresh.skills[0].path,'utf8'),/第二版/)
})
test('多次更新的历史技能仍按会话归属读取，不扩大其他用户的访问',t=>{
 const f=fixture(t),skill=f.importSkill();f.assign(skill)
 const versions=[prepareScopedBusinessSkills(f.directory,f.binding)]
 for(const body of ['第二次分配','第三次分配']) {
  f.library.importMarkdown({revision:f.library.catalog().revision,skillId:skill.id,contents:markdown('sample',body)})
  f.assign(f.library.catalog().skills.find(s=>s.id===skill.id))
  versions.push(prepareScopedBusinessSkills(f.directory,f.binding))
 }
 assert.equal(new Set(versions.map(c=>c.snapshotId)).size,3)
 const middle=versions[1]
 assert.match(readScopedSkillResourceForThread(f.directory,f.binding.threadId,`autoops/skills/${middle.snapshotId}/autoops-sample/SKILL.md`,f.access).content,/第二次分配/)
 assert.throws(()=>readScopedSkillResource(f.directory,middle.snapshotId,'autoops-sample','SKILL.md',{access:f.access,principal:{id:'user-two'}}),{code:'SKILL_SCOPE_FORBIDDEN'})
 assert.equal(resolveBusinessSkillContext(f.directory,{threadId:f.binding.threadId},{access:f.access,principal:f.principal}).snapshotId,versions[2].snapshotId)
})
test('历史技能快照只允许有权查看锁定会话的用户读取；新成员只看当前版本',t=>{
 const f=fixture(t),skill=f.importSkill();f.assign(skill)
 const old=prepareScopedBusinessSkills(f.directory,f.binding),member={id:'user-two'},ownerOptions={access:f.access,principal:f.principal},memberOptions={access:f.access,principal:member}
 f.library.importMarkdown({revision:f.library.catalog().revision,skillId:skill.id,contents:markdown('sample','新版本已删除原参考资料')})
 f.assign(f.library.catalog().skills.find(s=>s.id===skill.id))
 const fresh=resolveBusinessSkillContext(f.directory,{...f.binding,threadId:undefined},memberOptions)
 assert.notEqual(fresh.snapshotId,old.snapshotId)
 assert.throws(()=>readScopedSkillResource(f.directory,old.snapshotId,'autoops-sample','references/check.md',memberOptions),e=>e.code==='SKILL_SCOPE_FORBIDDEN')
 assert.throws(()=>authorizeBusinessSkillCwd(f.directory,old.cwd,memberOptions),e=>e.code==='SKILL_SCOPE_FORBIDDEN')
 assert.match(readScopedSkillResource(f.directory,fresh.snapshotId,'autoops-sample','SKILL.md',memberOptions).bytes.toString(),/新版本/)
 assert.equal(readScopedSkillResource(f.directory,old.snapshotId,'autoops-sample','references/check.md',ownerOptions).bytes.toString(),'固定参考内容')
 const value={providers:[{skills:old.skills,workspaceSnapshots:[{cwd:old.physicalCwd,skills:old.skills}]}]}
 assert.deepEqual(filterBusinessProviderResult(f.directory,value,memberOptions).providers[0].workspaceSnapshots,[])
 assert.equal(filterBusinessProviderResult(f.directory,value,ownerOptions).providers[0].workspaceSnapshots.length,1)
 // Scope access alone, or an unlocked draft, cannot confer historical access.
 f.binding.scopeState='draft'
 assert.throws(()=>readScopedSkillResource(f.directory,old.snapshotId,'autoops-sample','SKILL.md',ownerOptions),e=>e.code==='SKILL_SCOPE_FORBIDDEN')
 assert.throws(()=>readScopedSkillResource(f.directory,old.snapshotId,'autoops-sample','SKILL.md',{...ownerOptions,threadId:f.binding.threadId}),e=>e.code==='SKILL_SCOPE_FORBIDDEN')
 assert.equal(resolveBusinessSkillContext(f.directory,{threadId:f.binding.threadId},ownerOptions).snapshotId,fresh.snapshotId)
 f.binding.scopeState='locked';f.binding.visibility='project'
 assert.equal(readScopedSkillResource(f.directory,old.snapshotId,'autoops-sample','references/check.md',memberOptions).bytes.toString(),'固定参考内容')
 assert.equal(filterBusinessProviderResult(f.directory,value,memberOptions).providers[0].workspaceSnapshots.length,1)
 // Losing visibility removes access immediately; the provider cache is not an ACL.
 f.binding.visibility='private'
 assert.deepEqual(filterBusinessProviderResult(f.directory,value,memberOptions).providers[0].workspaceSnapshots,[])
 f.library.setEnabled({revision:f.library.catalog().revision,skillId:skill.id,enabled:false})
 assert.throws(()=>readScopedSkillResource(f.directory,old.snapshotId,'autoops-sample','SKILL.md',ownerOptions),e=>e.code==='SKILL_SCOPE_FORBIDDEN')
})
test('并发原生进程首次绑定只发布一个完整快照，冲突范围拒绝启动',async t=>{
 const f=fixture(t),skill=f.importSkill();f.assign(skill,'project','p-one')
 const worker=join(f.directory,'concurrent-scope.mjs'),moduleUrl=new URL('../agent-demo/t3-adapters/scoped-skills.mjs',import.meta.url).href
 writeFileSync(worker,`import {prepareScopedBusinessSkills} from ${JSON.stringify(moduleUrl)};\nprocess.send({ready:true});process.once('message',({directory,binding})=>{try{const c=prepareScopedBusinessSkills(directory,binding);process.send({snapshotId:c.snapshotId,scope:c.scope});}catch(e){process.send({error:e.code||e.message});}finally{process.disconnect();}});\n`)
 const children=Array.from({length:8},()=>fork(worker,[],{execPath:process.execPath,stdio:['ignore','ignore','pipe','ipc']}))
 t.after(()=>children.forEach(child=>{if(child.exitCode===null)child.kill()}))
 await Promise.all(children.map(child=>new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(Error(`worker exit ${code}`))})})))
 const results=await Promise.all(children.map((child,index)=>new Promise((resolve,reject)=>{
   child.once('message',resolve);child.once('error',reject)
   child.send({directory:f.directory,binding:{...f.binding,agentId:index%2?'a-one':'a-other'}})
 })))
 const success=results.filter(result=>result.snapshotId),failed=results.filter(result=>result.error)
 assert.ok(success.length);assert.equal(new Set(success.map(result=>result.snapshotId)).size,1)
 assert.ok(failed.every(result=>result.error==='SKILL_SCOPE_FORBIDDEN'))
 const winner=prepareScopedBusinessSkills(f.directory,{...f.binding,agentId:success[0].scope.agentId})
 assert.equal(winner.snapshotId,success[0].snapshotId)
 assert.throws(()=>prepareScopedBusinessSkills(f.directory,{...f.binding,agentId:success[0].scope.agentId==='a-one'?'a-other':'a-one'}),e=>e.code==='SKILL_SCOPE_FORBIDDEN')
})
test('真实登录与会话ACL：私有旧版本仅拥有者可见，共享旧版本内部成员可见',t=>{
 for(const visibility of ['private','project']) {
  const f=fixture(t),sessionDb=new DatabaseSync(':memory:'),bindingDb=new DatabaseSync(':memory:')
  t.after(()=>{sessionDb.close();bindingDb.close()})
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)');initializeAutoOpsAccessSchema(bindingDb)
  for(const id of ['u-admin','u-lin','u-guest'])sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(id).digest('hex'),id,'csrf',Date.now()+60000)
  const access=createAutoOpsAccess({sessionDb,bindingDb}),owner=access.authenticateCookie('demo_session=u-admin'),member=access.authenticateCookie('demo_session=u-lin'),guest=access.authenticateCookie('demo_session=u-guest')
  const binding=access.bindThread(owner,{threadId:'history',projectId:'p-autoops',agentId:'a-project',environmentId:'env-test',workspaceType:'internal',workspaceVersionId:'internal-v1',visibility})
  const skill=f.importSkill();f.assign(skill,'agent','a-project')
  const old=prepareScopedBusinessSkills(f.directory,binding)
  f.library.importMarkdown({revision:f.library.catalog().revision,skillId:skill.id,contents:markdown('sample','当前版本')});f.assign(f.library.catalog().skills.find(s=>s.id===skill.id),'agent','a-project')
  const ownerOptions={access,principal:owner},memberOptions={access,principal:member},guestOptions={access,principal:guest}
  const content=options=>readScopedSkillResource(f.directory,old.snapshotId,'autoops-sample','references/check.md',options).bytes.toString()
  const cached={providers:[{skills:old.skills,workspaceSnapshots:[{cwd:old.physicalCwd,skills:old.skills}]}]}
  assert.equal(content(ownerOptions),'固定参考内容')
  assert.notEqual(resolveBusinessSkillContext(f.directory,{threadId:binding.threadId},ownerOptions).snapshotId,old.snapshotId)
  const fresh=resolveBusinessSkillContext(f.directory,{...binding,threadId:undefined},memberOptions)
  assert.notEqual(fresh.snapshotId,old.snapshotId)
  assert.match(readScopedSkillResource(f.directory,fresh.snapshotId,'autoops-sample','SKILL.md',memberOptions).bytes.toString(),/当前版本/)
  assert.equal(filterBusinessProviderResult(f.directory,cached,memberOptions).providers[0].workspaceSnapshots.length,visibility==='project'?1:0)
  if(visibility==='project') {
   assert.equal(content(memberOptions),'固定参考内容')
   assert.equal(content({...memberOptions,threadId:binding.threadId}),'固定参考内容')
   assert.equal(authorizeBusinessSkillCwd(f.directory,old.cwd,memberOptions),old.physicalCwd)
  }else {
   assert.throws(()=>content(memberOptions),{code:'SKILL_SCOPE_FORBIDDEN'})
   assert.throws(()=>content({...memberOptions,threadId:binding.threadId}),{code:'THREAD_NOT_FOUND'})
   assert.throws(()=>resolveBusinessSkillContext(f.directory,{threadId:binding.threadId},memberOptions),{code:'THREAD_NOT_FOUND'})
   assert.throws(()=>authorizeBusinessSkillCwd(f.directory,old.cwd,memberOptions),{code:'SKILL_SCOPE_FORBIDDEN'})
  }
  assert.throws(()=>content(guestOptions),{code:'WORKSPACE_FORBIDDEN'})
  assert.deepEqual(filterBusinessProviderResult(f.directory,cached,guestOptions).providers[0].workspaceSnapshots,[])
 }
})
test('停用只拒绝该技能调用和资源读取，普通对话不受影响且历史目录保留',t=>{
 const f=fixture(t),skill=f.importSkill();f.assign(skill);const c=prepareScopedBusinessSkills(f.directory,f.binding)
 f.library.setEnabled({revision:f.library.catalog().revision,skillId:skill.id,enabled:false})
 assert.deepEqual(resolveBusinessSkillMentions('普通后续消息',f.env,f.binding),[])
 assert.throws(()=>resolveBusinessSkillMentions('$autoops-sample',f.env,f.binding),{code:'SKILL_NOT_AVAILABLE'})
 assert.deepEqual(scopedBusinessSkillPolicy(f.directory,f.binding).resources,[])
 assert.throws(()=>readScopedSkillResource(f.directory,c.snapshotId,'autoops-sample','references/check.md',{access:f.access,principal:f.principal}),e=>e.code==='SKILL_SCOPE_FORBIDDEN')
 assert.match(readFileSync(c.skills[0].path,'utf8'),/references/)
 assert.deepEqual(prepareScopedBusinessSkills(f.directory,{...f.binding,threadId:'new'}).skills,[])
})
test('旧对话部分技能撤回后仅移除对应候选，其余技能继续选择和执行',t=>{
 const f=fixture(t),kept=f.importSkill('kept'),removed=f.importSkill('removed')
 f.assign(kept);f.assign(removed)
 const context=prepareScopedBusinessSkills(f.directory,f.binding),options={access:f.access,principal:f.principal}
 assert.equal(resolveBusinessSkillContext(f.directory,{threadId:f.binding.threadId},options).skills.length,2)
 const manifest=join(context.physicalCwd,'snapshot.json'),before=readFileSync(manifest,'utf8')
 f.library.setEnabled({revision:f.library.catalog().revision,skillId:removed.id,enabled:false})
 const continued=resolveBusinessSkillContext(f.directory,{threadId:f.binding.threadId},options)
 assert.deepEqual(continued.skills.map(skill=>skill.name),['autoops-kept'])
 assert.equal(resolveBusinessSkillMentions('$autoops-kept',f.env,f.binding).length,1)
 assert.throws(()=>resolveBusinessSkillMentions('$autoops-removed',f.env,f.binding),{code:'SKILL_NOT_AVAILABLE'})
 const policy=scopedBusinessSkillPolicy(f.directory,f.binding)
 assert.equal(policy.context.snapshotId,continued.snapshotId)
 assert.match(readScopedSkillResourceForThread(f.directory,f.binding.threadId,policy.resources[0].instructionsPath,f.access).content,/name: autoops-kept/)
 assert.throws(()=>authorizeBusinessSkillCwd(f.directory,context.cwd,options),{code:'SKILL_CONTEXT_STALE'})
 const fresh=resolveBusinessSkillContext(f.directory,{...f.binding,threadId:undefined},options)
 assert.deepEqual(fresh.skills.map(skill=>skill.name),['autoops-kept'])
 assert.equal(fresh.snapshotId,continued.snapshotId)
 assert.equal(authorizeBusinessSkillCwd(f.directory,continued.cwd,options),policy.context.physicalCwd)
 assert.notEqual(fresh.snapshotId,context.snapshotId)
 assert.equal(readFileSync(manifest,'utf8'),before)
 f.library.setEnabled({revision:f.library.catalog().revision,skillId:removed.id,enabled:true})
 assert.equal(resolveBusinessSkillContext(f.directory,{threadId:f.binding.threadId},options).snapshotId,context.snapshotId)
})
test('完整只读包可按固定版本读取参考资料；禁止跨会话范围和路径穿越',t=>{
 const f=fixture(t),skill=f.importSkill();f.assign(skill);const c=prepareScopedBusinessSkills(f.directory,f.binding)
 const root=`autoops/skills/${c.snapshotId}/autoops-sample`
 const listing=readScopedSkillResourceForThread(f.directory,f.binding.threadId,root,f.access)
 assert.equal(listing.kind,'directory');assert.ok(listing.entries.some(entry=>entry.name==='references'&&entry.kind==='directory'))
 const nested=readScopedSkillResourceForThread(f.directory,f.binding.threadId,root+'/references',f.access)
 assert.equal(nested.entries[0].path,root+'/references/check.md')
 const resource=readScopedSkillResourceForThread(f.directory,f.binding.threadId,nested.entries[0].path,f.access)
 assert.equal(resource.content,'固定参考内容');assert.match(resource.sourceUrl,/contexts\/[a-f0-9]+\/files\/autoops-sample/)
 const other={...f.binding,threadId:'other',agentId:'a-other'};f.bindings.set(other.threadId,other);prepareScopedBusinessSkills(f.directory,other)
 assert.throws(()=>readScopedSkillResourceForThread(f.directory,'other',`autoops/skills/${c.snapshotId}/autoops-sample/references/check.md`,f.access))
 for(const path of ['../SKILL.md','/etc/passwd','references/../../outside'])assert.throws(()=>readScopedSkillResource(f.directory,c.snapshotId,'autoops-sample',path,{access:f.access,principal:f.principal}))
 const runtime=join(c.skills[0].packageRoot,'references/check.md');chmodSync(runtime,0o600);writeFileSync(runtime,'修改内容')
 assert.throws(()=>prepareScopedBusinessSkills(f.directory,f.binding),e=>e.code==='SKILL_PACKAGE_CHANGED')
})
test('授权context只暴露可用范围，provider全局缓存按每个订阅用户再次过滤',t=>{
 const f=fixture(t),skill=f.importSkill();f.assign(skill);const context=resolveBusinessSkillContext(f.directory,f.binding,{access:f.access,principal:f.principal}),c=prepareScopedBusinessSkills(f.directory,f.binding)
 assert.equal(authorizeBusinessSkillCwd(f.directory,context.cwd,{access:f.access,principal:f.principal}),c.physicalCwd)
 assert.throws(()=>authorizeBusinessSkillCwd(f.directory,'/etc',{access:f.access,principal:f.principal}))
 const value={type:'snapshot',config:{providers:[{skills:c.skills,workspaceSnapshots:[{cwd:c.physicalCwd,skills:c.skills}]}]}}
 const own=filterBusinessProviderResult(f.directory,value,{access:f.access,principal:f.principal})
 assert.deepEqual(own.config.providers[0].skills,[]);assert.equal(own.config.providers[0].workspaceSnapshots[0].cwd,context.cwd);assert.match(own.config.providers[0].workspaceSnapshots[0].skills[0].path,/skill-library\/contexts/)
 const denied={...f.access,bootstrap:()=>({projects:[]})},other=filterBusinessProviderResult(f.directory,value,{access:denied,principal:f.principal})
 assert.deepEqual(other.config.providers[0].workspaceSnapshots,[])
 const policy=scopedBusinessSkillPolicy(f.directory,f.binding).config
 assert.equal(policy['permissions.agent_demo.filesystem'][':root'],'deny');assert.equal(policy['permissions.agent_demo.filesystem'][c.skills[0].packageRoot],'read');assert.equal(Object.keys(policy['permissions.agent_demo.filesystem']).length,2)
})
test('脚本/依赖技能保留在仓库但不进入可调用目录',t=>{
 const f=fixture(t),skill=f.importSkill('scripted',undefined,{'scripts/check.py':'print(1)'})
 assert.equal(skill.versions.at(-1).readiness,'restricted');assert.throws(()=>f.assign(skill),error=>error.code==='SKILL_NOT_READY')
 assert.deepEqual(prepareScopedBusinessSkills(f.directory,f.binding).skills,[])
 assert.throws(()=>resolveBusinessSkillMentions('$autoops-scripted',f.env,f.binding),e=>e.code==='SKILL_NOT_AVAILABLE')
})

test('平台技能投影不覆盖客户本机目录，平台仍只输出授权快照',t=>{
 const f=fixture(t),skill=f.importSkill();f.assign(skill);const c=prepareScopedBusinessSkills(f.directory,f.binding)
 const customer={instanceId:'customer-owned-codex',skills:[{name:'local-check',path:'autoops-customer-skill:opaque',enabled:true}],workspaceSnapshots:[{cwd:'customer-local',skills:[{name:'local-check',path:'autoops-customer-skill:opaque',enabled:true}]}]}
 const platform={instanceId:'codex',skills:c.skills,workspaceSnapshots:[{cwd:c.physicalCwd,skills:c.skills}]}
 const projected=filterBusinessProviderResult(f.directory,{config:{providers:[platform,customer]}},{access:f.access,principal:f.principal}).config.providers
 assert.deepEqual(projected[1],customer)
 assert.deepEqual(projected[0].skills,[])
 assert.match(projected[0].workspaceSnapshots[0].cwd,/^autoops\/skill-context\//)
 assert.match(projected[0].workspaceSnapshots[0].skills[0].path,/skill-library\/contexts/)
})


test('技能运行上下文提供可直接读取的正文路径，正文与参考资料固定同一授权版本',t=>{
 const f=fixture(t),skill=f.importSkill('sample','先读取 SKILL.md，再读取 references/check.md。');f.assign(skill)
 const policy=scopedBusinessSkillPolicy(f.directory,f.binding)
 const resource=policy.resources[0]
 assert.equal(resource.name,'autoops-sample')
 assert.equal(resource.versionId,policy.context.skills[0].versionId)
 const instructions=readScopedSkillResourceForThread(f.directory,f.binding.threadId,resource.instructionsPath,f.access)
 assert.match(instructions.content,/name: autoops-sample/)
 assert.match(instructions.content,/先读取 SKILL.md/)
 assert.equal(instructions.versionId,resource.versionId)
 const listing=readScopedSkillResourceForThread(f.directory,f.binding.threadId,resource.resourcesRoot,f.access)
 assert.equal(listing.kind,'directory')
 const reference=readScopedSkillResourceForThread(f.directory,f.binding.threadId,resource.resourcesRoot+'/references/check.md',f.access)
 assert.equal(reference.content,'固定参考内容')
 assert.equal(reference.versionId,instructions.versionId)
 assert.throws(()=>readScopedSkillResourceForThread(f.directory,f.binding.threadId,policy.context.skills[0].path,f.access))
 assert.equal(policy.config['features.shell_tool'],undefined)
 assert.equal(policy.config['permissions.agent_demo.filesystem'][':root'],'deny')
})
