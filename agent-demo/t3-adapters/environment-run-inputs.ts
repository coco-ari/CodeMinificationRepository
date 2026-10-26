import { AutoOpsAccessError, type AutoOpsAccess } from './access.mjs'

export function environmentRunScope(access: AutoOpsAccess, threadId: string, runId: string) {
  let input = access.getRunInput(threadId, runId)
  if (!input?.actorVerified)
    throw new AutoOpsAccessError(409, 'THREAD_ACTOR_UNVERIFIED', '环境查询缺少可核验的本轮调用者')
  let { binding } = access.requireToolThread(threadId, input.actorId)
  if (binding.executionBinding.kind === 'customer')
    throw new AutoOpsAccessError(403, 'ENVIRONMENT_MCP_RUN_FORBIDDEN', '此运行来源未声明平台环境连接能力')
  // 原生子任务共用创建事件所属父轮的连接输入，不能补抓目录或借用父会话下一轮。
  for (let depth = 0; binding.nativeParentThreadId; depth++) {
    if (depth >= 64)
      throw new AutoOpsAccessError(409, 'ENVIRONMENT_MCP_RUN_CONFLICT', '原生子任务来源无法核验')
    const parentThreadId = binding.nativeParentThreadId
    const original = access.getRunInput(parentThreadId, runId)
    if (!original?.actorVerified || original.inputId !== input.inputId ||
      original.actorId !== input.actorId || original.inputOwnerId !== input.inputOwnerId)
      throw new AutoOpsAccessError(403, 'ENVIRONMENT_MCP_RUN_FORBIDDEN', '子任务环境输入与原父轮不一致')
    const parent = access.requireToolThread(parentThreadId, input.actorId).binding
    if (parent.projectId !== binding.projectId || parent.environmentId !== binding.environmentId ||
      parent.executionBinding.kind !== 'platform')
      throw new AutoOpsAccessError(403, 'ENVIRONMENT_MCP_RUN_FORBIDDEN', '子任务环境输入不属于原父轮范围')
    threadId = parentThreadId
    binding = parent
    input = original
  }
  return {
    actorId: input.actorId,
    projectId: binding.projectId,
    environmentId: binding.environmentId ?? null,
    threadId,
    runId,
  }
}
