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

test('会话接受后及发送确认中仍能调整可见范围，执行绑定不变且权限即时生效', t => {
  const { access, principal, bindingDb } = setup(t)
  const owner = principal('u-admin'), member = principal('u-lin')
  access.reserveThread(owner, { ...scope, threadId: 'mutable' })
  access.beginThreadSubmission(owner, 'mutable', 'sending')
  let notifications = 0
  const unsubscribe = access.subscribeVisibilityChanges(() => { notifications++ })
  const shared = access.updateThreadVisibility(owner, 'mutable', { expectedVisibility: 'private', visibility: 'project' })
  assert.equal(shared.scopeState, 'submitting')
  assert.equal(access.canSeeThread(member, 'mutable'), false)
  access.finishThreadSubmission('mutable', 'sending', true)
  assert.equal(access.canSeeThread(member, 'mutable'), true)
  access.recordThreadAttachment(owner, 'mutable-attachment', 'mutable')
  assert.equal(access.requireAttachment(member, 'mutable-attachment').threadId, 'mutable')
  const before = access.getThreadBinding('mutable')
  assert.throws(() => access.updateThreadVisibility(member, 'mutable', { expectedVisibility: 'project', visibility: 'private' }), { code: 'THREAD_OWNER_REQUIRED' })
  access.updateThreadVisibility(owner, 'mutable', { expectedVisibility: 'project', visibility: 'private' })
  assert.deepEqual(access.getThreadBinding('mutable'), { ...before, visibility: 'private' })
  assert.equal(access.canSeeThread(member, 'mutable'), false)
  assert.throws(() => access.requireAttachment(member, 'mutable-attachment'), { code: 'THREAD_NOT_FOUND' })
  assert.throws(() => authorizeAutoOpsRpc(access, member, 'orchestration.getThreadProjection', { threadId: 'mutable' }), { status: 404 })
  assert.equal(bindingDb.prepare('SELECT submission_command_id FROM t3_thread_bindings WHERE thread_id=?').get('mutable').submission_command_id, 'sending')
  assert.throws(() => access.reserveThread(owner, { ...scope, threadId: 'mutable', environmentId: 'env-prod' }), { code: 'THREAD_SCOPE_LOCKED' })
  assert.equal(notifications, 2)
  assert.equal(bindingDb.prepare('SELECT COUNT(*) AS count FROM t3_thread_visibility_changes WHERE thread_id=?').get('mutable').count, 2)
  unsubscribe()
})

test('可见性独立更新拒绝权限和并发覆盖，父会话变更同时同步原生子任务', t => {
  const { access, principal, bindingDb, catalog } = setup(t)
  const owner = principal('u-admin')
  for (const id of ['parent-visible', 'child-visible']) access.bindThread(owner, { ...scope, threadId: id })
  bindingDb.prepare('INSERT INTO t3_native_subagent_bindings VALUES(?,?,?,?)').run('child-visible', 'parent-visible', 'native-visible', 'now')
  assert.throws(() => access.updateThreadVisibility(owner, 'child-visible', { expectedVisibility: 'private', visibility: 'project' }), { code: 'THREAD_VISIBILITY_INHERITED' })
  access.updateThreadVisibility(owner, 'parent-visible', { expectedVisibility: 'private', visibility: 'project' })
  assert.equal(access.requireThread(principal('u-lin'), 'child-visible').visibility, 'project')
  assert.throws(() => access.updateThreadVisibility(owner, 'parent-visible', { expectedVisibility: 'private', visibility: 'private' }), { code: 'THREAD_VISIBILITY_CHANGED' })
  catalog.users.find(user => user.id === owner.id).role = 'member'
  const membership = catalog.projects.find(project => project.id === scope.projectId).memberships.find(member => member.userId === owner.id)
  membership.role = 'reader'; membership.canAdjustChat = false; membership.environmentIds = ['env-test']
  assert.equal(access.updateThreadVisibility(owner, 'parent-visible', { expectedVisibility: 'project', visibility: 'private' }).visibility, 'private')
  membership.status = 'disabled'
  assert.throws(() => access.updateThreadVisibility(owner, 'parent-visible', { expectedVisibility: 'private', visibility: 'project' }), { status: 404 })
})

test('可见性镜像随父子会话持久保存，必要审计失败时原子回滚', t => {
  const { access, principal, bindingDb } = setup(t)
  const owner = principal('u-admin')
  access.bindThread(owner, { ...scope, threadId: 'audit-visible' })
  const question = { assistantId: 'original', presetRevision: 1, configuration: { visibility: 'private', model: { model: 'fixed' } } }
  bindingDb.prepare('UPDATE t3_thread_bindings SET question_json=? WHERE thread_id=?').run(JSON.stringify(question), 'audit-visible')
  access.updateThreadVisibility(owner, 'audit-visible', { expectedVisibility: 'private', visibility: 'project' })
  assert.deepEqual(access.getThreadBinding('audit-visible').question, { ...question, configuration: { ...question.configuration, visibility: 'project' } })
  bindingDb.exec("CREATE TRIGGER reject_visibility_audit BEFORE INSERT ON t3_thread_visibility_changes BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  assert.throws(() => access.updateThreadVisibility(owner, 'audit-visible', { expectedVisibility: 'project', visibility: 'private' }), /audit unavailable/)
  assert.equal(access.getThreadBinding('audit-visible').visibility, 'project')
  assert.equal(access.getThreadBinding('audit-visible').question.configuration.visibility, 'project')
})

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
  catalog.users.find(user => user.id === admin.id).role = 'member'
  catalog.projects.find(p => p.id === 'p-autoops').memberships.find(member => member.userId === admin.id).status = 'disabled'
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

test('所有者共享本机会话后成员可沿原电脑操作，转私有拒绝后续请求及排队执行', t => {
  const {access, owner, principal, executionBinding, registry, devicePrincipal, bindingDb} = customerScope(t, 'u-admin')
  const member = principal('u-lin')
  registry.markConnected(devicePrincipal)
  access.bindThread(owner, {...scope, environmentId:null, threadId:'computer-collaboration', executionBinding})
  assert.equal(access.canSeeThread(member, 'computer-collaboration'), false)
  access.updateThreadVisibility(owner, 'computer-collaboration', {expectedVisibility:'private', visibility:'project'})
  assert.equal(access.canSeeThread(member, 'computer-collaboration'), true)
  assert.deepEqual(access.requireThreadExecution(member, 'computer-collaboration').executionBinding, executionBinding)
  assert.deepEqual(access.customerExecutionSource('computer-collaboration', member.id), {ownerId:owner.id, projectId:scope.projectId})
  access.recordMessageActor(member, 'computer-collaboration', 'collaborator-command', 'collaborator-message')
  access.prepareCustomerRun('computer-collaboration', 'collaborator-run', 'collaborator-message')
  assert.equal(access.requireCustomerRunActor('computer-collaboration', 'collaborator-run'), member.id)
  assert.equal(bindingDb.prepare('SELECT actor_id FROM t3_message_actors WHERE message_id=?').get('collaborator-message').actor_id, member.id)
  access.recordThreadAttachment(member, 'collaborator-attachment', 'computer-collaboration')
  assert.equal(access.requireCustomerAttachment(owner.id, 'computer-collaboration', 'collaborator-attachment').id, 'collaborator-attachment')
  assert.throws(() => access.updateThreadVisibility(member, 'computer-collaboration', {expectedVisibility:'project', visibility:'private'}), {code:'THREAD_OWNER_REQUIRED'})
  access.updateThreadVisibility(owner, 'computer-collaboration', {expectedVisibility:'project', visibility:'private'})
  assert.equal(access.canSeeThread(member, 'computer-collaboration'), false)
  assert.throws(() => access.requireThreadExecution(member, 'computer-collaboration'), {status:404})
  assert.throws(() => access.requireCustomerRunActor('computer-collaboration', 'collaborator-run'), {status:404})
  assert.throws(() => access.prepareCustomerRun('computer-collaboration', 'queued-after-revoke', 'collaborator-message'), {status:404})
  assert.deepEqual(access.requireThreadExecution(owner, 'computer-collaboration').executionBinding, executionBinding)
})

test('共享电脑仍要求当前成员及环境范围，不允许改绑或冒充所有者新建会话', t => {
  const {access, owner, principal, executionBinding, registry, devicePrincipal, catalog} = customerScope(t, 'u-admin')
  registry.markConnected(devicePrincipal)
  access.bindThread(owner, {...scope, threadId:'computer-member', visibility:'project', executionBinding})
  assert.equal(access.canSeeThread(principal('u-lin'), 'computer-member'), true)
  assert.equal(access.canSeeThread(principal('u-guest'), 'computer-member'), false)
  assert.throws(() => access.reserveThread(principal('u-lin'), {...scope, threadId:'stolen-source', executionBinding}), {code:'CUSTOMER_SHARED_ISOLATION_UNVERIFIED'})
  catalog.projects.find(project => project.id === scope.projectId).memberships.find(member => member.userId === 'u-lin').status = 'disabled'
  assert.equal(access.canSeeThread(principal('u-lin'), 'computer-member'), false)
  assert.throws(() => access.customerExecutionSource('computer-member','u-lin'), {status:404})
})

test('external members can bind their own customer directory without platform internal access', t => {
  const {access,owner,principal,executionBinding} = customerScope(t)
  const binding = access.reserveThread(owner,{...scope,environmentId:null,threadId:'customer-draft',executionBinding})
  assert.equal(binding.executionBinding.kind,'customer')
  assert.equal(binding.scopeState,'draft')
  assert.equal(access.canSeeThread(owner,'customer-draft'),true)
  assert.equal(access.canSeeThread(principal('u-admin'),'customer-draft'),false)
  assert.deepEqual(access.threadAudience(binding),[owner.id])
  assert.equal(access.reserveThread(owner,{...scope,environmentId:null,threadId:'shared-customer',visibility:'project',executionBinding}).visibility,'project')
  assert.throws(()=>access.reserveThread(owner,{...scope,environmentId:null,threadId:'report-customer',agentId:'a-report',executionBinding}),{code:'INVALID_CUSTOMER_SCOPE'})
  assert.throws(()=>access.reserveThread(owner,{...scope,environmentId:null,threadId:'prod-customer',environmentId:'env-prod',executionBinding}),{code:'ENVIRONMENT_FORBIDDEN'})
  assert.throws(()=>access.requireToolThread('customer-draft'),{code:'CUSTOMER_BUSINESS_TOOLS_DISABLED'})
})

test('customer conversation locks exact execution target after acceptance and history survives revoke', t => {
  const {access,owner,registry,devicePrincipal,executionBinding,paired} = customerScope(t)
  access.reserveThread(owner,{...scope,environmentId:null,threadId:'customer-history',executionBinding})
  assert.throws(()=>access.beginThreadSubmission(owner,'customer-history','cmd-1'),{code:'CUSTOMER_DEVICE_OFFLINE'})
  registry.markConnected(devicePrincipal)
  assert.equal(access.beginThreadSubmission(owner,'customer-history','cmd-1').scopeState,'submitting')
  registry.registerWorkspace(devicePrincipal,{registeredWorkspaceId:'local-other',projectId:'p-autoops',label:'其他目录',workspaceBindingRevision:1,runtimeId:'codex'})
  assert.throws(()=>access.reserveThread(owner,{...scope,environmentId:null,threadId:'customer-history',executionBinding:{...executionBinding,registeredWorkspaceId:'local-other'}}),{code:'THREAD_SCOPE_LOCKED'})
  access.finishThreadSubmission('customer-history','cmd-1',true)
  assert.equal(access.updateThreadVisibility(owner, 'customer-history', { expectedVisibility: 'private', visibility: 'project' }).visibility, 'project')
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

test('外部角色迁为无环境后，历史自用电脑保留固定身份和未知收据，不放开新环境绑定', t => {
  const { access, owner, principal, executionBinding, registry, devicePrincipal, bindingDb } = customerScope(t)
  registry.markConnected(devicePrincipal)
  access.reserveThread(owner, { ...scope, environmentId: null, threadId: 'legacy-self-computer', executionBinding })
  access.beginThreadSubmission(owner, 'legacy-self-computer', 'original-unknown-command')
  // 隔离旧记录保留原环境标识；新角色不改写已接受请求的执行身份。
  bindingDb.prepare('UPDATE t3_thread_bindings SET environment_id=? WHERE thread_id=?').run('env-test', 'legacy-self-computer')
  const binding = access.requireThread(owner, 'legacy-self-computer')
  assert.equal(binding.environmentId, 'env-test')
  assert.deepEqual(binding.executionBinding, executionBinding)
  assert.equal(access.beginThreadSubmission(owner, binding.threadId, 'original-unknown-command').scopeState, 'submitting')
  assert.equal(access.canSeeThread(principal('u-admin'), binding.threadId), false)
  assert.throws(() => access.reserveThread(owner, { ...scope, threadId: 'new-forged-environment', executionBinding }), { code: 'ENVIRONMENT_FORBIDDEN' })
  assert.throws(() => access.requireToolThread(binding.threadId), { code: 'CUSTOMER_BUSINESS_TOOLS_DISABLED' })
})


test('会话列表只读一次授权目录，后续请求立即反映撤权和停用', t => {
  const { access, catalog, principal } = setup(t)
  const admin=principal('u-admin'), lin=principal('u-lin')
  const threads=Array.from({length:100},(_,i)=>({id:`batch-${i}`}))
  for(const thread of threads) access.bindThread(admin,{...scope,threadId:thread.id,visibility:'project'})
  access.bindThread(admin,{...scope,threadId:'batch-private'})
  const snapshot={projects:[{id:'p-autoops'}],threads:[...threads,{id:'batch-private'}]}
  const reads={users:0,projects:0,agents:0}, values={...catalog}
  for(const key of Object.keys(reads)) Object.defineProperty(catalog,key,{get(){reads[key]++;return values[key]},set(value){values[key]=value}})
  assert.deepEqual(filterAutoOpsShell(access,lin,snapshot).threads,threads)
  assert.deepEqual(reads,{users:1,projects:1,agents:1})
  catalog.projects=values.projects.map(p=>p.id==='p-autoops'?{...p,memberships:p.memberships.filter(m=>m.userId!==lin.id)}:p)
  assert.deepEqual(filterAutoOpsShell(access,lin,snapshot).threads,[])
  catalog.users=values.users.map(u=>u.id===lin.id?{...u,status:'disabled'}:u)
  assert.throws(()=>filterAutoOpsShell(access,lin,snapshot),{code:'UNAUTHENTICATED'})
  catalog.users=values.users.map(u=>u.id===lin.id?{...u,status:'active'}:u)
  assert.deepEqual(filterAutoOpsShell(access,lin,snapshot).threads,[])
})
