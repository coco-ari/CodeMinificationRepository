import type { DeploymentRelease, DeploymentTarget, DeploymentTask } from '../deployments'

export interface DeploymentRuntimeStatus {
  state: 'unpublished' | 'confirmed' | 'updating' | 'uncertain'
  message: string
  /** 仅代表最近一次成功收据确认的版本，不证明站点此刻仍健康。 */
  confirmedRelease: DeploymentRelease | null
  activeTaskId?: string
  attentionTaskId?: string
}

const terminalStatuses = new Set(['succeeded', 'failed', 'rolled_back', 'interrupted'])
const mutationStages = new Set([
  'deploy',
  'deploying',
  'health',
  'healthcheck',
  'checking',
  'verifying',
  'rollback',
  'rolling_back',
])

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : undefined
}

function taskTime(task: DeploymentTask): number | undefined {
  return timestamp(task.updatedAt) ?? timestamp(task.createdAt)
}

function confirmsRelease(task: DeploymentTask, releaseId: string): boolean {
  if (task.status === 'succeeded') return (task.result?.release?.id ?? task.id) === releaseId
  return (
    task.status === 'rolled_back' &&
    (task.result?.rollback?.release?.id ?? task.result?.release?.id) === releaseId
  )
}

function attentionMessage(task: DeploymentTask): string | undefined {
  if (task.result?.rollback?.status === 'failed') return '自动恢复失败，当前运行状态待核对。'
  if (task.result?.cleanupError) return '部署清理出现异常，请核对清理结果与运行状态。'
  if (
    task.status === 'interrupted' &&
    (mutationStages.has(task.stage) ||
      task.stageHistory?.some((entry) => mutationStages.has(entry.stage)))
  )
    return '切换或恢复期间任务中断，当前运行状态待核对。'
  return undefined
}

/** 概览只保留有限历史；以已收到的事实提示风险，不把历史成功记录当成实时探测。 */
export function deriveDeploymentRuntimeStatus(
  target: Pick<DeploymentTarget, 'id' | 'currentRelease'>,
  tasks: readonly DeploymentTask[],
): DeploymentRuntimeStatus {
  const confirmedRelease = target.currentRelease ?? null
  const scoped = tasks
    .filter((task) => task.targetId === target.id)
    .toSorted((left, right) => (taskTime(right) ?? Infinity) - (taskTime(left) ?? Infinity))
  const confirmationTimes = confirmedRelease
    ? [
        timestamp(confirmedRelease.createdAt),
        ...scoped.filter((task) => confirmsRelease(task, confirmedRelease.id)).map(taskTime),
      ].filter((value): value is number => value !== undefined)
    : []
  // 自动恢复可重新确认较旧的版本，因此不能仅比较版本自身的创建时间。
  const confirmedAt = confirmationTimes.length ? Math.max(...confirmationTimes) : undefined
  const activeTask = scoped.find((task) => !terminalStatuses.has(task.status))
  const activity = activeTask ? { activeTaskId: activeTask.id } : {}
  const attention = scoped.find((task) => {
    if (!attentionMessage(task)) return false
    const at = taskTime(task)
    // 缺少时间或时间并列不足以证明恢复已经发生，保留需要核对的提示。
    return confirmedAt === undefined || at === undefined || at >= confirmedAt
  })
  if (attention)
    return {
      state: 'uncertain',
      message: attentionMessage(attention)!,
      confirmedRelease,
      ...activity,
      attentionTaskId: attention.id,
    }
  if (activeTask)
    return {
      state: 'updating',
      message: '发布或回退任务处理中，新的运行结果尚未确认。',
      confirmedRelease,
      ...activity,
    }
  return confirmedRelease
    ? { state: 'confirmed', message: '已有历史成功收据，显示上次确认版本。', confirmedRelease }
    : { state: 'unpublished', message: '尚无成功发布收据。', confirmedRelease }
}
