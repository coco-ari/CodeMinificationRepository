import { readAutoOpsHost } from './hostConfig'

export interface WorkspaceVersion {
  id: string
  name: string
  type: 'internal' | 'external'
  status: 'published' | 'pending_review' | 'failed'
  sourceVersionId?: string
  createdAt: string
  fileCount: number
  byteLength: number
  source: { repositories: Array<{ path: string; commit: string }>; contentHash: string }
  report?: {
    removedGitEntries: number
    replacements: number
    pendingFiles: Array<{ path: string; reason: string }>
    excludedFiles: string[]
    rulesVersion: string
  }
  isExample?: boolean
}

export interface WorkspaceRelease {
  id: string
  name: string
  sourceVersionId: string
  createdAt: string
  services: Array<{ service: 'frontend' | 'backend'; name: string; size: number; sha256: string }>
  manifest: object
}

export interface WorkspaceTask {
  id: string
  type: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
  stage: string
  message: string
  createdAt: string
  versionId?: string
  releaseId?: string
  error?: string
}

export interface WorkspaceOverview {
  projectId: string
  internalVersions: WorkspaceVersion[]
  externalVersions: WorkspaceVersion[]
  releases: WorkspaceRelease[]
  tasks: WorkspaceTask[]
  import?: { supported: boolean; hosts: string[]; maxBytes: number; maxFiles: number }
}

export interface WorkspaceTreeEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  size: number
}

export interface WorkspaceContent {
  path: string
  name: string
  mime: string
  contents: string
  byteLength: number
  truncated: boolean
}

function workspaceBase(projectId: string) {
  const host = readAutoOpsHost()
  if (!host) throw new Error('当前入口未连接项目工作区。')
  return `${host.gatewayBasePath}/autoops/projects/${encodeURIComponent(projectId)}/workspaces`
}

async function request<T>(projectId: string, suffix: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(workspaceBase(projectId) + suffix, {
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-CSRF': readAutoOpsHost()?.csrfToken ?? '' },
      body: JSON.stringify(body),
    }),
  })
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'message' in result
      ? result.message
      : result && typeof result === 'object' && 'error' in result ? result.error : undefined
    throw new Error(typeof message === 'string' ? message : `工作区请求失败（${response.status}），请重试。`)
  }
  return result as T
}

export const loadWorkspaces = (projectId: string, signal?: AbortSignal) =>
  request<WorkspaceOverview>(projectId, '', undefined, signal)

export const loadWorkspaceTree = (projectId: string, versionId: string, directory = '', signal?: AbortSignal) =>
  request<{ entries: WorkspaceTreeEntry[]; truncated: boolean }>(projectId,
    `/versions/${encodeURIComponent(versionId)}/tree?directory=${encodeURIComponent(directory)}`, undefined, signal)

export const loadWorkspaceContent = (projectId: string, versionId: string, path: string, signal?: AbortSignal) =>
  request<WorkspaceContent>(projectId,
    `/versions/${encodeURIComponent(versionId)}/content?path=${encodeURIComponent(path)}`, undefined, signal)

export const searchWorkspaceFiles = (projectId: string, versionId: string, query: string, limit = 200, signal?: AbortSignal) =>
  request<{ entries: Array<{ path: string; kind: 'file' | 'directory' }>; truncated: boolean }>(projectId,
    `/versions/${encodeURIComponent(versionId)}/search?query=${encodeURIComponent(query)}&limit=${limit}`, undefined, signal)

export const loadWorkspaceFileMetadata = (projectId: string, versionId: string, path: string, signal?: AbortSignal) =>
  request<{ name: string; mime: string; size: number }>(projectId,
    `/versions/${encodeURIComponent(versionId)}/download?metadata=1&path=${encodeURIComponent(path)}`, undefined, signal)

export const generateExternalWorkspace = (projectId: string, sourceVersionId: string, rules: Array<{ find: string; replace: string }>, requestId: string) =>
  request<WorkspaceTask>(projectId, '/external', { sourceVersionId, rules, requestId })

export const publishWorkspace = (projectId: string, versionId: string, confirmedPaths: string[], excludedPaths: string[]) =>
  request<WorkspaceVersion>(projectId, `/versions/${encodeURIComponent(versionId)}/publish`, { confirmedPaths, excludedPaths })

export const generateWorkspacePackages = (projectId: string, sourceVersionId: string, services: Array<'frontend' | 'backend'>, requestId: string) =>
  request<WorkspaceTask>(projectId, '/packages', { sourceVersionId, services, requestId })

export const importWorkspaceRepository = (projectId: string, repositoryUrl: string, branch: string, requestId: string) =>
  request<WorkspaceTask>(projectId, '/import', { repositoryUrl, branch, requestId })

export const cancelWorkspaceTask = (projectId: string, taskId: string) =>
  request<WorkspaceTask>(projectId, `/tasks/${encodeURIComponent(taskId)}/cancel`, {})

export function workspacePackageUrl(projectId: string, releaseId: string, service: 'frontend' | 'backend' | 'manifest') {
  return `${workspaceBase(projectId)}/packages/${encodeURIComponent(releaseId)}/${service}${service === 'manifest' ? '' : '/download'}`
}

export function workspaceFileDownloadUrl(projectId: string, versionId: string, path: string) {
  return `${workspaceBase(projectId)}/versions/${encodeURIComponent(versionId)}/download?path=${encodeURIComponent(path)}`
}

export function startWorkspaceConversation(projectId: string, version: WorkspaceVersion) {
  if (version.status !== 'published') return
  window.dispatchEvent(new CustomEvent('autoops:new-workspace-thread', {
    detail: { projectId, workspaceType: version.type, workspaceVersionId: version.id },
  }))
}
