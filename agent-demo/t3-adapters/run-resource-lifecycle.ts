import type { AutoOpsAccess } from './access.mjs'
import { AutoOpsAccessError } from './access.mjs'
import type { EnvironmentMcp } from './environment-mcp/index.ts'

type Access = Pick<AutoOpsAccess, 'runResourceReferences' | 'nativeSubagentRunReferenced'>
export type RunResourceReference = ReturnType<Access['runResourceReferences']>[number]

/** 此入口只供原生持久终态协调调用，不在 HTTP、MCP 或调用者参数中开放。 */
export function createRunResourceLifecycle(
  access: Access,
  mcp: Pick<EnvironmentMcp, 'releaseRun'>,
) {
  function release(reference: RunResourceReference, childrenVerified: boolean) {
    const current = access.runResourceReferences(reference.threadId, reference.runId).at(0)
    if (!current || !current.actorVerified || JSON.stringify(current) !== JSON.stringify(reference))
      throw new AutoOpsAccessError(
        409,
        'RUN_RESOURCE_IDENTITY_CHANGED',
        '原任务持久身份尚未核验或发生变化，保留环境输入',
      )
    // 原生子任务共用原父轮的环境输入；缺少可核验子终态时继续保留，后续按引用回收。
    if (!childrenVerified && access.nativeSubagentRunReferenced(current.threadId, current.runId))
      return { released: false }
    try {
      mcp.releaseRun({
        threadId: current.threadId,
        runId: current.runId,
        actorId: current.actorId,
        projectId: current.projectId,
        environmentId: current.environmentId,
      })
      return { released: true }
    } catch (error) {
      // 旧任务或准备阶段失败可能没有取得环境输入；不能因此伪造另一个来源。
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENVIRONMENT_MCP_RUN_MISSING'
      )
        return { released: false }
      throw error
    }
  }
  return {
    references(threadId: string, runId: string) {
      return access.runResourceReferences(threadId, runId)
    },
    releaseAfterNativeTerminal(reference: RunResourceReference) {
      return release(reference, false)
    },
    // 调用方必须在同一原生写事务内核对所有真实子轮、恢复收据及业务引用快照。
    releaseAfterNativeTreeTerminal(reference: RunResourceReference) {
      return release(reference, true)
    },
  }
}
export type RunResourceLifecycle = ReturnType<typeof createRunResourceLifecycle>
