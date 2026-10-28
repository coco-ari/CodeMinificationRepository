import { Link } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { Alert, AlertAction, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { useAutoOpsHost } from '../hostConfig'

export function RepositorySetupNotice({
  projectId,
  disabled = false,
}: {
  projectId: string
  disabled?: boolean
}) {
  const host = useAutoOpsHost()
  const canManage =
    host?.projects.find((project) => project.id === projectId)?.capabilities?.['project.manage'] ===
    true
  return (
    <Alert variant="warning">
      <AlertDescription>
        {canManage ? '项目尚未配置 Git 仓库。' : '项目尚未配置 Git 仓库，请联系项目管理员。'}
      </AlertDescription>
      {canManage ? (
        <AlertAction>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            render={
              <Link
                to="/projects"
                search={{
                  projectId: ProjectId.make(projectId),
                  section: 'git',
                  from: 'deployments',
                }}
              />
            }
          >
            配置项目仓库
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  )
}
