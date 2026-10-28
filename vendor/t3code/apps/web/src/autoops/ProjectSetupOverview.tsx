import { useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { SettingsSection } from '~/components/settings/settingsLayout'
import { Button } from '~/components/ui/button'
import { loadAuthoring, type WorkspaceAuthoringOverview } from './workspaceAuthoring'
import { loadDeployments, type DeploymentOverview } from './deployments'
import type { ProjectSettings } from './projectDirectory'
import { focusProjectSettingsArea } from './ProjectSettingsNavigation'

export type RepositorySetupSummary = { count: number; credentialIssues: number } | { error: string }
export type AssistantSetupSummary = { enabled: number; allocations: number } | { error: string }
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : '暂时无法读取，请重试。'

function OverviewRow({
  title,
  control,
  children,
}: {
  title: string
  control?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 px-3 py-3 sm:px-4">
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {children}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  )
}

export function ProjectSetupOverview({
  project,
  repositories,
  assistants,
  revision,
  canReadWorkspace,
  canReadDeployments,
}: {
  project: ProjectSettings
  repositories: RepositorySetupSummary | null
  assistants: AssistantSetupSummary | null
  revision: number
  canReadWorkspace: boolean
  canReadDeployments: boolean
}) {
  const projectId = project.project.id
  const hasEnvironments = project.project.environments.length > 0
  const [workspace, setWorkspace] = useState<WorkspaceAuthoringOverview | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [workspaceAttempt, setWorkspaceAttempt] = useState(0)
  const [deployment, setDeployment] = useState<DeploymentOverview | null>(null)
  const [deploymentError, setDeploymentError] = useState<string | null>(null)
  const [deploymentAttempt, setDeploymentAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setWorkspace(null)
    setWorkspaceError(null)
    if (canReadWorkspace)
      void loadAuthoring(projectId, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setWorkspace(value)
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setWorkspaceError(message(cause))
        })
    return () => controller.abort()
  }, [projectId, revision, workspaceAttempt, canReadWorkspace])
  useEffect(() => {
    const controller = new AbortController()
    setDeployment(null)
    setDeploymentError(null)
    if (canReadDeployments && hasEnvironments)
      void loadDeployments(projectId, undefined, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setDeployment(value)
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setDeploymentError(message(cause))
        })
    return () => controller.abort()
  }, [projectId, revision, deploymentAttempt, canReadDeployments, hasEnvironments])
  const environments = project.project.environments
  const nodes = !hasEnvironments
    ? []
    : deployment?.servers.filter((node) =>
        environments.some((environment) => environment.id === node.environmentId),
      )
  const pendingMembers = project.members.filter((member) => member.authorizationPending).length
  const fileCount = workspace?.entries.filter((entry) => entry.kind === 'file').length ?? 0
  const sourceStatus = workspace?.sourceStatus ?? []
  const synced = sourceStatus.filter((source) => source.status === 'synced').length
  const failed = sourceStatus.filter((source) => source.status === 'failed').length
  const updating = sourceStatus.some(
    (source) => source.status === 'queued' || source.status === 'syncing',
  )
  return (
    <section aria-label="项目配置概览">
      <SettingsSection title="配置概览">
        <OverviewRow
          title="仓库与凭证"
          control={
            <Button variant="ghost" size="sm" onClick={() => focusProjectSettingsArea('git')}>
              配置仓库
            </Button>
          }
        >
          {!repositories ? (
            <p className="text-sm text-muted-foreground">正在读取仓库…</p>
          ) : 'error' in repositories ? (
            <p className="text-sm text-muted-foreground">仓库状态暂不可用</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {repositories.count ? `${repositories.count} 个仓库已配置` : '尚未配置仓库'}
              {repositories.credentialIssues
                ? ` · ${repositories.credentialIssues} 个仓库凭证不可用`
                : ''}
            </p>
          )}
        </OverviewRow>
        <OverviewRow
          title="当前资料"
          control={
            canReadWorkspace ? (
              <Button
                variant="ghost"
                size="sm"
                render={<Link to="/workspaces" search={{ projectId: ProjectId.make(projectId) }} />}
              >
                打开工作区
              </Button>
            ) : undefined
          }
        >
          {workspaceError ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-destructive">
                {workspaceError}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setWorkspaceAttempt((value) => value + 1)}
              >
                重试资料状态
              </Button>
            </div>
          ) : !canReadWorkspace ? (
            <p className="text-sm text-muted-foreground">当前角色无内部资料管理权限</p>
          ) : !workspace ? (
            <p className="text-sm text-muted-foreground">正在读取资料状态…</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {fileCount} 个资料文件 · {workspace.sources.length} 个源码来源
              {workspace.sources.length
                ? workspace.sourceStatus
                  ? ` · ${synced} 个已同步`
                  : ' · 同步状态未提供'
                : ''}
              {failed ? ` · ${failed} 个同步失败` : ''}
              {updating ? ' · 正在更新' : ''}
            </p>
          )}
        </OverviewRow>
        <OverviewRow
          title="环境与节点"
          control={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => focusProjectSettingsArea('environments')}
            >
              配置环境
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            {environments.length} 个环境{nodes ? ` · ${nodes.length} 个节点绑定` : ''}
          </p>
          {deploymentError ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-destructive">
                {deploymentError}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeploymentAttempt((value) => value + 1)}
              >
                重试节点状态
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">MCP 和部署节点在对应环境中管理。</p>
        </OverviewRow>
        <OverviewRow
          title="助手与成员"
          control={
            <Button variant="ghost" size="sm" onClick={() => focusProjectSettingsArea('access')}>
              配置助手
            </Button>
          }
        >
          {!assistants ? (
            <p className="text-sm text-muted-foreground">正在读取助手…</p>
          ) : 'error' in assistants ? (
            <p className="text-sm text-muted-foreground">助手状态暂不可用</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {assistants.enabled} 个启用助手 · {assistants.allocations} 项分配规则
              {pendingMembers ? ` · ${pendingMembers} 位成员待分配` : ''}
            </p>
          )}
        </OverviewRow>
      </SettingsSection>
    </section>
  )
}
