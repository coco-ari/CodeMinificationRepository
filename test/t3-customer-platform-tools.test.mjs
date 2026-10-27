import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fixture, selection, dispatch, decodeContract } from './t3-customer-platform-fixture.mjs'
import { CustomerPlatformToolRequest, CustomerPlatformToolReference } from '../autoops/contracts/customer-platform-tools.ts'
import { createCustomerPlatformTools } from '../agent-demo/t3-adapters/customer-platform-tools.ts'
import { createAutoOpsAccess } from '../agent-demo/t3-adapters/access.mjs'

function declareBridge(f,version=1) {
  const {deviceId,updatedAt,...capabilities}=f.registry.getCapabilities('provider',f.target)
  return f.registry.updateCapabilities(f.machine,{...capabilities,platformToolsVersion:version})
}
async function run(f,patch={environmentId:'test',workspaceType:'internal'}) {
  const configuration=f.customerConfiguration(patch),preset=f.assistants.saveProvided('provider',null,f.command(configuration)),threadId=randomUUID()
  f.assignmentRevision=f.assistants.assign('manager','project',{requestId:randomUUID(),expectedRevision:f.assignmentRevision??0,target:{kind:'member',id:'provider'},assistantIds:[preset.id],defaultAssistantId:preset.id}).revision
  f.access.reserveThread(f.principal,{threadId,projectId:'project',environmentId:configuration.environmentId,agentId:'a-project',visibility:'private',workspaceType:configuration.workspaceType??undefined,executionBinding:f.target,question:selection(preset)})
  f.access.markThreadAccepted(threadId)
  const message=dispatch(threadId,f.modelSelection),runId='run:thread:'+threadId+':ordinal:1'
  f.access.recordMessageActor(f.principal,threadId,message.commandId,message.messageId)
  f.access.prepareCustomerRun(threadId,runId,message.messageId,undefined,message.modelSelection)
  const context=f.access.prepareCustomerToolRun(threadId,runId,message.messageId,undefined,message.modelSelection)
  if(configuration.workspaceType!==null)await f.inputs.prepare(threadId,runId,undefined,undefined,message.messageId,undefined,message.modelSelection)
  f.mcp.prepareRun({threadId,runId,actorId:'provider',projectId:'project',environmentId:configuration.environmentId})
  const reference=f.access.completeCustomerToolRun(threadId,runId)
  return {threadId,runId,message,reference,context:f.access.customerToolRun(threadId,runId),tools:createCustomerPlatformTools(f.access,f.workspace,f.mcp)}
}
const call=(tool,args={})=>({tool,arguments:args})

test('公共协议ID保留冒号横线，控制字符和自报权限字段全部拒绝',()=>{
  assert.equal(decodeContract(CustomerPlatformToolReference,{version:1,contextId:'context:run-id-1'}).contextId,'context:run-id-1')
  for(const control of ['\0','\n','\r','\x1f','\x7f'])assert.throws(()=>decodeContract(CustomerPlatformToolReference,{version:1,contextId:'id'+control}))
  const request={reference:{version:1,contextId:'context:run-id'},commandId:'command:one-1',sessionId:'session:one-1',runtimeEpoch:'epoch:one-1',call:call('query_environment')}
  assert.equal(decodeContract(CustomerPlatformToolRequest,request).commandId,request.commandId)
  for(const patch of [{actorId:'manager'},{environmentId:'production'},{inputId:'forged'}])assert.throws(()=>decodeContract(CustomerPlatformToolRequest,{...request,...patch}))
  assert.throws(()=>decodeContract(CustomerPlatformToolRequest,{...request,call:call('query_environment',{inputId:'forged'})}))
  assert.throws(()=>decodeContract(CustomerPlatformToolRequest,{...request,call:call('create_report')}))
})

test('无真实桥声明保留原自用，不允许资料或环境预设，能力版本严格',async t=>{
  const f=await fixture(t)
  assert(f.assistants.saveProvided('provider',null,f.command(f.customerConfiguration())))
  for(const patch of [{environmentId:'test'},{workspaceType:'internal'},{environmentId:'test',workspaceType:'internal'}])
    assert.throws(()=>f.assistants.saveProvided('provider',null,f.command(f.customerConfiguration(patch))),{code:'CUSTOMER_CONTEXT_UNSUPPORTED'})
  assert.throws(()=>declareBridge(f,2),{code:'CUSTOMER_CAPABILITIES_INVALID'})
  assert.equal(f.bindingDb.prepare('SELECT COUNT(*) AS n FROM t3_customer_tool_runs').get().n,0)
})

test('外部成员本人电脑仅保存外部资料预设，普通自用与内部成员范围保持',async t=>{
 const f=await fixture(t);declareBridge(f)
 Object.assign(f.providerMember,{role:'external',environmentIds:[],workspaceAccess:'external'})
 assert.equal(f.assistants.saveProvided('provider',null,f.command(f.customerConfiguration())).configuration.workspaceType,null)
 assert.equal(f.assistants.saveProvided('provider',null,f.command(f.customerConfiguration({workspaceType:'external'}))).configuration.workspaceType,'external')
 assert.throws(()=>f.access.requireWorkspaceInputReader('provider','project','internal'),{code:'WORKSPACE_FORBIDDEN'})
 assert.throws(()=>f.assistants.saveProvided('provider',null,f.command(f.customerConfiguration({workspaceType:'internal'}))),{code:'ASSISTANT_WORKSPACE_FORBIDDEN'})
 Object.assign(f.providerMember,{role:'developer',environmentIds:['test'],workspaceAccess:'internal'})
 assert.equal(f.assistants.saveProvided('provider',null,f.command(f.customerConfiguration({workspaceType:'internal'}))).configuration.workspaceType,'internal')
})

test('旧自用仅遗留环境绑定继续普通问答，不生成平台工具引用或输入',async t=>{
 const f=await fixture(t),legacy=createAutoOpsAccess({sessionDb:f.sessionDb,bindingDb:f.bindingDb,catalog:f.catalog,customerRegistry:f.registry}),threadId=randomUUID()
 legacy.reserveThread(f.principal,{threadId,projectId:'project',environmentId:'test',agentId:'a-project',visibility:'private',executionBinding:f.target});legacy.markThreadAccepted(threadId)
 assert.equal(f.access.requireThread(f.principal,threadId).environmentId,'test')
 assert.equal(f.access.requireQuestionForActor('provider',threadId,f.modelSelection),undefined)
 assert.equal(f.access.customerToolReference(threadId,'original-legacy-run'),undefined)
 assert.equal(f.bindingDb.prepare('SELECT COUNT(*) AS n FROM t3_customer_tool_runs').get().n,0)
 assert.equal(f.access.getRunInput(threadId,'original-legacy-run'),undefined)
 assert.throws(()=>f.access.requireCustomerToolThread(threadId,'provider',f.modelSelection),{code:'CUSTOMER_PLATFORM_TOOLS_NOT_SELECTED'})
})

test('原自用无grant工具固定原助手及原修订，换分配不能转用相同参数新助手',async t=>{
 const f=await fixture(t);declareBridge(f);const r=await run(f)
 const original=f.access.requireCustomerToolRun(r.reference).context
 assert.equal(original.scope.grantId,null)
 const preset=f.assistants.saveProvided('provider',null,f.command(f.customerConfiguration({environmentId:'test',workspaceType:'internal'})))
 f.assistants.assign('manager','project',{requestId:randomUUID(),expectedRevision:f.assignmentRevision,target:{kind:'member',id:'provider'},assistantIds:[preset.id],defaultAssistantId:preset.id})
 assert.throws(()=>f.access.requireCustomerToolRun(r.reference),{code:'ASSISTANT_NOT_ASSIGNED'})
 assert.deepEqual(f.access.customerToolRun(r.threadId,r.runId),original)
})

// 本组验证真实所属SQLite输入及能力边界；设备MCP/原生projection另在协议集成覆盖。
test('已声明桥的实际caller固定原资料与环境，原引用重入不换输入',async t=>{
  const f=await fixture(t);declareBridge(f)
  const r=await run(f),context=f.access.requireCustomerToolRun(r.reference,f.machine)
  assert.equal(context.actorId,'provider');assert.equal(context.context.scope.configuration.environmentId,'test')
  const input=f.access.getRunInput(r.threadId,r.runId)
  assert(input.actorVerified);assert.equal(input.actorId,'provider')
  assert.deepEqual(f.access.customerToolReference(r.threadId,r.runId),r.reference)
  const repeated=f.access.prepareCustomerToolRun(r.threadId,r.runId,r.message.messageId,undefined,r.message.modelSelection)
  assert.deepEqual(repeated.reference,r.reference);assert.equal(repeated.inputId,input.inputId)
  const listed=await r.tools.invoke(r.reference,call('list_project_materials'),()=>{})
  assert.equal(listed.source,'workspace_input')
  const read=await r.tools.invoke(r.reference,call('read_project_material',{path:`autoops/project/inputs/${input.inputId}/docs/proof.txt`}),()=>{})
  assert.match(read.content,/C7_REAL_SQLITE_CURRENT_INPUT/)
  assert.equal((await r.tools.invoke(r.reference,call('query_environment'),()=>{})).source,'environment_mcp_catalog')
  assert.throws(()=>f.access.requireToolThread(r.threadId,'provider'),{code:'CUSTOMER_BUSINESS_TOOLS_DISABLED'})
})

test('环境单用不生成内部资料输入，资料单用不借默认环境',async t=>{
  const f=await fixture(t);declareBridge(f)
  const environment=await run(f,{environmentId:'test',workspaceType:null})
  assert.equal(f.access.getRunInput(environment.threadId,environment.runId),undefined)
  assert.equal(environment.context.inputId,null)
  assert.equal(f.access.runResourceReferences(environment.threadId,environment.runId)[0].inputId,null)
  await assert.rejects(environment.tools.invoke(environment.reference,call('list_project_materials'),()=>{}),{code:'CUSTOMER_TOOL_MATERIALS_NOT_SELECTED'})
  const materials=await run(f,{environmentId:null,workspaceType:'internal'})
  assert.equal(f.access.requireCustomerToolRun(materials.reference).context.scope.configuration.environmentId,null)
  assert.equal((await materials.tools.invoke(materials.reference,call('query_environment'),()=>{})).environmentId,null)
})

test('跨设备/输入/环境与撤回拒绝，原引用不改变',async t=>{
  const f=await fixture(t);declareBridge(f);const r=await run(f)
  assert.throws(()=>f.access.requireCustomerToolRun(r.reference,{...f.machine,deviceId:'other-device'}),{code:'CUSTOMER_TOOL_DEVICE_FORBIDDEN'})
  assert.throws(()=>f.access.requireCustomerToolRun({...r.reference,contextId:randomUUID()}),{code:'CUSTOMER_TOOL_CONTEXT_FORBIDDEN'})
  await assert.rejects(r.tools.invoke(r.reference,call('read_project_material',{path:'autoops/project/inputs/other-input/docs/proof.txt'}),()=>{}))
  const original=JSON.stringify(f.access.customerToolRun(r.threadId,r.runId))
  f.providerMember.environmentIds=[]
  await assert.rejects(r.tools.invoke(r.reference,call('query_environment'),()=>{}))
  assert.equal(JSON.stringify(f.access.customerToolRun(r.threadId,r.runId)),original)
})

test('读取await期间撤权不返回迟到正文，原输入保留',async t=>{
  const f=await fixture(t);declareBridge(f);const r=await run(f),input=f.access.getRunInput(r.threadId,r.runId)
  let entered,release
  const pending=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
  const ownerRead=f.workspace.readInputContent.bind(f.workspace)
  f.workspace.readInputContent=async(...args)=>{entered();await gate;return ownerRead(...args)}
  const reading=r.tools.invoke(r.reference,call('read_project_material',{path:`autoops/project/inputs/${input.inputId}/docs/proof.txt`}),()=>{})
  await pending;f.providerMember.environmentIds=[];release()
  await assert.rejects(reading)
  assert.equal(f.access.getRunInput(r.threadId,r.runId).inputId,input.inputId)
})

async function sharedRun(f) {
 const configuration=f.customerConfiguration({customerProfile:f.profile,environmentId:'test',workspaceType:'internal'}),preset=f.assistants.saveProvided('provider',null,f.command(configuration))
 const allocation={requestId:randomUUID(),expectedRevision:0,target:{kind:'member',id:'reader'},assistantIds:[preset.id],defaultAssistantId:preset.id}
 assert.throws(()=>f.assistants.assign('manager','target-project',allocation),{code:'ASSISTANT_PROVIDER_SHARE_REQUIRED'})
 f.assistants.shareProvided('provider',preset.id,'target-project',{requestId:randomUUID(),expectedRevision:0,enabled:true})
 f.assistants.assign('manager','target-project',allocation)
 const principal=f.access.authenticateCookie('demo_session=reader'),threadId=randomUUID(),runId='run:thread:'+threadId+':ordinal:1'
 f.access.reserveThread(principal,{threadId,projectId:'target-project',environmentId:'test',agentId:'a-project',visibility:'private',workspaceType:'internal',executionBinding:f.target,question:selection(preset)});f.access.markThreadAccepted(threadId)
 const message=dispatch(threadId,f.modelSelection)
 f.access.recordMessageActor(principal,threadId,message.commandId,message.messageId)
 const grant=f.access.prepareCustomerRun(threadId,runId,message.messageId,undefined,message.modelSelection)
 f.access.prepareCustomerToolRun(threadId,runId,message.messageId,undefined,message.modelSelection)
 await f.inputs.prepare(threadId,runId,undefined,undefined,message.messageId,undefined,message.modelSelection)
 f.mcp.prepareRun({threadId,runId,actorId:'reader',projectId:'target-project',environmentId:'test'})
 const reference=f.access.completeCustomerToolRun(threadId,runId)
 return {principal,threadId,runId,preset,grant,reference,tools:createCustomerPlatformTools(f.access,f.workspace,f.mcp)}
}

test('已共享且获分配的跨项目reader工具沿原grant和本人输入，不继承提供者范围',async t=>{
 const f=await fixture(t,{shared:true}),r=await sharedRun(f),context=f.access.requireCustomerToolRun(r.reference,f.machine),input=f.access.getRunInput(r.threadId,r.runId)
 assert.equal(context.actorId,'reader');assert.equal(context.context.scope.projectId,'target-project');assert.equal(context.context.scope.grantId,r.grant.grantId)
 assert.equal(r.grant.providerId,'provider');assert.equal(r.grant.sourceProjectId,'project');assert.equal(r.grant.actorId,'reader')
 assert.equal(input.actorId,'reader');assert.equal(input.inputOwnerId,'reader')
 const path=`autoops/target-project/inputs/${input.inputId}/docs/proof.txt`,read=await r.tools.invoke(r.reference,call('read_project_material',{path}),()=>{})
 assert.match(read.content,/C7_RECIPIENT_PROJECT_CURRENT_INPUT/);assert.doesNotMatch(read.content,/C7_REAL_SQLITE_CURRENT_INPUT/)
 await assert.rejects(r.tools.invoke(r.reference,call('read_project_material',{path:path.replace('target-project','project')}),()=>{}))
 f.providerMember.environmentIds=[]
 assert.equal((await r.tools.invoke(r.reference,call('query_environment'),()=>{})).environmentId,'test')
 f.catalog.projects[1].memberships.find(m=>m.userId==='reader').environmentIds=[]
 await assert.rejects(r.tools.invoke(r.reference,call('query_environment'),()=>{}))
 assert.equal(f.access.customerToolRun(r.threadId,r.runId).scope.actorId,'reader')
})

test('共享读取await中提供者撤回不回传正文，原grant和input保持供收据恢复',async t=>{
 const f=await fixture(t,{shared:true}),r=await sharedRun(f),input=f.access.getRunInput(r.threadId,r.runId),before=structuredClone(f.access.customerToolRun(r.threadId,r.runId))
 let entered,release;const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve}),ownerRead=f.workspace.readInputContent.bind(f.workspace)
 f.workspace.readInputContent=async(...args)=>{entered();await gate;return ownerRead(...args)}
 const reading=r.tools.invoke(r.reference,call('read_project_material',{path:`autoops/target-project/inputs/${input.inputId}/docs/proof.txt`}),()=>{})
 await started;f.assistants.shareProvided('provider',r.preset.id,'target-project',{requestId:randomUUID(),expectedRevision:1,enabled:false});release()
 await assert.rejects(reading)
 assert.deepEqual(f.access.customerToolRun(r.threadId,r.runId),before);assert.equal(f.access.getRunInput(r.threadId,r.runId).inputId,input.inputId)
})

test('已验证隔离profile不能代替真实平台桥，能力撤销立即阻止既有工具引用',async t=>{
 const f=await fixture(t,{shared:true}),r=await sharedRun(f),before=f.access.customerToolRun(r.threadId,r.runId)
 const {deviceId,updatedAt,platformToolsVersion,...capabilities}=f.registry.getCapabilities('provider',f.target)
 f.registry.updateCapabilities(f.machine,capabilities)
 assert.throws(()=>f.assistants.saveProvided('provider',null,f.command(f.customerConfiguration({customerProfile:f.profile,environmentId:'test',workspaceType:'internal'}))),{code:'CUSTOMER_CONTEXT_UNSUPPORTED'})
 await assert.rejects(r.tools.invoke(r.reference,call('query_environment'),()=>{}))
 assert.deepEqual(f.access.customerToolRun(r.threadId,r.runId),before)
})
