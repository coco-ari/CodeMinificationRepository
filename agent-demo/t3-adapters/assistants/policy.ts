import type {
  QuestionConfiguration,
  AssistantChoices,
} from '../../../autoops/contracts/assistants.ts'
import type {
  ProjectMembership,
  RuntimeProject,
  RuntimeAgent,
} from '../../../autoops/contracts/runtime.ts'
import type { BusinessModels } from '../models.mjs'
import type { CustomerRegistry } from '../customer-registry.mjs'
import type { SharedProfileVerifier } from '../shared-profile-approvals.ts'
import { validateSharedAllocationConfiguration } from './allocation-policy.ts'

type Ports = {
  projects(): RuntimeProject[]
  agents(): RuntimeAgent[]
  models(): BusinessModels
  skills(
    projectId: string,
    agentId: string,
    workspaceType: 'internal' | 'external',
  ): Array<{ id: string; displayName?: string; name?: string }>
  customers(): CustomerRegistry
  verifySharedProfile?: SharedProfileVerifier
}

/** 只返回配置所需的公开能力，不返回技能物理路径、设备凭证或其他人的目录。 */
export function questionConfigurationChoices(
  ports: Ports,
  actor: string,
  projectId: string,
): AssistantChoices {
  const agents = ports
    .agents()
    .filter((agent) => agent.projectIds.includes(projectId))
    .map(({ id, name }) => ({ id, name }))
  const models = ports.models()
  const sources: AssistantChoices['sources'] = [
    {
      id: 'platform',
      name: '平台运行器',
      executionBinding: { kind: 'platform' },
      available: models.discovered,
      ...(!models.discovered
        ? { reason: { code: 'ASSISTANT_MODELS_UNAVAILABLE', message: '实际模型目录尚未就绪' } }
        : {}),
      models: models.discovered
        ? models.models.map(({ id, name, reasoningLevels, defaultReasoning }) => ({
            id,
            name,
            reasoningLevels,
            defaultReasoning,
          }))
        : [],
      skills: [],
    },
  ]
  const registry = ports.customers(),
    devices = registry.listDevices(actor)
  for (const workspace of registry.listWorkspaces(actor, projectId)) {
    const target = {
      kind: 'customer' as const,
      deviceId: workspace.deviceId,
      registeredWorkspaceId: workspace.registeredWorkspaceId,
      workspaceBindingRevision: workspace.workspaceBindingRevision,
      runtimeId: workspace.runtimeId,
    }
    const capabilities = registry.getCapabilities(actor, target)
    let unavailable: { code: string; message: string } | undefined
    try {
      registry.validateTarget(actor, projectId, target, { requireOnline: true })
      if (!capabilities)
        unavailable = { code: 'CUSTOMER_CAPABILITIES_MISSING', message: '电脑能力目录尚未就绪' }
    } catch (error) {
      const value = error as { code?: string; message?: string }
      unavailable = {
        code: value.code ?? 'CUSTOMER_UNAVAILABLE',
        message: value.message ?? '电脑当前不可用',
      }
    }
    if (!unavailable && capabilities?.assistantConfiguration !== true)
      unavailable = {
        code: 'CUSTOMER_CONNECTOR_UPDATE_REQUIRED',
        message: '请更新电脑连接程序后使用助手预设',
      }
    sources.push({
      id: `${target.deviceId}/${target.registeredWorkspaceId}/${target.workspaceBindingRevision}`,
      name: `${devices.find((device) => device.id === target.deviceId)?.label ?? '自己的电脑'} · ${workspace.label}`,
      executionBinding: target,
      available: !unavailable,
      ...(unavailable ? { reason: unavailable } : {}),
      models:
        capabilities?.models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          reasoningLevels: model.supportedReasoningEfforts,
          defaultReasoning: model.defaultReasoningEffort ?? null,
        })) ?? [],
      skills: capabilities?.skills.map(({ id, name }) => ({ id, name })) ?? [],
    })
  }
  return {
    agents,
    sources,
    platformSkills: agents.flatMap((agent) =>
      (['internal', 'external'] as const).flatMap((workspaceType) =>
        ports.skills(projectId, agent.id, workspaceType).map((skill) => ({
          id: skill.id,
          name: skill.displayName ?? skill.name ?? skill.id,
          agentId: agent.id,
          workspaceType,
        })),
      ),
    ),
  }
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
    accepted = false,
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
        value.agentId !== 'a-project'
      )
        return fail('CUSTOMER_CONTEXT_UNSUPPORTED', '此运行来源不使用平台资料或环境')
      const registry = ports.customers(),
        target = value.executionBinding
      const source = registry.sourceOwner(target)
      const shared = source.ownerId !== actor || source.projectId !== projectId || value.customerProfile!==undefined
      if (shared) {
        if (member.workspaceAccess !== 'internal')
          return fail('CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED', '此隔离来源尚未支持外部资料范围')
        const capabilities = registry.getCapabilities(source.ownerId, target)
        if (!ports.verifySharedProfile)
          return fail('CUSTOMER_SHARED_ISOLATION_UNVERIFIED', '此运行器尚未通过跨用户或跨项目执行隔离验证')
        ports.verifySharedProfile({providerId:source.ownerId,sourceProjectId:source.projectId,target,profile:capabilities?.sharedProfile})
        registry.validateTarget(source.ownerId,source.projectId,target,{requireOnline:true})
        const profile = capabilities?.sharedProfile
        validateSharedAllocationConfiguration(value,profile)
        return
      }
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
      if (capabilities.assistantConfiguration !== true)
        return fail(
          'CUSTOMER_CONNECTOR_UPDATE_REQUIRED',
          '请更新电脑连接程序后使用助手预设；既有自用对话可继续',
        )
      const model = capabilities.models.find((model) => model.id === value.model.model)
      if (value.model.reasoningEffort === null && model?.supportedReasoningEfforts.length)
        return fail('ASSISTANT_REASONING_REQUIRED', '请明确选择此运行器支持的思考强度')
      return
    }
    if(value.customerProfile!==undefined)return fail('ASSISTANT_PROFILE_FORBIDDEN','平台运行来源不能选择客户隔离profile')
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
    if (!accepted && value.skillIds.some((id) => !skills.some((skill) => skill.id === id)))
      return fail('ASSISTANT_SKILL_FORBIDDEN', '所选技能已停用或不属于当前项目和资料范围')
  }
}
