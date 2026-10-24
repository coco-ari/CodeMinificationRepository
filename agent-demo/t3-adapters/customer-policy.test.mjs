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

test('客户输入仍拒绝平台资料和未开放的自主目标',t=>{
  const {dispatch}=fixture(t)
  for(const patch of [{context:{records:[{}]}},{initialMessage:{text:'/goal work forever'}},{text:'/goal work forever'},{text:'/plan'}])
    assert.throws(()=>dispatch(patch),error=>['CUSTOMER_CONTEXT_UNSUPPORTED','CUSTOMER_COMMAND_UNSUPPORTED'].includes(error.code))
})

test('offline blocks new work but preserves stop and history controls',t=>{
  const {dispatch,registry,device,connectionEpoch,access,principal}=fixture(t)
  registry.markDisconnected(device.id,connectionEpoch)
  assert.throws(()=>dispatch(),{code:'CUSTOMER_DEVICE_OFFLINE'})
  authorizeAutoOpsRpc(access,principal,'orchestration.dispatchCommand',{type:'thread.stop',threadId:'customer'})
  authorizeAutoOpsRpc(access,principal,'orchestration.getThreadProjection',{threadId:'customer'})
  authorizeAutoOpsRpc(access,principal,'assets.persistChatAttachments',{threadId:'customer'})
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


test('customer skills never enter the configured platform scoped-skill registry',t=>{
  const {dispatch,access,principal,selection}=fixture(t)
  const previous=process.env.AUTOOPS_T3_DATA_DIR
  process.env.AUTOOPS_T3_DATA_DIR='/platform-context-must-not-be-read'
  t.after(()=>{if(previous===undefined)delete process.env.AUTOOPS_T3_DATA_DIR;else process.env.AUTOOPS_T3_DATA_DIR=previous})
  dispatch({text:'$autoops-local-check 检查本机项目'})
  authorizeAutoOpsRpc(access,principal,'orchestration.launchThread',{threadId:'customer',projectId:'p-autoops',modelSelection:selection,initialMessage:{text:'$autoops-local-check 检查本机项目'}})
})

test('customer catalog refresh stays owner-bound and cannot accept a platform or local cwd',t=>{
  const {access,principal,selection}=fixture(t)
  authorizeAutoOpsRpc(access,principal,'server.refreshProviders',{instanceId:selection.instanceId,fresh:true})
  for(const payload of [{instanceId:'customer-other-codex'},{instanceId:selection.instanceId,cwd:'autoops/skill-context/example'},{instanceId:selection.instanceId,cwd:'/private/local'}])
    assert.throws(()=>authorizeAutoOpsRpc(access,principal,'server.refreshProviders',payload),{code:'AUTOOPS_OPERATION_FORBIDDEN'})
})


test('客户附件仅允许已归属本私有对话的文件，设备和会话撤销立即阻止读取',t=>{
  const {access,principal,device,registry,dispatch}=fixture(t)
  const file={id:'attachment-one',type:'file',name:'资料.txt',mimeType:'text/plain',sizeBytes:3}
  access.recordPendingAttachment(principal,file.id,file)
  dispatch({attachments:[file],context:{records:[{kind:"file",attachmentId:file.id}]}})
  assert.throws(()=>dispatch({attachments:[file],context:{records:[{kind:"file",attachmentId:"other"}]}}),{code:"CUSTOMER_CONTEXT_UNSUPPORTED"})
  assert.throws(()=>access.requireCustomerAttachment(principal.id,'customer',file.id),{code:'ATTACHMENT_NOT_FOUND'})
  access.recordClaimedAttachment(principal,file.id,'claimed-file','customer')
  file.id='claimed-file'
  assert.equal(access.requireCustomerAttachment(principal.id,'customer',file.id).name,file.name)
  assert.throws(()=>access.requireCustomerAttachment('u-guest','customer',file.id),{code:'ATTACHMENT_NOT_FOUND'})
  assert.throws(()=>dispatch({attachments:[{...file,id:'not-owned'}]}),{code:'ATTACHMENT_NOT_FOUND'})
  registry.setDeviceStatus(principal.id,device.id,'disabled')
  assert.throws(()=>access.requireCustomerAttachment(principal.id,'customer',file.id),{code:'CUSTOMER_DEVICE_DISABLED'})
  registry.setDeviceStatus(principal.id,device.id,'active')
  access.markThreadDeleted('customer')
  assert.throws(()=>access.requireCustomerAttachment(principal.id,'customer',file.id),{code:'THREAD_NOT_FOUND'})
})
