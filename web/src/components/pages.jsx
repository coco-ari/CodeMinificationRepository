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
  modeName,
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
      <Targets compact />
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
  const [search, setSearch] = useState('')
  const repos = data.repositories.filter((r) =>
    [r.name, r.repository, r.branch].some((v) => v.toLowerCase().includes(search.toLowerCase())),
  )
  return (
    <div className="space-y-5">
      <Input
        id="search"
        aria-label="搜索代码仓库"
        placeholder="搜索仓库…"
        className="max-w-sm"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Card id="project-list" className="overflow-hidden py-0">
        <Table className="repository-table">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">仓库</TableHead>
              <TableHead className="repo-branch-cell">下载分支</TableHead>
              <TableHead className="hidden md:table-cell">最近同步</TableHead>
              <TableHead className="hidden sm:table-cell">启用</TableHead>
              <TableHead className="text-right pr-5">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repos.map((repo) => (
              <TableRow key={repo.id} className="project-card">
                <TableCell className="repo-name-cell whitespace-normal py-4 pl-5">
                  <Button
                    variant="link"
                    className="repo-name"
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
                  {repo.error && <p className="mt-2 text-xs text-destructive">{repo.error}</p>}
                  {repo.needsDownloadTokenReset && (
                    <p className="mt-2 text-xs text-muted-foreground">首次下载前请重置密码</p>
                  )}
                </TableCell>
                <TableCell className="repo-branch-cell">
                  <Badge variant="outline" className="repo-branch" title={repo.branch}>
                    {repo.branch}
                  </Badge>
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                  {repo.lastSuccess ? date(repo.lastSuccess.at) : '尚未同步'}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <RepositoryToggle repo={repo} />
                </TableCell>
                <TableCell className="pr-4">
                  <RepositoryActions repo={repo} />
                </TableCell>
              </TableRow>
            ))}
            {!repos.length && (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                  {search ? '没有匹配的仓库' : '尚未添加代码仓库'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      <p className="text-xs leading-relaxed text-muted-foreground">
        默认下载分支供浏览器与 Jenkins 使用；服务的发布分支在「环境与服务」中单独配置。
      </p>
    </div>
  )
}
export function Servers() {
  const { data, scope, open, request, endpoint, refresh, confirm, notify } = useConsole()
  const [selectedServer, setSelectedServer] = useState('')
  return (
    <div className="space-y-5">
      {scope && (
        <div className="space-y-4">
          <Notice>CPU、内存和磁盘是整台服务器的指标；这里只显示当前项目的服务。</Notice>
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
            description="Agent 主动连接中心，上报主机资源和受管服务状态。"
            label="接入新服务器"
            action={() => open('server')}
          />
        )}
        {data.servers.map((server) => {
          const metrics = server.metrics || {},
            memory = metrics.memory || {},
            disk = metrics.disk || {},
            cpu = metrics.cpuPercent ?? metrics.cpu?.percent
          return (
            <Card key={server.id} data-server-id={server.id} className="server-card shadow-none">
              <CardHeader>
                <div className="mb-2 flex items-center justify-between">
                  <Server className="size-5 text-muted-foreground" />
                  <Status value={server.online && !server.revoked ? 'online' : 'disabled'}>
                    {server.revoked
                      ? '已撤销'
                      : server.online
                        ? '在线'
                        : server.registeredAt
                          ? '失联'
                          : '等待接入'}
                  </Status>
                </div>
                <CardTitle>{server.name}</CardTitle>
                <CardDescription>
                  {modeName(server.mode)}
                  {scope ? ' · 主机指标' : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <HostResources server={server} />
                <p className="text-xs text-muted-foreground">
                  Agent {server.version || '等待接入'} · {modeName(server.mode)}
                </p>
                <p className="border-t pt-3 text-xs text-muted-foreground">
                  最近采集：{date(server.lastSeenAt)}
                </p>
                {!server.online && server.registeredAt && !server.revoked && (
                  <Notice error>连接已中断，业务当前状态待确认。保留最后上报的状态。</Notice>
                )}
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                {scope && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedServer(selectedServer === server.id ? '' : server.id)}
                  >
                    查看服务器
                  </Button>
                )}
                {!scope && !server.revoked && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      confirm(
                        server.mode === 'observe' ? '启用平台部署' : '切换为仅观察',
                        server.mode === 'observe'
                          ? `允许在「${server.name}」新建平台管理目标。现有 Jenkins 观察目标保持只读，Agent 身份保持不变。`
                          : `暂停「${server.name}」的平台发布能力。已有容器继续运行，目标配置与版本记录保留。`,
                        async () => {
                          await request(
                            `/api/deploy/servers/${server.id}/mode`,
                            {
                              mode: server.mode === 'observe' ? 'managed' : 'observe',
                            },
                            'PUT',
                          )
                          await refresh()
                          notify('服务器管理方式已更新，Agent 将在心跳时同步')
                        },
                      )
                    }
                  >
                    {server.mode === 'observe' ? '启用平台部署' : '切换为仅观察'}
                  </Button>
                )}
                {scope ? (
                  <Action
                    onClick={async () => {
                      await request(`${endpoint}/servers/${server.id}`, {}, 'DELETE')
                      await refresh()
                      notify('已解除项目绑定')
                    }}
                  >
                    解除项目绑定
                  </Action>
                ) : (
                  !server.revoked && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        confirm(
                          '撤销服务器接入',
                          `撤销「${server.name}」后，它将无法再连接中心，影响所有绑定项目。已有业务容器会继续运行。`,
                          async () => {
                            await request(`/api/deploy/servers/${server.id}/revoke`, {})
                            await refresh()
                          },
                        )
                      }
                    >
                      撤销接入
                    </Button>
                  )
                )}
              </CardFooter>
            </Card>
          )
        })}
      </div>
      {scope && selectedServer && (
        <div className="space-y-4">
          <h2 className="font-semibold">
            {data.servers.find((s) => s.id === selectedServer)?.name} · 当前项目的服务
          </h2>
          <Targets serverId={selectedServer} />
        </div>
      )}
    </div>
  )
}
export function Services() {
  const { data, environmentId, open, navigate, route, scope } = useConsole()
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={environmentId || ''}
          onValueChange={(id) => navigate(route.view, null, id)}
          className="max-w-full overflow-x-auto"
        >
          <TabsList>
            {data.environments.map((env) => (
              <TabsTrigger key={env.id} value={env.id}>
                {env.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => open('environment')}>
            <Plus />
            新增环境
          </Button>
          <Button onClick={() => open('service')}>
            <Plus />
            新增服务
          </Button>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          open(
            'environment',
            data.environments.find((e) => e.id === environmentId),
          )
        }
      >
        <Settings2 />
        编辑当前环境
      </Button>
      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">服务</TableHead>
              <TableHead>源码</TableHead>
              <TableHead className="hidden lg:table-cell">部署位置</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.services.map((service) => {
              const source = data.environmentSources.find(
                  (s) => s.environmentId === environmentId && s.serviceId === service.id,
                ),
                targets = data.targets.filter(
                  (t) => t.serviceId === service.id && t.environmentId === environmentId,
                )
              return (
                <TableRow key={service.id} data-service-id={service.id}>
                  <TableCell className="max-w-44 whitespace-normal py-5 pl-5">
                    <p className="font-medium">{service.name}</p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {service.kind === 'static' ? '静态站点' : 'Java'} · {service.module}
                    </p>
                  </TableCell>
                  <TableCell className="max-w-40 whitespace-normal">
                    <p className="text-sm">
                      {data.repositories.find((r) => r.id === source?.sourceProjectId)?.name ||
                        '未关联仓库'}
                    </p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {source?.branch || '请配置发布分支'}
                    </p>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    {targets.map((t) => (
                      <p className="py-1" key={t.id}>
                        {data.servers.find((s) => s.id === t.serverId)?.name}
                      </p>
                    ))}
                    {!targets.length && '待配置'}
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-72 flex-wrap gap-1">
                      {targets.map((t) => (
                        <Button
                          key={t.id}
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            location.hash = routeUrl('configuration', scope, environmentId, null, {
                              targetId: t.id,
                            })
                          }}
                        >
                          查看配置
                          {targets.length > 1
                            ? ` · ${data.servers.find((s) => s.id === t.serverId)?.name}`
                            : ''}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!environmentId || !data.repositories.length}
                        onClick={() => open('source', service)}
                      >
                        配置当前环境源码
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => open('service', service)}>
                        编辑服务
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {!data.services.length && (
              <TableRow>
                <TableCell colSpan={4} className="h-28 text-center text-muted-foreground">
                  暂无服务。新增服务后关联仓库与分支。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
export function Targets({ compact = false, serverId }) {
  const { data, targets, find, open, scope, environmentId, navigate } = useConsole()
  const items = serverId ? data.targets.filter((t) => t.serverId === serverId) : targets
  return (
    <div className="space-y-5">
      {!items.length ? (
        <Empty
          title="当前环境暂无部署目标"
          description="关联服务源码并绑定服务器后，配置部署位置。"
          label="新增部署目标"
          action={() => open('target')}
        />
      ) : (
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">服务 / 环境</TableHead>
                <TableHead className="hidden md:table-cell">服务器</TableHead>
                <TableHead>版本 / 状态</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((target) => {
                const server = find('servers', target.serverId),
                  observation = target.observation || {},
                  current = target.currentRelease || {},
                  running = observation.state || observation.status,
                  health = observation.health || observation.healthStatus,
                  isStatic = target.config?.kind === 'static'
                const canManage =
                  target.mode === 'managed' &&
                  server?.mode === 'managed' &&
                  !server.revoked &&
                  server.online
                const active = data.tasks.find(
                  (task) => task.targetId === target.id && !finished(task),
                )
                return (
                  <TableRow className="target-card" key={target.id} data-target-id={target.id}>
                    <TableCell className="max-w-48 whitespace-normal py-5 pl-5">
                      <Button
                        variant="link"
                        className="h-auto max-w-full whitespace-normal p-0 text-left"
                        onClick={() => {
                          location.hash = routeUrl(
                            'configuration',
                            scope,
                            target.environmentId,
                            null,
                            { targetId: target.id },
                          )
                        }}
                      >
                        {find('services', target.serviceId)?.name}
                      </Button>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {find('environments', target.environmentId)?.name}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground md:hidden">{server?.name}</p>
                      {target.mode === 'observe' && (
                        <Badge variant="secondary" className="mt-2">
                          仅观察 · Jenkins / 外部管理
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden max-w-44 whitespace-normal text-xs md:table-cell">
                      <p>{server?.name}</p>
                      <p className="mt-2 text-muted-foreground">
                        {server?.online ? '在线' : '离线'}
                      </p>
                    </TableCell>
                    <TableCell className="max-w-48 whitespace-normal">
                      <Commit value={current.revision || observation.revision} />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {!server?.online
                          ? '失联 · 当前待确认'
                          : {
                              running: '运行中',
                              published: '已发布',
                              unpublished: '尚未发布',
                              exited: '已停止',
                              restarting: '重启中',
                              created: '已创建',
                              missing: '未找到容器',
                              unknown: '待确认',
                            }[running] ||
                            running ||
                            '尚未上报'}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {{
                          healthy: '健康',
                          unhealthy: '健康异常',
                          starting: '检查中',
                          none: '未配置检查',
                          unknown: '待确认',
                        }[health] ||
                          health ||
                          '健康待上报'}
                      </p>
                      {active && (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs"
                          onClick={() => navigate('tasks', active.id, target.environmentId)}
                        >
                          {stageLabel(active.stage, target.config?.kind)} · {duration(active)}
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="card-actions flex max-w-64 flex-wrap gap-1">
                        {[
                          ['deploy', '更新'],
                          ['restart', '重启'],
                          ['rollback', '回退版本'],
                        ]
                          .filter(([action]) => !isStatic || action !== 'restart')
                          .map(([action, label]) => (
                            <Button
                              key={action}
                              size="sm"
                              variant={action === 'deploy' ? 'outline' : 'ghost'}
                              disabled={
                                !canManage ||
                                !!active ||
                                (action !== 'deploy' && !target.currentRelease)
                              }
                              onClick={() => open('release', { target, action })}
                            >
                              {label}
                            </Button>
                          ))}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            location.hash = routeUrl(
                              'configuration',
                              scope,
                              target.environmentId,
                              null,
                              { targetId: target.id },
                            )
                          }}
                        >
                          查看配置
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => open('target', target)}>
                          编辑配置
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
export function Tasks({ compact = false }) {
  const { tasks, find, nameOfTarget, navigate } = useConsole()
  return (
    <div className="space-y-5">
      {!tasks.length ? (
        <Empty
          title="还没有发布记录"
          description="在部署发布中发起首次发布，即可在这里跟踪进度。"
        />
      ) : (
        <Card className="overflow-hidden py-0 shadow-none">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">服务 / 版本</TableHead>
                <TableHead>结果</TableHead>
                <TableHead className="hidden md:table-cell">开始时间</TableHead>
                <TableHead className="hidden lg:table-cell">阶段 / 耗时</TableHead>
                <TableHead className="text-right pr-5">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(compact ? tasks.slice(0, 5) : tasks).map((task) => (
                <TableRow className="task-row" key={task.id} data-task-id={task.id}>
                  <TableCell className="max-w-48 whitespace-normal py-4 pl-5">
                    <p className="break-words font-medium">
                      {nameOfTarget(find('targets', task.targetId))}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {actionNames[task.action]} · <code>{short(revisionOf(task))}</code>
                    </p>
                  </TableCell>
                  <TableCell>
                    <Status value={task.status}>{resultName(task)}</Status>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {date(task.createdAt)}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    {stageLabel(task.stage, task.config?.kind)} · {duration(task)}
                  </TableCell>
                  <TableCell className="pr-5 text-right">
                    <Button variant="ghost" size="sm" onClick={() => navigate('tasks', task.id)}>
                      查看详情
                      <ArrowUpRight />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
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
  }
  return (
    <div id="activity-list">
      {!data.events?.length ? (
        <Empty title="还没有操作记录" description="管理操作与同步结果会显示在这里。" />
      ) : (
        <Card className="py-0 shadow-none">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">时间</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>操作内容</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.events.map((event, i) => (
                <TableRow key={event.id || i}>
                  <TableCell className="pl-5 text-xs text-muted-foreground">
                    {date(event.at)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{labels[event.action] || event.action}</Badge>
                  </TableCell>
                  <TableCell className="min-w-40 whitespace-normal break-words">
                    {event.message}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
