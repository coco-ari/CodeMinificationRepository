import { CredentialUsage } from '../../autoops/contracts/credential-usage.ts'
import { decodeContract } from '../../autoops/contracts/index.ts'
import type { AutoOpsAccess, AutoOpsPrincipal } from './access.mjs'
import type { DeploymentStore } from './deployments.mjs'
import type { WorkspaceManagement } from './workspace-management.ts'
import type { EnvironmentMcp } from './environment-mcp/index.ts'
import { WorkspaceError } from './workspaces.mjs'

type Workspace = Pick<WorkspaceManagement, 'credentials' | 'authoring'>
type Deployments = Pick<DeploymentStore, 'ensureProject' | 'overview'>
const unavailable = (): never => {
  throw new WorkspaceError(
    503,
    'CREDENTIAL_USAGE_UNAVAILABLE',
    '凭证使用关系暂时无法完整核对，请重试',
  )
}

export async function readCredentialUsage({
  access,
  principal,
  projectId,
  credentialId,
  workspace,
  deployments,
  environmentMcp,
}: {
  access: AutoOpsAccess
  principal: AutoOpsPrincipal
  projectId: string
  credentialId: string
  workspace: Workspace
  deployments: Deployments | undefined
  environmentMcp: Pick<EnvironmentMcp, 'list'> | undefined
}): Promise<CredentialUsage> {
  const authorize = () => {
    access.refresh(principal)
    access.requireProjectAction(principal, projectId, 'credential.manage')
    access.requireProjectAction(principal, projectId, 'project.manage')
    access.requireWorkspace(principal, projectId, 'internal')
    const project = access.requireProject(principal, projectId)
    let exists = false
    try {
      exists = workspace.credentials
        .list(principal.id, projectId)
        .some((value) => value.id === credentialId)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error.status === 403 || error.status === 404)
      )
        throw error
      return unavailable()
    }
    if (!exists) throw new WorkspaceError(404, 'CREDENTIAL_NOT_FOUND', '凭证不存在或不属于当前项目')
    const membership = access.requireDeploymentAction(principal, projectId, 'read')
    const environments = project.environments
      .filter((value) => membership.environmentIds.includes(value.id))
      .filter((value) => {
        try {
          access.requireDeploymentAction(principal, projectId, 'read', value.id)
          return true
        } catch (error) {
          if (error && typeof error === 'object' && 'status' in error && error.status === 403)
            return false
          throw error
        }
      })
    return { project, environments }
  }
  const initial = authorize()
  if (!deployments || !environmentMcp) return unavailable()
  try {
    await deployments.ensureProject(initial.project)
  } catch {
    authorize()
    return unavailable()
  }
  // 等待所属模块就绪后重裁当前范围，不能返回撤权前取得的关系。
  const { project, environments } = authorize()
  const environmentIds = environments.map((value) => value.id)
  const requireScope = (expected: string[], actual: string[]) => {
    if (expected.some((id) => !actual.includes(id)))
      throw new WorkspaceError(
        403,
        'CREDENTIAL_USAGE_SCOPE_CHANGED',
        '可用环境已变化，请重新核对凭证使用关系',
      )
  }
  requireScope(
    initial.environments.map((value) => value.id),
    environmentIds,
  )
  try {
    const repositories = workspace.authoring
      .repositories(projectId, principal.id)
      .items.filter((value) => value.credentialId === credentialId)
    const ids = new Set(repositories.map((value) => value.id))
    const sources = workspace.authoring.overview(projectId, principal.id).sources
    const deployment = deployments.overview(project, environmentIds)
    if (!Array.isArray(deployment.serviceSources)) return unavailable()
    const services = deployment.serviceSources
      .filter((value) => environmentIds.includes(value.environmentId))
      .flatMap((value) => {
        const repositoryIds = [
          ...new Set(
            value.sources
              .filter((source) => ids.has(source.sourceId))
              .map((source) => source.sourceId),
          ),
        ]
        if (!repositoryIds.length) return []
        const service = deployment.services.find((service) => service.id === value.serviceId)
        const environment = environments.find(
          (environment) => environment.id === value.environmentId,
        )
        if (!service || !environment) return unavailable()
        return [
          {
            serviceId: service.id,
            serviceName: service.name,
            environmentId: environment.id,
            environmentName: environment.name,
            repositoryIds,
          },
        ]
      })
    const connections = environments.flatMap((environment) =>
      environmentMcp
        .list(projectId, environment.id, principal.id)
        .map((value) => {
          if (value.projectId !== projectId || value.environmentId !== environment.id)
            return unavailable()
          return value
        })
        .filter((value) => value.configuration.credentialId === credentialId)
        .map((value) => ({
          connectionId: value.id,
          name: value.configuration.name,
          type: value.configuration.type,
          environmentId: environment.id,
          environmentName: environment.name,
          enabled: value.enabled,
        })),
    )
    const result = decodeContract(CredentialUsage, {
      projectId,
      credentialId,
      repositories: repositories.map((value) => ({ id: value.id, name: value.name })),
      workspaces: sources
        .filter((value) => ids.has(value.id))
        .map((value) => ({ repositoryId: value.id, mountPath: value.mountPath })),
      services,
      connections,
    })
    requireScope(
      environmentIds,
      authorize().environments.map((value) => value.id),
    )
    return result
  } catch (error) {
    // 先保留真实撤权结果；读取故障不伪装成零引用，也不泄露所有者异常。
    authorize()
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      (error.status === 403 || error.status === 404)
    )
      throw error
    return unavailable()
  }
}
