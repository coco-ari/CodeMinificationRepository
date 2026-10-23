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
  environmentId: row.environment_id,
  agentId: row.agent_id,
  ownerId: row.owner_id,
  visibility: row.visibility,
  createdAt: row.created_at,
  executionBinding: normalizeExecutionBinding(row.execution_binding_json ? JSON.parse(row.execution_binding_json) : undefined),
  scopeState: row.scope_state || 'locked',
  scopeLocked: (row.scope_state || 'locked') === 'locked',
  ...(row.workspace_type ? { workspaceType: row.workspace_type, workspaceVersionId: row.workspace_version_id } : {}),
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
    CREATE TABLE IF NOT EXISTS t3_attachment_access (
      attachment_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL
    );
  `)
  if (!db.prepare('PRAGMA table_info(t3_thread_bindings)').all().some((column) => column.name === 'revoked_at'))
    db.exec('ALTER TABLE t3_thread_bindings ADD COLUMN revoked_at TEXT')
  for (const [name, type] of [['compatibility_read_only','INTEGER NOT NULL DEFAULT 0'],['continuation_verified','INTEGER NOT NULL DEFAULT 0'],['native_thread_id','TEXT'],['workspace_type','TEXT'],['workspace_version_id','TEXT'],['scope_state',"TEXT NOT NULL DEFAULT 'locked'"],['submission_command_id','TEXT'],['execution_binding_json','TEXT']]) {
    if (!db.prepare('PRAGMA table_info(t3_thread_bindings)').all().some((column) => column.name === name)) db.exec(`ALTER TABLE t3_thread_bindings ADD COLUMN ${name} ${type}`)
  }
  if (!db.prepare('PRAGMA table_info(t3_attachment_access)').all().some((column) => column.name === 'metadata_json'))
    db.exec('ALTER TABLE t3_attachment_access ADD COLUMN metadata_json TEXT')
}

export function createAccessService({ sessionDb, bindingDb, catalog, now = Date.now, workspaceStore, customerRegistry: suppliedCustomerRegistry, deploymentEnabled, configuration }) {
  let accepting = true
  const assertAccepting = () => { if (!accepting) fail(503, 'AUTOOPS_STOPPING', '业务服务正在停止，请稍后重试') }
  const identity = createAccessIdentity({ sessionDb, bindingDb, findUser: (id) => catalog.users.find((entry) => entry.id === id), now, fail, identifier, assertAccepting })
  const { refresh } = identity
  const { membershipForUser, requireWorkspaceManagerForUser, requireCredentialActor, requireDeploymentActor, projectCapabilities } = createProjectAccess({ catalog, fail, deploymentEnabled })
  const customerRegistry = suppliedCustomerRegistry || createCustomerRegistry({
    db: bindingDb, now,
    requireOwner(userId) {
      const user = catalog.users.find((entry) => entry.id === userId)
      if (!user || (user.status !== undefined && user.status !== 'active')) fail(401, 'CUSTOMER_OWNER_INACTIVE', '设备所属用户已停用')
    },
    requireProjectForUser: membershipForUser,
  })
  const bindingAudienceForUser = (userId, binding) => {
    if (binding.executionBinding?.kind !== 'customer') return workspaceForUser(userId, binding.projectId, binding.workspaceType || 'internal', binding.workspaceVersionId, binding.environmentId)
    if (userId !== binding.ownerId || binding.visibility !== 'private') fail(403, 'CUSTOMER_OWNER_REQUIRED', '客户工作区对话仅限设备所有者访问')
    const membership = membershipForUser(userId, binding.projectId)
    if (!membership.environmentIds.includes(binding.environmentId)) fail(403, 'ENVIRONMENT_FORBIDDEN', '无权访问此项目环境')
    return membership
  }
  const requireMembership = (principal, projectId) => membershipForUser(refresh(principal).id, projectId)
  const requireEnvironment = (principal, projectId, environmentId) => {
    const membership = requireMembership(principal, projectId)
    if (!membership.environmentIds.includes(environmentId)) fail(403, 'ENVIRONMENT_FORBIDDEN', '无权访问此项目环境')
    return membership
  }
  const workspaceForUser = (userId, projectId, type, versionId, environmentId) => {
    const membership = membershipForUser(userId, projectId)
    if (!['internal', 'external'].includes(type) || (type === 'internal' && membership.workspaceAccess !== 'internal'))
      fail(403, 'WORKSPACE_FORBIDDEN', '无权访问内部原始资料')
    if (environmentId !== undefined && !membership.environmentIds.includes(environmentId)) fail(403, 'ENVIRONMENT_FORBIDDEN', '无权访问此项目环境')
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
      if (!['internal', 'external'].includes(binding.workspaceType) || !binding.workspaceVersionId)
        fail(400, 'INVALID_WORKSPACE_BINDING', '请选择有效的工作区版本')
      const version = workspaceStore?.getVersion(binding.projectId, binding.workspaceVersionId)
      if (workspaceStore && (!version || version.type !== binding.workspaceType || version.status !== 'published'))
        fail(403, 'WORKSPACE_NOT_AVAILABLE', '此工作区版本尚未发布或已不可用')
    }
    const project = catalog.projects.find((entry) => entry.id === binding.projectId)
    const agent = catalog.agents.find((entry) => entry.id === binding.agentId)
    if (!project?.environments.some((entry) => entry.id === binding.environmentId) ||
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
      environmentId: identifier(input.environmentId, '环境ID'),
      agentId: identifier(input.agentId, 'Agent ID'),
      ownerId: current.id,
      visibility: input.visibility,
      createdAt: new Date(now()).toISOString(),
      executionBinding: normalizeExecutionBinding(input.executionBinding),
      ...(input.workspaceType !== undefined || input.workspaceVersionId !== undefined ? {
        workspaceType: input.workspaceType,
        workspaceVersionId: identifier(input.workspaceVersionId, '工作区版本'),
      } : {}),
    }
    if (!['private', 'project'].includes(binding.visibility)) fail(400, 'INVALID_VISIBILITY', '会话可见范围无效')
    bindingAudienceForUser(current.id, binding)
    validateBinding(binding)
    if (binding.executionBinding.kind === 'customer') { requireCustomerAgentsEnabled(); customerRegistry.validateTarget(current.id, binding.projectId, binding.executionBinding) }
    return binding
  }
  const bindingKeys = ['projectId','environmentId','agentId','ownerId','visibility','workspaceType','workspaceVersionId']
  const bindingChanged = (left, right) => !sameExecutionBinding(left, right) || bindingKeys.some((key) => left[key] !== right[key])
  const bindThread = (principal, input) => {
    const current = refresh(principal)
    const binding = bindingInput(current, input)
    const existing = getThreadBinding(binding.threadId)
    if (existing) {
      if (bindingChanged(existing, binding))
        fail(409, 'THREAD_BINDING_CONFLICT', '会话身份已绑定，不能改投其他项目或环境')
      return existing
    }
    if (workspaceStore && !binding.workspaceType && binding.executionBinding.kind === 'platform')
      fail(400, 'WORKSPACE_REQUIRED', '新对话必须先选择固定的工作区版本')
    bindingDb.prepare('INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at,workspace_type,workspace_version_id,execution_binding_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO NOTHING').run(
      binding.threadId, binding.projectId, binding.environmentId, binding.agentId,
      binding.ownerId, binding.visibility, binding.createdAt, binding.workspaceType ?? null, binding.workspaceVersionId ?? null, JSON.stringify(binding.executionBinding),
    )
    const stored = getThreadBinding(binding.threadId)
    if (bindingChanged(stored, binding))
      fail(409, 'THREAD_BINDING_CONFLICT', '会话身份已绑定，不能改投其他项目或环境')
    return stored
  }
  const reserveThread = (principal, input) => {
    const current = refresh(principal), binding = bindingInput(current, input)
    if (workspaceStore && !binding.workspaceType && binding.executionBinding.kind === 'platform') fail(400, 'WORKSPACE_REQUIRED', '新对话必须先选择固定的工作区版本')
    bindingDb.exec('BEGIN IMMEDIATE')
    try {
      const existing = getThreadBinding(binding.threadId)
      if (existing) {
        if (existing.ownerId !== current.id || existing.nativeParentThreadId || existing.revokedAt) fail(409, 'THREAD_BINDING_CONFLICT', '无法修改此会话的范围')
        const changed = bindingChanged(existing, binding)
        if (changed && existing.scopeState !== 'draft') fail(409, 'THREAD_SCOPE_LOCKED', '消息提交中或已被接受，请新建对话以切换范围')
        if (changed) bindingDb.prepare('UPDATE t3_thread_bindings SET project_id=?,environment_id=?,agent_id=?,visibility=?,workspace_type=?,workspace_version_id=?,execution_binding_json=? WHERE thread_id=? AND scope_state=\'draft\'').run(binding.projectId, binding.environmentId, binding.agentId, binding.visibility, binding.workspaceType ?? null, binding.workspaceVersionId ?? null, JSON.stringify(binding.executionBinding), binding.threadId)
      } else {
        bindingDb.prepare('INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at,workspace_type,workspace_version_id,execution_binding_json,scope_state) VALUES(?,?,?,?,?,?,?,?,?,?,\'draft\')').run(binding.threadId, binding.projectId, binding.environmentId, binding.agentId, binding.ownerId, binding.visibility, binding.createdAt, binding.workspaceType ?? null, binding.workspaceVersionId ?? null, JSON.stringify(binding.executionBinding))
      }
      bindingDb.exec('COMMIT')
      return getThreadBinding(binding.threadId)
    } catch (error) { bindingDb.exec('ROLLBACK'); throw error }
  }
  const requireThreadExecution = (principal, threadId, options = {}) => {
    const binding = requireThread(principal, threadId)
    if (binding.compatibilityReadOnly) fail(409, 'LEGACY_THREAD_READ_ONLY', '历史兼容会话仅供查看')
    if (binding.executionBinding.kind === 'customer') { requireCustomerAgentsEnabled(); customerRegistry.validateTarget(binding.ownerId, binding.projectId, binding.executionBinding, options) }
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
      const attachments = bindingDb.prepare('SELECT attachment_id, metadata_json FROM t3_attachment_access WHERE thread_id=?').all(binding.threadId).map((file) => {
        const metadata = file.metadata_json ? JSON.parse(file.metadata_json) : {}
        return { id: file.attachment_id, name: metadata.name, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes }
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
    requireProject: projectFor,
    requireMembership,
    requireEnvironment,
    requireWorkspace,
    requireWorkspaceManager,
    threadAudience,
    getThreadBinding,
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
      const target = requireThread(current, threadId)
      if (target.executionBinding.kind === 'customer') fail(403, 'CUSTOMER_ATTACHMENTS_DISABLED', '客户工作区首版未开放附件')
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
      workspaceForUser(binding.ownerId, binding.projectId, binding.workspaceType || 'internal', binding.workspaceVersionId, binding.environmentId)
      bindingDb.prepare('INSERT INTO t3_attachment_access(attachment_id,owner_id,thread_id,created_at,metadata_json) VALUES(?,?,?,?,?) ON CONFLICT(attachment_id) DO NOTHING').run(
        identifier(attachmentId, '附件ID'), binding.ownerId, threadId, new Date(now()).toISOString(), JSON.stringify({name:metadata.name,mimeType:metadata.mimeType,sizeBytes:metadata.sizeBytes}),
      )
      const stored = bindingDb.prepare('SELECT owner_id,thread_id FROM t3_attachment_access WHERE attachment_id=?').get(attachmentId)
      if (stored.thread_id !== threadId || stored.owner_id !== binding.ownerId) fail(409, 'ATTACHMENT_SCOPE_CONFLICT', '生成附件归属不一致')
    },
    forkBinding(principal, sourceThreadId, targetThreadId) {
      const source = requireThread(principal, sourceThreadId)
      if (source.executionBinding.kind === 'customer') fail(403, 'CUSTOMER_FORK_DISABLED', '客户工作区首版未开放会话分支')
      return bindThread(principal, { ...source, threadId: targetThreadId, visibility: 'private' })
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
    requireWorkspaceActor: requireWorkspaceManagerForUser,
    requireWorkspaceReader: (userId, projectId) => workspaceForUser(userId, projectId, 'internal'),
    requireCredentialActor,
    projectCapabilities(principal, projectId) { return projectCapabilities(refresh(principal).id, projectId) },
    listResourceThreads(principal, projectId) {
      projectFor(principal, projectId)
      return resourceThreads(projectId, (binding) => canSeeThread(principal, binding.threadId))
    },
    listToolResourceThreads(threadId) {
      const { binding } = this.requireToolThread(threadId)
      const targetAudience = threadAudience(binding)
      return resourceThreads(binding.projectId, (source) => {
        const audience = threadAudience(source)
        return targetAudience.length > 0 && targetAudience.every((id) => audience.includes(id))
      })
    },
    requireToolThread(threadId) {
      assertAccepting()
      const binding = getThreadBinding(threadId)
      if (!binding) fail(403, 'THREAD_NOT_BOUND', '工具调用没有获授权的业务会话')
      if (binding.executionBinding.kind === 'customer') fail(403, 'CUSTOMER_BUSINESS_TOOLS_DISABLED', '客户工作区首版未开放平台资料、报告和附件工具')
      if (binding.compatibilityReadOnly) fail(409, 'LEGACY_THREAD_READ_ONLY', '历史会话缺少可验证的原生续接记录，仅供查看')
      const scope = validateBinding(binding)
      try { workspaceForUser(binding.ownerId, binding.projectId, binding.workspaceType || 'internal', binding.workspaceVersionId, binding.environmentId) }
      catch (error) { if (error?.code === 'PROJECT_NOT_FOUND') fail(403, 'THREAD_SCOPE_REVOKED', '会话所属用户的项目授权已失效'); throw error }
      return scope
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
      return projectAccessBootstrap({ current, catalog, membershipForUser, projectCapabilities, configuration: configuration() })
    },
  }
}
