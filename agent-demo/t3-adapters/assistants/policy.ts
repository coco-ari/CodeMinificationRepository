import type { QuestionConfiguration } from '../../../autoops/contracts/assistants.ts'
import type {
  ProjectMembership,
  RuntimeProject,
  RuntimeAgent,
} from '../../../autoops/contracts/runtime.ts'
import type { BusinessModels } from '../models.mjs'
import type { CustomerRegistry } from '../customer-registry.mjs'

type Ports = {
  projects(): RuntimeProject[]
  agents(): RuntimeAgent[]
  models(): BusinessModels
  skills(
    projectId: string,
    agentId: string,
    workspaceType: 'internal' | 'external',
  ): Array<{ id: string }>
  customers(): CustomerRegistry
}
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { status: 403, code })
}

/** 只组合已存在的目录能力及成员事实；资料、凭证和设备仍由原模块拥有。 */
export function questionConfigurationPolicy(ports: Ports) {
  return (
    actor: string,
    projectId: string,
    value: QuestionConfiguration,
    member: ProjectMembership,
  ) => {
    const project = ports.projects().find((project) => project.id === projectId)
    if (!project || member.status !== 'active')
      return fail('ASSISTANT_SCOPE_FORBIDDEN', '项目或成员授权已失效')
    if (
      !ports
        .agents()
        .some((agent) => agent.id === value.agentId && agent.projectIds.includes(projectId))
    )
      return fail('ASSISTANT_AGENT_FORBIDDEN', '助手业务身份不属于当前项目')
    if (
      value.environmentId !== null &&
      (!project.environments.some((env) => env.id === value.environmentId) ||
        (member.role !== 'project_admin' && !member.environmentIds.includes(value.environmentId)))
    )
      return fail('ASSISTANT_ENVIRONMENT_FORBIDDEN', '助手所选环境不在成员范围内')
    if (new Set(value.skillIds).size !== value.skillIds.length)
      return fail('ASSISTANT_SKILLS_DUPLICATE', '技能不能重复选择')
    if (value.executionBinding.kind === 'customer') {
      if (
        value.environmentId !== null ||
        value.workspaceType !== null ||
        value.visibility !== 'private' ||
        value.agentId !== 'a-project'
      )
        return fail('CUSTOMER_CONTEXT_UNSUPPORTED', '此运行来源尚未支持平台资料、环境及共享会话')
      const registry = ports.customers(),
        target = value.executionBinding
      const owner = registry
        .listRegisteredDevices()
        .find((device) => device.id === target.deviceId)?.ownerId
      if (owner !== actor)
        return fail('CUSTOMER_SHARED_ISOLATION_UNVERIFIED', '此运行器尚未通过跨用户执行隔离验证')
      if (value.model.instanceId !== `customer-${target.deviceId}-${target.runtimeId}`)
        return fail('CUSTOMER_RUNTIME_MISMATCH', '模型不属于此助手的运行器')
      registry.validateTarget(actor, projectId, target)
      const capabilities = registry.validateSelection(actor, projectId, target, {
        modelId: value.model.model,
        ...(value.model.reasoningEffort === null
          ? {}
          : { reasoningEffort: value.model.reasoningEffort }),
        skillIds: [...value.skillIds],
      })
      const model = capabilities.models.find((model) => model.id === value.model.model)
      if (value.model.reasoningEffort === null && model?.supportedReasoningEfforts.length)
        return fail('ASSISTANT_REASONING_REQUIRED', '请明确选择此运行器支持的思考强度')
      return
    }
    if (
      value.workspaceType === null ||
      (member.workspaceAccess === 'external' && value.workspaceType !== 'external')
    )
      return fail('ASSISTANT_WORKSPACE_FORBIDDEN', '助手资料范围不在成员授权内')
    const models = ports.models()
    if (!models.discovered)
      return fail('ASSISTANT_MODELS_UNAVAILABLE', '实际运行器的模型能力目录尚未就绪')
    const model = models.models.find((model) => model.id === value.model.model)
    if (value.model.instanceId !== 'codex' || !model)
      return fail('ASSISTANT_MODEL_FORBIDDEN', '模型不在此助手运行器的能力目录')
    if (
      value.model.reasoningEffort === null
        ? model.reasoningLevels.length > 0
        : !model.reasoningLevels.includes(value.model.reasoningEffort)
    )
      return fail('ASSISTANT_REASONING_FORBIDDEN', '请明确选择此模型支持的思考强度')
    const skills = ports.skills(projectId, value.agentId, value.workspaceType)
    if (value.skillIds.some((id) => !skills.some((skill) => skill.id === id)))
      return fail('ASSISTANT_SKILL_FORBIDDEN', '所选技能已停用或不属于当前项目和资料范围')
  }
}
