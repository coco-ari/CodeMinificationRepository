import {requireLegacyBusinessTool} from './legacy-tools.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { users, projects, agents } from '../fixtures.mjs'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from './access.mjs'
import { authorizeAutoOpsRpc, filterAutoOpsShell, filterAutoOpsShellItem } from './rpc-policy.mjs'

function setup(t) {
  const sessionDb = new DatabaseSync(':memory:')
  const bindingDb = new DatabaseSync(':memory:')
  t.after(() => { sessionDb.close(); bindingDb.close() })
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  let time = 1000
  for (const user of users) sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(
    createHash('sha256').update(user.id).digest('hex'), user.id, `csrf-${user.id}`, 2000,
  )
  const catalog = structuredClone({ users, projects, agents })
  const access = createAutoOpsAccess({ sessionDb, bindingDb, catalog, now: () => time })
  const principal = (id) => access.authenticateCookie(`demo_session=${id}`)
  return { access, catalog, principal, sessionDb, bindingDb, advance: (next) => { time = next } }
}
const scope = { projectId: 'p-autoops', environmentId: 'env-test', agentId: 'a-project', visibility: 'private' }

test('替换账号目录后所有身份入口都读取最新停用状态，不沿用旧数组', t => {
  const {access,catalog,principal}=setup(t)
  const admin=principal('u-admin')
  access.recordNativeSession(admin,'replaced-directory')
  catalog.users=catalog.users.map(user=>user.id==='u-admin'?{...user,status:'disabled'}:user)
  assert.throws(()=>access.authenticateCookie('demo_session=u-admin'),{code:'UNAUTHENTICATED'})
  assert.throws(()=>access.refresh(admin),{code:'UNAUTHENTICATED'})
  assert.throws(()=>access.principalForNativeSession('replaced-directory'),{code:'UNAUTHENTICATED'})
  assert.equal(principal('u-lin').id,'u-lin')
})

test('停止接单拒绝会话、工具及RPC新授权，已接受绑定可完成落盘且任务仍重查授权', t => {
  const {access,catalog,principal}=setup(t)
  const admin=principal('u-admin')
  access.recordNativeSession(admin,'stopping-session')
  access.reserveThread(admin,{...scope,threadId:'stopping-thread'})
  access.stopAccepting();access.stopAccepting()
  for(const operation of [()=>access.authenticateCookie('demo_session=u-admin'),()=>access.refresh(admin),()=>access.principalForNativeSession('stopping-session'),()=>access.requireToolThread('stopping-thread'),()=>access.requireProject(admin,scope.projectId)])
    assert.throws(operation,{status:503,code:'AUTOOPS_STOPPING'})
  access.markThreadAccepted('stopping-thread')
  assert.equal(access.getThreadBinding('stopping-thread').scopeState,'locked')
  assert.equal(access.requireWorkspaceActor(admin.id,scope.projectId).workspaceAccess,'internal')
  catalog.users=catalog.users.map(user=>user.id===admin.id?{...user,status:'disabled'}:user)
  assert.throws(()=>access.requireWorkspaceActor(admin.id,scope.projectId),{status:404,code:'PROJECT_NOT_FOUND'})
})

test('real session rows, private/project scopes and immutable thread binding', (t) => {
  const { access, principal } = setup(t)
  const admin = principal('u-admin'), lin = principal('u-lin'), chen = principal('u-chen')
  access.bindThread(admin, { ...scope, threadId: 'private' })
  access.bindThread(admin, { ...scope, visibility: 'project', threadId: 'shared' })
  assert.equal(access.canSeeThread(lin, 'private'), false)
  assert.equal(access.canSeeThread(lin, 'shared'), true)
  assert.equal(access.canSeeThread(chen, 'shared'), false)
  assert.throws(() => access.bindThread(lin, { ...scope, threadId: 'private' }), { code: 'THREAD_BINDING_CONFLICT' })
  assert.throws(() => access.bindThread(admin, { ...scope, environmentId: 'env-prod', threadId: 'private' }), { code: 'THREAD_BINDING_CONFLICT' })
  assert.equal(access.bindThread(admin, { ...scope, threadId: 'private' }).ownerId, admin.id)
  assert.throws(() => access.requireThread(admin, 'not-bound'), { code: 'THREAD_NOT_FOUND' })
})

test('native auth mapping does not outlive AutoOps logout or expiry', (t) => {
  const { access, principal, sessionDb, advance } = setup(t)
  const admin = principal('u-admin')
  access.recordNativeSession(admin, 'native-session')
  assert.equal(access.principalForNativeSession('native-session').id, 'u-admin')
  advance(2001)
  assert.throws(() => access.principalForNativeSession('native-session'), { code: 'UNAUTHENTICATED' })
  advance(1000)
  sessionDb.prepare('DELETE FROM sessions WHERE uid=?').run('u-admin')
  assert.throws(() => access.refresh(admin), { code: 'UNAUTHENTICATED' })
  assert.throws(() => access.principalForNativeSession('native-session'), { code: 'UNAUTHENTICATED' })
})

test('shared references cannot publish private data and forks remain private', (t) => {
  const { access, principal } = setup(t)
  const admin = principal('u-admin')
  access.bindThread(admin, { ...scope, threadId: 'private' })
  access.bindThread(admin, { ...scope, visibility: 'project', threadId: 'shared' })
  assert.throws(() => access.requireReference(admin, 'private', 'shared'), { code: 'REFERENCE_AUDIENCE_MISMATCH' })
  assert.equal(access.requireReference(admin, 'shared', 'private').threadId, 'shared')
  assert.equal(access.forkBinding(principal('u-lin'), 'shared', 'fork').visibility, 'private')
  assert.equal(access.canSeeThread(admin, 'fork'), false)
})

test('scope revocation blocks tools, csrf and bootstrap reflect the authenticated user', (t) => {
  const { access, principal, catalog } = setup(t)
  const admin = principal('u-admin')
  access.bindThread(admin, { ...scope, threadId: 'thread' })
  assert.equal(access.requireToolThread('thread').binding.environmentId, 'env-test')
  access.requireCsrf(admin, 'csrf-u-admin')
  assert.throws(() => access.requireCsrf(admin, 'csrf-u-lin'), { code: 'CSRF' })
  assert.throws(() => access.authenticateCookie('demo_session=u-admin; demo_session=u-lin'), { code: 'UNAUTHENTICATED' })
  assert.deepEqual(access.bootstrap(principal('u-lin')).projects.map((p) => p.id), ['p-autoops'])
  catalog.projects.find((p) => p.id === 'p-autoops').memberIds = ['u-lin']
  assert.throws(() => access.requireToolThread('thread'), { code: 'THREAD_SCOPE_REVOKED' })
  assert.equal(access.canSeeThread(admin, 'thread'), false)
})

test('pending attachment is private to its actual uploader, final claim follows shared audience', (t) => {
  const { access, principal } = setup(t)
  const admin = principal('u-admin'), lin = principal('u-lin'), chen = principal('u-chen')
  access.bindThread(admin, { ...scope, visibility: 'project', threadId: 'shared' })
  access.bindThread(admin, { ...scope, threadId: 'private' })
  access.recordPendingAttachment(lin, 'pending-lin')
  assert.throws(() => access.requireAttachment(admin, 'pending-lin'), { code: 'ATTACHMENT_NOT_FOUND' })
  access.recordClaimedAttachment(lin, 'pending-lin', 'final-shared', 'shared')
  assert.equal(access.requireAttachment(admin, 'final-shared').ownerId, 'u-lin')
  assert.throws(() => access.requireAttachment(chen, 'final-shared'), { code: 'THREAD_NOT_FOUND' })
  access.recordThreadAttachment(admin, 'final-private', 'private')
  assert.throws(() => access.requireAttachment(admin, 'final-private', 'shared'), { code: 'REFERENCE_AUDIENCE_MISMATCH' })
  assert.deepEqual(access.visibleThreadIds(lin), ['shared'])
})


test('RPC policy allows native conversation controls but refuses identity and runtime escalation', (t) => {
  const { access, principal } = setup(t)
  const admin = principal('u-admin'), lin = principal('u-lin')
  access.bindThread(admin, { ...scope, visibility: 'project', threadId: 'shared' })
  const previous = process.env.AUTOOPS_T3_MODEL
  process.env.AUTOOPS_T3_MODEL = 'grok-test'
  t.after(() => { if (previous === undefined) delete process.env.AUTOOPS_T3_MODEL; else process.env.AUTOOPS_T3_MODEL = previous })
  const call = (payload, actor = admin) => authorizeAutoOpsRpc(access, actor, 'orchestration.dispatchCommand', { threadId: 'shared', ...payload })
  for (const type of ['run.interrupt', 'queued-run.cancel', 'queued-run.edit', 'queued-message.promote-to-steer', 'queue.resume', 'runtime-request.respond', 'prepared-run.retry']) call({ type })
  call({ type: 'message.dispatch', modelSelection: { instanceId: 'codex', model: 'grok-test' }, runtimeMode: 'approval-required' })
  for (const extra of [
    { runtimeMode: 'full-access' }, { modelSelection: { instanceId: 'codex', model: 'gpt-5' } },
    { modelSelection: { instanceId: 'other', model: 'grok-test' } },
    { importedNativeThread: { ref: { nativeId: 'another-user-native-thread' } } },
    { dispatchMode: { type: 'defer_start', workspaceStrategy: { type: 'worktree' } } },
    { senderThreadId: 'private-source' }, { createdBy: 'system' },
  ]) assert.throws(() => call({ type: 'message.dispatch', ...extra }), { code: 'AUTOOPS_OPERATION_FORBIDDEN' })
  assert.throws(() => call({ type: 'thread.delete' }, lin), { code: 'AUTOOPS_OPERATION_FORBIDDEN' })
  assert.throws(() => authorizeAutoOpsRpc(access, admin, 'filesystem.browse', { path: '/' }), { code: 'AUTOOPS_OPERATION_FORBIDDEN' })
  assert.throws(() => authorizeAutoOpsRpc(access, admin, 'assets.createUrl', { resource: { _tag: 'workspace-file', threadId: 'shared', relativePath: 'secret' } }), { code: 'AUTOOPS_OPERATION_FORBIDDEN' })
})

test('RPC cross-thread input and shell replay preserve authorization and native watermarks', (t) => {
  const { access, principal } = setup(t)
  const admin = principal('u-admin'), lin = principal('u-lin')
  access.bindThread(admin, { ...scope, visibility: 'project', threadId: 'shared' })
  access.bindThread(admin, { ...scope, threadId: 'private' })
  assert.throws(() => authorizeAutoOpsRpc(access, admin, 'orchestration.dispatchCommand', {
    type: 'message.dispatch', threadId: 'shared', context: { threadId: 'private' },
  }), { code: 'REFERENCE_AUDIENCE_MISMATCH' })
  const shell = filterAutoOpsShell(access, lin, { snapshotSequence: 107, projects: [{id:'p-autoops'},{id:'p-cabinet'}], threads:[{id:'private'},{id:'shared'}], archivedThreads:[] })
  assert.equal(shell.snapshotSequence, 107)
  assert.deepEqual(shell.threads, [{id:'shared'}])
  assert.deepEqual(shell.projects, [{id:'p-autoops'}])
  assert.equal(filterAutoOpsShellItem(access, lin, {kind:'thread.updated',sequence:108,thread:{id:'private'}}), null)
  assert.deepEqual(filterAutoOpsShellItem(access, lin, {kind:'synchronized'}), {kind:'synchronized'})
  authorizeAutoOpsRpc(access, lin, 'orchestration.dispatchCommand', {type:'thread.fork',sourceThreadId:'shared',targetThreadId:'new-fork'})
  assert.equal(access.getThreadBinding('new-fork'), undefined, 'policy cannot claim an unchecked native fork target')
})


test('generated attachments derive owner from the immutable binding and deleted scope cannot recreate them', (t) => {
 const {access,principal}=setup(t), admin=principal('u-admin'), lin=principal('u-lin')
 access.bindThread(admin,{...scope,threadId:'generated',visibility:'project'})
 access.recordGeneratedAttachment('generated','html-safe',{name:'view.html',mimeType:'text/html',sizeBytes:12})
 assert.equal(access.requireAttachment(lin,'html-safe').ownerId,'u-admin')
 assert.equal(access.requireAttachment(lin,'html-safe').name,'view.html')
 access.markThreadDeleted('generated')
 assert.throws(()=>access.recordGeneratedAttachment('generated','another',{name:'x',mimeType:'text/plain',sizeBytes:1}))
 assert.equal(access.canSeeThread(lin,'generated'),false)
 assert.equal(filterAutoOpsShellItem(access,lin,{kind:'thread.removed',threadId:'generated',sequence:7}).sequence,7)
})

test('compatibility history remains readable but cannot run, fork, mutate or invoke business tools', (t) => {
 const {access,principal,bindingDb}=setup(t), admin=principal('u-admin')
 access.bindThread(admin,{...scope,threadId:'legacy'})
 bindingDb.prepare('UPDATE t3_thread_bindings SET compatibility_read_only=1 WHERE thread_id=?').run('legacy')
 assert.equal(access.requireThread(admin,'legacy').compatibilityReadOnly,true)
 authorizeAutoOpsRpc(access,admin,'orchestration.getThreadProjection',{threadId:'legacy'})
 authorizeAutoOpsRpc(access,admin,'orchestration.dispatchCommand',{type:'thread.archive',threadId:'legacy'})
 for (const type of ['message.dispatch','checkpoint.rollback','queued-run.edit']) assert.throws(()=>authorizeAutoOpsRpc(access,admin,'orchestration.dispatchCommand',{type,threadId:'legacy'}))
 assert.throws(()=>authorizeAutoOpsRpc(access,admin,'orchestration.dispatchCommand',{type:'thread.fork',sourceThreadId:'legacy',targetThreadId:'copy'}))
 assert.throws(()=>authorizeAutoOpsRpc(access,admin,'assets.persistChatAttachments',{threadId:'legacy'}))
 assert.throws(()=>access.requireToolThread('legacy'))
 authorizeAutoOpsRpc(access,admin,'server.updateSettings',{patch:{responseStreamingMode:'turn'}})
 assert.throws(()=>authorizeAutoOpsRpc(access,admin,'server.updateSettings',{patch:{defaultRuntimeMode:'full-access'}}))
})


test('native child reads inherit the complete parent ACL chain and only personal changes are writable', t=>{
 const {access,principal,bindingDb}=setup(t),admin=principal('u-admin'),lin=principal('u-lin')
 for(const threadId of ['parent','child','grandchild'])access.bindThread(admin,{...scope,visibility:'project',threadId})
 bindingDb.prepare('INSERT INTO t3_native_subagent_bindings VALUES(?,?,?,?)').run('child','parent','native-child','now')
 bindingDb.prepare('INSERT INTO t3_native_subagent_bindings VALUES(?,?,?,?)').run('grandchild','child','native-grandchild','now')
 assert.equal(access.requireThread(lin,'grandchild').nativeParentThreadId,'child')
 assert.equal(access.requireToolThread('grandchild').binding.projectId,'p-autoops')
 authorizeAutoOpsRpc(access,lin,'orchestration.getThreadProjection',{threadId:'child'})
 authorizeAutoOpsRpc(access,lin,'orchestration.dispatchCommand',{type:'thread.archive',threadId:'child'})
 for(const type of ['message.dispatch','thread.stop','thread.delete','checkpoint.rollback','runtime-request.respond'])assert.throws(()=>authorizeAutoOpsRpc(access,admin,'orchestration.dispatchCommand',{type,threadId:'child'}))
 assert.throws(()=>authorizeAutoOpsRpc(access,admin,'orchestration.dispatchCommand',{type:'thread.fork',sourceThreadId:'child',targetThreadId:'copy'}))
 access.markThreadDeleted('parent')
 assert.equal(access.canSeeThread(lin,'grandchild'),false)
 assert.throws(()=>access.requireThread(admin,'child'))
 assert.throws(()=>access.requireToolThread('grandchild'))
})


test('legacy dynamic tool forwarding requires verified exact native identity and fixed business allowlist', t=>{
 const {access,principal,bindingDb}=setup(t),admin=principal('u-admin')
 access.bindThread(admin,{...scope,threadId:'legacy-native'})
 assert.throws(()=>requireLegacyBusinessTool('legacy-native','native-1','ask_user',null,access))
 bindingDb.prepare('UPDATE t3_thread_bindings SET continuation_verified=1,native_thread_id=? WHERE thread_id=?').run('native-1','legacy-native')
 assert.deepEqual(requireLegacyBusinessTool('legacy-native','native-1','ask_user',null,access),{server:'t3-code',tool:'ask_user'})
 for(const [native,tool,namespace] of [['wrong','ask_user',null],['native-1','exec_command',null],['native-1','ask_user','other']])assert.throws(()=>requireLegacyBusinessTool('legacy-native',native,tool,namespace,access))
 access.markThreadDeleted('legacy-native')
 assert.throws(()=>requireLegacyBusinessTool('legacy-native','native-1','read_project_document',null,access))
})

test('verified legacy native forks inherit tools only after trusted success and retain source audience', t=>{
 const {access,principal,bindingDb}=setup(t),admin=principal('u-admin'),lin=principal('u-lin')
 access.bindThread(admin,{...scope,threadId:'legacy-source',visibility:'project'})
 bindingDb.prepare('UPDATE t3_thread_bindings SET continuation_verified=1,native_thread_id=? WHERE thread_id=?').run('native-source','legacy-source')
 access.forkBinding(lin,'legacy-source','native-fork')
 assert.throws(()=>requireLegacyBusinessTool('native-fork','native-new','ask_user',null,access))
 assert.throws(()=>access.recordLegacyNativeFork('legacy-source','native-fork','wrong','native-new'))
 access.recordLegacyNativeFork('legacy-source','native-fork','native-source','native-new')
 assert.deepEqual(requireLegacyBusinessTool('native-fork','native-new','ask_user',null,access),{server:'t3-code',tool:'ask_user'})
 access.recordLegacyNativeFork('legacy-source','native-fork','native-source','native-new')
 assert.throws(()=>access.recordLegacyNativeFork('legacy-source','native-fork','native-source','different'))
 access.recordLegacyNativeFork('legacy-source','legacy-source','native-source','backup-copy')
 assert.equal(access.getThreadBinding('legacy-source').nativeThreadId,'native-source')
 access.bindThread(lin,{...scope,environmentId:'env-prod',threadId:'different-scope'})
 assert.throws(()=>access.recordLegacyNativeFork('legacy-source','different-scope','native-source','new-other'))
 access.markThreadDeleted('legacy-source')
 assert.throws(()=>access.recordLegacyNativeFork('legacy-source','native-fork','native-source','native-new'))
})

function customerScope(t, ownerId = 'u-guest') {
  const previous = process.env.AUTOOPS_CUSTOMER_AGENTS
  process.env.AUTOOPS_CUSTOMER_AGENTS = '1'
  t.after(() => { if (previous === undefined) delete process.env.AUTOOPS_CUSTOMER_AGENTS; else process.env.AUTOOPS_CUSTOMER_AGENTS = previous })
  const setupResult = setup(t), {access,principal} = setupResult, registry = access.customerRegistry
  const paired = registry.consumePairing(registry.createPairing(ownerId).pairingCode,{label:'本机'})
  const devicePrincipal = registry.authenticateToken(paired.deviceToken)
  registry.registerWorkspace(devicePrincipal,{registeredWorkspaceId:'local-project',projectId:'p-autoops',label:'客户项目',workspaceBindingRevision:1,runtimeId:'codex'})
  const executionBinding = {kind:'customer',deviceId:paired.device.id,registeredWorkspaceId:'local-project',workspaceBindingRevision:1,runtimeId:'codex'}
  return {...setupResult,owner:principal(ownerId),registry,paired,devicePrincipal,executionBinding}
}

test('external members can bind their own customer directory without platform internal access', t => {
  const {access,owner,principal,executionBinding} = customerScope(t)
  const binding = access.reserveThread(owner,{...scope,threadId:'customer-draft',executionBinding})
  assert.equal(binding.executionBinding.kind,'customer')
  assert.equal(binding.scopeState,'draft')
  assert.equal(access.canSeeThread(owner,'customer-draft'),true)
  assert.equal(access.canSeeThread(principal('u-admin'),'customer-draft'),false)
  assert.deepEqual(access.threadAudience(binding),[owner.id])
  assert.throws(()=>access.reserveThread(owner,{...scope,threadId:'shared-customer',visibility:'project',executionBinding}),{code:'CUSTOMER_OWNER_REQUIRED'})
  assert.throws(()=>access.reserveThread(owner,{...scope,threadId:'report-customer',agentId:'a-report',executionBinding}),{code:'INVALID_CUSTOMER_SCOPE'})
  assert.throws(()=>access.reserveThread(owner,{...scope,threadId:'prod-customer',environmentId:'env-prod',executionBinding}),{code:'ENVIRONMENT_FORBIDDEN'})
  assert.throws(()=>access.requireToolThread('customer-draft'),{code:'CUSTOMER_BUSINESS_TOOLS_DISABLED'})
})

test('customer conversation locks exact execution target after acceptance and history survives revoke', t => {
  const {access,owner,registry,devicePrincipal,executionBinding,paired} = customerScope(t)
  access.reserveThread(owner,{...scope,threadId:'customer-history',executionBinding})
  assert.throws(()=>access.beginThreadSubmission(owner,'customer-history','cmd-1'),{code:'CUSTOMER_DEVICE_OFFLINE'})
  registry.markConnected(devicePrincipal)
  assert.equal(access.beginThreadSubmission(owner,'customer-history','cmd-1').scopeState,'submitting')
  registry.registerWorkspace(devicePrincipal,{registeredWorkspaceId:'local-other',projectId:'p-autoops',label:'其他目录',workspaceBindingRevision:1,runtimeId:'codex'})
  assert.throws(()=>access.reserveThread(owner,{...scope,threadId:'customer-history',executionBinding:{...executionBinding,registeredWorkspaceId:'local-other'}}),{code:'THREAD_SCOPE_LOCKED'})
  access.finishThreadSubmission('customer-history','cmd-1',true)
  registry.revokeWorkspace(devicePrincipal,'local-project')
  registry.revokeCredential(owner.id,paired.device.id)
  assert.equal(access.requireThread(owner,'customer-history').scopeState,'locked')
  assert.throws(()=>access.requireThreadExecution(owner,'customer-history'),{code:'CUSTOMER_DEVICE_DISABLED'})
  delete process.env.AUTOOPS_CUSTOMER_AGENTS
  assert.equal(access.requireThread(owner,'customer-history').threadId,'customer-history')
  assert.throws(()=>access.requireThreadExecution(owner,'customer-history'),{code:'CUSTOMER_AGENTS_DISABLED'})
})

test('old bindings normalize to platform and do not gain remote capabilities', t => {
  const {access,principal,bindingDb} = setup(t)
  access.bindThread(principal('u-admin'),{...scope,threadId:'old-platform'})
  bindingDb.prepare('UPDATE t3_thread_bindings SET execution_binding_json=NULL WHERE thread_id=?').run('old-platform')
  assert.deepEqual(access.getThreadBinding('old-platform').executionBinding,{kind:'platform'})
})
