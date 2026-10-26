import { randomUUID } from '~/lib/utils'
import type {
  DirectoryProject,
  ProjectSettings,
} from '../../../../../../autoops/contracts/project-directory.ts'
import { autoOpsRequest, AutoOpsRequestError } from './apiClient'
import {
  autoOpsStorage,
  autoOpsStorageKey,
  installAutoOpsHost,
  readAutoOpsHost,
  type AutoOpsT3Bootstrap,
} from './hostConfig'

export type {
  DirectoryProject,
  DirectoryMember,
  ProjectSettings,
} from '../../../../../../autoops/contracts/project-directory.ts'
export const loadProjectDirectory = (signal?: AbortSignal) =>
  autoOpsRequest<{ items: DirectoryProject[] }>('/api/v1/projects', {
    label: '项目',
    ...(signal ? { signal } : {}),
  })
export const loadProjectSettings = (project: string, signal?: AbortSignal) =>
  autoOpsRequest<ProjectSettings>(`/api/v1/projects/${encodeURIComponent(project)}/settings`, {
    label: '项目设置',
    ...(signal ? { signal } : {}),
  })
export async function refreshProjectHost() {
  const bootstrap = await autoOpsRequest<AutoOpsT3Bootstrap>('/autoops/bootstrap', {
    label: '项目授权',
  })
  installAutoOpsHost(bootstrap, window.location.origin)
}
export type PendingProjectWrite = {
  path: string
  method?: 'DELETE'
  body: { requestId: string; expectedRevision: number } & Record<string, unknown>
}
const pendingKey = () => autoOpsStorageKey('project-directory:pending')
export function readPendingProjectWrite(): PendingProjectWrite | null {
  try {
    return JSON.parse(
      autoOpsStorage(window.sessionStorage).getItem(pendingKey()) ?? 'null',
    ) as PendingProjectWrite | null
  } catch {
    return null
  }
}
export function prepareProjectWrite(
  path: string,
  expectedRevision: number,
  value: object,
): PendingProjectWrite {
  return prepareProjectMutation(path, expectedRevision, { value })
}
export function prepareProjectMutation(
  path: string,
  expectedRevision: number,
  payload: object,
  method?: 'DELETE',
): PendingProjectWrite {
  if (readPendingProjectWrite()) throw new Error('请先核对上一次保存结果')
  const pending = { path, ...(method ? { method } : {}), body: { ...payload, requestId: randomUUID(), expectedRevision } }
  autoOpsStorage(window.sessionStorage).setItem(pendingKey(), JSON.stringify(pending))
  return pending
}
export async function submitProjectWrite(pending: PendingProjectWrite) {
  // 同一收据支持自动核对与页面重开；没有确定失败前不生成新请求。
  try {
    const host = readAutoOpsHost()
    const result = await autoOpsRequest<Record<string, unknown>>(pending.path, {
      label: '配置',
      body: pending.body,
      ...(pending.method ? { method: pending.method } : {}),
    })
    if (readAutoOpsHost()?.principal.id !== host?.principal.id)
      throw new DOMException('登录已经改变', 'AbortError')
    autoOpsStorage(window.sessionStorage).removeItem(pendingKey())
    return result
  } catch (error) {
    if (!(error instanceof AutoOpsRequestError) || !error.uncertain)
      autoOpsStorage(window.sessionStorage).removeItem(pendingKey())
    throw error
  }
}
