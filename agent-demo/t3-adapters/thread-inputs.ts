// @effect-diagnostics nodeBuiltinImport:off -- 此业务边界只用同步摘要生成幂等标识，异步执行仍由 T3 管理。
import { createHash } from 'node:crypto'
import { AutoOpsAccessError, configuredAutoOpsAccess, type AutoOpsAccess } from './access.mjs'
import { configuredWorkspaceManagement, type WorkspaceManagement } from './workspace-management.ts'

type WorkspaceInputs = Pick<WorkspaceManagement, 'captureAgentInput' | 'readInput' | 'inputFiles' | 'readInputFile' | 'readInputContent'>

export function createBusinessRunInputs(access: AutoOpsAccess, workspace: WorkspaceInputs) {
  return {
    async prepare(threadId: string, runId: string, inheritedRunId?: string, signal?: AbortSignal) {
      const { binding } = access.requireToolThread(threadId)
      const existing = access.getRunInput(threadId, runId)
      if (existing) return workspace.readInput(binding.projectId, existing.inputId, binding.ownerId)
      if (inheritedRunId) {
        const original = access.getRunInput(threadId, inheritedRunId)
        if (!original) throw new AutoOpsAccessError(409, 'THREAD_INPUT_MISSING', '恢复任务的原资料输入不存在，不能改读最新内容')
        const captured = workspace.readInput(binding.projectId, original.inputId, binding.ownerId)
        access.bindRunInput(threadId, runId, captured.id)
        return captured
      }
      const requestId = 'agent-run-' + createHash('sha256').update(JSON.stringify([threadId, runId])).digest('hex')
      const captured = await workspace.captureAgentInput(binding.projectId, { requestId, workspaceType: binding.workspaceType ?? 'internal' }, binding.ownerId, signal)
      access.requireToolThread(threadId)
      access.bindRunInput(threadId, runId, captured.id)
      return captured
    },
    require(threadId: string, inputId: string) {
      const scope = access.requireToolThread(threadId)
      const input = access.requireRunInput(threadId, inputId)
      const capture = workspace.readInput(scope.binding.projectId, input.inputId, scope.binding.ownerId)
      if (capture.workspaceType !== (scope.binding.workspaceType ?? 'internal')) throw new AutoOpsAccessError(403, 'THREAD_INPUT_FORBIDDEN', '资料输入不属于当前内部或外部范围')
      return { ...scope, input, capture }
    },
  }
}

export async function prepareBusinessRunContext(threadId: string, runId: string, inheritedRunId?: string, signal?: AbortSignal) {
  const access = configuredAutoOpsAccess()
  if (!access) return undefined
  const binding = access.getThreadBinding(threadId)
  if (binding?.executionBinding.kind === 'customer') return undefined
  const capture = await createBusinessRunInputs(access, configuredWorkspaceManagement(access)).prepare(threadId, runId, inheritedRunId, signal)
  return {
    key: 'autoops_turn_input',
    text: `本轮任务已自动固定当前可用资料。后续同步或编辑不改变本轮输入，下一轮重新获取。业务工具的 inputId 必须使用下列标识，不能沿用旧轮次；历史消息和旧引用仅表示当时事实，回答当前状态前须重新读取本轮资料。\n${JSON.stringify({
      inputId: capture.id, runId, projectId: capture.projectId, workspaceType: capture.workspaceType,
      capturedAt: capture.createdAt, revision: capture.revision, sourceErrors: capture.sourceErrors ?? [], root: `autoops/${capture.projectId}/inputs/${capture.id}`,
      repositories: capture.workspaceType === 'external' ? [] : capture.repositories.map(repository => ({ path: repository.source.mountPath, commit: repository.commit })),
    })}`,
  }
}
