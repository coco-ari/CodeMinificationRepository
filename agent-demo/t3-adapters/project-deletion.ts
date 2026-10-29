// @effect-diagnostics nodeBuiltinImport:off -- 项目删除组合根通过所属模块的公开接口检查和清理数据。
import { configuredBusinessArtifactStore } from './business-tools.mjs'
import type { DeletionBlocker } from '../../autoops/contracts/project-directory.ts'
import { configuredAutoOpsAssistantDirectory, type AutoOpsAccess } from './access.mjs'
import { configuredWorkspaceStore } from './workspaces.mjs'
import { configuredWorkspaceManagement } from './workspace-management.ts'
import { configuredWorkspaceUpdates } from './workspace-update-runtime.ts'
import {
  configuredDeploymentStore,
  configuredDeploymentDeletionReferences,
} from './deployments.mjs'
import { createSkillLibrary, projectSkillDeletionReferences } from './skill-library.mjs'

type ReferenceSource = {
  deletionReferences(projectId: string, environmentId?: string): DeletionBlocker[]
}
export type ProjectDeletionInspection = ((
  projectId: string,
  environmentId?: string,
) => DeletionBlocker[]) & {
  purge?: ((projectId: string, environmentId?: string) => Promise<void>) | undefined
  threads?: ((projectId: string, environmentId?: string) => string[]) | undefined
}

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
  environmentMcp: ReferenceSource & { purgeScope(projectId: string, environmentId?: string): void },
): ProjectDeletionInspection {
  const dataDir = process.env.AUTOOPS_T3_DATA_DIR
  const workspace = configuredWorkspaceStore()
  if (!dataDir || !workspace)
    throw Object.assign(new Error('工作区存储不可用，尚未删除'), {
      status: 503,
      code: 'PROJECT_DELETE_INSPECTION_UNAVAILABLE',
    })
  const management = configuredWorkspaceManagement(access)
  const inspect = createProjectDeletionInspection({
    access,
    workspace: { deletionReferences: (project, environment) => [...workspace.deletionReferences(project, environment), ...configuredWorkspaceUpdates(access).deletionReferences(project, environment)] },
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
  inspect.threads = (project, environment) =>
    access.scopeThreads(project, environment).map((value) => value.nativeId)
  inspect.purge = async (project, environment) => {
    if (environment === undefined) {
      await configuredWorkspaceUpdates(access).purgeProject(project)
      await management.cancelProjectWork(project)
    }
    const deployment = configuredDeploymentStore()
    if (deployment) await deployment.purgeScope(project, environment)
    else if (configuredDeploymentDeletionReferences(project, environment).length)
      throw Object.assign(new Error('部署存储未启动，请恢复服务后继续原删除'), {
        status: 503,
        code: 'PROJECT_DELETE_PENDING',
      })
    configuredAutoOpsAssistantDirectory().purgeScope(project, environment)
    environmentMcp.purgeScope(project, environment)
    if (environment === undefined) {
      await workspace.purgeProject(project)
      management.authoring.purgeProject(project)
      management.credentials.purgeProject(project)
      createSkillLibrary(dataDir).removeAssignments({ projectId: project })
    }
    configuredBusinessArtifactStore()?.purgeScope(
      project,
      environment === undefined
        ? undefined
        : access.scopeThreads(project, environment).map((value) => value.id),
    )
    access.purgeScope(project, environment)
  }
  return inspect
}
