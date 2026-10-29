import { useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { environmentNodesHref, nodePageHref, type NodePageSearch } from './deployment/deploymentNodeNavigation'
import { ServerIcon } from 'lucide-react'
import { SidebarInset } from '~/components/ui/sidebar'
import { WorkspacePageContainer } from '~/components/WorkspacePageContainer'
import { Button } from '~/components/ui/button'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { ModuleHeader, ModuleSidebar, ModuleSidebarItem } from './ModuleWorkspace'
import { useAutoOpsHost } from './hostConfig'
import { DeploymentServers } from './deployment'

export function PlatformNodesPage() {
  const host = useAutoOpsHost()
  const location = useLocation()
  const navigate = useNavigate()
  const search = location.search as NodePageSearch
  const returnContext = search.from && search.returnProjectId && search.returnEnvironmentId
    ? { from: search.from, projectId: search.returnProjectId, environmentId: search.returnEnvironmentId } : undefined
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  return (
    <SidebarInset className="h-dvh min-h-0 min-w-0 overflow-hidden">
      <ModuleHeader title="平台节点" />
      <ModuleSidebar label="平台节点">
        <ModuleSidebarItem
          label="全部节点"
          icon={ServerIcon}
          selected
          onClick={() => {
            setError(null)
            setAttempt((value) => value + 1)
          }}
        />
      </ModuleSidebar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer>
          {host?.canManageDeploymentNodes && !error ? (
            <DeploymentServers
              key={`${host.principal.id}:${attempt}`}
              scope="platform"
              embedded
              nodeLocation={search}
              returnContext={returnContext}
              onNodeNavigate={(next) => void navigate({ href: nodePageHref({ ...returnContext, ...next }) })}
              onReturn={returnContext ? () => void navigate({ href: environmentNodesHref(returnContext) }) : undefined}
              open
              finalFocus={undefined}
              onOpenChange={() => {}}
              onChanged={() => {}}
              onAccessDenied={(cause) =>
                setError(cause instanceof Error ? cause.message : '当前账号无平台节点管理权限。')
              }
            />
          ) : (
            <Alert variant="error">
              <AlertDescription>
                {error ?? '当前账号无平台节点管理权限。'}
                {error ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setError(null)
                      setAttempt((value) => value + 1)
                    }}
                  >
                    重试
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  )
}
