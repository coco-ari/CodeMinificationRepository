import type { ProvidedAssistantSource } from '../../../../../../autoops/contracts/assistants.ts'
import type { SharedProfileDescriptor } from '../../../../../../autoops/contracts/shared-profile.ts'
import type { CustomerSkill } from '../../../../../../autoops/contracts/runtime.ts'

type RuntimeModel = {
  readonly id: string
  readonly name?: string
  readonly supportedReasoningEfforts: ReadonlyArray<string>
  readonly defaultReasoningEffort?: string
}

export type ProvidedRuntimeSelection = 'self' | SharedProfileDescriptor | null
export function providedProfileDescriptor(value: SharedProfileDescriptor): SharedProfileDescriptor {
  return {
    id: value.id,
    revision: value.revision,
    digest: value.digest,
    imageDigest: value.imageDigest,
    policy: value.policy,
  }
}
export const providedRuntimeKey = (selection: ProvidedRuntimeSelection) =>
  selection === null
    ? ''
    : selection === 'self'
      ? 'self'
      : JSON.stringify(providedProfileDescriptor(selection))
const sameProfile = (left: SharedProfileDescriptor, right: SharedProfileDescriptor) =>
  JSON.stringify(providedProfileDescriptor(left)) ===
  JSON.stringify(providedProfileDescriptor(right))

/** 旧预设保留原目录身份；撤回、迟到目录或内容变化只阻止保存，不改用自用目录。 */
export function providedRuntimeCatalog(
  source: ProvidedAssistantSource | undefined,
  selection: ProvidedRuntimeSelection,
): {
  available: boolean
  reason?: string
  models: ReadonlyArray<RuntimeModel>
  skills: ReadonlyArray<CustomerSkill>
} {
  const unavailable = (reason: string) => ({ available: false, reason, models: [], skills: [] })
  if (selection === null) return unavailable('请选择运行目录。')
  if (!source) return unavailable('原运行来源暂不可用，请刷新核对。')
  if (source.deviceStatus !== 'active' || source.workspaceStatus !== 'active')
    return unavailable('运行来源已停用或撤回。')
  if (!source.capabilities || source.capabilities.assistantConfiguration !== true)
    return unavailable('运行器能力目录尚未就绪，请刷新核对。')
  let directory: { models: ReadonlyArray<RuntimeModel>; skills: ReadonlyArray<CustomerSkill> } =
    source.capabilities
  if (selection !== 'self') {
    const shared = source.capabilities.sharedProfile
    if (!shared) return unavailable('原隔离运行目录暂不可用，请刷新核对。')
    if (!sameProfile(selection, shared))
      return unavailable('隔离运行目录已变化，请重新选择并确认参数。')
    if (source.sharedProfileAvailable !== true)
      return unavailable(
        source.sharedProfileReason?.message ?? '此隔离运行目录尚未取得有效验证许可。',
      )
    directory = shared
  }
  return {
    available: source.online,
    ...(!source.online ? { reason: '运行来源已离线，请恢复连接后重试。' } : {}),
    models: directory.models,
    skills: directory.skills,
  }
}
export function providedConfigurationIssue(
  source: ProvidedAssistantSource | undefined,
  draft: {
    runtime: ProvidedRuntimeSelection
    model: string
    reasoning: string | null
    skillIds: string[]
  },
): string | null {
  const catalog = providedRuntimeCatalog(source, draft.runtime)
  if (!catalog.available) return catalog.reason ?? '运行目录暂不可用。'
  const model = catalog.models.find((value) => value.id === draft.model)
  if (!model) return '请选择所选运行目录提供的模型。'
  if (
    draft.reasoning === null
      ? model.supportedReasoningEfforts.length > 0
      : !model.supportedReasoningEfforts.includes(draft.reasoning)
  )
    return '请选择此模型实际支持的思考强度。'
  if (
    new Set(draft.skillIds).size !== draft.skillIds.length ||
    draft.skillIds.some((id) => !catalog.skills.some((skill) => skill.id === id))
  )
    return '所选skill已不属于此运行目录，请重新核对。'
  return null
}
