// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- 独立 Node 组合根只记录无敏感内容的固定诊断；导入时不启动任务。
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { AutoOpsAccess } from './access.mjs'
import { configuredWorkspaceStore, type WorkspaceStore } from './workspaces.mjs'
import { configuredWorkspaceManagement } from './workspace-management.ts'
import type { WorkspaceAuthoringOverview } from '../../autoops/contracts/workspace-authoring.ts'
import type { WorkspaceTask } from '../../autoops/contracts/workspaces.ts'
import {
  createWorkspaceUpdates,
  WorkspaceUpdateError,
  type WorkspaceUpdateCommand,
  type WorkspaceUpdateReceipt,
} from './workspace-updates/index.ts'

// 手动 HTTP 和到期触发共同使用这份协调器；原任务、固定输入和发布规则仍由工作区拥有。
export function createManagedWorkspaceUpdates({
  dataDir,
  access,
  service,
  store,
  now,
  pollMs,
  onError,
}: {
  dataDir: string
  access: AutoOpsAccess
  service: {
    overview(project: string, actor: string): WorkspaceAuthoringOverview
    sync(
      project: string,
      input: WorkspaceUpdateCommand,
      actor: string,
      signal?: AbortSignal,
    ): Promise<WorkspaceTask>
    generateCurrentExternal(
      project: string,
      input: WorkspaceUpdateCommand,
      actor: string,
      signal?: AbortSignal,
    ): Promise<WorkspaceTask>
    receipt(project: string, requestId: string, actor: string): WorkspaceUpdateReceipt
  }
  store: WorkspaceStore
  now?: () => number
  pollMs?: number
  onError?: (event: { event: string; code: string }) => void
}) {
  return createWorkspaceUpdates({
    dataDir,
    ...(now ? { now } : {}),
    ...(pollMs !== undefined ? { pollMs } : {}),
    ...(onError ? { onError } : {}),
    ports: {
      authorize(actor, project, scope, action) {
        if (action === 'read') access.requireWorkspaceReader(actor, project)
        else {
          access.requireWorkspaceActor(actor, project)
          if (scope === 'external')
            access.requireProjectActionForActor(actor, project, 'workspace.external.publish')
        }
      },
      sources(project, actor) {
        const current = service.overview(project, actor)
        const sources = [...current.sources].sort((a, b) => a.id.localeCompare(b.id))
        return {
          revision: current.revision,
          sourceIds: sources.map((source) => source.id),
          names: Object.fromEntries(sources.map((source) => [source.id, source.name])),
          fingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
        }
      },
      busy(project, scope, actor) {
        access.requireWorkspaceActor(actor, project)
        return store
          .overview(project)
          .tasks.some(
            (task) =>
              ['queued', 'running'].includes(task.status) &&
              (scope === 'internal'
                ? ['sync', 'snapshot', 'import']
                : ['external', 'snapshot']
              ).includes(task.type),
          )
      },
      start(project, scope, input, actor, signal) {
        return scope === 'internal'
          ? service.sync(project, input, actor, signal)
          : service.generateCurrentExternal(project, input, actor, signal)
      },
      receipt(project, _scope, requestId, actor) {
        const receipt = service.receipt(project, requestId, actor)
        const overview =
          receipt.task?.status === 'completed' && receipt.task.versionId
            ? store.overview(project)
            : undefined
        const version = overview
          ? [...overview.internalVersions, ...overview.externalVersions].find(
              (value) => value.id === receipt.task?.versionId,
            )
          : undefined
        return {
          ...(receipt.task ? { task: receipt.task } : {}),
          ...(receipt.capture ? { capture: receipt.capture } : {}),
          ...(version ? { versionStatus: version.status } : {}),
        }
      },
      settled(project, scope, requestId, taskId) {
        const overview = store.overview(project)
        const task = overview.tasks.find(
          (value) =>
            value.id === taskId &&
            value.requestId === requestId &&
            value.type === (scope === 'internal' ? 'sync' : 'external') &&
            ['completed', 'failed', 'interrupted'].includes(value.status),
        )
        if (!task) return null
        const version = [...overview.internalVersions, ...overview.externalVersions].find(
          (value) => value.id === task.versionId,
        )
        return { task, ...(version ? { versionStatus: version.status } : {}) }
      },
    },
  })
}

let configured:
  { dataDir: string; service: ReturnType<typeof createManagedWorkspaceUpdates> } | undefined
let stopping = false
export function configuredWorkspaceUpdates(access: AutoOpsAccess) {
  if (stopping)
    throw new WorkspaceUpdateError(503, 'WORKSPACE_UPDATE_STOPPING', '资料更新正在停止接单')
  const dataDir = process.env.AUTOOPS_T3_DATA_DIR && resolve(process.env.AUTOOPS_T3_DATA_DIR)
  if (!dataDir)
    throw new WorkspaceUpdateError(503, 'WORKSPACE_UPDATE_UNAVAILABLE', '工作区资料更新尚未配置')
  if (configured) {
    if (configured.dataDir !== dataDir)
      throw new WorkspaceUpdateError(
        503,
        'WORKSPACE_UPDATE_CONFIGURATION_CHANGED',
        '资料更新目录变更需要重启服务',
      )
    return configured.service
  }
  const store = configuredWorkspaceStore()
  if (!store)
    throw new WorkspaceUpdateError(503, 'WORKSPACE_UPDATE_UNAVAILABLE', '工作区资料存储尚未配置')
  const service = createManagedWorkspaceUpdates({
    dataDir,
    access,
    store,
    service: configuredWorkspaceManagement(access),
    onError: (event) => console.warn(JSON.stringify(event)),
  })
  configured = { dataDir, service }
  return service
}
export function stopConfiguredWorkspaceUpdates() {
  stopping = true
  configured?.service.stopAccepting()
}
export async function closeConfiguredWorkspaceUpdates() {
  stopConfiguredWorkspaceUpdates()
  await configured?.service.close()
}
