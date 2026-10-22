import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { users, projects, agents } from '../fixtures.mjs'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from './access.mjs'
import { authorizeAutoOpsRpc } from './rpc-policy.mjs'

function fixture(t) {
  const previous = process.env.AUTOOPS_CUSTOMER_AGENTS
  process.env.AUTOOPS_CUSTOMER_AGENTS = '1'
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('test').digest('hex'),'u-admin','csrf',Date.now()+60000)
  const access=createAutoOpsAccess({sessionDb,bindingDb,catalog:structuredClone({users,projects,agents})})
  const principal=access.authenticateCookie('demo_session=test'), registry=access.customerRegistry
  const {device,deviceToken}=registry.consumePairing(registry.createPairing(principal.id).pairingCode,{label:'测试客户电脑'})
  const machine=registry.authenticateToken(deviceToken)
  registry.registerWorkspace(machine,{registeredWorkspaceId:'workspace',projectId:'p-autoops',label:'本机目录',workspaceBindingRevision:1,runtimeId:'codex'})
  const {connectionEpoch}=registry.markConnected(machine)
  registry.updateCapabilities(machine,{registeredWorkspaceId:'workspace',workspaceBindingRevision:1,runtimeId:'codex',revision:'one',protocolVersion:1,models:[{id:'local-model',supportedReasoningEfforts:['low','high']}],skills:[]})
  access.reserveThread(principal,{threadId:'customer',projectId:'p-autoops',environmentId:'env-test',agentId:'a-project',visibility:'private',executionBinding:{kind:'customer',deviceId:device.id,registeredWorkspaceId:'workspace',workspaceBindingRevision:1,runtimeId:'codex'}})
  const selection={instanceId:`customer-${device.id}-codex`,model:'local-model',options:[{id:'reasoningEffort',value:'high'}]}
  const dispatch=(patch={})=>authorizeAutoOpsRpc(access,principal,'orchestration.dispatchCommand',{type:'message.dispatch',threadId:'customer',text:'检查本机目录',modelSelection:selection,...patch})
  t.after(()=>{sessionDb.close();bindingDb.close();if(previous===undefined)delete process.env.AUTOOPS_CUSTOMER_AGENTS;else process.env.AUTOOPS_CUSTOMER_AGENTS=previous})
  return {access,principal,registry,device,connectionEpoch,selection,dispatch}
}

test('customer dispatch accepts its actual model and effort but cannot switch provider or broaden permissions', t=>{
  const {dispatch,selection}=fixture(t)
  dispatch()
  for(const patch of [
    {modelSelection:{...selection,instanceId:'codex'}},
    {modelSelection:{...selection,model:'not-in-local-catalog'}},
    {modelSelection:{...selection,options:[{id:'reasoningEffort',value:'max'}]}},
    {modelSelection:{...selection,options:[{id:'permission',value:'full-access'}]}},
    {runtimeMode:'full-access'},{cwd:'/other-workspace'},
  ])assert.throws(()=>dispatch(patch),{code:'AUTOOPS_OPERATION_FORBIDDEN'})
})

test('customer input cannot bypass missing attachment, platform context, or autonomous-goal capabilities',t=>{
  const {dispatch}=fixture(t)
  for(const patch of [{attachments:[{id:'file'}]},{context:{records:[{}]}},{message:{attachments:[{}]}},{initialMessage:{text:'/goal work forever'}},{text:'/goal work forever'},{text:'/plan'}])
    assert.throws(()=>dispatch(patch),error=>['CUSTOMER_CONTEXT_UNSUPPORTED','CUSTOMER_COMMAND_UNSUPPORTED'].includes(error.code))
})

test('offline blocks new work but preserves stop and history controls',t=>{
  const {dispatch,registry,device,connectionEpoch,access,principal}=fixture(t)
  registry.markDisconnected(device.id,connectionEpoch)
  assert.throws(()=>dispatch(),{code:'CUSTOMER_DEVICE_OFFLINE'})
  authorizeAutoOpsRpc(access,principal,'orchestration.dispatchCommand',{type:'thread.stop',threadId:'customer'})
  authorizeAutoOpsRpc(access,principal,'orchestration.getThreadProjection',{threadId:'customer'})
  assert.throws(()=>authorizeAutoOpsRpc(access,principal,'assets.persistChatAttachments',{threadId:'customer'}),{code:'AUTOOPS_OPERATION_FORBIDDEN'})
})

test('customer approval is authorized before native projection can mark it resolved',t=>{
  const {registry,device,connectionEpoch,access,principal}=fixture(t)
  const respond=()=>authorizeAutoOpsRpc(access,principal,'orchestration.dispatchCommand',{type:'runtime-request.respond',threadId:'customer',requestId:'owned-request',decision:'accept'})
  respond()
  registry.markDisconnected(device.id,connectionEpoch)
  assert.throws(respond,{code:'CUSTOMER_DEVICE_OFFLINE'})
  registry.setDeviceStatus(principal.id,device.id,'disabled')
  assert.throws(respond,{code:'CUSTOMER_DEVICE_DISABLED'})
})
