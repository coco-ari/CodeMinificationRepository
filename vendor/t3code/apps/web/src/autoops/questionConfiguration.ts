import { ProviderInstanceId, type ModelSelection, type ServerProvider } from '@t3tools/contracts'
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
/** 目录变化只阻止本次发送，不把已选模型或思考档位替换为其他值。 */
export function questionModelDisabledReason(
  selection: ModelSelection,
  models: ServerProvider['models'],
): string | null {
  if (!selection.model) return '请选择所选运行器提供的模型。'
  const model = models.find(model => model.slug === selection.model)
  if (!model) return '所选模型暂不可用，请等待目录恢复或手动选择。'
  const effort = selection.options?.find(option => option.id === 'reasoningEffort')?.value
  if (effort !== undefined) {
    const descriptor = model.capabilities?.optionDescriptors?.find(option => option.id === 'reasoningEffort')
    if (descriptor?.type !== 'select' || !descriptor.options.some(option => option.id === effort))
      return '所选思考强度暂不可用，请等待目录恢复或手动选择。'
  }
  return null
}
export function questionSendDisabledReason(scope: AutoOpsThreadScope | undefined) {
  const host = readAutoOpsHost()
  if (!host?.assistantDirectoryEnabled || (scope?.scopeState === 'locked' && !scope.question))
    return null
  // 共享原电脑会话的目录与执行授权由会话接口复核，不要求成员另建助手分配。
  if (scope?.scopeState === 'locked' && scope.executionBinding?.kind === 'customer' &&
      scope.visibility === 'project' && scope.ownerId !== host.principal.id) return null
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
