import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createCustomerRegistry } from '../agent-demo/t3-adapters/customer-registry.mjs'
import { decodeContract } from '../autoops/contracts/index.ts'
import { SharedProfileCapability } from '../autoops/contracts/shared-execution.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAssistantDirectory, questionConfigurationPolicy } from '../agent-demo/t3-adapters/assistants/index.ts'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { sharedProfileVerifier } from '../agent-demo/t3-adapters/shared-profile-approvals.ts'
import { projectCustomerProviderResult } from '../agent-demo/t3-adapters/customer-target.mjs'

const profile = () => ({
  id: 'readonly-linux', revision: 1, digest: 'a'.repeat(64),
  imageDigest: `sha256:${'b'.repeat(64)}`, policy: 'linux-docker-readonly-v1',
  models: [{ id: 'isolated-real-model', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low' }],
  skills: [{ id: 'isolated-skill', name: '只读分析', description: '' }],
})
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  const registry = createCustomerRegistry({ db, enabled: () => true,
    requireOwner(actor) { assert.equal(actor, 'provider') },
    requireProjectForUser(actor, project) { assert.equal(actor, 'provider'); assert.equal(project, 'source-project') },
  })
  const paired = registry.consumePairing(registry.createPairing('provider').pairingCode, { label: '隔离验收来源' })
  const principal = registry.authenticateToken(paired.deviceToken)
  const target = { kind: 'customer', deviceId: paired.device.id, registeredWorkspaceId: 'source-directory', workspaceBindingRevision: 1, runtimeId: 'codex' }
  registry.registerWorkspace(principal, { registeredWorkspaceId: target.registeredWorkspaceId,
    workspaceBindingRevision: 1, runtimeId: 'codex', projectId: 'source-project', label: '明确登记目录' })
  registry.markConnected(principal)
  const capability = { registeredWorkspaceId: target.registeredWorkspaceId, workspaceBindingRevision: 1,
    runtimeId: 'codex', revision: 'actual-catalog', protocolVersion: 1, assistantConfiguration: true,
    models: [{ id: 'self-model', supportedReasoningEfforts: ['high'] }], skills: [],
  }
  t.after(() => db.close())
  return { registry, principal, target, capability }
}

test('隔离运行器能力目录独立上报，不以提供者自用模型与技能覆盖', t => {
  const f = fixture(t), sharedProfile = decodeContract(SharedProfileCapability, profile())
  f.registry.updateCapabilities(f.principal, { ...f.capability, sharedProfile })
  const actual = f.registry.getCapabilities('provider', f.target)
  assert.equal(actual.models[0].id, 'self-model')
  assert.equal(actual.sharedProfile.models[0].id, 'isolated-real-model')
  assert.equal(actual.sharedProfile.skills[0].id, 'isolated-skill')
  assert.deepEqual(f.registry.sourceOwner(f.target), { ownerId: 'provider', projectId: 'source-project' })
})

function assistantFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'autoops-shared-execution-')), db = new DatabaseSync(':memory:')
  const members = new Map(['provider', 'admin', 'recipient'].map(userId => [userId, {
    userId, role: userId === 'recipient' ? 'reader' : 'project_admin', workspaceAccess: 'internal',
    environmentIds: [], status: 'active', canAdjustChat: userId !== 'recipient',
  }]))
  const membership = (actor, project) => {
    if (!members.has(actor) || !['source-project', 'target-project'].includes(project) || members.get(actor).status !== 'active')
      throw Object.assign(new Error('无项目使用权'), { status: 403, code: 'PROJECT_FORBIDDEN' })
    return members.get(actor)
  }
  const registry = createCustomerRegistry({ db, enabled: () => true,
    requireOwner: actor => { if (!members.has(actor)) throw new Error('账号不可用') }, requireProjectForUser: membership })
  const paired = registry.consumePairing(registry.createPairing('provider').pairingCode, { label: '真实隔离来源夹具' })
  const principal = registry.authenticateToken(paired.deviceToken)
  const target = {kind:'customer',deviceId:paired.device.id,registeredWorkspaceId:'source-directory',workspaceBindingRevision:1,runtimeId:'codex'}
  registry.registerWorkspace(principal, {registeredWorkspaceId:target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex',projectId:'source-project',label:'明确共享资料'})
  registry.markConnected(principal)
  const shared = profile(), capability = {registeredWorkspaceId:target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex',revision:'isolated-catalog-v1',protocolVersion:1,assistantConfiguration:true,models:shared.models,skills:shared.skills,sharedProfile:shared}
  registry.updateCapabilities(principal, capability)
  const approvalFile = join(root,'verified-profiles.json'), {models,skills,...descriptor} = shared
  const approvals = [{providerId:'provider',sourceProjectId:'source-project',target,profile:descriptor,validationId:'fixture-policy-only-not-os-proof',verifiedAt:'2026-10-26T00:00:00Z'}]
  writeFileSync(approvalFile,JSON.stringify(approvals),{mode:0o600})
  const verifySharedProfile = sharedProfileVerifier(() => approvalFile)
  const policy = questionConfigurationPolicy({projects:()=>['source-project','target-project'].map(id=>({id,environments:[]})),agents:()=>[{id:'a-project',projectIds:['source-project','target-project']}],models:()=>{throw new Error('不能使用平台模型目录')},skills:()=>[],customers:()=>registry,verifySharedProfile})
  const directory = createAssistantDirectory({dataDir:root,membership,manage:(actor,project)=>{if(membership(actor,project).role!=='project_admin')throw new Error('无项目管理权')},validate:policy,validateTarget:()=>{},providers:{registry:()=>registry,displayName:actor=>actor},verifySharedProfile})
  const preset = directory.saveProvided('provider',null,{requestId:'create-provider',expectedRevision:0,value:{name:'只读共享助手',description:'',instructions:'按实际隔离范围读取',enabled:true,configuration:{agentId:'a-project',executionBinding:target,customerProfile:descriptor,environmentId:null,workspaceType:null,visibility:'private',model:{instanceId:`customer-${target.deviceId}-codex`,model:'isolated-real-model',reasoningEffort:'low'},skillIds:['isolated-skill']}}})
  directory.shareProvided('provider',preset.id,'target-project',{requestId:'share-target',expectedRevision:0,enabled:true})
  const assign = (targetId='recipient') => directory.assign('admin','target-project',{requestId:`assign-${targetId}`,expectedRevision:0,target:{kind:'member',id:targetId},assistantIds:[preset.id],defaultAssistantId:preset.id})
  const selection={assistantId:preset.id,presetRevision:preset.revision,configuration:preset.configuration}
  t.after(()=>{directory.close();db.close();rmSync(root,{recursive:true,force:true})})
  return {directory,registry,principal,target,capability,members,preset,selection,assign,approvals,approvalFile,db,root,membership}
}

test('共享准入固定实际调用者及来源身份，不能继承提供者或管理员身份', t => {
  const f=assistantFixture(t); f.assign()
  const scope=f.directory.executionScope('recipient','target-project',f.selection,{threadId:'caller-thread',runId:'caller-run'})
  assert.equal(scope.actorId,'recipient')
  assert.equal(scope.providerId,'provider')
  assert.equal(scope.projectId,'target-project')
  assert.equal(scope.sourceProjectId,'source-project')
  assert.deepEqual(scope.allocation,{kind:'member',id:'recipient',revision:1})
  assert.equal(scope.profile.digest,profile().digest)
  assert.equal(scope.capabilityRevision,'isolated-catalog-v1')
  assert.deepEqual(scope.target,f.target)
  assert.equal(scope.model.model,'isolated-real-model')
})
test('提供者明确选择隔离profile时本人也固定隔离范围，不回落自用进程',t=>{
  const f=assistantFixture(t)
  f.registry.updateCapabilities(f.principal,{...f.capability,models:[{id:'different-self-model',supportedReasoningEfforts:['high']}],skills:[]})
  const scope=f.directory.executionScope('provider','source-project',f.selection,{threadId:'own-isolated-thread',runId:'own-isolated-run'})
  assert.equal(scope.actorId,'provider');assert.equal(scope.providerId,'provider')
  assert.equal(scope.shareRevision,0)
  assert.deepEqual(scope.allocation,{kind:'self',id:'provider',revision:f.preset.revision})
  assert.equal(scope.model.model,'isolated-real-model')
  assert.deepEqual(f.directory.requireExecutionScope(scope),scope)
  const changed=structuredClone(f.selection);delete changed.configuration.customerProfile
  assert.throws(()=>f.directory.validateSelection('provider','source-project',changed),{code:'ASSISTANT_SOURCE_FIXED'})
  const facts=f.directory.providedSettings('provider').sources[0]
  assert.equal(facts.sharedProfileAvailable,true)
})
test('外部成员原本人电脑自用保持原链路，不因共享隔离方案被收回',t=>{
  const f=assistantFixture(t),member=f.members.get('provider')
  member.role='external';member.workspaceAccess='external';member.canAdjustChat=false
  const {customerProfile,...configuration}=f.preset.configuration
  const self=f.directory.saveProvided('provider',null,{requestId:'original-external-self',expectedRevision:0,value:{name:'原本人电脑',description:'',instructions:'',enabled:true,configuration}})
  f.directory.assign('admin','source-project',{requestId:'external-self-assignment',expectedRevision:0,target:{kind:'member',id:'provider'},assistantIds:[self.id],defaultAssistantId:self.id})
  const selected={assistantId:self.id,presetRevision:self.revision,configuration:self.configuration}
  assert.equal(f.directory.validateSelection('provider','source-project',selected).assistantId,self.id)
  assert.equal(f.directory.executionScope('provider','source-project',selected,{threadId:'original-self-thread',runId:'original-self-run'}),undefined)
})

test('未由中心签发的公开哈希范围不能冒充另一任务，原任务范围耐久固定', t => {
  const f=assistantFixture(t); f.assign()
  const original=f.directory.executionScope('recipient','target-project',f.selection,{threadId:'thread-a',runId:'run-a'})
  const forged={...original,runId:'run-forged'}
  const {grantId,...core}=forged
  const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
  forged.grantId=`shared-${createHash('sha256').update(stable(core)).digest('hex')}`
  assert.throws(()=>f.directory.requireExecutionScope(forged),{code:'CUSTOMER_SHARED_SCOPE_UNISSUED'})
  assert.deepEqual(f.directory.requireExecutionScope(original),original)
})

test('共享撤回后已签发范围拒绝新调用，管理员也须获得明确分配', t => {
  const f=assistantFixture(t); f.assign()
  assert.throws(()=>f.directory.executionScope('admin','target-project',f.selection,{threadId:'admin-thread',runId:'admin-run'}),{code:'ASSISTANT_PROVIDER_APPROVAL_REQUIRED'})
  const original=f.directory.executionScope('recipient','target-project',f.selection,{threadId:'caller-thread',runId:'caller-run'})
  f.directory.shareProvided('provider',f.preset.id,'target-project',{requestId:'withdraw-target',expectedRevision:1,enabled:false})
  assert.throws(()=>f.directory.requireExecutionScope(original))
})

function sharedAccess(t) {
  const f=assistantFixture(t),sessionDb=new DatabaseSync(':memory:'),bindingDb=new DatabaseSync(':memory:')
  const previous=process.env.AUTOOPS_CUSTOMER_AGENTS;process.env.AUTOOPS_CUSTOMER_AGENTS='1'
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  for(const id of f.members.keys())sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(id).digest('hex'),id,'csrf',Date.now()+60_000)
  const catalog={users:[...f.members.keys()].map(id=>({id,name:id,role:id==='recipient'?'member':'admin'})),projects:['source-project','target-project'].map(id=>({id,name:id,memberIds:[...f.members.keys()],memberships:[...f.members.values()],environments:[],documents:[],resources:[]})),agents:[{id:'a-project',projectIds:['source-project','target-project']}]}
  const access=createAutoOpsAccess({sessionDb,bindingDb,catalog,customerRegistry:f.registry,questions:()=>f.directory})
  const recipient=access.authenticateCookie('demo_session=recipient'),provider=access.authenticateCookie('demo_session=provider')
  f.assign()
  access.reserveThread(recipient,{threadId:'actual-shared-thread',projectId:'target-project',environmentId:null,agentId:'a-project',visibility:'private',executionBinding:f.target,question:f.selection})
  t.after(()=>{sessionDb.close();bindingDb.close();if(previous===undefined)delete process.env.AUTOOPS_CUSTOMER_AGENTS;else process.env.AUTOOPS_CUSTOMER_AGENTS=previous})
  return {...f,access,recipient,provider}
}
const nativeSelection=f=>({instanceId:f.selection.configuration.model.instanceId,model:f.selection.configuration.model.model,options:[{id:'reasoningEffort',value:'low'}]})

test('真实业务绑定只从可信消息收据取得调用者，共享使用不能管理提供者设备或调用平台工具',t=>{
  const f=sharedAccess(t),thread='actual-shared-thread'
  assert.throws(()=>f.access.customerRunScope(thread,'missing'),{code:'CUSTOMER_SHARED_SCOPE_MISSING'})
  assert.throws(()=>f.access.recordMessageActor(f.provider,thread,'forged','provider-message'))
  f.access.recordMessageActor(f.recipient,thread,'real-command','real-message')
  const scope=f.access.prepareCustomerRun(thread,'actual-run','real-message',undefined,nativeSelection(f))
  assert.equal(scope.actorId,'recipient');assert.equal(scope.providerId,'provider')
  assert.deepEqual(f.access.customerRunScope(thread,'actual-run'),scope)
  assert.deepEqual(f.access.customerExecutionSource(thread,'recipient'),{ownerId:'provider',projectId:'source-project'})
  assert.deepEqual(f.registry.listDevices('recipient'),[])
  assert.throws(()=>f.access.requireToolThread(thread,'recipient'),{code:'CUSTOMER_BUSINESS_TOOLS_DISABLED'})
  assert.throws(()=>f.access.requireSharedExecutionScope(scope,{...f.principal,ownerId:'recipient'}),{code:'CUSTOMER_SHARED_SCOPE_FORBIDDEN'})
  assert.deepEqual(f.access.requireSharedExecutionScope(scope,f.principal),scope)
  f.access.recordPendingAttachment(f.recipient,'pending-image',{name:'fixture.png',mimeType:'image/png',sizeBytes:1})
  f.access.recordClaimedAttachment(f.recipient,'pending-image','thread-image',thread)
  assert.equal(f.access.requireCustomerAttachment('recipient',thread,'thread-image').id,'thread-image')
  assert.throws(()=>f.access.requireCustomerAttachment('provider',thread,'thread-image'),{code:'ATTACHMENT_NOT_FOUND'})
})

test('原任务恢复沿原共享范围和实际调用者，撤回共享后不能恢复或接收迟到资源',t=>{
  const f=sharedAccess(t),thread='actual-shared-thread'
  f.access.recordMessageActor(f.recipient,thread,'real-command','real-message')
  const original=f.access.prepareCustomerRun(thread,'original-run','real-message',undefined,nativeSelection(f))
  const restored=f.access.prepareCustomerRun(thread,'restored-run','real-message',undefined,nativeSelection(f),'original-run')
  assert.equal(restored.actorId,original.actorId);assert.equal(restored.profile.digest,original.profile.digest)
  assert.notEqual(restored.grantId,original.grantId)
  assert.equal(f.access.prepareCustomerRun(thread,'restored-original-receipt',undefined,undefined,nativeSelection(f),'original-run').actorId,'recipient')
  f.directory.shareProvided('provider',f.preset.id,'target-project',{requestId:'withdraw-live',expectedRevision:1,enabled:false})
  assert.throws(()=>f.access.requireSharedExecutionScope(original,f.principal))
  assert.throws(()=>f.access.prepareCustomerRun(thread,'after-withdraw','real-message',undefined,nativeSelection(f),'original-run'))
})
test('获分配者只读助手实际隔离目录，不获得提供者设备、宿主路径或自用能力',t=>{
  const f=sharedAccess(t),input={projectId:'target-project',question:f.selection}
  assert.throws(()=>f.registry.getCapabilities('recipient',f.target))
  const runtime=f.access.customerAssistantRuntime(f.recipient,input)
  assert.equal(runtime.profile,'linux-docker-readonly-v1')
  assert.equal(runtime.available,true)
  assert.equal(runtime.capabilities.models[0].id,'isolated-real-model')
  assert.equal('sharedProfile' in runtime.capabilities,false)
  assert.deepEqual(Object.keys(runtime.device).sort(),['id','label','online','status'])
  const instanceId=`customer-${f.target.deviceId}-codex`,platform={instanceId:'codex'},raw={instanceId,checkedAt:'2026-10-26T00:00:00Z',auth:{status:'authenticated',email:'PRIVATE_PROVIDER_AUTH'},runtimePaths:{homePath:'/provider/private'},models:[{slug:'private-self-model'}],skills:[{path:'/provider/private/skill'}]}
  const projected=projectCustomerProviderResult(f.access,f.recipient,{providers:[platform,raw,{instanceId:'customer-unassigned-codex'}]})
  assert.equal(projected.providers.length,2)
  assert.equal(JSON.stringify(projected).includes('/provider/private'),false)
  assert.equal(JSON.stringify(projected).includes('PRIVATE_PROVIDER_AUTH'),false)
  assert.deepEqual(projected.providers[1].models,[])
  const changed=structuredClone(input);changed.question.configuration.model.model='tampered-model'
  assert.throws(()=>f.access.customerAssistantRuntime(f.recipient,changed),{code:'ASSISTANT_PARAMETERS_FIXED'})
  assert.throws(()=>f.access.customerAssistantRuntime(f.provider,input),{code:'ASSISTANT_PROVIDER_APPROVAL_REQUIRED'})
  f.members.get('recipient').canAdjustChat=true
  f.registry.updateCapabilities(f.principal,{...f.capability,revision:'catalog-v2',sharedProfile:{...profile(),models:[{id:'new-actual-model',supportedReasoningEfforts:['low']}]}})
  const stale=f.access.customerAssistantRuntime(f.recipient,input)
  assert.equal(stale.available,false);assert.equal(stale.reason.code,'CUSTOMER_MODEL_UNAVAILABLE')
  assert.equal(stale.capabilities.models[0].id,'new-actual-model')
  f.directory.shareProvided('provider',f.preset.id,'target-project',{requestId:'withdraw-runtime',expectedRevision:1,enabled:false})
  assert.throws(()=>f.access.customerAssistantRuntime(f.recipient,input),{code:'ASSISTANT_NOT_ASSIGNED'})
  assert.deepEqual(projectCustomerProviderResult(f.access,f.recipient,[raw]),[])
})
