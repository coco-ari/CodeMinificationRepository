import { DatabaseSync } from 'node:sqlite'
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { users, projects, agents } from '../fixtures.mjs'
import { resolveProductProfile } from './product-profile.mjs'
import { configuredBusinessModels } from './models.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'

// AutoOps business authorization only. T3 remains the sole owner of runs,
// commands, queues, events and native-provider session state.
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
const hash = (value) => createHash('sha256').update(value).digest('hex')
const identifier = (value, name) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f]/u.test(value))
    fail(400, 'INVALID_ID', `${name}无效`)
  return value
}
const requireMatchingWorkspaces = (source, target) => {
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
  scopeState: row.scope_state || 'locked',
  scopeLocked: (row.scope_state || 'locked') === 'locked',
  ...(row.workspace_type ? { workspaceType: row.workspace_type, workspaceVersionId: row.workspace_version_id } : {}),
  compatibilityReadOnly: Boolean(row.compatibility_read_only),
  continuationVerified: Boolean(row.continuation_verified),
  ...(row.native_thread_id ? {nativeThreadId:row.native_thread_id} : {}),
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
})

export function initializeAutoOpsAccessSchema(db) {
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
    CREATE TABLE IF NOT EXISTS t3_native_auth_sessions (
      native_session_id TEXT PRIMARY KEY,
      autoops_session_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL
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
  for (const [name, type] of [['compatibility_read_only','INTEGER NOT NULL DEFAULT 0'],['continuation_verified','INTEGER NOT NULL DEFAULT 0'],['native_thread_id','TEXT'],['workspace_type','TEXT'],['workspace_version_id','TEXT'],['scope_state',"TEXT NOT NULL DEFAULT 'locked'"],['submission_command_id','TEXT']]) {
    if (!db.prepare('PRAGMA table_info(t3_thread_bindings)').all().some((column) => column.name === name)) db.exec(`ALTER TABLE t3_thread_bindings ADD COLUMN ${name} ${type}`)
  }
  if (!db.prepare('PRAGMA table_info(t3_attachment_access)').all().some((column) => column.name === 'metadata_json'))
    db.exec('ALTER TABLE t3_attachment_access ADD COLUMN metadata_json TEXT')
}

export function createAutoOpsAccess({ sessionDb, bindingDb, catalog = { users, projects, agents }, now = Date.now, workspaceStore }) {
  const lookupSession = (sessionHash) => {
    const row = sessionDb.prepare('SELECT token,uid,csrf,expires FROM sessions WHERE token=? AND expires>?').get(sessionHash, now())
    const user = row && catalog.users.find((entry) => entry.id === row.uid)
    if (!row || !user || (user.status !== undefined && user.status !== 'active')) fail(401, 'UNAUTHENTICATED', '登录已失效，请重新登录')
    return Object.freeze({ id: user.id, displayName: user.name, role: user.role, sessionHash: row.token, csrf: row.csrf, expiresAt: row.expires })
  }
  const refresh = (principal) => {
    if (!principal || typeof principal.sessionHash !== 'string') fail(401, 'UNAUTHENTICATED', '请先登录')
    const current = lookupSession(principal.sessionHash)
    if (current.id !== principal.id) fail(401, 'UNAUTHENTICATED', '登录身份已改变')
    return current
  }
  const membershipForUser = (userId, projectId) => {
    const project = catalog.projects.find((entry) => entry.id === projectId)
    const user = catalog.users.find((entry) => entry.id === userId)
    const configured = project?.memberships?.find((entry) => entry.userId === userId)
    const membership = configured || (project?.memberIds.includes(userId) ? { userId, workspaceAccess: 'internal', role: user?.role === 'admin' ? 'manager' : 'member', environmentIds: project.environments.map((entry) => entry.id), status: 'active' } : undefined)
    if (!project || !user || (user.status !== undefined && user.status !== 'active') || !membership || membership.status !== 'active' ||
        !['internal', 'external'].includes(membership.workspaceAccess) || !['manager', 'member'].includes(membership.role) ||
        !Array.isArray(membership.environmentIds) || membership.environmentIds.some((id) => !project.environments.some((environment) => environment.id === id)))
      fail(404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问')
    return { userId, workspaceAccess: membership.workspaceAccess, role: membership.role, environmentIds: [...new Set(membership.environmentIds)], status: 'active' }
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
  const requireWorkspaceManager = (principal, projectId) => {
    const membership = requireWorkspace(principal, projectId, 'internal')
    if (membership.role !== 'manager') fail(403, 'WORKSPACE_MANAGEMENT_FORBIDDEN', '只有项目内部管理者可以管理工作区')
    return membership
  }
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
      if (!parent || ['projectId','environmentId','agentId','ownerId','visibility','workspaceType','workspaceVersionId'].some(key=>parent[key]!==binding[key])) fail(403,'THREAD_SCOPE_REVOKED','原生子任务来源已失效')
      validateBinding(parent, ancestors)
    }
    if (binding.revokedAt) fail(404, 'THREAD_NOT_FOUND', '会话已删除')
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
    try { workspaceForUser(current.id, binding.projectId, binding.workspaceType || 'internal', binding.workspaceVersionId, binding.environmentId) } catch { return false }
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
      try { workspaceForUser(userId, binding.projectId, binding.workspaceType || 'internal', binding.workspaceVersionId, binding.environmentId); return true } catch { return false }
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
      ...(input.workspaceType !== undefined || input.workspaceVersionId !== undefined ? {
        workspaceType: input.workspaceType,
        workspaceVersionId: identifier(input.workspaceVersionId, '工作区版本'),
      } : {}),
    }
    if (!['private', 'project'].includes(binding.visibility)) fail(400, 'INVALID_VISIBILITY', '会话可见范围无效')
    workspaceForUser(current.id, binding.projectId, binding.workspaceType || 'internal', binding.workspaceVersionId, binding.environmentId)
    validateBinding(binding)
    return binding
  }
  const bindingKeys = ['projectId','environmentId','agentId','ownerId','visibility','workspaceType','workspaceVersionId']
  const bindThread = (principal, input) => {
    const current = refresh(principal)
    const binding = bindingInput(current, input)
    const existing = getThreadBinding(binding.threadId)
    if (existing) {
      if (bindingKeys.some((key) => existing[key] !== binding[key]))
        fail(409, 'THREAD_BINDING_CONFLICT', '会话身份已绑定，不能改投其他项目或环境')
      return existing
    }
    if (workspaceStore && !binding.workspaceType)
      fail(400, 'WORKSPACE_REQUIRED', '新对话必须先选择固定的工作区版本')
    bindingDb.prepare('INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at,workspace_type,workspace_version_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO NOTHING').run(
      binding.threadId, binding.projectId, binding.environmentId, binding.agentId,
      binding.ownerId, binding.visibility, binding.createdAt, binding.workspaceType ?? null, binding.workspaceVersionId ?? null,
    )
    const stored = getThreadBinding(binding.threadId)
    if (['projectId','environmentId','agentId','ownerId','visibility','workspaceType','workspaceVersionId'].some((key) => stored[key] !== binding[key]))
      fail(409, 'THREAD_BINDING_CONFLICT', '会话身份已绑定，不能改投其他项目或环境')
    return stored
  }
  const reserveThread = (principal, input) => {
    const current = refresh(principal), binding = bindingInput(current, input)
    if (workspaceStore && !binding.workspaceType) fail(400, 'WORKSPACE_REQUIRED', '新对话必须先选择固定的工作区版本')
    bindingDb.exec('BEGIN IMMEDIATE')
    try {
      const existing = getThreadBinding(binding.threadId)
      if (existing) {
        if (existing.ownerId !== current.id || existing.nativeParentThreadId || existing.revokedAt) fail(409, 'THREAD_BINDING_CONFLICT', '无法修改此会话的范围')
        const changed = bindingKeys.some((key) => existing[key] !== binding[key])
        if (changed && existing.scopeState !== 'draft') fail(409, 'THREAD_SCOPE_LOCKED', '消息提交中或已被接受，请新建对话以切换范围')
        if (changed) bindingDb.prepare('UPDATE t3_thread_bindings SET project_id=?,environment_id=?,agent_id=?,visibility=?,workspace_type=?,workspace_version_id=? WHERE thread_id=? AND scope_state=\'draft\'').run(binding.projectId, binding.environmentId, binding.agentId, binding.visibility, binding.workspaceType ?? null, binding.workspaceVersionId ?? null, binding.threadId)
      } else {
        bindingDb.prepare('INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at,workspace_type,workspace_version_id,scope_state) VALUES(?,?,?,?,?,?,?,?,?,\'draft\')').run(binding.threadId, binding.projectId, binding.environmentId, binding.agentId, binding.ownerId, binding.visibility, binding.createdAt, binding.workspaceType ?? null, binding.workspaceVersionId ?? null)
      }
      bindingDb.exec('COMMIT')
      return getThreadBinding(binding.threadId)
    } catch (error) { bindingDb.exec('ROLLBACK'); throw error }
  }
  const beginThreadSubmission = (principal, threadId, commandId) => {
    requireThread(principal, threadId)
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
  return {
    authenticateCookie(cookie = '') {
      const values = String(cookie).split(';').map((item) => item.trim()).filter((item) => item.startsWith('demo_session='))
      if (values.length !== 1 || !values[0].slice(13)) fail(401, 'UNAUTHENTICATED', '请先登录')
      return lookupSession(hash(values[0].slice(13)))
    },
    refresh,
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
      return bindThread(principal, { ...source, threadId: targetThreadId, visibility: 'private' })
    },
    recordLegacyNativeFork(sourceThreadId, targetThreadId, sourceNativeId, targetNativeId) {
      // Called only after a provider's actual fork response, never from RPC
      // input. A rollback protection copy belongs to the same app thread and
      // must not replace its live native identity.
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
    requireToolThread(threadId) {
      const binding = getThreadBinding(threadId)
      if (!binding) fail(403, 'THREAD_NOT_BOUND', '工具调用没有获授权的业务会话')
      if (binding.compatibilityReadOnly) fail(409, 'LEGACY_THREAD_READ_ONLY', '历史会话缺少可验证的原生续接记录，仅供查看')
      workspaceForUser(binding.ownerId, binding.projectId, binding.workspaceType || 'internal', binding.workspaceVersionId, binding.environmentId)
      return validateBinding(binding)
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
    requireCsrf(principal, presented) {
      const current = refresh(principal)
      if (typeof presented !== 'string' || !timingSafeEqual(Buffer.from(hash(presented)), Buffer.from(hash(current.csrf))))
        fail(403, 'CSRF', '会话校验失败，请刷新后重试')
    },
    recordNativeSession(principal, nativeSessionId) {
      const current = refresh(principal)
      bindingDb.prepare('DELETE FROM t3_native_auth_sessions WHERE expires_at<=?').run(now())
      bindingDb.prepare('INSERT OR REPLACE INTO t3_native_auth_sessions VALUES(?,?,?)').run(
        identifier(nativeSessionId, '原生登录ID'), current.sessionHash, current.expiresAt,
      )
    },
    principalForNativeSession(nativeSessionId) {
      const row = bindingDb.prepare('SELECT * FROM t3_native_auth_sessions WHERE native_session_id=? AND expires_at>?').get(nativeSessionId, now())
      if (!row) fail(401, 'UNAUTHENTICATED', '登录已失效，请重新登录')
      return lookupSession(row.autoops_session_hash)
    },
    bootstrap(principal) {
      const current = refresh(principal)
      const profile = resolveProductProfile()
      const visibleProjects = catalog.projects.filter((entry) => { try { membershipForUser(current.id, entry.id); return true } catch { return false } })
      return {
        principal: { id: current.id, displayName: current.displayName, role: current.role },
        csrfToken: current.csrf,
        gatewayBasePath: '/api/agent-demo/t3',
        fixedModel: { instanceId: 'codex', model: process.env.AUTOOPS_T3_MODEL || process.env.AGENT_DEMO_MODEL || '' },
        modelSelectionEnabled: Boolean(process.env.AUTOOPS_T3_MODEL || process.env.AGENT_DEMO_MODEL) && configuredBusinessModels().discovered,
        runtimeMode: 'approval-required',
        projects: visibleProjects.map(({ id, name, environments }) => ({
          id, name, environments: environments.filter((entry) => membershipForUser(current.id, id).environmentIds.includes(entry.id)), membership: membershipForUser(current.id, id),
          agents: catalog.agents.filter((agent) => agent.projectIds.includes(id)).map(({ id, name }) => ({ id, name })),
        })),
        agents: catalog.agents.filter((entry) => entry.projectIds.some((id) => visibleProjects.some((project) => project.id === id))),
        productProfile: { id: profile.id },
        capabilities: profile.capabilities,
        clientSettingsOverrides: profile.clientSettingsOverrides,
      }
    },
  }
}

let configuredAccess
export function autoOpsAccessEnabled() {
  return process.env.AUTOOPS_T3_DATA_DIR !== undefined
}
export const isAutoOpsEnabled = autoOpsAccessEnabled
export function configuredAutoOpsProjects() { return autoOpsAccessEnabled() ? projects : [] }
export function configuredAutoOpsAccess() {
  if (!autoOpsAccessEnabled()) return undefined
  if (configuredAccess) return configuredAccess
  if (!process.env.AUTOOPS_T3_DATA_DIR?.trim()) fail(500, 'INVALID_DATA_DIR', 'AutoOps 数据目录不能为空')
  const directory = resolve(process.env.AUTOOPS_T3_DATA_DIR)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const sessionDb = new DatabaseSync(join(directory, 'demo.sqlite'), { readOnly: true })
  const bindingDb = new DatabaseSync(join(directory, 't3-autoops.sqlite'))
  bindingDb.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
  initializeAutoOpsAccessSchema(bindingDb)
  configuredAccess = createAutoOpsAccess({ sessionDb, bindingDb, workspaceStore: configuredWorkspaceStore() })
  return configuredAccess
}

export function getThreadBinding(threadId) {
  return configuredAutoOpsAccess()?.getThreadBinding(threadId)
}
export function requireToolThread(threadId) {
  const access = configuredAutoOpsAccess()
  if (!access) fail(503, 'AUTOOPS_NOT_CONFIGURED', 'AutoOps 业务授权尚未配置')
  return access.requireToolThread(threadId)
}
