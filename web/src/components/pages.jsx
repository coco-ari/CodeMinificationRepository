import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { ServiceList, OnboardingChecklist } from './service-pages'
import { DataTable } from './data-table'
import { Commit, HostResources } from './workspace-home'
import { useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Box,
  GitBranch,
  GitFork,
  Server,
  Search,
  Plus,
  FolderOpen,
  CircleCheck,
  Clock3,
  Settings2,
  RefreshCw,
  MoreHorizontal,
  Copy,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { Action, Detail, Empty, Notice, Stats, Status } from './shared'
import {
  useConsole,
  date,
  size,
  short,
  finished,
  resultName,
  actionNames,
  revisionOf,
  duration,
  stageLabel,
  downloadPage,
  copy,
  routeUrl,
} from '@/lib/console'

const grid = 'grid gap-5 lg:grid-cols-2 2xl:grid-cols-3'
const actions = 'card-actions flex flex-wrap items-center gap-2'
export function Overview() {
  const { data, open, navigate } = useConsole()
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => open('workspace', data.project)}>
          <Settings2 />
          项目设置
        </Button>
      </div>
      <OnboardingChecklist />
      <ServiceList compact />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>代码仓库</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate('projects')}>
              管理 <ArrowUpRight />
            </Button>
          </CardHeader>
          <CardContent className="divide-y">
            {data.repositories.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <span className="truncate">{r.name}</span>
                <Badge variant="outline">{r.branch}</Badge>
              </div>
            ))}
            {!data.repositories.length && (
              <p className="text-sm text-muted-foreground">尚未添加代码仓库</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>服务器</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate('servers')}>
              管理 <ArrowUpRight />
            </Button>
          </CardHeader>
          <CardContent className="divide-y">
            {data.servers.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <span className="truncate">{s.name}</span>
                <Status value={s.online ? 'online' : 'disabled'}>
                  {s.online ? '在线' : '离线'}
                </Status>
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
        aria-label={`${repo.name} 启用源码下载`}
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
  const { open, request, endpoint, refresh, confirm, notify } = useConsole()
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
          variant="ghost"
          size="sm"
          aria-label="立即同步"
          disabled={!repo.enabled || ['syncing', 'queued'].includes(repo.status)}
          onClick={async () => {
            await request(`${endpoint}/repositories/${repo.id}/sync`, {})
            await refresh()
            notify('源码同步完成')
          }}
        >
          <RefreshCw />
          <span className="repo-sync-label">同步</span>
        </Action>
        <Button
          variant="ghost"
          size="sm"
          className="repo-edit"
          aria-label="编辑仓库"
          onClick={() => open('repository', repo)}
        >
          编辑
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
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
            <DropdownMenuItem
              onSelect={() =>
                menuAction(async () => {
                  await copy(downloadPage(repo.id))
                  notify('下载地址已复制')
                })
              }
            >
              <Copy />
              复制下载地址
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
              {repo.enabled ? '停用源码下载' : '启用源码下载'}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                confirm(
                  '重置下载密码',
                  `「${repo.name}」的旧密码会立即失效，请同步更新 Jenkins 凭据。`,
                  async () => {
                    const result = await request(
                      `${endpoint}/repositories/${repo.id}/rotate-token`,
                      {},
                    )
                    open('secret', { project: repo, token: result.token })
                  },
                )
              }
            >
              重置下载密码
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
        {repo.name}
      </Button>
      <a
        className="mt-1 block truncate text-xs text-muted-foreground"
        href={repo.repository}
        target="_blank"
        rel="noopener noreferrer"
      >
        {repo.repository}
      </a>
      <div className="mt-2">
        <Status value={repo.enabled ? repo.status : 'disabled'} />
      </div>
      {repo.error && <p className="mt-2 break-words text-xs text-destructive">{repo.error}</p>}
      {repo.needsDownloadTokenReset && (
        <p className="mt-1 text-xs text-muted-foreground">首次下载前请重置密码</p>
      )}
    </div>
  )
  return (
    <div id="project-list" className="space-y-4">
      <DataTable
        data={data.repositories}
        searchPlaceholder="搜索代码仓库…"
        searchText={(r) => [r.name, r.repository, r.branch].join(' ')}
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
            accessorKey: 'branch',
            header: '下载分支',
            sortingFn: 'text',
            meta: { className: 'max-w-36' },
            cell: ({ row }) => (
              <span className="block truncate font-mono text-xs" title={row.original.branch}>
                {row.original.branch}
              </span>
            ),
          },
          {
            id: 'sync',
            header: '最近同步',
            cell: ({ row }) => (
              <span className="text-xs text-muted-foreground">
                {row.original.lastSuccess ? date(row.original.lastSuccess.at) : '尚未同步'}
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
            meta: { className: 'w-40 text-right' },
            cell: ({ row }) => <RepositoryActions repo={row.original} />,
          },
        ]}
        renderMobile={(repo) => (
          <>
            {repoName(repo)}
            <div className="flex items-center justify-between gap-2">
              <Badge variant="outline" className="max-w-40 truncate">
                {repo.branch}
              </Badge>
              <RepositoryToggle repo={repo} />
            </div>
            <RepositoryActions repo={repo} />
          </>
        )}
        emptyTitle="尚未添加代码仓库"
      />
      <p className="text-xs text-muted-foreground">
        默认下载分支供浏览器与 Jenkins 使用；服务的发布分支在「服务与部署」中单独配置。
      </p>
    </div>
  )
}

export function Servers() {
  const { data, scope, open, request, endpoint, refresh, confirm, notify } = useConsole()
  const [selectedServer, setSelectedServer] = useState(null)
  const selected = data.servers.find((s) => s.id === selectedServer)
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
    )
  return (
    <div className="space-y-4">
      {scope && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            复用已接入的服务器，无需重复安装 Agent。资源指标为整台服务器的数据。
          </p>
          <Button className="bind-server" variant="outline" onClick={() => open('binding')}>
            <Plus />
            绑定已接入服务器
          </Button>
        </div>
      )}
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
            <CardHeader className="gap-3">
              <div className="flex items-center justify-between">
                <Server className="size-5 text-muted-foreground" />
                <Status
                  value={
                    server.online && !server.revoked
                      ? 'online'
                      : server.registeredAt && !server.revoked
                        ? 'unhealthy'
                        : 'disabled'
                  }
                >
                  {server.revoked
                    ? '已撤销'
                    : server.online
                      ? '在线'
                      : server.registeredAt
                        ? '失联'
                        : '等待接入'}
                </Status>
              </div>
              <CardTitle className="break-words">{server.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <HostResources server={server} />
              <div className="flex flex-wrap justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                <span>Agent {server.version || '等待接入'}</span>
                <span>最近采集：{date(server.lastSeenAt)}</span>
              </div>
              {!server.online && server.registeredAt && !server.revoked && (
                <Notice error>连接已中断，业务当前状态待确认。</Notice>
              )}
            </CardContent>
            <CardFooter className="justify-between gap-2">
              <Button variant="outline" size="sm" onClick={() => setSelectedServer(server.id)}>
                查看详情
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={server.name + ' · 更多操作'}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {scope ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        confirm(
                          '解除项目绑定',
                          '仅解除此项目与服务器的关联，不撤销 Agent。存在部署目标时不能解除绑定。',
                          async () => {
                            await request(endpoint + '/servers/' + server.id, {}, 'DELETE')
                            await refresh()
                            notify('已解除项目绑定')
                          },
                        )
                      }
                    >
                      解除项目绑定
                    </DropdownMenuItem>
                  ) : server.revoked ? (
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
                        )
                      }
                    >
                      撤销接入
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </CardFooter>
          </Card>
        ))}
      </div>
      <Sheet
        open={!!selected}
        onOpenChange={(value) => {
          if (!value) setSelectedServer(null)
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{selected?.name}</SheetTitle>
            <SheetDescription>
              {scope ? '当前项目在该服务器上的部署位置' : '该服务器的 Agent 与部署状态'}
            </SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="space-y-5 px-4">
              <HostResources server={selected} />
              <p className="text-xs text-muted-foreground">最近采集：{date(selected.lastSeenAt)}</p>
              {data.targets
                .filter((t) => t.serverId === selected.id)
                .map((target) => (
                  <div key={target.id} className="rounded-lg border p-3">
                    <p className="font-medium">
                      {data.services.find((s) => s.id === target.serviceId)?.name || '服务'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {data.environments.find((e) => e.id === target.environmentId)?.name}
                    </p>
                    <Button
                      variant="link"
                      className="mt-2 h-auto p-0"
                      onClick={() => {
                        location.hash = routeUrl(
                          'service',
                          target.applicationId,
                          target.environmentId,
                          null,
                          { serviceId: target.serviceId, targetId: target.id },
                        )
                      }}
                    >
                      查看服务 <ArrowRight />
                    </Button>
                  </div>
                ))}
              {!data.targets.some((t) => t.serverId === selected.id) && (
                <p className="text-sm text-muted-foreground">尚未配置部署位置。</p>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
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
        <Card className="shadow-none" key={item.id}>
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
                variant="ghost"
                onClick={() =>
                  confirm(
                    '删除共享凭证',
                    `确定删除「${item.name}」？仍被仓库引用的凭证无法删除。`,
                    async () => {
                      await request(`/api/credentials/${item.id}`, {}, 'DELETE')
                      await refresh()
                    },
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
    token: '下载密码',
    enabled: '状态',
    'server-delete': '删除服务器记录',
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
