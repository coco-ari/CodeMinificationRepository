import { createFileRoute } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { AutoOpsProjectsPage } from '../autoops/ProjectsPage'

export const Route = createFileRoute('/_chat/projects')({
  validateSearch: (search: Record<string, unknown>): { projectId?: ProjectId } => ({
    ...(Object.hasOwn(search, 'projectId')
      ? { projectId: ProjectId.make(typeof search.projectId === 'string' ? search.projectId : '') }
      : {}),
  }),
  component: AutoOpsProjectsPage,
})
