import { ProviderInstanceId, type ModelSelection } from '@t3tools/contracts'
import type { AssistantSelection } from '../../../../../../autoops/contracts/assistants.ts'
import { readAutoOpsHost } from './hostSnapshot'
import type { AutoOpsThreadScope } from './threadScopes'

export function questionModelSelection(question: AssistantSelection): ModelSelection {
  const model = question.configuration.model
  return {
    instanceId: ProviderInstanceId.make(model.instanceId),
    model: model.model,
    ...(model.reasoningEffort === null
      ? {}
      : { options: [{ id: 'reasoningEffort', value: model.reasoningEffort }] }),
  }
}
export function questionCanAdjust(scope: AutoOpsThreadScope | undefined) {
  const host = readAutoOpsHost()
  if (!host?.assistantDirectoryEnabled) return true
  if (scope?.scopeState === 'submitting') return false
  if (
    scope?.scopeState === 'locked' &&
    !scope.question &&
    scope.executionBinding?.kind === 'customer'
  )
    return true
  return (
    host.projects.find((project) => project.id === scope?.projectId)?.capabilities?.[
      'chat.configure'
    ] === true
  )
}
export function questionSendDisabledReason(scope: AutoOpsThreadScope | undefined) {
  const host = readAutoOpsHost()
  if (!host?.assistantDirectoryEnabled || (scope?.scopeState === 'locked' && !scope.question))
    return null
  const state = host.projects.find((project) => project.id === scope?.projectId)?.assistants
  if (!state) return '助手目录尚未就绪，请刷新项目配置。'
  if (!state.canAdjust && !state.ready)
    return state.reason?.message ?? '项目管理员尚未配置有效默认助手。'
  if (!scope?.question)
    return state.ready ? '请选择助手。' : (state.reason?.message ?? '当前没有可用助手。')
  const selected = state.items.find((item) => item.preset.id === scope.question!.assistantId)
  if (!selected) return '此助手分配已撤回，请刷新后选择。'
  if (!selected.preset.enabled) return '助手已停用，请联系项目管理员。'
  if (
    scope.scopeState !== 'locked' &&
    (!selected.available || selected.preset.revision !== scope.question.presetRevision)
  )
    return selected.reason?.message ?? '助手预设已更新，请重新载入。'
  return null
}
