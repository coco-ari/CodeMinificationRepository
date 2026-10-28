import { createFileRoute } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { AutoOpsProjectsPage } from '../autoops/ProjectsPage'

export const Route = createFileRoute('/_chat/projects')({
  validateSearch: (search: Record<string, unknown>): { projectId?: ProjectId; section?: 'git'; from?: 'deployments' } => ({
    ...(Object.hasOwn(search, 'projectId')
      ? { projectId: ProjectId.make(typeof search.projectId === 'string' ? search.projectId : '') }
      : {}),
    ...(search.section === 'git' ? { section: 'git' as const } : {}),
    ...(search.from === 'deployments' ? { from: 'deployments' as const } : {}),
  }),
  component: AutoOpsProjectsPage,
})
