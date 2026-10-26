import {
  AutoOpsAccessError,
  type AutoOpsAccess,
} from '../../../../../../agent-demo/t3-adapters/access.mjs'

/** 原生运行身份限定工具输入；模型提供的旧 inputId 不能选择另一位调用者。 */
export function businessToolRun(
  access: AutoOpsAccess,
  threadId: string,
  inputId: string,
  activeRunId: string | undefined,
) {
  const inherited = access.nativeSubagentParent(threadId)
    ? access.listThreadInputs(threadId)[0]
    : undefined
  const runId = inherited?.runId ?? activeRunId
  if (!runId)
    throw new AutoOpsAccessError(409, 'THREAD_RUN_INACTIVE', '此会话没有可接受业务工具的活动任务')
  const input = access.requireRunInput(threadId, inputId, runId)
  if (!input.actorVerified) throw new AutoOpsAccessError(409, 'THREAD_ACTOR_UNVERIFIED', '旧共享任务缺少可核验的实际调用者，保留原记录但不继承创建者执行权限')
  return input
}
