import { createFileRoute } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { AutoOpsDeploymentsPage } from '../autoops/DeploymentsPage'
import {
  deploymentNavigation,
  type DeploymentNavigation,
} from '../autoops/deployment'

export const Route = createFileRoute('/_chat/deployments')({
  validateSearch: (
    search: Record<string, unknown>,
  ): Omit<DeploymentNavigation, 'environmentId'> & {
    deploymentEnvironmentId?: string
    projectId?: ProjectId
    sourceVersionId?: string
  } => {
    const { environmentId, ...navigation } = deploymentNavigation({
      ...search,
      environmentId: search.deploymentEnvironmentId,
    })
    return {
      ...navigation,
      ...(environmentId ? { deploymentEnvironmentId: environmentId } : {}),
      ...(Object.hasOwn(search, 'projectId')
        ? {
            projectId: ProjectId.make(typeof search.projectId === 'string' ? search.projectId : ''),
          }
        : {}),
      ...(Object.hasOwn(search, 'sourceVersionId')
        ? {
            sourceVersionId:
              typeof search.sourceVersionId === 'string' ? search.sourceVersionId : '',
          }
        : {}),
    }
  },
  component: AutoOpsDeploymentsPage,
})
