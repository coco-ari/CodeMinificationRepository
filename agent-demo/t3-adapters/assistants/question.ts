import * as S from 'effect/Schema'
import { AssistantModel, type QuestionSelection } from '../../../autoops/contracts/assistants.ts'
import type { ExecutionBinding } from '../../../autoops/contracts/runtime.ts'

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { status: 403, code })
}
export function assertQuestionBinding(
  question: QuestionSelection,
  binding: {
    agentId: string
    environmentId: string | null
    visibility: string
    workspaceType?: string
    workspaceVersionId?: string
    executionBinding: ExecutionBinding
  },
) {
  const value = question.configuration
  if (
    value.agentId !== binding.agentId ||
    value.environmentId !== binding.environmentId ||
    value.visibility !== binding.visibility ||
    value.workspaceType !== (binding.workspaceType ?? null) ||
    JSON.stringify(value.executionBinding) !== JSON.stringify(binding.executionBinding) ||
    binding.workspaceVersionId !== undefined
  )
    fail('QUESTION_SCOPE_MISMATCH', '会话范围与本次最终助手参数不一致，请重新选择')
}

/** 原生 ModelSelection 只映射实际值；缺省强度不擅自替换成目录默认。 */
export function nativeQuestionModel(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return fail('QUESTION_MODEL_INVALID', '本轮模型参数无效')
  const value = input as { instanceId?: unknown; model?: unknown; options?: unknown }
  if (
    value.options !== undefined &&
    (!Array.isArray(value.options) ||
      value.options.length > 1 ||
      value.options.some(
        (option) => !option || option.id !== 'reasoningEffort' || typeof option.value !== 'string',
      ))
  )
    return fail('QUESTION_MODEL_INVALID', '本轮模型只能包含所选运行器支持的思考强度')
  try {
    return S.decodeUnknownSync(AssistantModel)({
      instanceId: value.instanceId,
      model: value.model,
      reasoningEffort: (value.options as Array<{ value: string }> | undefined)?.[0]?.value ?? null,
    })
  } catch {
    return fail('QUESTION_MODEL_INVALID', '本轮模型或思考强度格式无效')
  }
}
