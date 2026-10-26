import type { ProjectRepositoryConnection } from '../../../../../../autoops/contracts/workspace-authoring.ts'
import { autoOpsRequest } from './apiClient'
export type {
  ProjectRepositoryConnection,
  ProjectRepositoryDetails,
} from '../../../../../../autoops/contracts/workspace-authoring.ts'
export const repositoryPath = (project: string) =>
  `/api/v1/projects/${encodeURIComponent(project)}/repositories`
export const loadProjectRepositories = (project: string, signal?: AbortSignal) =>
  autoOpsRequest<{ revision: number; items: ProjectRepositoryConnection[] }>(
    repositoryPath(project),
    { label: '项目仓库', ...(signal ? { signal } : {}) },
  )
export const checkProjectRepository = (project: string, id: string, signal?: AbortSignal) =>
  autoOpsRequest<{
    sourceId: string
    defaultRef: string | null
    branches: Array<{ name: string; commit: string }>
    tags: Array<{ name: string; commit: string }>
    truncated: boolean
  }>(`${repositoryPath(project)}/${encodeURIComponent(id)}/refs`, {
    label: '仓库连接',
    ...(signal ? { signal } : {}),
  })
