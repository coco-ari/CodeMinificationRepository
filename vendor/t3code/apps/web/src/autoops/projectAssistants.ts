import type {
  AssistantPreset,
  AssistantTarget,
  AssistantChoices,
} from '../../../../../../autoops/contracts/assistants.ts'
import { autoOpsRequest } from './apiClient'
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
