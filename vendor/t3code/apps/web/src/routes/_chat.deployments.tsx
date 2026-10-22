import { createFileRoute } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { AutoOpsDeploymentsPage } from '../autoops/DeploymentsPage'

export const Route = createFileRoute('/_chat/deployments')({
  validateSearch: (search: Record<string, unknown>): { projectId?: ProjectId; sourceVersionId?: string } => ({
    ...(Object.hasOwn(search, 'projectId') ? { projectId: ProjectId.make(typeof search.projectId === 'string' ? search.projectId : '') } : {}),
    ...(Object.hasOwn(search, 'sourceVersionId') ? { sourceVersionId: typeof search.sourceVersionId === 'string' ? search.sourceVersionId : '' } : {}),
  }),
  component: AutoOpsDeploymentsPage,
})
