import { AutoOpsAccessError } from './access.mjs'

export const customerProviderInstanceId = (target) => `customer-${target.deviceId}-${target.runtimeId}`
export const isCustomerProviderInstanceId = (value) => typeof value === 'string' && /^customer-[a-f0-9-]{36}-codex$/u.test(value)
export const customerWorkspaceKey = (target) => `${target.deviceId}/${target.registeredWorkspaceId}/${target.workspaceBindingRevision}`

export function authorizeCustomerModel(access, binding, selection) {
  const target = binding.executionBinding
  if (target?.kind !== 'customer') throw new AutoOpsAccessError(403, 'CUSTOMER_TARGET_REQUIRED', '此对话未绑定客户工作区')
  if (selection.instanceId !== customerProviderInstanceId(target))
    throw new AutoOpsAccessError(403, 'CUSTOMER_RUNTIME_MISMATCH', '所选模型不属于此对话固定的客户运行器')
  const options = selection.options ?? []
  if (!Array.isArray(options) || options.length > 1 || options.some((option) => option.id !== 'reasoningEffort' || typeof option.value !== 'string'))
    throw new AutoOpsAccessError(400, 'CUSTOMER_MODEL_OPTION_UNSUPPORTED', '客户首版仅支持模型和思考强度选择')
  const reasoningEffort = options[0]?.value
  return access.customerRegistry.validateSelection(binding.ownerId, binding.projectId, target, {
    modelId: selection.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })
}

export function assertCustomerInput(input) {
  if (!input || typeof input !== 'object') return
  if ((Array.isArray(input.attachments) && input.attachments.length > 0) ||
      (Array.isArray(input.context?.records) && input.context.records.length > 0) ||
      (input.attachmentsByQuestionId && Object.values(input.attachmentsByQuestionId).some((items) => items?.length)))
    throw new AutoOpsAccessError(403, 'CUSTOMER_CONTEXT_UNSUPPORTED', '客户首版暂不支持文件引用、平台资料或附件，请直接输入或粘贴文本')
  if (typeof input.text === 'string' && /^\s*\/(?:login|logout|compact|model|plan|goal)\b/iu.test(input.text))
    throw new AutoOpsAccessError(403, 'CUSTOMER_COMMAND_UNSUPPORTED', '请使用模型选择器；运行器登录与配置在客户本机管理')
}
