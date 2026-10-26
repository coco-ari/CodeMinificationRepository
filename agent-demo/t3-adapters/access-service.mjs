import { assertQuestionBinding, nativeQuestionModel } from './assistants/index.ts'
import { createProjectAccess } from './project-access.mjs'
import { createCustomerRegistry, normalizeExecutionBinding, requireCustomerAgentsEnabled } from './customer-registry.mjs'
import { createAccessIdentity, initializeAccessIdentitySchema } from './access-identity.mjs'
import { projectAccessBootstrap } from './access-bootstrap.mjs'

// 业务授权拥有线程和附件的业务绑定，原生运行与事件仍由 T3 管理。
export class AutoOpsAccessError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'AutoOpsAccessError'
    this.status = status
    this.code = code
  }
}

const fail = (status, code, message) => {
  throw new AutoOpsAccessError(status, code, message)
}
const identifier = (value, name) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f]/u.test(value))
    fail(400, 'INVALID_ID', `${name}无效`)
  return value
}
const sameExecutionBinding = (source, target) => JSON.stringify(normalizeExecutionBinding(source.executionBinding)) === JSON.stringify(normalizeExecutionBinding(target.executionBinding))
const requireMatchingWorkspaces = (source, target) => {
  if (!sameExecutionBinding(source, target) || source.executionBinding?.kind === 'customer')
    fail(403, 'REFERENCE_WORKSPACE_MISMATCH', '客户工作区首版不支持跨对话引入资料')
  if ((source.workspaceType || target.workspaceType) &&
      ['projectId', 'workspaceType', 'workspaceVersionId'].some((key) => source[key] !== target[key]))
    fail(403, 'REFERENCE_WORKSPACE_MISMATCH', '不同工作区或版本的历史资料不能带入此会话，请使用独立新对话')
}
const fromRow = (row) => row && ({
  threadId: row.thread_id,
  projectId: row.project_id,
  environmentId: row.environment_id || null,
  agentId: row.agent_id,
  ownerId: row.owner_id,
  visibility: row.visibility,
  createdAt: row.created_at,
  executionBinding: normalizeExecutionBinding(row.execution_binding_json ? JSON.parse(row.execution_binding_json) : undefined),
  ...(row.question_json ? { question: JSON.parse(row.question_json) } : {}),
  scopeState: row.scope_state || 'locked',
  scopeLocked: (row.scope_state || 'locked') === 'locked',
  ...(row.workspace_type ? { workspaceType: row.workspace_type, ...(row.workspace_version_id ? { workspaceVersionId: row.workspace_version_id } : {}) } : {}),
  compatibilityReadOnly: Boolean(row.compatibility_read_only),
  continuationVerified: Boolean(row.continuation_verified),
  ...(row.native_thread_id ? {nativeThreadId:row.native_thread_id} : {}),
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
})

export function initializeAutoOpsAccessSchema(db) {
  initializeAccessIdentitySchema(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS t3_thread_bindings (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('private','project')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS t3_thread_bindings_project ON t3_thread_bindings(project_id);
    CREATE TABLE IF NOT EXISTS t3_native_subagent_bindings (
      child_thread_id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL,
      native_thread_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS t3_native_subagent_bindings_parent ON t3_native_subagent_bindings(parent_thread_id);
    CREATE TABLE IF NOT EXISTS t3_attachment_access (
      attachment_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS t3_thread_inputs (
      thread_id TEXT NOT NULL, run_id TEXT NOT NULL, input_id TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(thread_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS t3_thread_inputs_identity ON t3_thread_inputs(input_id);
    CREATE TABLE IF NOT EXISTS t3_request_actors (
      command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL,
      target_id TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS t3_message_actors (
      thread_id TEXT NOT NULL, message_id TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE,
      actor_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(thread_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS t3_thread_input_references (
      thread_id TEXT NOT NULL, input_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(thread_id,input_id)
    );
  `)
  if (!db.prepare('PRAGMA table_info(t3_thread_bindings)').all().some((column) => column.name === 'revoked_at'))
    db.exec('ALTER TABLE t3_thread_bindings ADD COLUMN revoked_at TEXT')
  for (const [name, type] of [['compatibility_read_only','INTEGER NOT NULL DEFAULT 0'],['continuation_verified','INTEGER NOT NULL DEFAULT 0'],['native_thread_id','TEXT'],['workspace_type','TEXT'],['workspace_version_id','TEXT'],['scope_state',"TEXT NOT NULL DEFAULT 'locked'"],['submission_command_id','TEXT'],['execution_binding_json','TEXT'],['question_json','TEXT']]) {
    if (!db.prepare('PRAGMA table_info(t3_thread_bindings)').all().some((column) => column.name === name)) db.exec(`ALTER TABLE t3_thread_bindings ADD COLUMN ${name} ${type}`)
  }
  db.exec('SAVEPOINT autoops_actor_upgrade')
  try {
    for (const name of ['actor_id', 'input_owner_id']) {
      if (!db.prepare('PRAGMA table_info(t3_thread_inputs)').all().some(column => column.name === name)) db.exec(`ALTER TABLE t3_thread_inputs ADD COLUMN ${name} TEXT`)
      db.exec(`UPDATE t3_thread_inputs SET ${name}=(SELECT owner_id FROM t3_thread_bindings WHERE thread_id=t3_thread_inputs.thread_id) WHERE ${name} IS NULL`)
    }
    if (!db.prepare('PRAGMA table_info(t3_thread_inputs)').all().some(column => column.name === 'actor_verified')) db.exec('ALTER TABLE t3_thread_inputs ADD COLUMN actor_verified INTEGER NOT NULL DEFAULT 0')
    db.exec("UPDATE t3_thread_inputs SET actor_verified=1 WHERE actor_id=(SELECT owner_id FROM t3_thread_bindings WHERE thread_id=t3_thread_inputs.thread_id AND visibility='private')")
    db.exec('RELEASE autoops_actor_upgrade')
  } catch (error) { db.exec('ROLLBACK TO autoops_actor_upgrade; RELEASE autoops_actor_upgrade'); throw error }
  if (!db.prepare('PRAGMA table_info(t3_attachment_access)').all().some((column) => column.name === 'metadata_json'))
    db.exec('ALTER TABLE t3_attachment_access ADD COLUMN metadata_json TEXT')
}

export function createAccessService({ sessionDb, bindingDb, catalog, now = Date.now, workspaceStore, customerRegistry: suppliedCustomerRegistry, deploymentEnabled, configuration, questions }) {
  let accepting = true
  const assertAccepting = () => { if (!accepting) fail(503, 'AUTOOPS_STOPPING', '业务服务正在停止，请稍后重试') }
  const identity = createAccessIdentity({ sessionDb, bindingDb, findUser: (id) => catalog.users.find((entry) => entry.id === id), now, fail, identifier, assertAccepting })
  const { refresh } = identity
  const { membershipForUser, requireProjectActionForUser, requireEnvironmentQueryForUser, requireWorkspaceManagerForUser, requireCredentialActor, requireDeploymentActor, requireDeploymentAction: deploymentActionForUser, projectCapabilities, requireDeploymentNodeManagerForUser } = createProjectAccess({ catalog, fail, deploymentEnabled })
  const customerRegistry = suppliedCustomerRegistry || createCustomerRegistry({
    db: bindingDb, now,
    requireOwner(userId) {
      const user = catalog.users.find((entry) => entry.id === userId)
      if (!user || (user.status !== undefined && user.status !== 'active')) fail(401, 'CUSTOMER_OWNER_INACTIVE', '设备所属用户已停用')
    },
    requireProjectForUser: membershipForUser,
  })
  const bindingAudienceForUser = (userId, binding) => {
    if (binding.executionBinding?.kind !== 'customer') return workspaceForUser(userId, binding.projectId, binding.workspaceType || 'internal', undefined, binding.environmentId)
    if (userId !== binding.ownerId || binding.visibility !== 'private') fail(403, 'CUSTOMER_OWNER_REQUIRED', '客户工作区对话仅限设备所有者访问')
    const membership = membershipForUser(userId, binding.projectId)
    // 历史自用电脑不使用平台环境资源；外部角色收回环境后仍核对原设备和原收据。
    if (membership.workspaceAccess !== 'external' && binding.environmentId !== null && !membership.environmentIds.includes(binding.environmentId)) fail(403, 'ENVIRONMENT_FORBIDDEN', '无权访问此项目环境')
    return membership
  }
  const requireMembership = (principal, projectId) => membershipForUser(refresh(principal).id, projectId)
  const requireCustomerSource = (binding, actorId, options = {}) => {
    requireCustomerAgentsEnabled()
    const source = customerRegistry.sourceOwner(binding.executionBinding)
    if (source.ownerId !== actorId || source.projectId !== binding.projectId || binding.question?.configuration.customerProfile) {
      if (!questions || !binding.question) fail(403, 'CUSTOMER_SHARED_ISOLATION_UNVERIFIED', '共享来源缺少已核验的助手授权')
      questions().validateSelection(actorId, binding.projectId, binding.question, binding.scopeState !== 'draft')
    }
    return customerRegistry.validateTarget(source.ownerId, source.projectId, binding.executionBinding, options)
  }
  const requireEnvironment = (principal, projectId, environmentId) => {
    const membership = requireMembership(principal, projectId)
    if (!membership.environmentIds.includes(environmentId)) fail(403, 'ENVIRONMENT_FORBIDDEN', '无权访问此项目环境')
    return membership
  }
  const workspaceForUser = (userId, projectId, type, versionId, environmentId) => {
    const membership = membershipForUser(userId, projectId)
    if (!['internal', 'external'].includes(type) || (type === 'internal' && membership.workspaceAccess !== 'internal'))
      fail(403, 'WORKSPACE_FORBIDDEN', '无权访问内部原始资料')
    if (environmentId !== undefined && environmentId !== null && !membership.environmentIds.includes(environmentId)) fail(403, 'ENVIRONMENT_FORBIDDEN', '无权访问此项目环境')
    if (versionId !== undefined && workspaceStore) {
      const version = workspaceStore.getVersion(projectId, versionId)
      if (version.type !== type || version.status !== 'published') fail(403, 'WORKSPACE_NOT_AVAILABLE', '此工作区版本尚未发布或已不可用')
    }
    return membership
  }
  const requireWorkspace = (principal, projectId, type, versionId, environmentId) => workspaceForUser(refresh(principal).id, projectId, type, versionId, environmentId)
  const requireWorkspaceManager = (principal, projectId) => requireWorkspaceManagerForUser(refresh(principal).id, projectId)
  const projectFor = (principal, projectId) => {
    requireMembership(principal, projectId)
    const project = catalog.projects.find((entry) => entry.id === projectId)
    return project
  }
  const nativeSubagentParent = (threadId) => bindingDb.prepare('SELECT parent_thread_id FROM t3_native_subagent_bindings WHERE child_thread_id=?').get(identifier(threadId, '会话ID'))?.parent_thread_id
  const getThreadBinding = (threadId) => {
    const binding=fromRow(bindingDb.prepare('SELECT * FROM t3_thread_bindings WHERE thread_id=?').get(identifier(threadId, '会话ID')))
    const parent=binding && nativeSubagentParent(threadId)
    return binding && (parent ? {...binding,nativeParentThreadId:parent} : binding)
  }
  const validateBinding = (binding, ancestors = new Set()) => {
    if (ancestors.size >= 64 || ancestors.has(binding.threadId)) fail(403, 'THREAD_SCOPE_REVOKED', '原生子任务来源无效')
    ancestors.add(binding.threadId)
    if (binding.nativeParentThreadId) {
      const parent=getThreadBinding(binding.nativeParentThreadId)
      if (!parent || !sameExecutionBinding(parent, binding) || ['projectId','environmentId','agentId','ownerId','visibility','workspaceType','workspaceVersionId'].some(key=>parent[key]!==binding[key])) fail(403,'THREAD_SCOPE_REVOKED','原生子任务来源已失效')
      validateBinding(parent, ancestors)
    }
    if (binding.revokedAt) fail(404, 'THREAD_NOT_FOUND', '会话已删除')
    if (binding.executionBinding?.kind === 'customer') {
      normalizeExecutionBinding(binding.executionBinding)
      if (binding.visibility !== 'private' || binding.workspaceType || binding.workspaceVersionId || binding.agentId !== 'a-project')
        fail(400, 'INVALID_CUSTOMER_SCOPE', '客户工作区仅支持私有开发对话，不接入平台工作区或报告助手')
    }
    if (binding.workspaceType) {
      if (!['internal', 'external'].includes(binding.workspaceType))
        fail(400, 'INVALID_WORKSPACE_BINDING', '请选择有效的资料范围')
    }
    const project = catalog.projects.find((entry) => entry.id === binding.projectId)
    const agent = catalog.agents.find((entry) => entry.id === binding.agentId)
    if (!project || (binding.environmentId !== null && !project.environments.some((entry) => entry.id === binding.environmentId)) ||
        !agent?.projectIds.includes(binding.projectId))
      fail(403, 'THREAD_SCOPE_REVOKED', '会话的项目、环境或 Agent 授权已失效')
    return { binding, project, agent }
  }
  const canSeeThread = (principal, threadId, includeDeleted = false) => {
    const current = refresh(principal)
    const binding = getThreadBinding(threadId)
    if (!binding || (binding.revokedAt && !includeDeleted)) return false
    if (binding.scopeState !== 'locked' && binding.ownerId !== current.id) return false
    try { validateBinding(includeDeleted ? {...binding,revokedAt:undefined} : binding) } catch { return false }
    try { bindingAudienceForUser(current.id, binding) } catch { return false }
    return binding.visibility === 'project' || binding.ownerId === current.id
  }
  const requireActorThread = (threadId, actorId) => {
    assertAccepting()
    const binding = getThreadBinding(identifier(threadId, '会话ID'))
    if (!binding) fail(403, 'THREAD_NOT_BOUND', '缺少获授权的业务会话')
    const scope = validateBinding(binding), actor = actorId ?? binding.ownerId
    bindingAudienceForUser(actor, binding)
    if (binding.visibility === 'private' && actor !== binding.ownerId) fail(404, 'THREAD_NOT_FOUND', '会话不存在或无权访问')
    return { ...scope, actorId: actor }
  }
  const requireThread = (principal, threadId) => {
    if (!canSeeThread(principal, threadId)) fail(404, 'THREAD_NOT_FOUND', '会话不存在或无权访问')
    const binding = getThreadBinding(threadId)
    validateBinding(binding)
    return binding
  }
  function threadAudience(binding) {
    const project = catalog.projects.find((entry) => entry.id === binding.projectId)
    const candidates = binding.visibility === 'private' ? [binding.ownerId] : [...new Set([...(project?.memberIds || []), ...(project?.memberships || []).map((entry) => entry.userId)])]
    return candidates.filter((userId) => {
      try { bindingAudienceForUser(userId, binding); return true } catch { return false }
    })
  }
  const bindingInput = (current, input) => {
    projectFor(current, identifier(input.projectId, '项目ID'))
    const binding = {
      threadId: identifier(input.threadId, '会话ID'),
      projectId: input.projectId,
      environmentId: input.environmentId === null ? null : identifier(input.environmentId, '环境ID'),
      agentId: identifier(input.agentId, 'Agent ID'),
      ownerId: current.id,
      visibility: input.visibility,
      createdAt: new Date(now()).toISOString(),
      executionBinding: normalizeExecutionBinding(input.executionBinding),
      ...(input.workspaceType !== undefined || input.workspaceVersionId !== undefined || (workspaceStore && input.executionBinding?.kind !== 'customer') ? {
        workspaceType: input.workspaceType ?? requireMembership(current, input.projectId).workspaceAccess,
        ...(input.workspaceVersionId !== undefined ? { workspaceVersionId: identifier(input.workspaceVersionId, '工作区版本') } : {}),
      } : {}),
    }
    if (!['private', 'project'].includes(binding.visibility)) fail(400, 'INVALID_VISIBILITY', '会话可见范围无效')
    if (binding.environmentId !== null) requireEnvironment(current, binding.projectId, binding.environmentId)
    bindingAudienceForUser(current.id, binding)
    if (binding.workspaceVersionId) workspaceForUser(current.id, binding.projectId, binding.workspaceType, binding.workspaceVersionId, binding.environmentId)
    validateBinding(binding)
    if (questions && input.question === undefined && !getThreadBinding(binding.threadId)) fail(409, 'QUESTION_ASSISTANT_REQUIRED', '请选择当前项目已配置的可用助手')
    if (input.question !== undefined) {
      if (!questions) fail(503, 'QUESTIONS_NOT_CONFIGURED', '助手授权尚未就绪')
      const previous = getThreadBinding(binding.threadId)
      binding.question = questions().validateSelection(current.id, binding.projectId, input.question, previous?.ownerId === current.id && previous.scopeState !== 'draft')
      assertQuestionBinding(binding.question, binding)
    }
    if (binding.executionBinding.kind === 'customer') requireCustomerSource(binding, current.id)
    return binding
  }
  const bindingKeys = ['projectId','environmentId','agentId','ownerId','visibility','workspaceType','workspaceVersionId']
  const bindingChanged = (left, right) => !sameExecutionBinding(left, right) || JSON.stringify(left.question) !== JSON.stringify(right.question) || bindingKeys.some((key) => left[key] !== right[key])
  const bindThread = (principal, input) => {
    const current = refresh(principal)
    const binding = bindingInput(current, input)
    const existing = getThreadBinding(binding.threadId)
    if (existing) {
      if (bindingChanged(existing, binding))
        fail(409, 'THREAD_BINDING_CONFLICT', '会话身份已绑定，不能改投其他项目或环境')
      return existing
    }
    bindingDb.prepare('INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at,workspace_type,workspace_version_id,execution_binding_json,question_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO NOTHING').run(
      binding.threadId, binding.projectId, binding.environmentId ?? '', binding.agentId,
      binding.ownerId, binding.visibility, binding.createdAt, binding.workspaceType ?? null, binding.workspaceVersionId ?? null, JSON.stringify(binding.executionBinding), binding.question ? JSON.stringify(binding.question) : null,
    )
    const stored = getThreadBinding(binding.threadId)
    if (bindingChanged(stored, binding))
      fail(409, 'THREAD_BINDING_CONFLICT', '会话身份已绑定，不能改投其他项目或环境')
    return stored
  }
  const reserveThread = (principal, input) => {
    const current = refresh(principal), binding = bindingInput(current, input)
    bindingDb.exec('BEGIN IMMEDIATE')
    try {
      const existing = getThreadBinding(binding.threadId)
      if (existing) {
        if (existing.ownerId !== current.id || existing.nativeParentThreadId || existing.revokedAt) fail(409, 'THREAD_BINDING_CONFLICT', '无法修改此会话的范围')
        const changed = bindingChanged(existing, binding)
        if (changed && existing.scopeState !== 'draft') fail(409, 'THREAD_SCOPE_LOCKED', '消息提交中或已被接受，请新建对话以切换范围')
        if (changed) bindingDb.prepare('UPDATE t3_thread_bindings SET project_id=?,environment_id=?,agent_id=?,visibility=?,workspace_type=?,workspace_version_id=?,execution_binding_json=?,question_json=? WHERE thread_id=? AND scope_state=\'draft\'').run(binding.projectId, binding.environmentId ?? '', binding.agentId, binding.visibility, binding.workspaceType ?? null, binding.workspaceVersionId ?? null, JSON.stringify(binding.executionBinding), binding.question ? JSON.stringify(binding.question) : null, binding.threadId)
      } else {
        bindingDb.prepare('INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at,workspace_type,workspace_version_id,execution_binding_json,question_json,scope_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'draft\')').run(binding.threadId, binding.projectId, binding.environmentId ?? '', binding.agentId, binding.ownerId, binding.visibility, binding.createdAt, binding.workspaceType ?? null, binding.workspaceVersionId ?? null, JSON.stringify(binding.executionBinding), binding.question ? JSON.stringify(binding.question) : null)
      }
      bindingDb.exec('COMMIT')
      return getThreadBinding(binding.threadId)
    } catch (error) { bindingDb.exec('ROLLBACK'); throw error }
  }
  const requireThreadExecution = (principal, threadId, options = {}) => {
    const binding = requireThread(principal, threadId)
    if (binding.compatibilityReadOnly) fail(409, 'LEGACY_THREAD_READ_ONLY', '历史兼容会话仅供查看')
    if (binding.executionBinding.kind === 'customer') requireCustomerSource(binding, binding.ownerId, options)
    return binding
  }
  const beginThreadSubmission = (principal, threadId, commandId) => {
    requireThreadExecution(principal, threadId, { requireOnline: true })
    identifier(commandId, '提交命令ID')
    bindingDb.exec('BEGIN IMMEDIATE')
    try {
      const row = bindingDb.prepare('SELECT * FROM t3_thread_bindings WHERE thread_id=?').get(threadId)
      if (row.scope_state === 'draft') bindingDb.prepare("UPDATE t3_thread_bindings SET scope_state='submitting',submission_command_id=? WHERE thread_id=?").run(commandId, threadId)
      else if (row.submission_command_id !== commandId) fail(409, 'THREAD_SUBMISSION_CONFLICT', '此对话已有提交，请等待当前消息确认或新建对话')
      bindingDb.exec('COMMIT')
      return getThreadBinding(threadId)
    } catch (error) { bindingDb.exec('ROLLBACK'); throw error }
  }
  const finishThreadSubmission = (threadId, commandId, accepted) => {
    identifier(threadId, '会话ID'); identifier(commandId, '提交命令ID')
    if (typeof accepted !== 'boolean') fail(400, 'INVALID_SUBMISSION_RESULT', '消息接受状态无效')
    bindingDb.prepare("UPDATE t3_thread_bindings SET scope_state=?,submission_command_id=CASE WHEN ? THEN submission_command_id ELSE NULL END WHERE thread_id=? AND scope_state='submitting' AND submission_command_id=?").run(accepted ? 'locked' : 'draft', Number(accepted), threadId, commandId)
    return getThreadBinding(threadId)
  }
  const markThreadAccepted = (threadId) => {
    identifier(threadId, '会话ID')
    bindingDb.prepare("UPDATE t3_thread_bindings SET scope_state='locked' WHERE thread_id=?").run(threadId)
    return getThreadBinding(threadId)
  }
  const reconcileThreadSubmission = (threadId, accepted) => {
    identifier(threadId, '会话ID')
    if (typeof accepted !== 'boolean') fail(400, 'INVALID_SUBMISSION_RESULT', '消息接受状态无效')
    if (accepted) return markThreadAccepted(threadId)
    bindingDb.prepare("UPDATE t3_thread_bindings SET scope_state='draft',submission_command_id=NULL WHERE thread_id=? AND scope_state='submitting'").run(threadId)
    return getThreadBinding(threadId)
  }
  const requireAttachment = (principal, attachmentId, targetThreadId) => {
    const current = refresh(principal)
    const row = bindingDb.prepare('SELECT * FROM t3_attachment_access WHERE attachment_id=?').get(identifier(attachmentId, '附件ID'))
    if (!row) fail(404, 'ATTACHMENT_NOT_FOUND', '附件不存在或无权访问')
    if (row.thread_id === null) {
      if (row.owner_id !== current.id) fail(404, 'ATTACHMENT_NOT_FOUND', '附件不存在或无权访问')
      if (targetThreadId) requireThread(current, targetThreadId)
    } else {
      requireThread(current, row.thread_id)
      if (targetThreadId && targetThreadId !== row.thread_id) {
        const source = requireThread(current, row.thread_id), target = requireThread(current, targetThreadId)
        requireMatchingWorkspaces(source, target)
        const sourceAudience = threadAudience(source)
        const targetAudience = threadAudience(target)
        if (targetAudience.some((member) => !sourceAudience.includes(member)))
          fail(403, 'REFERENCE_AUDIENCE_MISMATCH', '附件授权范围不包含目标会话的所有成员')
      }
    }
    return { id: row.attachment_id, ownerId: row.owner_id, threadId: row.thread_id, ...(row.metadata_json ? JSON.parse(row.metadata_json) : {}) }
  }
  // 资料目录通过只读快照协作，不暴露数据库连接或可修改的存储行。
  function resourceThreads(projectId, canRead) {
    return bindingDb.prepare('SELECT thread_id FROM t3_thread_bindings WHERE project_id=? AND revoked_at IS NULL').all(projectId)
      .map((row) => getThreadBinding(row.thread_id)).filter(canRead).map((binding) => {
      const attachments = bindingDb.prepare('SELECT attachment_id, metadata_json, created_at FROM t3_attachment_access WHERE thread_id=?').all(binding.threadId).map((file) => {
        const metadata = file.metadata_json ? JSON.parse(file.metadata_json) : {}
        return { id: file.attachment_id, createdAt: file.created_at, name: metadata.name, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes }
      })
      return { binding, attachments }
    })
  }
  return {
    assertAccepting,
    stopAccepting() { accepting = false },
    authenticateCookie: identity.authenticateCookie,
    refresh,
    customerRegistry,
    requireThreadExecution,
    customerAssistantRuntime(principal,input) {
      const current=refresh(principal)
      requireCustomerAgentsEnabled()
      if(!questions)fail(409,'ASSISTANT_DIRECTORY_UNAVAILABLE','助手目录尚未配置')
      const state=questions().readRuntimeConfiguration(current.id,input.projectId,input.question)
      const target=state.selection.configuration.executionBinding
      const owner=customerRegistry.sourceOwner(target),source=customerRegistry.describeSource(owner.ownerId,target)
      const shared=owner.ownerId!==current.id||owner.projectId!==input.projectId||state.selection.configuration.customerProfile!==undefined
      const {sharedProfile,...capabilities}=source.capabilities??{}
      // 共享文件浏览协议尚无双端资源许可；模型仍可读取容器内固定的只读来源。
      const projected=source.capabilities?{...capabilities,...(shared?{models:sharedProfile?.models??[],skills:sharedProfile?.skills??[],workspaceFiles:false,permissions:{approvalPolicy:'on-request',sandboxMode:'read-only'}}:{})}:null
      return {target,profile:shared?'linux-docker-readonly-v1':'self',device:{id:target.deviceId,label:source.deviceName,status:source.deviceStatus,online:source.online},workspace:{label:source.workspaceName,status:source.workspaceStatus},capabilities:projected,available:state.available,...(state.reason?{reason:state.reason}:{})}
    },
    visibleCustomerProviderInstances(principal) {
      const current=refresh(principal),owned=customerRegistry.listDevices(current.id).map(device=>`customer-${device.id}-codex`),shared=new Set()
      if(questions)for(const project of catalog.projects) {
        try {for(const item of questions().catalog(current.id,project.id).items) {
          const target=item.preset.configuration.executionBinding
          if(item.available&&target.kind==='customer'&&!owned.includes(`customer-${target.deviceId}-codex`))shared.add(`customer-${target.deviceId}-codex`)
        }} catch(error) {if(!(error&&typeof error==='object'&&'status' in error&&[401,403,404].includes(error.status)))throw error}
      }
      return {owned,shared:[...shared]}
    },
    customerExecutionSource(threadId, actorId) {
      const binding = requireActorThread(threadId, actorId).binding
      if (binding.executionBinding.kind !== 'customer') fail(403, 'CUSTOMER_TARGET_REQUIRED', '此对话没有客户运行来源')
      requireCustomerSource(binding, actorId ?? binding.ownerId)
      return customerRegistry.sourceOwner(binding.executionBinding)
    },
    issueCustomerSessionScope(threadId, sessionId, modelSelection) {
      const binding = getThreadBinding(threadId)
      if (!binding || binding.executionBinding.kind !== 'customer') fail(404, 'THREAD_NOT_FOUND', '客户会话不存在')
      const selected = this.requireQuestionForActor(binding.ownerId, threadId, modelSelection)
      if (!selected) return undefined
      return questions().executionScope(binding.ownerId, binding.projectId, selected, { threadId, runId: `session:${identifier(sessionId, '客户会话ID')}` })
    },
    prepareCustomerRun(threadId, runId, messageId, editCommandId, modelSelection, inheritedRunId) {
      const binding = getThreadBinding(threadId)
      if (!binding || binding.executionBinding.kind !== 'customer') fail(404, 'THREAD_NOT_FOUND', '客户会话不存在')
      const source = customerRegistry.sourceOwner(binding.executionBinding)
      if (source.ownerId === binding.ownerId && source.projectId === binding.projectId && !binding.question?.configuration.customerProfile) return undefined
      const original = inheritedRunId ? questions().executionGrant(threadId, inheritedRunId) : undefined
      let actorId
      try {
        if (!messageId && !editCommandId) fail(409, 'MESSAGE_ACTOR_MISSING', '客户消息缺少可信调用者记录')
        actorId = (editCommandId ? this.requireQueuedEditActor(threadId, editCommandId, runId) : this.requireMessageActor(threadId, messageId)).actorId
      } catch (error) {
        if (error.code !== 'MESSAGE_ACTOR_MISSING' || !original) throw error
        actorId = original.actorId
      }
      if (inheritedRunId && !original) fail(409, 'CUSTOMER_SHARED_SCOPE_MISSING', '原任务缺少固定共享范围，不能改用最新来源恢复')
      const selected = this.requireQuestionForActor(actorId, threadId, modelSelection)
      if (!selected) fail(403, 'CUSTOMER_SHARED_SCOPE_MISSING', '共享执行必须使用已分配助手')
      const scope = questions().executionScope(actorId, binding.projectId, selected, { threadId, runId })
      if (original) {
        const identity = ({ grantId, runId, ...value }) => JSON.stringify(value)
        if (identity(original) !== identity(scope)) fail(409, 'CUSTOMER_SHARED_SCOPE_FIXED', '恢复必须沿用原共享配置及能力，不能切换最新来源')
      }
      return scope
    },
    customerRunScope(threadId, runId) {
      const binding = getThreadBinding(threadId)
      if (!binding || binding.executionBinding.kind !== 'customer') fail(404, 'THREAD_NOT_FOUND', '客户会话不存在')
      const source = customerRegistry.sourceOwner(binding.executionBinding)
      if (source.ownerId === binding.ownerId && source.projectId === binding.projectId && !binding.question?.configuration.customerProfile) return undefined
      const scope = questions?.().executionGrant(threadId, runId)
      if (!scope) fail(409, 'CUSTOMER_SHARED_SCOPE_MISSING', '任务尚无可信共享范围，不能按最新配置补建')
      requireActorThread(threadId, scope.actorId)
      return scope
    },
    requireSharedExecutionScope(scope, principal) {
      if (!questions) fail(503, 'QUESTIONS_NOT_CONFIGURED', '助手授权尚未就绪')
      const current = questions().requireExecutionScope(scope)
      requireActorThread(current.threadId, current.actorId)
      if (principal && (principal.deviceId !== current.target.deviceId || principal.ownerId !== current.providerId)) fail(403, 'CUSTOMER_SHARED_SCOPE_FORBIDDEN', '设备不能使用其他来源的执行范围')
      return current
    },
    questionInstructions(actorId, threadId, modelSelection) {
      const selected = this.requireQuestionForActor(actorId, threadId, modelSelection)
      return selected ? questions().instructions(actorId, getThreadBinding(threadId).projectId, selected) : ''
    },
    requireQuestionForActor(actorId, threadId, modelSelection) {
      const binding = getThreadBinding(threadId)
      if (!binding) fail(404, 'THREAD_NOT_FOUND', '会话不存在或无权访问')
      validateBinding(binding)
      bindingAudienceForUser(actorId, binding)
      if (binding.visibility === 'private' && binding.ownerId !== actorId) fail(404, 'THREAD_NOT_FOUND', '会话不存在或无权访问')
      if (!binding.question) {
        const member = membershipForUser(actorId, binding.projectId)
        if (questions && binding.executionBinding.kind !== 'customer' && member.role !== 'project_admin' && !member.canAdjustChat) fail(409, 'QUESTION_MIGRATION_REQUIRED', '原对话尚未核验受限预设，可查看历史；请使用已分配助手新建对话')
        return undefined
      }
      if (!questions) fail(503, 'QUESTIONS_NOT_CONFIGURED', '助手授权尚未就绪')
      assertQuestionBinding(binding.question, binding)
      const selection = modelSelection === undefined ? binding.question : { ...binding.question, configuration: { ...binding.question.configuration, model: nativeQuestionModel(modelSelection) } }
      return questions().validateSelection(actorId, binding.projectId, selection, binding.scopeState !== 'draft')
    },
    requireProject: projectFor,
    requireMembership,
    requireEnvironment,
    requireWorkspace,
    requireWorkspaceManager,
    threadAudience,
    getThreadBinding,
    recordQueuedEditActor(principal, threadId, commandId, runId) {
      const current = refresh(principal)
      requireThread(current, threadId)
      identifier(commandId, '命令ID'); identifier(runId, '任务ID')
      bindingDb.prepare("INSERT INTO t3_request_actors VALUES(?,?,'queued-run.edit',?,?,?) ON CONFLICT(command_id) DO NOTHING").run(commandId, threadId, runId, current.id, new Date(now()).toISOString())
      const stored = this.getQueuedEditActor(threadId, commandId, runId)
      if (!stored || stored.actorId !== current.id) fail(409, 'MESSAGE_ACTOR_CONFLICT', '原编辑请求已属于其他调用者或任务')
    },
    getQueuedEditActor(threadId, commandId, runId) {
      const row = bindingDb.prepare("SELECT actor_id FROM t3_request_actors WHERE command_id=? AND thread_id=? AND target_id=? AND kind='queued-run.edit'").get(identifier(commandId, '命令ID'), identifier(threadId, '会话ID'), identifier(runId, '任务ID'))
      return row ? { actorId: row.actor_id } : undefined
    },
    requireQueuedEditActor(threadId, commandId, runId) {
      const record = this.getQueuedEditActor(threadId, commandId, runId)
      if (!record) fail(409, 'MESSAGE_ACTOR_MISSING', '原生编辑缺少可信调用者记录')
      return requireActorThread(threadId, record.actorId)
    },
    recordMessageActor(principal, threadId, commandId, messageId) {
      const current = refresh(principal)
      requireThread(current, threadId)
      identifier(commandId, '命令ID'); identifier(messageId, '消息ID')
      bindingDb.exec('BEGIN IMMEDIATE')
      try {
        requireThread(current, threadId)
        const previous = bindingDb.prepare('SELECT * FROM t3_message_actors WHERE command_id=? OR (thread_id=? AND message_id=?)').all(commandId, threadId, messageId)
        if (previous.some(row => row.thread_id !== threadId || row.message_id !== messageId || row.command_id !== commandId || row.actor_id !== current.id)) fail(409, 'MESSAGE_ACTOR_CONFLICT', '消息已固定其他调用者或原请求')
        bindingDb.prepare('INSERT INTO t3_message_actors VALUES(?,?,?,?,?) ON CONFLICT(thread_id,message_id) DO NOTHING').run(threadId, messageId, commandId, current.id, new Date(now()).toISOString())
        bindingDb.exec('COMMIT')
      } catch (error) { bindingDb.exec('ROLLBACK'); throw error }
    },
    requireMessageActor(threadId, messageId) {
      const row = bindingDb.prepare('SELECT actor_id FROM t3_message_actors WHERE thread_id=? AND message_id=?').get(identifier(threadId, '会话ID'), identifier(messageId, '消息ID'))
      if (!row) fail(409, 'MESSAGE_ACTOR_MISSING', '消息缺少可信调用者记录，不能继承会话创建者身份')
      return requireActorThread(threadId, row.actor_id)
    },
    getRunInput(threadId, runId) {
      const row = bindingDb.prepare('SELECT * FROM t3_thread_inputs WHERE thread_id=? AND run_id=?').get(identifier(threadId, '会话ID'), identifier(runId, '任务ID'))
      return row ? { threadId: row.thread_id, runId: row.run_id, inputId: row.input_id, actorId: row.actor_id, inputOwnerId: row.input_owner_id, actorVerified: Boolean(row.actor_verified), createdAt: row.created_at } : undefined
    },
    bindRunInput(threadId, runId, inputId, actorId = getThreadBinding(threadId)?.ownerId, inputOwnerId = actorId) {
      this.requireToolThread(threadId, actorId)
      for (const [value, label] of [[runId, '任务ID'], [inputId, '资料输入ID']]) identifier(value, label)
      bindingDb.prepare('INSERT INTO t3_thread_inputs(thread_id,run_id,input_id,created_at,actor_id,input_owner_id,actor_verified) VALUES(?,?,?,?,?,?,1) ON CONFLICT(thread_id,run_id) DO NOTHING').run(threadId, runId, inputId, new Date(now()).toISOString(), identifier(actorId, '调用者ID'), identifier(inputOwnerId, '资料所有者ID'))
      const stored = this.getRunInput(threadId, runId)
      if (stored.inputId !== inputId || stored.actorId !== actorId || stored.inputOwnerId !== inputOwnerId) fail(409, 'THREAD_INPUT_CONFLICT', '此任务已经固定另一份资料输入')
      return stored
    },
    listThreadInputs(threadId) {
      return bindingDb.prepare('SELECT * FROM t3_thread_inputs WHERE thread_id=? ORDER BY rowid').all(identifier(threadId, '会话ID'))
        .map(row => ({ threadId: row.thread_id, runId: row.run_id, inputId: row.input_id, actorId: row.actor_id, inputOwnerId: row.input_owner_id, actorVerified: Boolean(row.actor_verified), createdAt: row.created_at }))
    },
    // 可信原生终态协调只读取持久身份事实，不将撤权后的调用者改成管理员。
    runResourceReferences(threadId, runId) {
      return bindingDb.prepare('SELECT i.*,b.project_id,b.environment_id FROM t3_thread_inputs i JOIN t3_thread_bindings b ON b.thread_id=i.thread_id WHERE i.thread_id=? AND i.run_id=?').all(identifier(threadId, '会话ID'), identifier(runId, '任务ID'))
        .map(row => ({ threadId: row.thread_id, runId: row.run_id, projectId: row.project_id, environmentId: row.environment_id || null, inputId: row.input_id, actorId: row.actor_id, inputOwnerId: row.input_owner_id, actorVerified: Boolean(row.actor_verified), createdAt: row.created_at }))
    },
    nativeSubagentRunReferenced(threadId, runId) {
      return Boolean(bindingDb.prepare('SELECT 1 FROM t3_native_subagent_bindings n JOIN t3_thread_inputs i ON i.thread_id=n.child_thread_id WHERE n.parent_thread_id=? AND i.run_id=? LIMIT 1').get(identifier(threadId, '会话ID'), identifier(runId, '任务ID')))
    },
    workspaceVersionReferences(projectId) {
      return bindingDb.prepare('SELECT DISTINCT workspace_version_id AS id FROM t3_thread_bindings WHERE project_id=? AND workspace_version_id IS NOT NULL').all(identifier(projectId, '项目ID')).map(row => row.id)
    },
    deletionReferences(projectId, environmentId) {
      const count = Number(bindingDb.prepare(`SELECT COUNT(*) AS n FROM t3_thread_bindings WHERE project_id=? AND revoked_at IS NULL${environmentId === undefined ? '' : ' AND environment_id=?'}`).get(projectId,...(environmentId === undefined ? [] : [environmentId]))?.n ?? 0)
      const resources = catalog.projects.find(project => project.id === projectId)?.resources?.filter(value => environmentId === undefined || value.environmentId === environmentId).length ?? 0
      return [
        ...(count ? [{kind:'bound-threads',count,message:'仍有会话或待接受提交（包含私有及归档会话）'}] : []),
        ...(resources ? [{kind:'environment-resources',count:resources,message:'仍有环境资源'}] : []),
        ...customerRegistry.deletionReferences(projectId,environmentId),
      ]
    },
    canReceiveProjectRemoval(principal, projectId) {
      const current = refresh(principal)
      return current.role === 'admin' && current.kind !== 'external' || (catalog.removedProjectAudience?.(projectId) ?? []).includes(current.id)
    },
    retainInputReference(threadId, inputId, actorId, callerId) {
      this.requireToolThread(threadId, callerId)
      identifier(inputId, '资料输入ID'); identifier(actorId, '用户ID')
      bindingDb.prepare('INSERT INTO t3_thread_input_references VALUES(?,?,?,?) ON CONFLICT(thread_id,input_id) DO NOTHING').run(threadId, inputId, actorId, new Date(now()).toISOString())
    },
    inputReferences(threadId) {
      return bindingDb.prepare('SELECT input_id,actor_id FROM t3_thread_input_references WHERE thread_id=?').all(identifier(threadId, '会话ID')).map(row => ({ inputId: row.input_id, actorId: row.actor_id }))
    },
    requireRunInput(threadId, inputId, runId) {
      identifier(inputId, '资料输入ID')
      const row = runId ? bindingDb.prepare('SELECT * FROM t3_thread_inputs WHERE thread_id=? AND input_id=? AND run_id=?').get(threadId, inputId, identifier(runId, '任务ID')) : bindingDb.prepare('SELECT * FROM t3_thread_inputs WHERE thread_id=? AND input_id=? ORDER BY rowid LIMIT 1').get(threadId, inputId)
      if (!row) fail(403, 'THREAD_INPUT_FORBIDDEN', '资料输入不属于此会话任务，请使用本轮输入标识')
      this.requireToolThread(threadId, row.actor_id)
      return { threadId: row.thread_id, runId: row.run_id, inputId: row.input_id, actorId: row.actor_id, inputOwnerId: row.input_owner_id, actorVerified: Boolean(row.actor_verified), createdAt: row.created_at }
    },
    nativeSubagentParent,
    canSeeThread,
    visibleThreadIds(principal) {
      refresh(principal)
      return bindingDb.prepare('SELECT thread_id FROM t3_thread_bindings').all()
        .map((row) => row.thread_id).filter((id) => canSeeThread(principal, id))
    },
    requireThread,
    markThreadDeleted(threadId) {
      bindingDb.prepare('UPDATE t3_thread_bindings SET revoked_at=COALESCE(revoked_at,?) WHERE thread_id=?').run(new Date(now()).toISOString(), identifier(threadId, '会话ID'))
    },
    bindThread,
    reserveThread,
    beginThreadSubmission,
    finishThreadSubmission,
    markThreadAccepted,
    reconcileThreadSubmission,
    requireAttachment,
    requireCustomerAttachment(ownerId, threadId, attachmentId) {
      const binding = getThreadBinding(identifier(threadId, '会话ID'))
      if (!binding || binding.ownerId !== ownerId || binding.executionBinding.kind !== 'customer') fail(404, 'ATTACHMENT_NOT_FOUND', '附件不存在或无权访问')
      validateBinding(binding)
      bindingAudienceForUser(ownerId, binding)
      requireCustomerSource(binding, ownerId)
      const row = bindingDb.prepare('SELECT * FROM t3_attachment_access WHERE attachment_id=?').get(identifier(attachmentId, '附件ID'))
      if (!row || row.owner_id !== ownerId || row.thread_id !== threadId) fail(404, 'ATTACHMENT_NOT_FOUND', '附件不属于此客户对话')
      return {id:row.attachment_id, ...(row.metadata_json ? JSON.parse(row.metadata_json) : {})}
    },
    recordPendingAttachment(principal, attachmentId, metadata) {
      const current = refresh(principal)
      bindingDb.prepare('INSERT INTO t3_attachment_access(attachment_id,owner_id,thread_id,created_at,metadata_json) VALUES(?,?,NULL,?,?) ON CONFLICT(attachment_id) DO NOTHING').run(
        identifier(attachmentId, '附件ID'), current.id, new Date(now()).toISOString(), metadata ? JSON.stringify({ name: metadata.name, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes }) : null,
      )
      const stored = requireAttachment(current, attachmentId)
      if (stored.threadId !== null) fail(409, 'ATTACHMENT_ALREADY_CLAIMED', '已发送的附件不能变成临时上传')
    },
    recordClaimedAttachment(principal, sourceId, finalId, threadId) {
      const source = requireAttachment(principal, sourceId, threadId)
      bindingDb.prepare('INSERT INTO t3_attachment_access(attachment_id,owner_id,thread_id,created_at,metadata_json) VALUES(?,?,?,?,?) ON CONFLICT(attachment_id) DO NOTHING').run(
        identifier(finalId, '附件ID'), source.ownerId, threadId, new Date(now()).toISOString(), JSON.stringify({name:source.name,mimeType:source.mimeType,sizeBytes:source.sizeBytes}),
      )
      const stored = requireAttachment(principal, finalId, threadId)
      if (stored.threadId !== threadId) fail(409, 'ATTACHMENT_SCOPE_CONFLICT', '附件归属不一致')
    },
    recordThreadAttachment(principal, attachmentId, threadId, metadata) {
      const current = refresh(principal)
      requireThread(current, threadId)
      bindingDb.prepare('INSERT INTO t3_attachment_access(attachment_id,owner_id,thread_id,created_at,metadata_json) VALUES(?,?,?,?,?) ON CONFLICT(attachment_id) DO NOTHING').run(
        identifier(attachmentId, '附件ID'), current.id, threadId, new Date(now()).toISOString(), metadata ? JSON.stringify({ name: metadata.name, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes }) : null,
      )
      const stored = requireAttachment(current, attachmentId, threadId)
      if (stored.threadId !== threadId) fail(409, 'ATTACHMENT_SCOPE_CONFLICT', '附件归属不一致')
    },
    recordGeneratedAttachment(threadId, attachmentId, metadata) {
      const binding = getThreadBinding(threadId)
      if (!binding) fail(403, 'THREAD_NOT_BOUND', '生成附件没有获授权的业务会话')
      if (binding.executionBinding.kind === 'customer') fail(403, 'CUSTOMER_ATTACHMENTS_DISABLED', '客户工作区首版未开放附件')
      if (binding.compatibilityReadOnly) fail(409, 'LEGACY_THREAD_READ_ONLY', '历史兼容会话仅供查看')
      validateBinding(binding)
      workspaceForUser(binding.ownerId, binding.projectId, binding.workspaceType || 'internal', undefined, binding.environmentId)
      bindingDb.prepare('INSERT INTO t3_attachment_access(attachment_id,owner_id,thread_id,created_at,metadata_json) VALUES(?,?,?,?,?) ON CONFLICT(attachment_id) DO NOTHING').run(
        identifier(attachmentId, '附件ID'), binding.ownerId, threadId, new Date(now()).toISOString(), JSON.stringify({name:metadata.name,mimeType:metadata.mimeType,sizeBytes:metadata.sizeBytes}),
      )
      const stored = bindingDb.prepare('SELECT owner_id,thread_id FROM t3_attachment_access WHERE attachment_id=?').get(attachmentId)
      if (stored.thread_id !== threadId || stored.owner_id !== binding.ownerId) fail(409, 'ATTACHMENT_SCOPE_CONFLICT', '生成附件归属不一致')
    },
    forkBinding(principal, sourceThreadId, targetThreadId) {
      const source = requireThread(principal, sourceThreadId)
      if (source.executionBinding.kind === 'customer') fail(403, 'CUSTOMER_FORK_DISABLED', '客户工作区首版未开放会话分支')
      const target = bindThread(principal, { ...source, threadId: targetThreadId, visibility: 'private' })
      for (const input of this.listThreadInputs(sourceThreadId)) this.retainInputReference(targetThreadId, input.inputId, source.ownerId)
      for (const reference of this.inputReferences(sourceThreadId)) this.retainInputReference(targetThreadId, reference.inputId, reference.actorId)
      return target
    },
    recordLegacyNativeFork(sourceThreadId, targetThreadId, sourceNativeId, targetNativeId) {
      // 仅处理提供者真实分支响应；同一应用会话的回退副本不能覆盖当前原生身份。
      if (sourceThreadId === targetThreadId) return
      const source = getThreadBinding(sourceThreadId)
      if (!source?.continuationVerified) return
      validateBinding(source)
      const target = getThreadBinding(targetThreadId)
      if (!target) fail(403, 'THREAD_NOT_BOUND', '原生分支没有获授权的业务会话')
      validateBinding(target)
      const audience = threadAudience(source)
      if (source.compatibilityReadOnly || source.nativeParentThreadId || source.nativeThreadId !== sourceNativeId ||
          target.compatibilityReadOnly || target.nativeParentThreadId || target.visibility !== 'private' ||
          !audience.includes(target.ownerId) || ['projectId','environmentId','agentId','workspaceType','workspaceVersionId'].some(key => source[key] !== target[key]))
        fail(403, 'NATIVE_FORK_SCOPE_MISMATCH', '原生分支的授权范围或来源不一致')
      identifier(targetNativeId, '原生会话ID')
      if (targetNativeId === sourceNativeId || (target.nativeThreadId && target.nativeThreadId !== targetNativeId))
        fail(409, 'NATIVE_FORK_IDENTITY_CONFLICT', '原生分支身份已改变')
      bindingDb.prepare('UPDATE t3_thread_bindings SET continuation_verified=1,native_thread_id=? WHERE thread_id=?').run(targetNativeId, targetThreadId)
    },
    requireDeploymentActor,
    requireDeploymentNodeManagerForActor: requireDeploymentNodeManagerForUser,
    requireDeploymentNodeManager: principal => requireDeploymentNodeManagerForUser(refresh(principal).id),
    requireProjectAction: (principal, projectId, action) => requireProjectActionForUser(refresh(principal).id, projectId, action),
    requireProjectActionForActor: requireProjectActionForUser,
    requireEnvironmentQuery: (principal, projectId, environmentId) => requireEnvironmentQueryForUser(refresh(principal).id, projectId, environmentId),
    requireEnvironmentQueryForActor: (actorId, projectId, environmentId) => requireEnvironmentQueryForUser(actorId,projectId,environmentId),
    requireDeploymentAction: (principal, projectId, action, environmentId) => deploymentActionForUser(refresh(principal).id, projectId, action, environmentId),
    requireDeploymentActionForActor: deploymentActionForUser,
    requireWorkspaceActor: requireWorkspaceManagerForUser,
    requireWorkspaceReader: (userId, projectId) => workspaceForUser(userId, projectId, 'internal'),
    requireWorkspaceInputReader: (userId, projectId, workspaceType) => workspaceForUser(userId, projectId, workspaceType),
    requireCredentialActor,
    projectCapabilities(principal, projectId) { return projectCapabilities(refresh(principal).id, projectId) },
    listResourceThreads(principal, projectId) {
      projectFor(principal, projectId)
      return resourceThreads(projectId, (binding) => canSeeThread(principal, binding.threadId))
    },
    listToolResourceThreads(threadId, actorId) {
      const { binding } = this.requireToolThread(threadId, actorId)
      const targetAudience = threadAudience(binding)
      return resourceThreads(binding.projectId, (source) => {
        const audience = threadAudience(source)
        return targetAudience.length > 0 && targetAudience.every((id) => audience.includes(id))
      })
    },
    requireToolThread(threadId, actorId) {
      assertAccepting()
      const binding = getThreadBinding(threadId)
      if (!binding) fail(403, 'THREAD_NOT_BOUND', '工具调用没有获授权的业务会话')
      if (binding.executionBinding.kind === 'customer') fail(403, 'CUSTOMER_BUSINESS_TOOLS_DISABLED', '客户工作区首版未开放平台资料、报告和附件工具')
      if (binding.compatibilityReadOnly) fail(409, 'LEGACY_THREAD_READ_ONLY', '历史会话缺少可验证的原生续接记录，仅供查看')
      const scope = validateBinding(binding)
      const caller = actorId === undefined ? binding.ownerId : identifier(actorId, '调用者ID')
      if (binding.visibility === 'private' && caller !== binding.ownerId) fail(404, 'THREAD_NOT_FOUND', '会话不存在或无权访问')
      try { workspaceForUser(caller, binding.projectId, binding.workspaceType || 'internal', undefined, binding.environmentId) }
      catch (error) { if (error?.code === 'PROJECT_NOT_FOUND') fail(403, 'THREAD_SCOPE_REVOKED', '本次调用者的项目授权已失效'); throw error }
      return { ...scope, actorId: caller }
    },
    requireReference(principal, sourceThreadId, targetThreadId) {
      const source = requireThread(principal, sourceThreadId)
      const target = requireThread(principal, targetThreadId)
      requireMatchingWorkspaces(source, target)
      const sourceAudience = threadAudience(source)
      const targetAudience = threadAudience(target)
      if (targetAudience.some((member) => !sourceAudience.includes(member)))
        fail(403, 'REFERENCE_AUDIENCE_MISMATCH', '引用内容的授权范围不包含目标会话的所有成员')
      return source
    },
    requireCsrf: identity.requireCsrf,
    recordNativeSession: identity.recordNativeSession,
    principalForNativeSession: identity.principalForNativeSession,
    bootstrap(principal) {
      const current = refresh(principal)
      let canManageDeploymentNodes = false
      try { requireDeploymentNodeManagerForUser(current.id); canManageDeploymentNodes = true } catch (error) { if (![403, 503].includes(error.status)) throw error }
      return projectAccessBootstrap({ current, catalog, membershipForUser, projectCapabilities, configuration: configuration(), canManageDeploymentNodes, ...(questions ? { assistantCatalog: (actor, project) => questions().catalog(actor, project) } : {}) })
    },
  }
}
