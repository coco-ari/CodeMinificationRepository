import { readAutoOpsHost } from './hostConfig'

export interface StaticDeploymentConfig {
  kind: 'static'
  module: string
  artifactPath: string
  buildImage: string
  packageManager: 'npm' | 'pnpm'
  packageManagerVersion: string
  buildScript: string
  buildArgs: string[]
  build: { cpus: number; memoryMb: number }
  health: {
    url: string
    bodyIncludes: string
    status: number
    timeoutSeconds: number
    intervalSeconds: number
  }
}

export interface DeploymentRelease {
  id: string
  targetId: string
  createdAt: string
  revision?: string
  current?: boolean
  available?: boolean
  archiveStatus?: string
  sourceIdentity?: { packageId?: string; sourceVersionId?: string; service?: string }
  config?: StaticDeploymentConfig
}

export interface DeploymentTarget {
  id: string
  name: string
  environmentId: string
  serverId: string
  kind?: 'static'
  service?: 'frontend'
  configKey: string
  config: StaticDeploymentConfig
  currentRelease?: DeploymentRelease | null
}

export interface DeploymentTask {
  id: string
  targetId: string
  status: string
  stage: string
  action?: string
  createdAt: string
  updatedAt?: string
  error?: string | null
  lastSeq?: number
  requestId?: string
  stageHistory?: Array<{ stage: string; startedAt?: string; finishedAt?: string }>
  sourceIdentity?: { packageId?: string; sourceVersionId?: string }
  result?: {
    error?: string
    cleanupError?: string
    recoveryMethod?: string
    release?: DeploymentRelease
    rollback?: {
      status: 'succeeded' | 'failed' | 'unavailable'
      error?: string
      release?: DeploymentRelease
    }
  }
}

export interface DeploymentLog {
  seq: number
  at?: string
  stage?: string
  message: string
}
export interface DeploymentTaskDetails {
  task: DeploymentTask
  logs: DeploymentLog[]
  nextSeq: number
}
export interface DeploymentOverview {
  enabled: boolean
  environments: Array<{ id: string; name: string }>
  servers: Array<{
    id: string
    name: string
    online: boolean
    environmentId?: string
    version?: string
    revoked?: boolean
    capabilities?: string[]
  }>
  targets: DeploymentTarget[]
  tasks: DeploymentTask[]
}

export interface DeploymentSubmission {
  targetId: string
  action: 'deploy' | 'rollback'
  packageId?: string
  service: 'frontend'
  configKey: string
  releaseId?: string
  requestId: string
}

export interface DeploymentTargetSubmission {
  name: string
  environmentId: string
  serverId: string
  config: StaticDeploymentConfig
  requestId: string
}

/** An interrupted mutation has no client-side success/failure inference. */
export class DeploymentRequestError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    super(message)
  }
}

function deploymentBase(projectId: string) {
  const host = readAutoOpsHost()
  if (!host) throw new Error('当前入口未连接部署服务。')
  return `${host.gatewayBasePath}/autoops/projects/${encodeURIComponent(projectId)}/deployments`
}

async function request<T>(
  projectId: string,
  suffix: string,
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(deploymentBase(projectId) + suffix, {
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Demo-CSRF': readAutoOpsHost()?.csrfToken ?? '',
            },
            body: JSON.stringify(body),
          }),
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new DeploymentRequestError(
      body
        ? '连接中断，提交结果尚未确认。请核对后用原请求重试。'
        : '部署服务暂时无法连接，请重试。',
      body !== undefined,
    )
  }
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok || result === null) {
    const message =
      result && typeof result === 'object' && 'message' in result
        ? result.message
        : result && typeof result === 'object' && 'error' in result
          ? result.error
          : undefined
    throw new DeploymentRequestError(
      typeof message === 'string' ? message : `部署请求未完成（${response.status}）。`,
      body !== undefined && (response.status >= 500 || response.status === 408 || response.ok),
    )
  }
  return result as T
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
