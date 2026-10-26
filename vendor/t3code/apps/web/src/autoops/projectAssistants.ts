import type {
  AssistantPreset,
  AssistantTarget,
  AssistantChoices,
} from '../../../../../../autoops/contracts/assistants.ts'
import { autoOpsRequest, isAutoOpsAccessError } from './apiClient'
import { loadProjectSettings } from './projectDirectory'
import { loadProjectProvidedAssistants } from './providedAssistants'
export type {
  AssistantDetails,
  AssistantPreset,
  AssistantTarget,
  AssistantChoices,
  QuestionConfiguration,
} from '../../../../../../autoops/contracts/assistants.ts'
export interface AssistantSettings {
  presets: AssistantPreset[]
  allocations: Array<{
    target: AssistantTarget
    assistantIds: string[]
    defaultAssistantId: string | null
    revision: number
  }>
}
const base = (project: string) => `/api/v1/projects/${encodeURIComponent(project)}/assistants`
export const loadAssistantSettings = (project: string, signal?: AbortSignal) =>
  autoOpsRequest<AssistantSettings>(`${base(project)}/settings`, {
    label: '项目助手',
    ...(signal ? { signal } : {}),
  })
export const loadAssistantChoices = (project: string, signal?: AbortSignal) =>
  autoOpsRequest<AssistantChoices>(`${base(project)}/choices`, {
    label: '运行能力',
    ...(signal ? { signal } : {}),
  })

export async function loadAssistantManagement(project: string, signal?: AbortSignal) {
  const results = await Promise.allSettled([
    loadProjectSettings(project, signal),
    loadAssistantSettings(project, signal),
    loadAssistantChoices(project, signal),
    loadProjectProvidedAssistants(project, signal),
  ])
  // 临时故障不能掩盖其他接口已确认的撤权，调用方必须清除旧管理内容。
  const failed = results.find((result) =>
    result.status === 'rejected' && isAutoOpsAccessError(result.reason))
    ?? results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  const [details, assistants, choices, provided] = results
  if (
    details.status === 'fulfilled' && assistants.status === 'fulfilled' &&
    choices.status === 'fulfilled' && provided.status === 'fulfilled'
  ) {
    return {
      project: details.value,
      assistants: assistants.value,
      choices: choices.value,
      provided: provided.value,
    }
  }
  throw new Error('项目助手读取未完成，请重试。')
}
