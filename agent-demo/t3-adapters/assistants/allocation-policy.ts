import type { QuestionConfiguration } from '../../../autoops/contracts/assistants.ts'
import type { ProjectRole } from '../../../autoops/contracts/project-access.ts'
import type { SharedProfileCapability } from '../../../autoops/contracts/shared-profile.ts'

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { status: 403, code })
}

/** 角色模板不能替未来成员制造环境授权；具体成员仍按实际范围在使用时校验。 */
export function validateRoleDefault(role: ProjectRole, value: QuestionConfiguration) {
  if (role !== 'external') return
  if (value.executionBinding.kind === 'customer')
    return fail('CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED', '此隔离来源尚未支持外部资料范围')
  if (value.workspaceType !== 'external')
    return fail('ASSISTANT_WORKSPACE_FORBIDDEN', '外部角色的默认助手只能使用外部资料')
  if (value.environmentId !== null)
    return fail('ASSISTANT_ENVIRONMENT_FORBIDDEN', '外部角色不能通过默认助手取得环境范围')
}

/** 管理候选只核对共享来源配置，不把配置者的自用能力或已有执行分配当作证明。 */
export function validateSharedAllocationConfiguration(
  value: QuestionConfiguration,
  profile: SharedProfileCapability | undefined,
  platformToolsVersion?: 1,
) {
  const target = value.executionBinding
  if (!profile || target.kind !== 'customer')
    return fail('CUSTOMER_SHARED_ISOLATION_UNVERIFIED', '此来源尚未取得实际隔离能力目录')
  const selected=value.customerProfile
  if(!selected||selected.id!==profile.id||selected.revision!==profile.revision||selected.digest!==profile.digest||selected.imageDigest!==profile.imageDigest||selected.policy!==profile.policy)
    return fail('CUSTOMER_SHARED_PROFILE_REQUIRED','提供者尚未为此预设明确选择当前已验证的隔离profile')
  if (
    value.agentId !== 'a-project' ||
    ((value.environmentId !== null || value.workspaceType !== null) && platformToolsVersion !== 1) ||
    value.visibility !== 'private'
  )
    return fail('CUSTOMER_CONTEXT_UNSUPPORTED', '此运行来源尚未支持平台资料、环境及共享会话')
  const model = profile.models.find((model) => model.id === value.model.model)
  if (value.model.instanceId !== `customer-${target.deviceId}-${target.runtimeId}` || !model)
    return fail('CUSTOMER_MODEL_UNAVAILABLE', '模型不在实际隔离运行器目录中')
  if (
    value.model.reasoningEffort === null
      ? model.supportedReasoningEfforts.length > 0
      : !model.supportedReasoningEfforts.includes(value.model.reasoningEffort)
  )
    return fail('CUSTOMER_REASONING_UNAVAILABLE', '思考强度不在实际隔离运行器目录中')
  if (
    new Set(value.skillIds).size !== value.skillIds.length ||
    value.skillIds.some((id) => !profile.skills.some((skill) => skill.id === id))
  )
    return fail('CUSTOMER_SKILL_UNAVAILABLE', '所选技能不在明确开放的隔离运行器目录中')
}
