import { AutoOpsAccessError } from './access.mjs'
import { customerFilePathForTarget } from '../../vendor/t3code/packages/contracts/src/customerFiles.ts'
import { collectComposerInlineTokens } from '../../vendor/t3code/packages/shared/src/composerInlineTokens.ts'

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

export function assertCustomerInput(input, target) {
  if (!input || typeof input !== 'object') return
  const attachments = Array.isArray(input.attachments) ? input.attachments : []
  const unsupportedContext = Array.isArray(input.context?.records) && input.context.records.some(record =>
    record?.kind === 'mention' && target && typeof record.path === 'string' && customerFilePathForTarget(record.path, target) !== null
      ? false : !['file', 'image'].includes(record?.kind) || !attachments.some(attachment => attachment.id === record.attachmentId && attachment.type === record.kind))
  if (unsupportedContext ||
      (input.attachmentsByQuestionId && Object.values(input.attachmentsByQuestionId).some((items) => items?.length)))
    throw new AutoOpsAccessError(403, 'CUSTOMER_CONTEXT_UNSUPPORTED', '本机对话不支持引用平台资料或在审批回答中附加文件')
  if (typeof input.text === 'string' && /^\s*\/(?:login|logout|compact|model|plan|goal)\b/iu.test(input.text))
    throw new AutoOpsAccessError(403, 'CUSTOMER_COMMAND_UNSUPPORTED', '请使用模型选择器；运行器登录与配置在客户本机管理')
  const files = typeof input.text === 'string' ? collectComposerInlineTokens(input.text + '\n').filter(token => token.type === 'mention' && token.value.startsWith('autoops-customer/')) : []
  if (files.length > 20 || files.some(token => !target || customerFilePathForTarget(token.value, target) === null))
    throw new AutoOpsAccessError(403, 'CUSTOMER_FILE_SCOPE', '引用文件不属于当前电脑目录，请重新选择')
}
