import { ServiceList, OnboardingChecklist } from './service-pages'
import { DataTable } from './data-table'
import { HostResources } from './workspace-home'
import { StoragePolicy } from './storage-policy'
import { useState } from 'react'
import { ArrowUpRight, Server, Settings2, RefreshCw, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Action, Empty, Notice, Status, RepositoryStatus, ServerStatus } from './shared'
import {
  useConsole,
  date,
  short,
  finished,
  resultName,
  actionNames,
  revisionOf,
  duration,
  stageLabel,
} from '@/lib/console'

const grid = 'grid gap-5 lg:grid-cols-2 2xl:grid-cols-3'
const actions = 'card-actions flex flex-wrap items-center gap-2'
export function Overview() {
  const { data, navigate } = useConsole()
  return (
    <div className="space-y-6">
      <OnboardingChecklist />
      <ServiceList compact />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card data-overview="repositories">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>代码仓库</CardTitle>
            <Button variant="outline" size="sm" onClick={() => navigate('projects')}>
              管理 <ArrowUpRight />
            </Button>
          </CardHeader>
          <CardContent className="divide-y">
            {data.repositories.map((r) => (
              <div
                key={r.id}
                data-repository-id={r.id}
                className="flex items-center justify-between gap-3 py-3 text-sm"
              >
                <span className="truncate">{r.name}</span>
                <RepositoryStatus repo={r} />
              </div>
            ))}
            {!data.repositories.length && (
              <p className="text-sm text-muted-foreground">尚未添加代码仓库</p>
            )}
          </CardContent>
        </Card>
        <Card data-overview="servers">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>服务器</CardTitle>
            <Button variant="outline" size="sm" onClick={() => navigate('servers')}>
              管理 <ArrowUpRight />
            </Button>
          </CardHeader>
          <CardContent className="divide-y">
            {data.servers.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <span className="truncate">{s.name}</span>
                <ServerStatus server={s} />
              </div>
            ))}
            {!data.servers.length && (
              <p className="text-sm text-muted-foreground">尚未绑定服务器</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
function RepositoryToggle({ repo }) {
  const { request, endpoint, refresh } = useConsole()
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <div className="space-y-2">
      <Switch
        aria-label={`${repo.name} 启用仓库`}
        checked={repo.enabled}
        disabled={busy}
        onCheckedChange={async (enabled) => {
          setBusy(true)
          setError('')
          try {
            await request(`${endpoint}/repositories/${repo.id}/enabled`, { enabled })
            await refresh()
          } catch (e) {
            if (e.name !== 'AbortError') setError(e.message)
          } finally {
            setBusy(false)
          }
        }}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
function RepositoryActions({ repo }) {
  const { open, request, endpoint, refresh, notify } = useConsole()
  const [error, setError] = useState('')
  const menuAction = async (action) => {
    setError('')
    try {
      await action()
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message)
    }
  }
  return (
    <>
      <div className="card-actions repository-actions">
        <Action
          variant="outline"
          size="sm"
          aria-label="刷新仓库信息"
          disabled={!repo.enabled || ['syncing', 'queued'].includes(repo.status)}
          onClick={async () => {
            await request(`${endpoint}/repositories/${repo.id}/branches/refresh`, {})
            await refresh()
            notify('仓库分支信息已刷新')
          }}
        >
          <RefreshCw />
          <span className="hidden xl:inline">刷新仓库信息</span>
          <span className="xl:hidden">刷新</span>
        </Action>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`${repo.name} 更多操作`}
              data-repository-menu
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => open('repository', repo)}>
              <Settings2 />
              编辑仓库
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                menuAction(async () => {
                  await request(`${endpoint}/repositories/${repo.id}/enabled`, {
                    enabled: !repo.enabled,
                  })
                  await refresh()
                })
              }
            >
              {repo.enabled ? '停用仓库' : '启用仓库'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

export function Repositories() {
  const { data, open } = useConsole()
  const repoName = (repo) => (
    <div className="min-w-0">
      <Button
        variant="link"
        className="repo-name font-medium"
        onClick={() => open('repository', repo)}
      >
        <span className="min-w-0 break-words whitespace-normal">{repo.name}</span>
        <Settings2 className="size-3.5 text-muted-foreground" />
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            className="mt-1 block truncate text-xs text-muted-foreground"
            href={repo.repository}
            target="_blank"
            rel="noopener noreferrer"
          >
            {repo.repository}
          </a>
        </TooltipTrigger>
        <TooltipContent className="max-w-80 break-all">{repo.repository}</TooltipContent>
      </Tooltip>
      <div className="mt-2">
        <RepositoryStatus repo={repo} />
      </div>
      {repo.enabled && repo.connectionError && (
        <p className="mt-2 break-words text-xs text-destructive">{repo.connectionError}</p>
      )}
    </div>
  )
  return (
    <div id="project-list" className="space-y-4">
      <DataTable
        data={data.repositories}
        searchPlaceholder="搜索代码仓库…"
        searchText={(r) => [r.name, r.repository].join(' ')}
        filters={[
          { value: 'enabled', label: '已启用' },
          { value: 'disabled', label: '已停用' },
        ]}
        filterValue={(r) => (r.enabled ? 'enabled' : 'disabled')}
        rowProps={(r) => ({ 'data-repository-id': r.id, className: 'project-card' })}
        columns={[
          {
            accessorKey: 'name',
            header: '仓库',
            sortingFn: 'text',
            meta: { className: 'w-[35%] max-w-64' },
            cell: ({ row }) => repoName(row.original),
          },
          {
            id: 'sync',
            header: '最近成功刷新',
            cell: ({ row }) => (
              <span className="text-xs text-muted-foreground">
                {row.original.branchInfo?.refreshedAt
                  ? date(row.original.branchInfo.refreshedAt)
                  : '尚未刷新'}
              </span>
            ),
          },
          {
            id: 'enabled',
            header: '启用',
            meta: { className: 'w-16' },
            cell: ({ row }) => <RepositoryToggle repo={row.original} />,
          },
          {
            id: 'actions',
            header: '操作',
            meta: { className: 'w-48 text-right xl:w-64' },
            cell: ({ row }) => <RepositoryActions repo={row.original} />,
          },
        ]}
        renderMobile={(repo) => (
          <>
            {repoName(repo)}
            <div className="flex items-center justify-between gap-2">
              <RepositoryToggle repo={repo} />
            </div>
            <RepositoryActions repo={repo} />
          </>
        )}
        emptyTitle="尚未添加代码仓库"
      />
    </div>
  )
}

export function Servers() {
  const { data, scope, open, request, endpoint, refresh, confirm, notify } = useConsole()
  const remove = (server) =>
    confirm(
      '删除服务器记录',
      '删除「' +
        server.name +
        '」及其项目绑定。有关联部署目标或发布历史时不能删除。此操作仅清理中心记录，不卸载 Agent，也不删除服务器上的容器和文件。',
      async () => {
        await request('/api/deploy/servers/' + server.id, {}, 'DELETE')
        await refresh()
        notify('服务器记录已删除')
      },
      { destructive: true },
    )
  return (
    <div className="space-y-4">
      <div className={grid}>
        {!data.servers.length && (
          <Empty
            title="接入第一台服务器"
            description="安装 Agent 后即可配置项目服务。"
            label="接入服务器"
            action={() => open('server')}
          />
        )}
        {data.servers.map((server) => (
          <Card key={server.id} data-server-id={server.id} className="server-card py-5">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <CardTitle className="flex min-w-0 items-start gap-2 text-sm leading-6">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      className="mt-0.5 shrink-0 text-muted-foreground"
                      aria-label="整台服务器资源"
                    >
                      <Server className="size-5" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>资源指标属于整台服务器，可能由多个项目共用。</TooltipContent>
                </Tooltip>
                <span className="break-words [overflow-wrap:anywhere]">{server.name}</span>
              </CardTitle>
              <div className="flex shrink-0 items-center gap-1">
                <ServerStatus server={server} />
                {!scope && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-8"
                        aria-label={server.name + ' · 更多操作'}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {server.revoked ? (
                        <DropdownMenuItem variant="destructive" onSelect={() => remove(server)}>
                          删除记录
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() =>
                            confirm(
                              '撤销服务器接入',
                              '撤销「' +
                                server.name +
                                '」后将无法连接中心，影响所有绑定项目。已有业务容器继续运行。',
                              async () => {
                                await request('/api/deploy/servers/' + server.id + '/revoke', {})
                                await refresh()
                              },
                              { destructive: true },
                            )
                          }
                        >
                          撤销接入
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <HostResources server={server} showConnection={false} />
              <StoragePolicy server={server} editable={!scope} />
              <div className="flex flex-wrap justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                <span>Agent {server.version || '等待接入'}</span>
                <span>最近采集：{date(server.lastSeenAt)}</span>
              </div>
              {!server.online && server.registeredAt && !server.revoked && (
                <Notice error>连接已中断，业务当前状态待确认。</Notice>
              )}
            </CardContent>
            {scope && (
              <CardFooter className="justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    confirm(
                      '解除项目绑定',
                      '仅解除此项目与服务器的关联，不撤销 Agent。存在部署目标时不能解除绑定。',
                      async () => {
                        await request(endpoint + '/servers/' + server.id, {}, 'DELETE')
                        await refresh()
                        notify('已解除项目绑定')
                      },
                      { destructive: true },
                    )
                  }
                >
                  解除绑定
                </Button>
              </CardFooter>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}
export function Services() {
  return <ServiceList />
}
export function Targets({ compact = false, serverId }) {
  return <ServiceList compact={compact} serverId={serverId} />
}
export function Tasks({ compact = false }) {
  const { tasks, find, nameOfTarget, navigate } = useConsole()
  const title = (task) => (
    <div>
      <p className="break-words font-medium">
        {find('services', find('targets', task.targetId)?.serviceId)?.name ||
          nameOfTarget(find('targets', task.targetId))}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {actionNames[task.action]} · <code>{short(revisionOf(task))}</code>
      </p>
    </div>
  )
  const detail = (task) => (
    <Button variant="outline" size="sm" onClick={() => navigate('tasks', task.id)}>
      查看详情 <ArrowUpRight />
    </Button>
  )
  return (
    <DataTable
      data={compact ? tasks.slice(0, 5) : tasks}
      searchPlaceholder="搜索服务、版本或任务…"
      searchText={(t) =>
        nameOfTarget(find('targets', t.targetId)) + ' ' + revisionOf(t) + ' ' + t.id
      }
      scopeNote="当前环境 · 项目最近 200 条任务范围"
      filters={[
        { value: 'active', label: '进行中' },
        { value: 'succeeded', label: '成功' },
        { value: 'failed', label: '失败或已回退' },
      ]}
      filterValue={(t) =>
        !finished(t)
          ? 'active'
          : ['succeeded', 'success'].includes(t.status)
            ? 'succeeded'
            : 'failed'
      }
      rowProps={(t) => ({ 'data-task-id': t.id, className: 'task-row' })}
      columns={[
        {
          id: 'service',
          header: '服务 / 版本',
          meta: { className: 'w-[30%]' },
          cell: ({ row }) => title(row.original),
        },
        {
          accessorKey: 'status',
          header: '结果',
          sortingFn: 'text',
          cell: ({ row }) => (
            <Status value={row.original.status}>{resultName(row.original)}</Status>
          ),
        },
        {
          accessorKey: 'createdAt',
          header: '开始时间',
          sortingFn: 'text',
          cell: ({ row }) => (
            <span className="text-xs text-muted-foreground">{date(row.original.createdAt)}</span>
          ),
        },
        {
          id: 'stage',
          header: '阶段 / 耗时',
          cell: ({ row }) => (
            <span className="text-xs text-muted-foreground">
              {stageLabel(row.original.stage, row.original.config?.kind)} · {duration(row.original)}
            </span>
          ),
        },
        {
          id: 'actions',
          header: '操作',
          meta: { className: 'w-32 text-right' },
          cell: ({ row }) => detail(row.original),
        },
      ]}
      renderMobile={(t) => (
        <>
          <div className="flex items-start justify-between gap-2">
            {title(t)}
            <Status value={t.status}>{resultName(t)}</Status>
          </div>
          <p className="text-xs text-muted-foreground">
            {date(t.createdAt)} · {duration(t)}
          </p>
          {detail(t)}
        </>
      )}
      emptyTitle="还没有发布记录"
    />
  )
}

export function Credentials() {
  const { data, open, confirm, request, refresh } = useConsole()
  return (
    <div id="credential-list" className="space-y-4">
      {!data.credentials.length && (
        <Empty
          title="还没有 Gitee 凭证"
          description="添加能读取目标仓库的专用账号，供不同项目复用。"
          label="新增凭证"
          action={() => open('credential')}
        />
      )}
      {data.credentials.map((item) => (
        <Card data-surface="inset" key={item.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold">{item.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{item.username} · 密码已加密保存</p>
            </div>
            <div className={actions}>
              <Button variant="outline" onClick={() => open('credential', item)}>
                编辑
              </Button>
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() =>
                  confirm(
                    '删除共享凭证',
                    `确定删除「${item.name}」？仍被仓库引用的凭证无法删除。`,
                    async () => {
                      await request(`/api/credentials/${item.id}`, {}, 'DELETE')
                      await refresh()
                    },
                    { destructive: true },
                  )
                }
              >
                删除
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
export function Activity() {
  const { data } = useConsole()
  const labels = {
    setup: '初始化',
    project: '仓库',
    credential: '凭证',
    sync: '同步成功',
    failure: '同步失败',
    enabled: '状态',
    'server-delete': '删除服务器记录',
    environment_delete: '删除环境',
  }
  const events = (data.events || []).map((event, i) => ({ ...event, id: event.id || String(i) }))
  return (
    <div id="activity-list">
      <DataTable
        data={events}
        scopeNote="接口返回的最近操作记录"
        searchPlaceholder="搜索操作记录…"
        searchText={(e) => (labels[e.action] || e.action) + ' ' + e.message}
        columns={[
          {
            accessorKey: 'at',
            header: '时间',
            sortingFn: 'text',
            meta: { className: 'w-44' },
            cell: ({ row }) => (
              <span className="text-xs text-muted-foreground">{date(row.original.at)}</span>
            ),
          },
          {
            accessorKey: 'action',
            header: '类型',
            sortingFn: 'text',
            meta: { className: 'w-36' },
            cell: ({ row }) => (
              <Badge variant="secondary">
                {labels[row.original.action] || row.original.action}
              </Badge>
            ),
          },
          {
            accessorKey: 'message',
            header: '操作内容',
            cell: ({ row }) => (
              <p className="break-words whitespace-normal">{row.original.message}</p>
            ),
          },
        ]}
        renderMobile={(e) => (
          <>
            <div className="flex justify-between gap-2">
              <Badge variant="secondary">{labels[e.action] || e.action}</Badge>
              <span className="text-xs text-muted-foreground">{date(e.at)}</span>
            </div>
            <p className="break-words text-sm">{e.message}</p>
          </>
        )}
        emptyTitle="还没有操作记录"
      />
    </div>
  )
}
