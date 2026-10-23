import { autoOpsApiUrl, autoOpsRequest } from './apiClient'
import type { WorkspaceBuildContext } from '../../../../../../autoops/contracts/workspaces.ts'
import type { WorkspaceSource, WorkspaceVersion, WorkspaceFile, WorkspaceTask, WorkspaceRelease, WorkspaceOverview, WorkspaceTreeEntry, WorkspaceContent } from '../../../../../../autoops/contracts/workspaces.ts'
export type { WorkspaceSource, WorkspaceVersion, WorkspaceFile, WorkspaceTask, WorkspaceRelease, WorkspaceOverview, WorkspaceTreeEntry, WorkspaceContent } from '../../../../../../autoops/contracts/workspaces.ts'

const workspacePath = (projectId: string) => `/autoops/projects/${encodeURIComponent(projectId)}/workspaces`
const workspaceBase = (projectId: string) => autoOpsApiUrl(workspacePath(projectId))
const request = <T>(projectId: string, suffix: string, body?: object, signal?: AbortSignal) =>
  autoOpsRequest<T>(workspacePath(projectId) + suffix, { label: '工作区', ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}) })

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

export const generateWorkspacePackages = (projectId: string, sourceVersionId: string, services: Array<'frontend' | 'backend'>, requestId: string, contexts?: WorkspaceBuildContext[]) =>
  request<WorkspaceTask>(projectId, '/packages', { sourceVersionId, services, requestId, ...(contexts ? { contexts } : {}) })

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
