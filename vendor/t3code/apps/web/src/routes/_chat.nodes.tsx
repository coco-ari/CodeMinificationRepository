import { createFileRoute } from '@tanstack/react-router'
import { PlatformNodesPage } from '../autoops/PlatformNodesPage'
import { parseNodePageSearch } from '../autoops/deployment/deploymentNodeNavigation'

export const Route = createFileRoute('/_chat/nodes')({ validateSearch: parseNodePageSearch, component: PlatformNodesPage })
