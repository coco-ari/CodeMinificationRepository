import type {
  MembershipDetails,
  ProjectSettings,
} from '../../../../../../autoops/contracts/project-directory.ts'
import type {
  ProjectRepositoryDetails,
  WorkspaceCredentialMetadata,
} from '../../../../../../autoops/contracts/workspace-authoring.ts'
import type { ProjectRole } from '../../../../../../autoops/contracts/project-access.ts'
import type {
  AssistantSettings,
  AssistantChoices,
  AssistantDetails,
  AssistantTarget,
  QuestionConfiguration,
} from './projectAssistants'
export const projectRoleNames: Record<ProjectRole, string> = {
  project_admin: '项目管理员',
  developer: '开发',
  release_operator: '发布运维',
  reader: '只读成员',
  external: '外部协作成员',
}
type Context = {
  project: ProjectSettings
  assistants: AssistantSettings
  choices: AssistantChoices
}
export type ProjectConfigurationEditor =
  | {
      kind: 'repository'
      name: string
      description: string
      revision: number
      id?: string
      remove: boolean
      value: ProjectRepositoryDetails
      context: { credentials: WorkspaceCredentialMetadata[] }
    }
  | {
      kind: 'assistant'
      name: string
      description: string
      revision: number
      id?: string
      value: AssistantDetails
      context: Context
    }
  | {
      kind: 'allocation'
      name: string
      description: string
      revision: number
      target: AssistantTarget
      assistantIds: string[]
      defaultAssistantId: string | null
      context: Context
    }
  | {
      kind: 'member'
      remove?: boolean
      name: string
      description: string
      revision: number
      value: MembershipDetails
      context: { project: ProjectSettings }
    }
export const emptyConfig = (): QuestionConfiguration => ({
  agentId: 'a-project',
  executionBinding: { kind: 'platform' },
  environmentId: null,
  workspaceType: 'internal',
  visibility: 'private',
  model: { instanceId: 'codex', model: '', reasoningEffort: null },
  skillIds: [],
})
export const isConfigurationEditor = (value: {
  kind: string
}): value is ProjectConfigurationEditor =>
  ['assistant', 'allocation', 'member', 'repository'].includes(value.kind)
export function configurationMutation(project: string, editor: ProjectConfigurationEditor) {
  const base = `/api/v1/projects/${encodeURIComponent(project)}`
  if (editor.kind === 'repository') {
    if (editor.remove && !editor.id) throw new Error('请选择要移除的仓库连接')
    return {
      path: `${base}/repositories${editor.id ? '/' + encodeURIComponent(editor.id) : ''}${editor.remove ? '/remove' : ''}`,
      payload: editor.remove ? {} : { value: { ...editor.value, name: editor.name } },
    }
  }
  if (editor.kind === 'assistant')
    return {
      path: `${base}/assistants${editor.id ? '/' + encodeURIComponent(editor.id) : ''}`,
      payload: { value: { ...editor.value, name: editor.name, description: editor.description } },
    }
  if (editor.kind === 'member' && editor.remove)
    return {
      path: `${base}/members/${encodeURIComponent(editor.value.userId)}/remove`,
      payload: {},
    }
  if (editor.kind === 'member') return { path: `${base}/members`, payload: { value: editor.value } }
  return {
    path: `${base}/assistant-allocations`,
    payload: {
      target: editor.target,
      assistantIds: editor.assistantIds,
      defaultAssistantId: editor.defaultAssistantId,
    },
  }
}

export const assistantSourceKey = (source: QuestionConfiguration['executionBinding']) =>
  source.kind === 'platform'
    ? 'platform'
    : `${source.deviceId}/${source.registeredWorkspaceId}/${source.workspaceBindingRevision}/${source.runtimeId}`
