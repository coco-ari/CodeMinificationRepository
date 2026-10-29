import { createFileRoute } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { AutoOpsProjectsPage } from '../autoops/ProjectsPage'
import { nodeRouteId } from '../autoops/deployment/deploymentNodeNavigation'

export const Route = createFileRoute('/_chat/projects')({
  validateSearch: (search: Record<string, unknown>): { projectId?: ProjectId; section?: 'git'; from?: 'deployments'; nodeEnvironmentId?: string } => ({
    ...(search.nodeEnvironmentId === undefined ? {} : { nodeEnvironmentId: nodeRouteId(search.nodeEnvironmentId) }),
    ...(Object.hasOwn(search, 'projectId')
      ? { projectId: ProjectId.make(typeof search.projectId === 'string' ? search.projectId : '') }
      : {}),
    ...(search.section === 'git' ? { section: 'git' as const } : {}),
    ...(search.from === 'deployments' ? { from: 'deployments' as const } : {}),
  }),
  component: AutoOpsProjectsPage,
})
