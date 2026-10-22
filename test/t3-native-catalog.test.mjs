import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fixedNativeModelCatalog,prepareBusinessNativePolicy,assertBusinessNativeConfig} from '../agent-demo/t3-adapters/native-catalog.mjs'
import {prepareScopedBusinessSkills} from '../agent-demo/t3-adapters/scoped-skills.mjs'
import {readBusinessSkills,filterBusinessSkills,prepareBusinessSkills,businessSkillRules,businessSlashCommands} from '../agent-demo/t3-adapters/skills.mjs'

const fixture=t=>{const data=mkdtempSync(join(tmpdir(),'t3-catalog-test-'));t.after(()=>rmSync(data,{recursive:true,force:true}));mkdirSync(join(data,'t3'));return {data,home:join(data,'t3/codex-home'),registry:join(data,'t3/skills-registry.json')}}
const skill={name:'inspect-release',description:'检查已授权资料',instructions:'使用 read_project_document 读取资料并注明来源。',tools:['read_project_document']}
test('空注册表真实返回空技能，不捏造安装；独立 T3 元数据保留',t=>{
  const {data,home,registry}=fixture(t);writeFileSync(registry,JSON.stringify({version:1,skills:[]}));assert.deepEqual(readBusinessSkills(data),[]);assert.deepEqual(prepareBusinessSkills(data,home),[])
  const native=[{name:'other',path:'/tmp/other/SKILL.md',enabled:true}]
  assert.deepEqual(filterBusinessSkills(native,{AUTOOPS_T3_DATA_DIR:data}),[])
  assert.strictEqual(filterBusinessSkills(native,{}),native)
  assert.deepEqual(businessSlashCommands([{name:'compact'},{name:'feedback'},{name:'goal'}],{AUTOOPS_T3_DATA_DIR:data}),[{name:'compact'}])
})
test('管理员技能仅安装到授权scope；元数据严格原生交集且拒绝写工具',t=>{
  const {data,home,registry}=fixture(t);writeFileSync(registry,JSON.stringify({version:1,skills:[skill]}))
  assert.deepEqual(prepareBusinessSkills(data,home),[])
  const context=prepareScopedBusinessSkills(data,{threadId:'test-thread',projectId:'p-autoops',agentId:'a-project',workspaceType:'internal'})
  const generated=context.skills;assert.equal(generated.length,1)
  assert.match(readFileSync(generated[0].path,'utf8'),/name: autoops-inspect-release/)
  const entries=[generated[0],{...generated[0],path:'/other/SKILL.md'},{...generated[0],enabled:false}]
  assert.deepEqual(filterBusinessSkills(entries,{AUTOOPS_T3_DATA_DIR:data,AUTOOPS_T3_CODEX_HOME:home},context.physicalCwd),[generated[0]])
  writeFileSync(registry,JSON.stringify({version:1,skills:[{...skill,tools:['delete_file']}]}))
  assert.throws(()=>readBusinessSkills(data),/工具/)
})
test('非注册宿主技能实际 disabled，全局目录无任何启用技能；符号链接根拒绝',t=>{
  const {data,home,registry}=fixture(t);writeFileSync(registry,JSON.stringify({version:1,skills:[skill]}));prepareBusinessSkills(data,home)
  const outside=join(data,'outside');mkdirSync(outside);writeFileSync(join(outside,'SKILL.md'),'outside')
  const rules=businessSkillRules(data,home,{userHome:data,extraRoots:[outside]})
  assert.ok(rules.some(rule=>rule.path===realpathSync(join(outside,'SKILL.md'))&&!rule.enabled));assert.ok(rules.every(rule=>!rule.enabled))
  rmSync(join(home,'skills'),{recursive:true});symlinkSync(outside,join(home,'skills'))
  assert.throws(()=>prepareBusinessSkills(data,home),/符号链接/)
})
test('原生模型目录仅固定模型且不虚构 CPA 容量；全部内置 role 固定相同模型',t=>{
  const {data,home}=fixture(t);const {policy}=prepareBusinessNativePolicy(data,home,'grok-4.6')
  const catalog=JSON.parse(readFileSync(policy.model_catalog_json,'utf8'))
  assert.deepEqual(catalog.models.map(model=>model.slug),['grok-4.6'])
  assert.equal(catalog.models[0].context_window,null)
  for(const role of ['default','explorer','worker'])assert.match(readFileSync(policy[`agents.${role}`].config_file,'utf8'),/^model = "grok-4\.6"/)
  assert.equal(policy['agents.default_subagent_model'],'grok-4.6')
  assert.equal(policy['agents.max_depth'],1);assert.equal(policy['agents.max_threads'],2)
  assert.equal(policy['permissions.agent_demo.filesystem'][':root'],'deny')
  assert.throws(()=>fixedNativeModelCatalog('grok\nother'),/模型/)
})
test('有效原生配置验证拒绝遗留自定义角色、替换 catalog 及角色文件修改',t=>{
  const {data,home}=fixture(t),{policy}=prepareBusinessNativePolicy(data,home,'grok-4.6')
  const response={config:{permissions:{agent_demo:{filesystem:{':root':'deny'}}},features:{multi_agent:true},model:'grok-4.6',model_catalog_json:policy.model_catalog_json,agents:{enabled:true,max_depth:1,default_subagent_model:'grok-4.6',...Object.fromEntries(['default','explorer','worker'].map(role=>[role,policy[`agents.${role}`]]))}}}
  const env={AUTOOPS_T3_DATA_DIR:data,AUTOOPS_T3_MODEL:'grok-4.6'}
  assert.doesNotThrow(()=>assertBusinessNativeConfig(response,env))
  assert.throws(()=>assertBusinessNativeConfig({config:{...response.config,permissions:{agent_demo:{filesystem:{':root':'deny','/other':'read'}}}}},env),/全局文件权限/)
  assert.throws(()=>assertBusinessNativeConfig({config:{...response.config,agents:{...response.config.agents,rogue:{config_file:'/outside'}}}},env),/未注册/)
  assert.throws(()=>assertBusinessNativeConfig({config:{...response.config,model_catalog_json:'/outside'}},env),/固定目录/)
  writeFileSync(policy['agents.default'].config_file,'model="other"')
  assert.throws(()=>assertBusinessNativeConfig(response,env),/已改变/)
})
