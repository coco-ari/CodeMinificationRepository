import { configuredBusinessResourceCatalog } from './resources.mjs'
import { assertPersonalSettingsPatch } from './settings-preferences.mjs'
import { isPersonalPreferenceCommand } from './preferences.mjs'
import { AutoOpsAccessError } from './access.mjs'
import { resolveBusinessSkillMentions } from './skills.mjs'
import { authorizeBusinessSkillCwd } from './scoped-skills.mjs'
import { assertBusinessModelSelection } from './models.mjs'
import { resolve } from 'node:path'
import { resolveProductProfile, PRODUCT_CAPABILITY_DISABLED, PRODUCT_CAPABILITY_MESSAGE } from './product-profile.mjs'
import { authorizeCustomerModel, assertCustomerInput, isCustomerProviderInstanceId } from './customer-target.mjs'

const denied = (message = '该操作不在当前 AutoOps 业务权限范围内') => {
  throw new AutoOpsAccessError(403, 'AUTOOPS_OPERATION_FORBIDDEN', message)
}
const reads = new Set([
  'server.getUsageSummary', 'server.probe', 'server.getConfig', 'server.getSettings', 'server.getBackgroundPolicy',
  'server.reportClientActivity', 'subscribeServerConfig', 'subscribeServerLifecycle',
  'subscribeBackgroundPolicy', 'projects.list',
  'orchestration.getArchivedShellSnapshot', 'orchestration.subscribeArchivedShell',
  'orchestration.subscribeShell', 'orchestration.searchThreads',
  'projects.searchEntries', 'projects.listEntries', 'projects.readFile', 'filesystem.getMetadata',
])
const threadMethods = new Set([
  'orchestration.searchThread', 'orchestration.searchThreadStream',
  'orchestration.getThreadProjection', 'orchestration.getTurnItem',
  'orchestration.subscribeThread', 'orchestration.subscribeCommandOutput',
  'assets.persistChatAttachments',
  'mcpApps.callTool', 'mcpApps.toolInfo', 'mcpApps.readResource', 'mcpApps.updateModelContext',
])
const commands = new Set([
  'thread.create', 'thread.stop', 'thread.archive', 'thread.unarchive', 'thread.delete',
  'thread.settle', 'thread.unsettle', 'thread.snooze', 'thread.unsnooze', 'thread.auto-settle.set',
  'thread.pin', 'thread.unpin', 'thread.pin.reorder', 'thread.active.reorder',
  'thread.visit', 'thread.mark-unread', 'thread.metadata.update',
  'thread.runtime-mode.set', 'thread.interaction-mode.set', 'thread.model-selection.set',
  'provider-session.detach', 'message.dispatch', 'run.interrupt',
  'queued-message.promote-to-steer', 'queue.resume', 'queued-run.reorder',
  'queued-run.cancel', 'queued-run.edit', 'runtime-request.respond', 'thread.user-input.dismiss',
  'checkpoint.rollback', 'thread.fork', 'prepared-run.retry',
])

/** Product restrictions supplement ACLs; old records are never rewritten. */
export function authorizeProductRpc(method, payload = {}, env = process.env) {
  const { capabilities } = resolveProductProfile(env)
  const requireCapability = (name) => { if (!capabilities[name]) throw new AutoOpsAccessError(403, PRODUCT_CAPABILITY_DISABLED, PRODUCT_CAPABILITY_MESSAGE) }
  if (method === 'server.getUsageSummary') requireCapability('usageDashboard')
  if (['server.upsertKeybinding', 'server.removeKeybinding'].includes(method)) requireCapability('customKeybindings')
  if (['mcpApps.callTool', 'mcpApps.updateModelContext'].includes(method)) requireCapability('interactiveArtifacts')
  if (!['orchestration.launchThread', 'orchestration.dispatchCommand'].includes(method)) return
  if (payload.interactionMode === 'plan' || payload.sourcePlanRef || payload.initialMessage?.sourcePlanRef) requireCapability('planMode')
  if (payload.type === 'thread.fork') requireCapability('threadFork')
  if (payload.type === 'checkpoint.rollback') requireCapability('historyRollback')
  if (['thread.snooze', 'thread.settle', 'thread.auto-settle'].includes(payload.type) ||
      (payload.type === 'thread.auto-settle.set' && payload.enabled)) requireCapability('advancedOrganization')
  // Cancelling an old recovery is allowed; scheduling another is not.
  if ((payload.type === 'thread.metadata.update' && payload.limitRecovery != null &&
      (payload.limitRecovery.autoResume === true || payload.limitRecovery.snooze === true || (payload.limitRecovery.autoResume !== false && payload.limitRecovery.snooze !== false))) ||
      payload.restartContinuationOfRunId || payload.usageLimitContinuationOfRunId || payload.usageLimitRecoveryRequestId) requireCapability('automaticRecovery')
}

function checkRuntime(input, access, binding) {
  if (input.runtimeMode !== undefined && input.runtimeMode !== 'approval-required') denied('当前 Agent 仅允许受限运行模式')
  if (input.workspaceStrategy && (input.workspaceStrategy.type !== 'root' || input.workspaceStrategy.branch)) denied()
  if (input.worktreePath || input.branch || input.cwd) denied('业务会话不允许切换宿主工作目录')
  if (input.importedNativeThread || input.scheduledTaskId || input.senderThreadId || input.notification || input.delegatedCompletion)
    denied('浏览器不能声明内部运行器或系统任务身份')
  if (input.createdBy !== undefined && input.createdBy !== 'user') denied()
  if (input.dispatchMode?.workspaceStrategy) checkRuntime({ workspaceStrategy: input.dispatchMode.workspaceStrategy }, access, binding)
  if (input.restoreFiles === true) denied('业务会话不允许恢复宿主文件')
  if (input.modelSelection) {
    try {
      if (binding?.executionBinding?.kind === 'customer') authorizeCustomerModel(access, binding, input.modelSelection)
      else assertBusinessModelSelection(input.modelSelection)
    }
    catch(error) { denied(error.message) }
  }
}

function checkReferences(access, principal, value, targetThreadId, depth = 0) {
  if (depth > 25) denied('上下文结构过深')
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const entry of value) checkReferences(access, principal, entry, targetThreadId, depth + 1)
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (['threadId', 'sourceThreadId', 'targetThreadId', 'parentThreadId', 'anchorThreadId'].includes(key) && typeof entry === 'string') {
      if (entry === targetThreadId) access.requireThread(principal, entry)
      else access.requireReference(principal, entry, targetThreadId)
    } else if (key === 'attachments' && Array.isArray(entry)) {
      for (const attachment of entry) {
        if (typeof attachment?.id === 'string') access.requireAttachment(principal, attachment.id, targetThreadId)
      }
    } else if (key === 'attachmentsByQuestionId' && entry && typeof entry === 'object') {
      for (const attachments of Object.values(entry)) for (const attachment of attachments)
        access.requireAttachment(principal, attachment.id, targetThreadId)
    } else if (typeof entry === 'object' && entry !== null) checkReferences(access, principal, entry, targetThreadId, depth + 1)
  }
}

export function authorizeAutoOpsRpc(access, principal, method, payload = {}) {
  access.refresh(principal)
  authorizeProductRpc(method, payload)
  if (reads.has(method)) return
  if (method === 'server.refreshProviders') {
    if (isCustomerProviderInstanceId(payload.instanceId)) {
      if (Object.keys(payload).some(key=>!['instanceId','fresh'].includes(key)) || !access.customerRegistry.listDevices(principal.id).some(device=>payload.instanceId===`customer-${device.id}-codex`)) denied('只能刷新自己的客户运行器')
      return
    }
    if(Object.keys(payload).some(key=>!['instanceId','cwd','fresh'].includes(key)) || (payload.instanceId!==undefined&&payload.instanceId!=='codex') || (payload.fresh!==undefined&&typeof payload.fresh!=='boolean'))denied()
    if(payload.cwd!==undefined) {
      const data=process.env.AUTOOPS_T3_DATA_DIR
      if(typeof payload.cwd==='string'&&data&&payload.cwd.startsWith('autoops/skill-context/')) {authorizeBusinessSkillCwd(data,payload.cwd,{access,principal});return}
      if(typeof payload.cwd!=='string'||!data||!access.bootstrap(principal).projects.some(project=>payload.cwd===`autoops/${project.id}/workspaces` || (project.membership.workspaceAccess==='internal' && payload.cwd===resolve(data,'t3/workspaces',project.id))))denied('技能目录只能刷新当前账号获授权的项目')
    }
    return
  }
  if (method === 'server.updateSettings') {
    if (payload.providerInstanceMutation) denied()
    assertPersonalSettingsPatch(payload.patch)
    return
  }
  if (method === 'orchestration.launchThread') {
    const binding = access.requireThread(principal, payload.threadId)
    const customer = binding.executionBinding?.kind === 'customer'
    if (customer) { access.requireThreadExecution(principal, binding.threadId, {requireOnline:true}); assertCustomerInput(payload.initialMessage, binding.executionBinding) }
    else resolveBusinessSkillMentions(payload.initialMessage?.text,process.env,binding)
    if (binding.nativeParentThreadId) denied('原生子任务由父会话控制，仅供查看')
    if (binding.compatibilityReadOnly) denied('兼容历史仅供查看，不能继续执行')
    if (binding.projectId !== payload.projectId) denied('会话项目与已确认的授权绑定不一致')
    access.requireQuestionForActor(principal.id, binding.threadId, payload.modelSelection)
    checkRuntime(payload, access, binding)
    checkReferences(access, principal, payload.initialMessage, binding.threadId)
    if (!customer) configuredBusinessResourceCatalog()?.requireContext(binding.threadId,payload.initialMessage?.context,principal.id)
    return
  }
  if (method === 'orchestration.dispatchCommand') {
    if (!commands.has(payload.type)) denied()
    if (payload.type === 'thread.fork') {
      if (access.requireThread(principal,payload.sourceThreadId).executionBinding?.kind === 'customer') denied('客户首版不支持会话分支')
      if (access.requireThread(principal, payload.sourceThreadId).nativeParentThreadId) denied('原生子任务不能独立分支')
      if (access.requireThread(principal, payload.sourceThreadId).compatibilityReadOnly) denied('兼容历史无法生成可靠的原生分支')
      const target = access.getThreadBinding(payload.targetThreadId)
      if (target && target.ownerId !== principal.id) denied('目标会话身份已经被绑定')
      checkRuntime(payload)
      return
    }
    const binding = access.requireThread(principal, payload.threadId)
    const customer = binding.executionBinding?.kind === 'customer'
    if (customer) {
      if (['provider-session.detach','prepared-run.retry','thread.fork','checkpoint.rollback'].includes(payload.type)) denied('客户首版不支持此运行操作')
      assertCustomerInput(payload, binding.executionBinding)
      assertCustomerInput(payload.message, binding.executionBinding)
      assertCustomerInput(payload.initialMessage, binding.executionBinding)
      if (['message.dispatch','queue.resume','thread.model-selection.set','queued-run.edit','runtime-request.respond'].includes(payload.type))
        access.requireThreadExecution(principal, binding.threadId, {requireOnline:true})
      if (payload.type === 'queued-message.promote-to-steer')
        access.requireThreadExecution(principal, binding.threadId, {requireOnline:true})
    }
    if (binding.nativeParentThreadId && !isPersonalPreferenceCommand(payload)) denied('原生子任务由父会话控制，仅供查看')
    if (binding.compatibilityReadOnly && !isPersonalPreferenceCommand(payload) && payload.type !== 'thread.delete') denied('兼容历史仅供查看，不能修改对话或继续执行')
    if (payload.type === 'checkpoint.rollback' && binding.visibility === 'project' && payload.confirmSharedHistoryEdit !== true) denied('请先确认该编辑会改变所有成员可见的共享历史')
    if (payload.type === 'checkpoint.rollback' && payload.restoreFiles !== false) denied('业务会话编辑历史不能恢复宿主文件')
    if (payload.type === 'thread.delete' && binding.ownerId !== principal.id) denied('只有创建者可以删除会话')
    if (payload.projectId !== undefined && payload.projectId !== binding.projectId) denied()
    if (payload.type === 'thread.metadata.update' &&
      ['projectId', 'worktreePath', 'branch', 'linkedPullRequest', 'branchPullRequest'].some((key) => key in payload)) denied()
    if (['message.dispatch','thread.model-selection.set'].includes(payload.type) && payload.modelSelection !== undefined) access.requireQuestionForActor(principal.id, binding.threadId, payload.modelSelection)
    checkRuntime(payload, access, binding)
    checkReferences(access, principal, payload, binding.threadId)
    if (payload.type === 'message.dispatch' || payload.type === 'queued-run.edit') {
      if (!customer) {
        resolveBusinessSkillMentions(payload.text,process.env,binding)
        configuredBusinessResourceCatalog()?.requireContext(binding.threadId,payload.context,principal.id)
      }
    }
    return
  }
  if (threadMethods.has(method)) {
    const binding = access.requireThread(principal, payload.threadId)
    if (binding.executionBinding?.kind === 'customer' && method.startsWith('mcpApps.')) denied('本机对话不支持平台交互式工具页面')
    if (binding.nativeParentThreadId && ['assets.persistChatAttachments','mcpApps.callTool','mcpApps.updateModelContext'].includes(method)) denied('原生子任务仅供查看')
    if (binding.compatibilityReadOnly && ['assets.persistChatAttachments','mcpApps.callTool','mcpApps.updateModelContext'].includes(method)) denied('兼容历史仅供查看')
    if (method === 'mcpApps.updateModelContext') access.requireReference(principal, payload.threadId, payload.conversationThreadId)
    checkReferences(access, principal, payload, payload.threadId)
    return
  }
  if (method === 'attachments.createUploadUrl') return
  if (method === 'attachments.delete') {
    const attachment = access.requireAttachment(principal, payload.attachmentId)
    if (attachment.threadId !== null) denied('已发送附件不能按临时上传删除')
    return
  }
  if (method === 'assets.createUrl') {
    const resource = payload.resource
    if (resource?._tag === 'attachment') access.requireAttachment(principal, resource.attachmentId)
    else if (resource?._tag === 'tool-output-image') access.requireThread(principal, resource.threadId)
    else denied()
    return
  }
  denied()
}

export function prepareAutoOpsRpcPayload(access, principal, method, payload = {}) {
  if (method !== 'server.refreshProviders' || typeof payload.cwd !== 'string') return payload
  authorizeAutoOpsRpc(access, principal, method, payload)
  if(payload.cwd.startsWith('autoops/skill-context/'))return {...payload,cwd:authorizeBusinessSkillCwd(process.env.AUTOOPS_T3_DATA_DIR,payload.cwd,{access,principal})}
  const project = access.bootstrap(principal).projects.find((entry) => payload.cwd === `autoops/${entry.id}/workspaces`)
  return project ? { ...payload, cwd: resolve(process.env.AUTOOPS_T3_DATA_DIR, 't3/workspaces', project.id) } : payload
}

const projectForViewer = (access, principal, project) => access.requireMembership(principal, project.id).workspaceAccess === 'external'
  ? { ...project, workspaceRoot: `autoops/${project.id}/workspaces`, ...(Object.hasOwn(project, 'repositoryIdentity') ? {repositoryIdentity:null} : {}) }
  : project

export function filterAutoOpsShell(access, principal, snapshot) {
  access.refresh(principal)
  const permittedProject = (project) => {
    try { access.requireProject(principal, project.id); return true } catch (error) {
      if (error.status === 404) return false
      throw error
    }
  }
  const permittedThread = (thread) => access.canSeeThread(principal, thread.id)
  return {
    ...snapshot,
    ...(Array.isArray(snapshot.projects) ? { projects: snapshot.projects.filter(permittedProject).map((project) => projectForViewer(access, principal, project)) } : {}),
    ...(Array.isArray(snapshot.threads) ? { threads: snapshot.threads.filter(permittedThread) } : {}),
    ...(Array.isArray(snapshot.archivedThreads) ? { archivedThreads: snapshot.archivedThreads.filter(permittedThread) } : {}),
  }
}

export function filterAutoOpsShellItem(access, principal, item) {
  access.refresh(principal)
  if (item.kind === 'snapshot') {
    const snapshot = filterAutoOpsShell(access, principal, item.snapshot)
    const roots = new Set(snapshot.projects?.map((project) => project.workspaceRoot) ?? [])
    return { ...item, snapshot, ...(item.resolvedRepositoryIdentityRoots ? {resolvedRepositoryIdentityRoots:item.resolvedRepositoryIdentityRoots.filter((root) => roots.has(root))} : {}) }
  }
  if (item.kind === 'thread.updated' || item.kind === 'thread.removed')
    return access.canSeeThread(principal, item.thread?.id ?? item.threadId, item.kind === 'thread.removed') ? item : null
  if (item.kind === 'project.updated' || item.kind === 'project.removed') {
    if (item.kind === 'project.removed' && access.canReceiveProjectRemoval?.(principal,item.projectId)) return item
    try { access.requireProject(principal, item.project?.id ?? item.projectId); return item.project ? {...item,project:projectForViewer(access,principal,item.project)} : item } catch (error) {
      if (error.status === 404) return null
      throw error
    }
  }
  return item
}
