import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createCustomerRegistry, normalizeExecutionBinding } from './customer-registry.mjs'

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  let time = 1000, enabled = true
  const registry = createCustomerRegistry({db,now:()=>time,enabled:()=>enabled,
    requireOwner(owner) { if (!['owner','other'].includes(owner)) throw {status:401,code:'OWNER_INACTIVE'} },
    requireProjectForUser(owner,project) { if (project !== 'project' || owner !== 'owner') throw {status:404,code:'PROJECT_NOT_FOUND'} },
  })
  const pair = () => registry.consumePairing(registry.createPairing('owner').pairingCode,{label:'客户电脑',platform:'win32'})
  const register = (paired = pair(), workspaceId = 'workspace-1') => {
    const principal = registry.authenticateToken(paired.deviceToken)
    const workspace = registry.registerWorkspace(principal,{registeredWorkspaceId:workspaceId,projectId:'project',label:'前后端项目',workspaceBindingRevision:1,runtimeId:'codex'})
    return {...paired,principal,workspace,target:{kind:'customer',deviceId:paired.device.id,registeredWorkspaceId:workspaceId,workspaceBindingRevision:1,runtimeId:'codex'}}
  }
  return {db,registry,pair,register,time:(value)=>{time=value},disable:()=>{enabled=false}}
}

test('pairing codes are short-lived, one-time, owner-bound; only hashes persist', t => {
  const {db,registry,time} = fixture(t), pairing = registry.createPairing('owner',{label:'指定名称'})
  const result = registry.consumePairing(pairing.pairingCode,{label:'本机名称'})
  assert.equal(result.device.ownerId,'owner'); assert.equal(result.device.label,'指定名称')
  assert.throws(()=>registry.consumePairing(pairing.pairingCode,{label:'重复'}),{code:'CUSTOMER_PAIRING_INVALID'})
  const serialized = JSON.stringify(db.prepare('SELECT * FROM customer_devices').all()) + JSON.stringify(db.prepare('SELECT * FROM customer_pairings').all())
  assert.equal(serialized.includes(pairing.pairingCode),false); assert.equal(serialized.includes(result.deviceToken),false)
  assert.equal(JSON.stringify(registry.listDevices('owner')).includes('token'),false)
  const expired = registry.createPairing('owner'); time(700_000)
  assert.throws(()=>registry.consumePairing(expired.pairingCode,{label:'过期'}),{code:'CUSTOMER_PAIRING_INVALID'})
  assert.throws(()=>registry.authenticateToken('invalid'),{code:'CUSTOMER_DEVICE_UNAUTHENTICATED'})
})

test('directory registrations accept metadata only, stay owner/project-bound and never replace roots', t => {
  const {registry,register,pair} = fixture(t), entry = register()
  assert.throws(()=>registry.registerWorkspace(entry.principal,{...entry.workspace,cwd:'/tmp/private'}),{code:'INVALID_CUSTOMER_METADATA'})
  assert.throws(()=>normalizeExecutionBinding({...entry.target,registeredWorkspaceId:'C:\\Projects\\x'}),{code:'INVALID_CUSTOMER_ID'})
  assert.throws(()=>registry.registerWorkspace(entry.principal,{registeredWorkspaceId:'other',projectId:'other-project',label:'x',workspaceBindingRevision:1,runtimeId:'codex'}),{code:'PROJECT_NOT_FOUND'})
  assert.throws(()=>registry.registerWorkspace(entry.principal,{registeredWorkspaceId:'workspace-1',projectId:'project',label:'x',workspaceBindingRevision:2,runtimeId:'codex'}),{code:'CUSTOMER_WORKSPACE_BINDING_CHANGED'})
  assert.throws(()=>registry.validateTarget('other','project',entry.target),{code:'PROJECT_NOT_FOUND'})
  const otherDevice = pair(), otherPrincipal = registry.authenticateToken(otherDevice.deviceToken)
  assert.throws(()=>registry.revokeWorkspace(otherPrincipal,'workspace-1'),{code:'CUSTOMER_WORKSPACE_NOT_FOUND'})
  const renamed = registry.registerWorkspace(entry.principal,{registeredWorkspaceId:'workspace-1',projectId:'project',label:'重命名',workspaceBindingRevision:1,runtimeId:'codex'})
  assert.equal(renamed.label,'重命名'); assert.equal(renamed.workspaceBindingRevision,1)
})

test('connection epochs protect new connections from stale disconnects; offline never implies stopped', t => {
  const {registry,register,time} = fixture(t), entry = register()
  assert.throws(()=>registry.validateTarget('owner','project',entry.target,{requireOnline:true}),{code:'CUSTOMER_DEVICE_OFFLINE'})
  const first = registry.markConnected(entry.principal), second = registry.markConnected(entry.principal)
  registry.markDisconnected(entry.device.id,first.connectionEpoch)
  assert.equal(registry.validateTarget('owner','project',entry.target,{requireOnline:true}).device.online,true)
  assert.throws(()=>registry.markHeartbeat(entry.principal,first.connectionEpoch),{code:'CUSTOMER_CONNECTION_REPLACED'})
  time(50_000)
  assert.throws(()=>registry.validateTarget('owner','project',entry.target,{requireOnline:true}),{code:'CUSTOMER_DEVICE_OFFLINE'})
  registry.markHeartbeat(entry.principal,second.connectionEpoch)
  assert.equal(registry.validateTarget('owner','project',entry.target,{requireOnline:true}).device.online,true)
  registry.resetPresence()
  assert.equal(registry.listDevices('owner')[0].online,false)
})

test('当前连接记录真实版本，所有者读取新值且不会再次递增连接代次', t => {
  const {registry} = fixture(t)
  const paired = registry.consumePairing(registry.createPairing('owner').pairingCode,{label:'升级测试',connectorVersion:'0.1.0'})
  const principal = registry.authenticateToken(paired.deviceToken)
  const {connectionEpoch} = registry.markConnected(principal)
  registry.markHeartbeat(principal,connectionEpoch,{connectorVersion:'0.4.0'})
  const device = registry.listDevices('owner')[0]
  assert.equal(device.connectorVersion,'0.4.0')
  assert.equal(device.connectionEpoch,connectionEpoch)
  registry.markHeartbeat(principal,connectionEpoch)
  assert.equal(registry.listDevices('owner')[0].connectorVersion,'0.4.0')
  assert.deepEqual(registry.listDevices('other'),[])
})

test('旧代次、已断开或撤证的连接不能改写当前版本，非法版本不覆盖有效值', t => {
  const {registry} = fixture(t)
  const paired = registry.consumePairing(registry.createPairing('owner').pairingCode,{label:'版本范围',connectorVersion:'0.1.0'})
  const principal = registry.authenticateToken(paired.deviceToken)
  const first = registry.markConnected(principal), second = registry.markConnected(principal)
  registry.markHeartbeat(principal,second.connectionEpoch,{connectorVersion:'0.4.0'})
  assert.throws(()=>registry.markHeartbeat({...principal,ownerId:'other'},second.connectionEpoch,{connectorVersion:'0.2.0'}),{code:'CUSTOMER_DEVICE_UNAUTHENTICATED'})
  assert.throws(()=>registry.markHeartbeat(principal,first.connectionEpoch,{connectorVersion:'0.2.0'}),{code:'CUSTOMER_CONNECTION_REPLACED'})
  assert.throws(()=>registry.markHeartbeat(principal,second.connectionEpoch,{connectorVersion:''}),{code:'INVALID_CUSTOMER_METADATA'})
  assert.throws(()=>registry.markHeartbeat(principal,second.connectionEpoch,{connectorVersion:'x'.repeat(81)}),{code:'INVALID_CUSTOMER_METADATA'})
  assert.equal(registry.listDevices('owner')[0].connectorVersion,'0.4.0')
  registry.markDisconnected(paired.device.id,second.connectionEpoch)
  assert.throws(()=>registry.markHeartbeat(principal,second.connectionEpoch,{connectorVersion:'0.2.0'}),{code:'CUSTOMER_CONNECTION_REPLACED'})
  registry.markConnected(principal)
  registry.revokeCredential('owner',paired.device.id)
  assert.throws(()=>registry.markHeartbeat(principal,3,{connectorVersion:'0.2.0'}),{code:'CUSTOMER_DEVICE_UNAUTHENTICATED'})
  assert.equal(registry.listDevices('owner')[0].connectorVersion,'0.4.0')
})

test('disabled devices retain recovery authentication, revoked credentials cannot reconnect', t => {
  const {registry,register} = fixture(t), entry = register()
  registry.markConnected(entry.principal)
  registry.setDeviceStatus('owner',entry.device.id,'disabled')
  assert.equal(registry.authenticateToken(entry.deviceToken).deviceId,entry.device.id)
  assert.throws(()=>registry.validateTarget('owner','project',entry.target),{code:'CUSTOMER_DEVICE_DISABLED'})
  registry.setDeviceStatus('owner',entry.device.id,'active')
  registry.revokeWorkspace(entry.principal,'workspace-1')
  assert.throws(()=>registry.validateTarget('owner','project',entry.target),{code:'CUSTOMER_WORKSPACE_REVOKED'})
  assert.equal(registry.listWorkspaces('owner')[0].status,'revoked')
  registry.revokeCredential('owner',entry.device.id)
  assert.throws(()=>registry.authenticateToken(entry.deviceToken),{code:'CUSTOMER_DEVICE_UNAUTHENTICATED'})
  assert.throws(()=>registry.setDeviceStatus('owner',entry.device.id,'active'),{code:'CUSTOMER_DEVICE_STATUS_INVALID'})
})

test('capabilities stay per-workspace, reject executable paths and never silently replace selection', t => {
  const {registry,register} = fixture(t), entry = register()
  registry.markConnected(entry.principal)
  const input = {registeredWorkspaceId:'workspace-1',workspaceBindingRevision:1,runtimeId:'codex',revision:'catalog-1',protocolVersion:1,models:[{id:'gpt-test',supportedReasoningEfforts:['low','high']}],skills:[{id:'skill-docs',name:'docs',description:'使用本机文档工具'}],permissions:{approvalPolicy:'on-request',sandboxMode:'workspace-write'}}
  registry.updateCapabilities(entry.principal,input)
  registry.updateCapabilities(entry.principal,{...input,models:[{...input.models[0],defaultReasoningEffort:'high'}]})
  assert.equal(registry.getCapabilities('owner',entry.target).models[0].defaultReasoningEffort,'high')
  assert.throws(()=>registry.updateCapabilities(entry.principal,{...input,models:[{...input.models[0],defaultReasoningEffort:'max'}]}),{code:'CUSTOMER_CAPABILITIES_INVALID'})
  assert.equal(registry.getCapabilities('owner',entry.target).models[0].defaultReasoningEffort,'high')
  assert.equal(registry.validateSelection('owner','project',entry.target,{modelId:'gpt-test',reasoningEffort:'high',skillIds:['skill-docs']}).revision,'catalog-1')
  assert.throws(()=>registry.validateSelection('owner','project',entry.target,{modelId:'unknown'}),{code:'CUSTOMER_MODEL_UNAVAILABLE'})
  assert.throws(()=>registry.validateSelection('owner','project',entry.target,{modelId:'gpt-test',reasoningEffort:'max'}),{code:'CUSTOMER_REASONING_UNAVAILABLE'})
  assert.throws(()=>registry.validateSelection('owner','project',entry.target,{modelId:'gpt-test',skillIds:['missing']}),{code:'CUSTOMER_SKILL_UNAVAILABLE'})
  assert.throws(()=>registry.updateCapabilities(entry.principal,{...input,skills:[{id:'skill-docs',name:'docs',description:'',path:'/private/SKILL.md'}]}),{code:'INVALID_CUSTOMER_METADATA'})
  assert.throws(()=>registry.updateCapabilities(entry.principal,{...input,protocolVersion:2}),{code:'CUSTOMER_PROTOCOL_UNSUPPORTED'})
  registry.revokeWorkspace(entry.principal,'workspace-1')
  assert.equal(registry.getCapabilities('owner',entry.target).models[0].id,'gpt-test','historical catalog remains readable after revoke')
})

test('feature rollback retains metadata and recovery credentials but blocks fresh pairing and registration', t => {
  const {registry,register,disable} = fixture(t), entry = register()
  disable()
  assert.equal(registry.listDevices('owner').length,1)
  assert.equal(registry.authenticateToken(entry.deviceToken).deviceId,entry.device.id)
  assert.throws(()=>registry.createPairing('owner'),{code:'CUSTOMER_AGENTS_DISABLED'})
  assert.throws(()=>registry.registerWorkspace(entry.principal,{registeredWorkspaceId:'new',projectId:'project',label:'x',workspaceBindingRevision:1,runtimeId:'codex'}),{code:'CUSTOMER_AGENTS_DISABLED'})
})
