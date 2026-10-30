import { autoOpsRequest, AutoOpsRequestError } from './apiClient'
import type { DeploymentRequestReceipt } from '../../../../../../autoops/contracts/deployments.ts'
export type {
  DeploymentRequestReceipt,
  DeploymentSourceRef,
  DeploymentCapabilities,
} from '../../../../../../autoops/contracts/deployments.ts'
import type {
  DeploymentRepositoryRefs,
  DeploymentRepositoryHistory,
  StaticDeploymentConfig,
  JavaDeploymentConfig,
  DeploymentConfig,
  DeploymentKind,
  DeploymentService,
  DeploymentServiceSubmission,
  DeploymentServiceSource,
  DeploymentServiceSourceSubmission,
  DeploymentTargetUpdate,
  DeploymentRelease,
  DeploymentTarget,
  DeploymentTask,
  DeploymentLog,
  DeploymentTaskDetails,
  DeploymentOverview,
  DeploymentSubmission,
  DeploymentTargetSubmission,
  DeploymentServer,
  DeploymentSourceIdentity,
} from '../../../../../../autoops/contracts/deployments.ts'
export type {
  DeploymentRepositoryRefs,
  DeploymentRepositoryHistory,
  StaticDeploymentConfig,
  JavaDeploymentConfig,
  DeploymentConfig,
  DeploymentKind,
  DeploymentService,
  DeploymentServiceSubmission,
  DeploymentServiceSource,
  DeploymentServiceSourceSubmission,
  DeploymentTargetUpdate,
  DeploymentRelease,
  DeploymentTarget,
  DeploymentTask,
  DeploymentLog,
  DeploymentTaskDetails,
  DeploymentOverview,
  DeploymentSubmission,
  DeploymentTargetSubmission,
  DeploymentServer,
  DeploymentSourceIdentity,
} from '../../../../../../autoops/contracts/deployments.ts'

/** 中断的写请求保留待核查状态，界面不能自行推断成功或失败。 */
export class DeploymentRequestError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

export const isDeploymentAccessError = (error: unknown) =>
  error instanceof DeploymentRequestError &&
  (error.status === 401 || error.status === 403 || error.status === 404)

async function request<T>(
  projectId: string,
  suffix: string,
  body?: object,
  signal?: AbortSignal,
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  timeoutMs?: number,
): Promise<T> {
  try {
    return await autoOpsRequest<T>(
      `/autoops/projects/${encodeURIComponent(projectId)}/deployments${suffix}`,
      {
        label: '部署',
        ...(method ? { method } : {}),
        ...(body === undefined ? {} : { body }),
        ...(signal ? { signal } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      },
    )
  } catch (cause) {
    if (cause instanceof AutoOpsRequestError)
      throw new DeploymentRequestError(cause.message, cause.uncertain, cause.status, cause.code)
    throw cause
  }
}

export const loadDeployments = (
  projectId: string,
  environmentId?: string,
  signal?: AbortSignal,
  catalog = false,
) =>
  request<DeploymentOverview>(
    projectId,
    environmentId
      ? `?environmentId=${encodeURIComponent(environmentId)}${catalog ? '&includeAvailableServices=1' : ''}`
      : '',
    undefined,
    signal,
  )
export const loadDeploymentRequest = async (projectId: string, requestId: string) => {
  const result = await autoOpsRequest<DeploymentRequestReceipt>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/deployments/requests/${encodeURIComponent(requestId)}`,
    { label: '部署结果' },
  )
  if (
    result?.requestId !== requestId ||
    !['not_observed', 'accepted', 'completed'].includes(result.state)
  )
    throw new DeploymentRequestError('原请求结果格式无法核对，请稍后再检查。', true)
  return result
}
export const removeEnvironmentDeploymentService = (
  projectId: string,
  environmentId: string,
  serviceId: string,
  input: { requestId: string; configKey: string },
) =>
  autoOpsRequest<{ deleted: true }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(environmentId)}/deployment-services/${encodeURIComponent(serviceId)}`,
    { label: '移除环境服务', method: 'DELETE', body: input },
  )
export const createDeploymentTarget = (projectId: string, input: DeploymentTargetSubmission) =>
  request<{ target: DeploymentTarget }>(projectId, '/targets', input)
export const loadDeploymentRepositoryRefs = (
  projectId: string,
  sourceId: string,
  signal?: AbortSignal,
) =>
  request<DeploymentRepositoryRefs>(
    projectId,
    `/repositories/${encodeURIComponent(sourceId)}/refs`,
    undefined,
    signal,
  )
export const loadDeploymentRepositoryHistory = (
  projectId: string,
  sourceId: string,
  selection: { refKind?: 'default' | 'branch' | 'tag' | 'commit'; ref?: string },
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({
    refKind: selection.refKind ?? 'default',
    ref: selection.ref ?? '',
  })
  return request<DeploymentRepositoryHistory>(
    projectId,
    `/repositories/${encodeURIComponent(sourceId)}/history?${query}`,
    undefined,
    signal,
    undefined,
    210_000,
  )
}
export const saveDeploymentService = (projectId: string, input: DeploymentServiceSubmission) =>
  request<{ service: DeploymentService }>(projectId, '/services', input)
export const updateDeploymentTarget = (
  projectId: string,
  targetId: string,
  input: DeploymentTargetUpdate,
) =>
  request<{ target: DeploymentTarget }>(
    projectId,
    `/targets/${encodeURIComponent(targetId)}`,
    input,
    undefined,
    'PATCH',
  )
export const loadDeploymentServiceSource = (
  projectId: string,
  serviceId: string,
  environmentId: string,
  signal?: AbortSignal,
) =>
  request<{ source: DeploymentServiceSource | null }>(
    projectId,
    `/services/${encodeURIComponent(serviceId)}/sources/${encodeURIComponent(environmentId)}`,
    undefined,
    signal,
  )
export const saveDeploymentServiceSource = (
  projectId: string,
  serviceId: string,
  environmentId: string,
  input: DeploymentServiceSourceSubmission,
) =>
  request<{ source: DeploymentServiceSource }>(
    projectId,
    `/services/${encodeURIComponent(serviceId)}/sources/${encodeURIComponent(environmentId)}`,
    input,
    undefined,
    'PUT',
  )
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
export const loadDeploymentReleases = (
  projectId: string,
  targetId: string,
  signal?: AbortSignal,
  page?: { offset: number; limit: number },
) =>
  request<{ releases: DeploymentRelease[] }>(
    projectId,
    `/targets/${encodeURIComponent(targetId)}/releases${page ? `?offset=${page.offset}&limit=${page.limit}` : ''}`,
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
  build: '构建',
  building: '构建',
  image: '准备镜像',
  deploy: '切换服务',
  deploying: '切换服务',
  health: '健康检查',
  healthcheck: '健康检查',
  checking: '健康检查',
  verifying: '验证服务',
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

export const removeDeploymentConfiguration = (
  projectId: string,
  kind: 'service' | 'target',
  id: string,
  input: { requestId: string; configKey: string; environmentId?: string },
) =>
  request<{ deleted: true; id: string }>(
    projectId,
    `/${kind === 'service' ? 'services' : 'targets'}/${encodeURIComponent(id)}`,
    input,
    undefined,
    'DELETE',
  )
