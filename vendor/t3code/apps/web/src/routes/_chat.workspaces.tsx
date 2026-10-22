import { createFileRoute } from '@tanstack/react-router'
import { AutoOpsWorkspacesPage } from '../autoops/WorkspacesPage'

export const Route = createFileRoute('/_chat/workspaces')({ component: AutoOpsWorkspacesPage })
