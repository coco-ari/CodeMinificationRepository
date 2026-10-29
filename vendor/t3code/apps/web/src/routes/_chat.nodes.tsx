import { createFileRoute } from '@tanstack/react-router'
import { PlatformNodesPage } from '../autoops/PlatformNodesPage'

export const Route = createFileRoute('/_chat/nodes')({ component: PlatformNodesPage })
