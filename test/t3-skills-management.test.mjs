import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,existsSync,rmSync,writeFileSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readBusinessSkillRegistry,readBusinessSkills,businessSkillsRevision,manageBusinessSkills,prepareBusinessSkills,resolveBusinessSkillMentions,filterBusinessSkills} from '../agent-demo/t3-adapters/skills.mjs'
import {refreshBusinessSkillLaunchArgs} from '../agent-demo/t3-adapters/native-catalog.mjs'
import {authorizeAutoOpsRpc} from '../agent-demo/t3-adapters/rpc-policy.mjs'

function fixture(t) {
  const data=mkdtempSync(join(tmpdir(),'autoops-skills-')),home=join(data,'t3/codex-home')
  t.after(()=>rmSync(data,{recursive:true,force:true}))
  const principal={role:'admin'},access={refresh:current=>current}
  return {data,home,access,principal,env:{AUTOOPS_T3_DATA_DIR:data,AUTOOPS_T3_CODEX_HOME:home,AUTOOPS_T3_MODEL:'grok-4.6',AUTOOPS_DEMO_PROFILE:'project-assistant-lite-v1'}}
}
test('首次启动安装真实内置技能，管理员显式空目录不会被覆盖',t=>{
  const f=fixture(t),skills=prepareBusinessSkills(f.data,f.home)
  assert.equal(skills.length,3)
  for(const skill of skills)assert.match(readFileSync(skill.path,'utf8'),/^---\nname: autoops-[a-z-]+\ndescription: /)
  const native=filterBusinessSkills(skills,f.env)
  assert.deepEqual(native.map(skill=>skill.displayName),['项目资料解读','环境健康检查','发布准备报告'])
  writeFileSync(join(f.data,'t3/skills-registry.json'),JSON.stringify({version:1,skills:[]}))
  assert.deepEqual(prepareBusinessSkills(f.data,f.home),[])
  for(const skill of skills)assert.equal(existsSync(skill.path),false)
})
test('导入、调用、停用、重启读取与再次启用闭环，原有内容不丢失',t=>{
  const f=fixture(t),initial=readBusinessSkillRegistry(f.data)
  const skill={name:'review-test',displayName:'自定义检查',description:'检查资料',instructions:'只读取当前项目并引用来源。',tools:['read_project_document']}
  const saved=manageBusinessSkills(f.data,f.home,f.access,f.principal,{action:'import',revision:businessSkillsRevision(initial),skill})
  assert.equal(saved.skills.length,4)
  const mention=resolveBusinessSkillMentions('请使用 $autoops-review-test 完成检查',f.env)
  assert.deepEqual(mention,[{type:'skill',name:'autoops-review-test',path:join(f.home,'skills/autoops-review-test/SKILL.md')}])
  assert.match(readFileSync(mention[0].path,'utf8'),/只读取当前项目/)
  const disabled=manageBusinessSkills(f.data,f.home,f.access,f.principal,{action:'toggle',revision:businessSkillsRevision(saved),name:'autoops-review-test',enabled:false})
  assert.throws(()=>resolveBusinessSkillMentions('$autoops-review-test 请检查',f.env),error=>error.code==='SKILL_NOT_AVAILABLE')
  assert.equal(readBusinessSkillRegistry(f.data).skills.find(entry=>entry.name===skill.name).instructions,skill.instructions)
  assert.equal(existsSync(mention[0].path),false)
  manageBusinessSkills(f.data,f.home,f.access,f.principal,{action:'toggle',revision:businessSkillsRevision(disabled),name:'autoops-review-test',enabled:true})
  assert.equal(resolveBusinessSkillMentions('$autoops-review-test 请检查',f.env).length,1)
})
test('成员无管理权，过期修订与重复导入均不覆盖目录',t=>{
  const f=fixture(t),before=readBusinessSkillRegistry(f.data),revision=businessSkillsRevision(before)
  assert.throws(()=>manageBusinessSkills(f.data,f.home,f.access,{role:'viewer'},{action:'toggle',revision,name:'autoops-project-brief',enabled:false}),error=>error.status===403)
  assert.throws(()=>manageBusinessSkills(f.data,f.home,f.access,f.principal,{action:'toggle',revision:'old',name:'autoops-project-brief',enabled:false}),error=>error.code==='SKILL_REVISION_CONFLICT')
  assert.throws(()=>manageBusinessSkills(f.data,f.home,f.access,f.principal,{action:'import',revision,skill:before.skills[0]}),error=>error.code==='SKILL_ALREADY_EXISTS')
  assert.deepEqual(readBusinessSkillRegistry(f.data),before)
})
test('不接受越界工具或目录路径，保存失败恢复原目录',t=>{
  const f=fixture(t),before=readBusinessSkillRegistry(f.data),revision=businessSkillsRevision(before)
  for(const skill of [
    {name:'../../outside',description:'x',instructions:'x',tools:['read_project_document']},
    {name:'unsafe',description:'x',instructions:'x',tools:['shell']},
  ])assert.throws(()=>manageBusinessSkills(f.data,f.home,f.access,f.principal,{action:'import',revision,skill}))
  assert.deepEqual(readBusinessSkillRegistry(f.data),before)
})
test('新探测进程使用最新启用目录，普通 T3 参数保持不变',t=>{
  const f=fixture(t),before=refreshBusinessSkillLaunchArgs('--strict-config',f.env)
  const registry=readBusinessSkillRegistry(f.data)
  for(const skill of registry.skills)manageBusinessSkills(f.data,f.home,f.access,f.principal,{action:'toggle',revision:businessSkillsRevision(readBusinessSkillRegistry(f.data)),name:skill.name,enabled:false})
  const after=refreshBusinessSkillLaunchArgs('--strict-config',f.env)
  assert.notEqual(before,after);assert.match(after,/skills.include_instructions=false/)
  assert.equal(readBusinessSkills(f.data).length,0)
  assert.equal(refreshBusinessSkillLaunchArgs('--strict-config',{}),'--strict-config')
})
test('技能快照只允许刷新账号已授权的固定项目目录',t=>{
  const f=fixture(t),old=process.env.AUTOOPS_T3_DATA_DIR
  process.env.AUTOOPS_T3_DATA_DIR=f.data
  const access={refresh:current=>current,bootstrap:()=>({projects:[{id:'p-autoops'}]})}
  try {
    assert.doesNotThrow(()=>authorizeAutoOpsRpc(access,f.principal,'server.refreshProviders',{instanceId:'codex',cwd:join(f.data,'t3/workspaces/p-autoops'),fresh:true}))
    for(const payload of [{instanceId:'claude'}, {cwd:'/etc'}, {cwd:join(f.data,'t3/workspaces/p-cabinet')}, {refreshModels:true}, {fresh:'yes'}])assert.throws(()=>authorizeAutoOpsRpc(access,f.principal,'server.refreshProviders',payload),error=>error.status===403)
  } finally { if(old===undefined)delete process.env.AUTOOPS_T3_DATA_DIR;else process.env.AUTOOPS_T3_DATA_DIR=old }
})
