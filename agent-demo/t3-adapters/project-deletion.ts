// @effect-diagnostics nodeBuiltinImport:off -- 项目删除组合根只读取所属模块的公开引用摘要。
import type { DeletionBlocker } from '../../autoops/contracts/project-directory.ts'
import { configuredAutoOpsAssistantDirectory, type AutoOpsAccess } from './access.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'
import { configuredWorkspaceManagement } from './workspace-management.ts'
import { configuredDeploymentDeletionReferences } from './deployments.mjs'
import { projectSkillDeletionReferences } from './skill-library.mjs'

type ReferenceSource = {
  deletionReferences(projectId: string, environmentId?: string): DeletionBlocker[]
}
export type ProjectDeletionInspection = (
  projectId: string,
  environmentId?: string,
) => DeletionBlocker[]

export function createProjectDeletionInspection(sources: {
  access: ReferenceSource
  workspace: ReferenceSource
  authoring: ReferenceSource
  credentials: ReferenceSource
  assistants: ReferenceSource
  deployments: ReferenceSource
  skills: ReferenceSource
  environmentMcp: ReferenceSource
}): ProjectDeletionInspection {
  const owners = Object.values(sources)
  return (projectId, environmentId) => {
    if (
      owners.length !== 8 ||
      owners.some((owner) => typeof owner?.deletionReferences !== 'function')
    )
      throw Object.assign(new Error('引用检查尚未完整装配，尚未删除'), {
        status: 503,
        code: 'PROJECT_DELETE_INSPECTION_UNAVAILABLE',
      })
    try {
      return owners.flatMap((owner) => owner.deletionReferences(projectId, environmentId))
    } catch (cause) {
      throw Object.assign(new Error('引用检查暂不可用，尚未删除；请恢复连接后核对原请求'), {
        status: 503,
        code: 'PROJECT_DELETE_INSPECTION_UNAVAILABLE',
        cause,
      })
    }
  }
}

export function configuredProjectDeletionInspection(
  access: AutoOpsAccess,
  environmentMcp: ReferenceSource,
): ProjectDeletionInspection {
  const dataDir = process.env.AUTOOPS_T3_DATA_DIR
  const workspace = configuredWorkspaceStore()
  if (!dataDir || !workspace)
    throw Object.assign(new Error('工作区存储不可用，尚未删除'), {
      status: 503,
      code: 'PROJECT_DELETE_INSPECTION_UNAVAILABLE',
    })
  const management = configuredWorkspaceManagement(access)
  return createProjectDeletionInspection({
    access,
    workspace,
    authoring: management.authoring,
    credentials: management.credentials,
    assistants: configuredAutoOpsAssistantDirectory(),
    environmentMcp,
    deployments: { deletionReferences: configuredDeploymentDeletionReferences },
    skills: {
      deletionReferences: (project, environment) =>
        projectSkillDeletionReferences(dataDir, project, environment),
    },
  })
}
