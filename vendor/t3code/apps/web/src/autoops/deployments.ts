import { autoOpsRequest, AutoOpsRequestError } from './apiClient'
import type { StaticDeploymentConfig, DeploymentRelease, DeploymentTarget, DeploymentTask, DeploymentLog, DeploymentTaskDetails, DeploymentOverview, DeploymentSubmission, DeploymentTargetSubmission, DeploymentServer, DeploymentSourceIdentity } from '../../../../../../autoops/contracts/deployments.ts'
export type { StaticDeploymentConfig, DeploymentRelease, DeploymentTarget, DeploymentTask, DeploymentLog, DeploymentTaskDetails, DeploymentOverview, DeploymentSubmission, DeploymentTargetSubmission, DeploymentServer, DeploymentSourceIdentity } from '../../../../../../autoops/contracts/deployments.ts'

/** 中断的写请求保留待核查状态，界面不能自行推断成功或失败。 */
export class DeploymentRequestError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    super(message)
  }
}

async function request<T>(projectId: string, suffix: string, body?: object, signal?: AbortSignal): Promise<T> {
  try {
    return await autoOpsRequest<T>(`/autoops/projects/${encodeURIComponent(projectId)}/deployments${suffix}`, {
      label: '部署', ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}),
    })
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError) throw new DeploymentRequestError(cause.message, cause.uncertain)
    throw cause
  }
}

export const loadDeployments = (projectId: string, environmentId?: string, signal?: AbortSignal) =>
  request<DeploymentOverview>(
    projectId,
    environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : '',
    undefined,
    signal,
  )
export const createDeploymentTarget = (projectId: string, input: DeploymentTargetSubmission) =>
  request<{ target: DeploymentTarget }>(projectId, '/targets', input)
export const submitDeployment = (projectId: string, input: DeploymentSubmission) =>
  request<{ task: DeploymentTask }>(projectId, '/tasks', input)
export const loadDeploymentTask = (
  projectId: string,
  taskId: string,
  after = 0,
  signal?: AbortSignal,
) =>
  request<DeploymentTaskDetails>(
    projectId,
    `/tasks/${encodeURIComponent(taskId)}?after=${after}`,
    undefined,
    signal,
  )
export const loadDeploymentReleases = (projectId: string, targetId: string, signal?: AbortSignal) =>
  request<{ releases: DeploymentRelease[] }>(
    projectId,
    `/targets/${encodeURIComponent(targetId)}/releases`,
    undefined,
    signal,
  )

export const deploymentTaskFinished = (task: DeploymentTask) =>
  ['succeeded', 'failed', 'rolled_back', 'interrupted'].includes(task.status)
const statusLabels: Record<string, string> = {
  preparing: '准备中',
  queued: '已排队',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  rolled_back: '发布失败，已恢复',
  interrupted: '已中断',
}
const stageLabels: Record<string, string> = {
  queued: '排队',
  source_fetch: '获取源码',
  source_resolve: '固定来源',
  source_archive: '保存源码包',
  download: '下载校验',
  downloading: '下载校验',
  extract: '解压',
  extracting: '解压',
  build: '构建前端',
  building: '构建前端',
  image: '准备镜像',
  deploy: '切换站点',
  deploying: '切换站点',
  health: '健康检查',
  healthcheck: '健康检查',
  checking: '健康检查',
  verifying: '验证站点',
  rollback: '恢复版本',
  rolling_back: '恢复版本',
  completed: '完成',
  succeeded: '完成',
  done: '完成',
  failed: '失败',
  interrupted: '已中断',
  rolled_back: '已恢复',
  prepare: '准备',
  preparing: '准备',
}
export const deploymentStatusLabel = (status: string) => statusLabels[status] ?? status
export const deploymentStageLabel = (stage: string) => stageLabels[stage] ?? stage
