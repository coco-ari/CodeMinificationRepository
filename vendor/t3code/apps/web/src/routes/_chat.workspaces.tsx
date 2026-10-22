import { createFileRoute } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { AutoOpsWorkspacesPage } from '../autoops/WorkspacesPage'

export const Route = createFileRoute('/_chat/workspaces')({
  validateSearch: (search: Record<string, unknown>): { projectId?: ProjectId; versionId?: string } => ({
    // Keep malformed explicit values empty so the page rejects them, rather than
    // treating them as an absent scope and falling back to another project.
    ...(Object.hasOwn(search, 'projectId') ? { projectId: ProjectId.make(typeof search.projectId === 'string' ? search.projectId : '') } : {}),
    ...(Object.hasOwn(search, 'versionId') ? { versionId: typeof search.versionId === 'string' ? search.versionId : '' } : {}),
  }),
  component: AutoOpsWorkspacesPage,
})
