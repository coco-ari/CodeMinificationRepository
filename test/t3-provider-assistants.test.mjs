import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createAssistantDirectory,questionConfigurationPolicy} from '../agent-demo/t3-adapters/assistants/index.ts'
import {createCustomerRegistry} from '../agent-demo/t3-adapters/customer-registry.mjs'
import {openDatabase} from '../autoops/server/platform/database.ts'
import {migrations} from '../agent-demo/t3-adapters/assistants/schema.ts'

function fixture(t) {
  const dataDir=mkdtempSync(join(tmpdir(),'provider-assistant-')),db=new DatabaseSync(':memory:')
  const users=new Map(['provider','manager','recipient','outsider'].map(id=>[id,{id,active:true}]))
  const memberships=new Map(['provider','manager','recipient'].map(userId=>[userId,{userId,role:userId==='recipient'?'reader':'project_admin',status:'active',workspaceAccess:'internal',environmentIds:[],canAdjustChat:userId!=='recipient'}]))
  const owner=actor=>{if(!users.get(actor)?.active)throw Object.assign(new Error('账号不可用'),{status:403,code:'ACTOR_FORBIDDEN'})}
  const membership=(actor,project)=>{owner(actor);if(!['project','other-project'].includes(project)||!memberships.has(actor))throw Object.assign(new Error('无项目权限'),{status:403,code:'PROJECT_FORBIDDEN'});return memberships.get(actor)}
  const registry=createCustomerRegistry({db,enabled:()=>true,requireOwner:owner,requireProjectForUser:membership})
  const pair=registry.createPairing('provider'),device=registry.consumePairing(pair.pairingCode,{label:'提供者电脑'})
  const principal=registry.authenticateToken(device.deviceToken)
  const target={kind:'customer',deviceId:device.device.id,registeredWorkspaceId:'fixed-provider-workspace',workspaceBindingRevision:1,runtimeId:'codex'}
  registry.registerWorkspace(principal,{registeredWorkspaceId:target.registeredWorkspaceId,projectId:'project',label:'已登记目录',workspaceBindingRevision:1,runtimeId:'codex'})
  registry.markConnected(principal)
  registry.updateCapabilities(principal,{registeredWorkspaceId:target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex',revision:'actual-capabilities',protocolVersion:1,assistantConfiguration:true,models:[{id:'provider-real-model',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'low'}],skills:[{id:'provider-skill',name:'真实本机技能',description:''}]})
  const policy=questionConfigurationPolicy({projects:()=>[{id:'project',environments:[]},{id:'other-project',environments:[]}],agents:()=>[{id:'a-project',projectIds:['project','other-project']}],customers:()=>registry,models:()=>{throw new Error('不能读取平台模型')},skills:()=>[]})
  let directory
  const options={dataDir,membership,manage(actor,project){if(membership(actor,project).role!=='project_admin')throw Object.assign(new Error('不能管理项目'),{status:403,code:'PROJECT_MANAGE_FORBIDDEN'})},validate:policy,validateTarget(project,target){membership(target.kind==='member'?target.id:'recipient',project)},providers:{registry:()=>registry,displayName:actor=>users.get(actor)?.id??'提供者'}}
  const open=()=>directory=createAssistantDirectory(options)
  open()
  t.after(()=>{directory.close();db.close();rmSync(dataDir,{recursive:true,force:true})})
  return {dataDir,options,registry,target,devicePrincipal:principal,users,memberships,bindings:db,open,get directory(){return directory},value:{name:'提供者助手',description:'',instructions:'按实际运行能力回答',enabled:true,configuration:{agentId:'a-project',executionBinding:target,environmentId:null,workspaceType:null,visibility:'private',model:{instanceId:`customer-${device.device.id}-codex`,model:'provider-real-model',reasoningEffort:'high'},skillIds:['provider-skill']}}}
}
const save=(requestId,value,expectedRevision=0)=>({requestId,expectedRevision,value})
const allocation=(id,requestId='allocate-without-share')=>({requestId,expectedRevision:0,target:{kind:'member',id:'recipient'},assistantIds:[id],defaultAssistantId:null})

test('管理员不能把提供者未共享的电脑助手分配给其他成员',t=>{
  const f=fixture(t)
  const preset=f.directory.save('provider','project',null,save('original-provider-preset',f.value))
  assert.throws(()=>f.directory.assign('manager','project',allocation(preset.id)),{code:'ASSISTANT_PROVIDER_SHARE_REQUIRED'})
  assert.throws(()=>f.directory.save('manager','project',preset.id,save('manager-disable-provider',{...f.value,enabled:false},1)),{code:'ASSISTANT_PROVIDER_MANAGEMENT_REQUIRED'})
  assert.throws(()=>f.directory.save('manager','project',null,save('manager-forge-provider',{...f.value,enabled:false})),{code:'CUSTOMER_DEVICE_NOT_FOUND'})
})

test('普通提供者维护本人助手并保留真实能力，私有助手不对项目管理员自动公开',t=>{
  const f=fixture(t)
  f.memberships.get('provider').role='reader'
  f.memberships.get('provider').canAdjustChat=false
  const preset=f.directory.saveProvided('provider',null,save('self-create',f.value))
  assert.equal(preset.providedBy.id,'provider')
  assert.equal(preset.providedBy.sourceProjectId,'project')
  assert.deepEqual(preset.configuration,f.value.configuration)
  assert.equal(f.directory.providedSettings('provider').items[0].preset.id,preset.id)
  assert.equal(f.directory.providedSettings('provider').sources[0].capabilities.models[0].id,'provider-real-model')
  assert.deepEqual(f.directory.providedForProject('manager','project').items,[])
  assert(!f.directory.settings('manager','project').presets.some(value=>value.id===preset.id))
  assert.throws(()=>f.directory.saveProvided('manager',preset.id,save('forged-owner',f.value,1)),{code:'ASSISTANT_PROVIDER_NOT_FOUND'})
  assert.throws(()=>f.directory.saveProvided('provider',preset.id,save('changed-binding',{...f.value,configuration:{...f.value.configuration,executionBinding:{...f.target,workspaceBindingRevision:2}}},1)),{code:'ASSISTANT_SOURCE_FIXED'})
})

test('提供者主动跨项目共享保留登记归属，只在获准目标项目可分配且执行仍关闭',t=>{
  const f=fixture(t),preset=f.directory.saveProvided('provider',null,save('own',f.value))
  const input={requestId:'share-target-project',expectedRevision:0,enabled:true}
  const share=f.directory.shareProvided('provider',preset.id,'other-project',input)
  assert.equal(share.projectId,'other-project')
  assert.equal(share.revision,1)
  assert.equal(f.registry.listWorkspaces('provider')[0].projectId,'project')
  const shared=f.directory.providedForProject('manager','other-project').items[0]
  assert.equal(shared.preset.providedBy.sourceProjectId,'project')
  assert.deepEqual(shared.preset.configuration.executionBinding,f.target)
  assert.equal(shared.available,false)
  assert.equal(shared.reason.code,'CUSTOMER_SHARED_ISOLATION_UNVERIFIED')
  const assigned=f.directory.assign('manager','other-project',allocation(preset.id,'assigned-shared'))
  assert.equal(assigned.assistantIds[0],preset.id)
  const catalog=f.directory.catalog('recipient','other-project')
  assert.equal(catalog.items[0].available,false)
  assert.equal(catalog.items[0].reason.code,'CUSTOMER_SHARED_ISOLATION_UNVERIFIED')
  assert.throws(()=>f.directory.shareProvided('manager',preset.id,'other-project',{requestId:'admin-cannot-share',expectedRevision:1,enabled:false}),{code:'ASSISTANT_PROVIDER_NOT_FOUND'})
  assert.throws(()=>f.directory.shareProvided('provider',preset.id,'invisible-project',{requestId:'hidden-project',expectedRevision:0,enabled:true}),{code:'PROJECT_FORBIDDEN'})
})

test('共享与分配原收据跨重启恢复，撤回不生成替代身份且旧分配不恢复运行资格',t=>{
  const f=fixture(t),preset=f.directory.saveProvided('provider',null,save('own',f.value))
  const input={requestId:'share',expectedRevision:0,enabled:true}
  const share=f.directory.shareProvided('provider',preset.id,'other-project',input)
  const command=allocation(preset.id,'assigned-original')
  const accepted=f.directory.assign('manager','other-project',command)
  f.directory.close();f.open()
  assert.deepEqual(f.directory.shareProvided('provider',preset.id,'other-project',input),share)
  assert.throws(()=>f.directory.shareProvided('provider',preset.id,'other-project',{...input,enabled:false}),{code:'ASSISTANT_REQUEST_CONFLICT'})
  assert.throws(()=>f.directory.shareProvided('provider',preset.id,'other-project',{requestId:'stale-revoke',expectedRevision:0,enabled:false}),{code:'ASSISTANT_REVISION_CONFLICT'})
  const revoked=f.directory.shareProvided('provider',preset.id,'other-project',{requestId:'withdraw',expectedRevision:1,enabled:false})
  assert.equal(revoked.revision,2)
  assert.equal(revoked.enabled,false)
  assert.deepEqual(f.directory.assign('manager','other-project',command),accepted)
  assert.throws(()=>f.directory.assign('manager','other-project',{...command,requestId:'new-after-withdraw',expectedRevision:1}),{code:'ASSISTANT_PROVIDER_SHARE_REQUIRED'})
  assert.equal(f.directory.catalog('recipient','other-project').ready,false)
  assert.deepEqual(f.directory.providedForProject('manager','other-project').items,[])
  assert.deepEqual(f.registry.listWorkspaces('provider').map(value=>({id:value.registeredWorkspaceId,project:value.projectId})),[{id:f.target.registeredWorkspaceId,project:'project'}])
})

test('提供者编辑低权限本人已分配预设必须由管理员再确认，新参数不继承旧分配',t=>{
  const f=fixture(t)
  f.memberships.get('provider').role='reader'
  f.memberships.get('provider').canAdjustChat=false
  const preset=f.directory.saveProvided('provider',null,save('own',f.value))
  const original={requestId:'self-allocation',expectedRevision:0,target:{kind:'member',id:'provider'},assistantIds:[preset.id],defaultAssistantId:preset.id}
  f.directory.assign('manager','project',original)
  assert.equal(f.directory.catalog('provider','project').ready,true)
  const selection={assistantId:preset.id,presetRevision:preset.revision,configuration:preset.configuration}
  const revised=f.directory.saveProvided('provider',preset.id,save('provider-change',{...f.value,instructions:'提供者更新指令',configuration:{...f.value.configuration,model:{...f.value.configuration.model,reasoningEffort:'low'}}},1))
  const state=f.directory.catalog('provider','project')
  assert.equal(state.ready,false)
  assert.equal(state.items[0].reason.code,'ASSISTANT_PROVIDER_APPROVAL_REQUIRED')
  assert.deepEqual(f.directory.validateSelection('provider','project',selection,true),selection)
  assert.throws(()=>f.directory.validateSelection('provider','project',{assistantId:revised.id,presetRevision:revised.revision,configuration:revised.configuration}),{code:'DEFAULT_ASSISTANT_REQUIRED'})
  f.directory.assign('manager','project',{...original,requestId:'reapprove',expectedRevision:1})
  assert.equal(f.directory.catalog('provider','project').ready,true)
  assert.equal(f.directory.catalog('provider','project').items[0].preset.configuration.model.reasoningEffort,'low')
})

test('共享审计失败原子回滚consent及收据，修复后同请求成功且账号停用仍不能复用收据',t=>{
  const f=fixture(t),preset=f.directory.saveProvided('provider',null,save('own',f.value))
  const db=new DatabaseSync(join(f.dataDir,'assistants','state.sqlite'))
  try {
    db.exec("CREATE TRIGGER reject_share_audit BEFORE INSERT ON assistant_audit BEGIN SELECT RAISE(ABORT,'隔离共享审计失败'); END")
    const input={requestId:'atomic-share',expectedRevision:0,enabled:true}
    assert.throws(()=>f.directory.shareProvided('provider',preset.id,'other-project',input),/隔离共享审计失败/)
    assert.deepEqual(f.directory.providedForProject('manager','other-project').items,[])
    assert.deepEqual(f.directory.providedSettings('provider').items[0].shares,[])
    db.exec('DROP TRIGGER reject_share_audit')
    assert.equal(f.directory.shareProvided('provider',preset.id,'other-project',input).revision,1)
    f.users.get('provider').active=false
    assert.throws(()=>f.directory.shareProvided('provider',preset.id,'other-project',input),{code:'ACTOR_FORBIDDEN'})
  } finally {db.close()}
})

test('既有自用预设按真实device owner映射同一身份，无能力目录时不猜平台模型或创建替代助手',t=>{
  const f=fixture(t)
  const original=f.directory.save('provider','project',null,save('existing-self-preset',f.value))
  const prior=new DatabaseSync(join(f.dataDir,'assistants','state.sqlite'))
  try {prior.prepare('UPDATE assistant_presets SET provider_id=NULL WHERE id=?').run(original.id)} finally {prior.close()}
  const own=f.directory.providedSettings('provider')
  assert.equal(own.items.length,1)
  assert.equal(own.items[0].preset.id,original.id)
  assert.deepEqual(own.items[0].preset.configuration,original.configuration)
  assert.equal(own.sources[0].capabilities.models[0].id,'provider-real-model')
  assert(!JSON.stringify(own).includes('deviceToken'))
  assert(!JSON.stringify(own).includes('tokenHash'))
  const invalid={...f.value,configuration:{...f.value.configuration,model:{...f.value.configuration.model,model:'platform-guessed-model'}}}
  assert.throws(()=>f.directory.saveProvided('provider',null,save('unavailable-model',invalid)),{code:'CUSTOMER_MODEL_UNAVAILABLE'})
  assert.equal(f.directory.providedSettings('provider').items.length,1)
  f.bindings.exec('DELETE FROM customer_capabilities')
  assert.equal(f.directory.providedSettings('provider').sources[0].capabilities,null)
  assert.equal(f.directory.providedSettings('provider').items[0].preset.id,original.id)
  assert.equal(f.directory.catalog('provider','project').ready,false)
})

test('停用预设不暗中撤回已有共享，目标项目删除须等提供者明确撤回且不能跨环境混计',t=>{
  const f=fixture(t),preset=f.directory.saveProvided('provider',null,save('provided',f.value))
  f.directory.shareProvided('provider',preset.id,'other-project',{requestId:'share',expectedRevision:0,enabled:true})
  f.directory.saveProvided('provider',preset.id,save('disable',{...f.value,enabled:false},1))
  assert.equal(f.directory.deletionReferences('other-project').find(value=>value.kind==='assistant-provider-shares').count,1)
  assert.deepEqual(f.directory.deletionReferences('other-project','environment'),[])
  f.directory.shareProvided('provider',preset.id,'other-project',{requestId:'withdraw',expectedRevision:1,enabled:false})
  assert.deepEqual(f.directory.deletionReferences('other-project'),[])
})

test('撤销本人登记或失去目标项目身份后仍能撤回共享，原共享成功收据不再次授权',t=>{
  const f=fixture(t),preset=f.directory.saveProvided('provider',null,save('provided',f.value))
  const input={requestId:'share',expectedRevision:0,enabled:true}
  const accepted=f.directory.shareProvided('provider',preset.id,'other-project',input)
  assert.deepEqual(f.directory.providedReceipt('provider','share'),{requestId:'share',operation:`provider.share:${preset.id}`,projectId:'other-project',payload:input,result:accepted})
  assert.throws(()=>f.directory.providedReceipt('manager','share'),{code:'ASSISTANT_PROVIDER_RECEIPT_NOT_FOUND'})
  const device=f.registry.listDevices('provider')[0]
  f.registry.setDeviceStatus('provider',device.id,'disabled')
  f.memberships.delete('provider')
  assert.throws(()=>f.directory.saveProvided('provider',null,save('new-binding-after-loss',{...f.value,enabled:false})),{code:'PROJECT_FORBIDDEN'})
  assert.equal(f.directory.saveProvided('provider',preset.id,save('disable-existing-after-loss',{...f.value,enabled:false},1)).enabled,false)
  assert.deepEqual(f.directory.shareProvided('provider',preset.id,'other-project',input),accepted)
  assert.equal(f.directory.shareProvided('provider',preset.id,'other-project',{requestId:'withdraw-after-loss',expectedRevision:1,enabled:false}).enabled,false)
  assert.throws(()=>f.directory.shareProvided('provider',preset.id,'other-project',{requestId:'fresh-after-loss',expectedRevision:2,enabled:true}),{code:'PROJECT_FORBIDDEN'})
  assert.deepEqual(f.directory.providedForProject('manager','other-project').items,[])
})

test('真实v1数据库升级保留自用身份和历史分配，但不把无共享记录升级成提供者同意',t=>{
  const f=fixture(t),dataDir=mkdtempSync(join(tmpdir(),'provider-assistant-upgrade-'))
  mkdirSync(join(dataDir,'assistants'))
  const old=openDatabase(join(dataDir,'assistants','state.sqlite'),migrations.slice(0,1)),at='2026-10-26T00:00:00Z'
  old.db.prepare('INSERT INTO assistant_presets VALUES(?,?,?,?,?,?)').run('legacy-self','project',JSON.stringify(f.value),1,'provider',at)
  old.db.prepare('INSERT INTO assistant_versions VALUES(?,?,?,?)').run('legacy-self',1,JSON.stringify(f.value),at)
  old.db.prepare('INSERT INTO assistant_allocations VALUES(?,?,?,?,?,?)').run('project','member','recipient','["legacy-self"]','legacy-self',1)
  old.close()
  const upgraded=createAssistantDirectory({...f.options,dataDir})
  try {
    const own=upgraded.providedSettings('provider')
    assert.equal(own.items[0].preset.id,'legacy-self')
    assert.deepEqual(own.items[0].shares,[])
    assert.deepEqual(own.items[0].preset.configuration,f.value.configuration)
    assert.equal(upgraded.catalog('recipient','project').ready,false)
    assert.throws(()=>upgraded.assign('manager','project',{...allocation('legacy-self'),expectedRevision:1}),{code:'ASSISTANT_PROVIDER_SHARE_REQUIRED'})
  } finally {upgraded.close();rmSync(dataDir,{recursive:true,force:true})}
})

test('真实能力收缩与断线使预设不可用，恢复沿原来源与模型强度，不静默换平台默认',t=>{
  const f=fixture(t),preset=f.directory.saveProvided('provider',null,save('own',f.value))
  const {deviceId:_deviceId,updatedAt:_updatedAt,...capabilities}=f.registry.getCapabilities('provider',f.target)
  f.registry.updateCapabilities(f.devicePrincipal,{...capabilities,revision:'reasoning-reduced',models:[{id:'provider-real-model',supportedReasoningEfforts:['low'],defaultReasoningEffort:'low'}]})
  let state=f.directory.catalog('provider','project')
  assert.equal(state.ready,false)
  assert.equal(state.items[0].reason.code,'CUSTOMER_REASONING_UNAVAILABLE')
  assert.equal(state.items[0].preset.configuration.model.reasoningEffort,'high')
  f.registry.updateCapabilities(f.devicePrincipal,{...capabilities,revision:'capability-restored'})
  const device=f.registry.listDevices('provider')[0]
  f.registry.markDisconnected(device.id,device.connectionEpoch)
  assert.equal(f.directory.providedSettings('provider').sources[0].online,false)
  assert.equal(f.directory.catalog('provider','project').items[0].reason.code,'CUSTOMER_DEVICE_OFFLINE')
  f.registry.markConnected(f.devicePrincipal)
  state=f.directory.catalog('provider','project')
  assert.equal(state.ready,true)
  assert.equal(state.items[0].preset.id,preset.id)
  assert.deepEqual(state.items[0].preset.configuration.model,f.value.configuration.model)
  assert.deepEqual(state.items[0].preset.configuration.executionBinding,f.target)
})

test('批量分配逐项检查提供者同意，后一来源未共享时回滚整项分配并可沿原请求恢复',t=>{
  const f=fixture(t)
  const first=f.directory.saveProvided('provider',null,save('first',f.value))
  const second=f.directory.saveProvided('provider',null,save('second',{...f.value,name:'第二位预设'}))
  f.directory.shareProvided('provider',first.id,'other-project',{requestId:'share-first',expectedRevision:0,enabled:true})
  const input={...allocation(first.id,'batch-original'),assistantIds:[first.id,second.id]}
  assert.throws(()=>f.directory.assign('manager','other-project',input),{code:'ASSISTANT_PROVIDER_SHARE_REQUIRED'})
  assert.deepEqual(f.directory.settings('manager','other-project').allocations,[])
  f.directory.shareProvided('provider',second.id,'other-project',{requestId:'share-second',expectedRevision:0,enabled:true})
  const accepted=f.directory.assign('manager','other-project',input)
  assert.equal(accepted.revision,1)
  assert.deepEqual(accepted.assistantIds,[first.id,second.id])
  assert.deepEqual(f.directory.assign('manager','other-project',input),accepted)
})
