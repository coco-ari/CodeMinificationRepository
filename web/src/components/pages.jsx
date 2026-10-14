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
} from '@/lib/console'

const grid = 'grid gap-5 lg:grid-cols-2 2xl:grid-cols-3'
const actions = 'card-actions flex flex-wrap items-center gap-2'
export function Home() {
  const { data, open, enter } = useConsole()
  const projects = data.projects || []
  return (
    <div className="space-y-6">
      <Stats
        items={[
          ['项目空间', projects.length, '每个项目独立组织交付资源'],
          [
            '运行中的目标',
            projects.reduce((n, p) => n + p.runningTargets, 0),
            '最近上报的容器运行状态',
          ],
          [
            '进行中的任务',
            projects.reduce((n, p) => n + p.activeTasks, 0),
            '准备源码、排队或执行中',
          ],
        ]}
      />
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">
          全部项目 <span className="ml-2 font-normal text-muted-foreground">{projects.length}</span>
        </h2>
        <span className="text-xs text-muted-foreground">按项目组织，独立交付</span>
      </div>
      <div id="workspace-home" className={grid}>
        {!projects.length && (
          <Empty
            title="创建第一个项目"
            description="添加代码仓库、绑定服务器，然后为不同环境配置和发布服务。"
            label="创建项目"
            action={() => open('workspace')}
          />
        )}
        {projects.map((project) => (
          <Card
            key={project.id}
            className="workspace-card group shadow-none transition-colors hover:border-primary/40"
            data-workspace-id={project.id}
          >
            <CardHeader>
              <div className="mb-3 flex items-center justify-between">
                <div className="rounded-lg border bg-muted/50 p-2.5">
                  <FolderOpen className="size-5 text-primary" />
                </div>
                {project.legacySources && <Badge variant="secondary">历史源码</Badge>}
                {project.activeTasks > 0 && (
                  <Status value="running">{project.activeTasks} 个任务</Status>
                )}
              </div>
              <CardTitle className="text-lg">{project.name}</CardTitle>
              <CardDescription className="line-clamp-2 min-h-10">
                {project.description || '管理源码、服务器与服务发布'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2 border-y py-4">
                <Detail label="代码仓库">{project.repositories}</Detail>
                <Detail label="服务器">{project.servers}</Detail>
                <Detail label="目标运行中">
                  {project.runningTargets} / {project.targets}
                </Detail>
              </div>
              <div className="mt-4 flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
                {project.latestTask ? (
                  <>
                    <Status value={project.latestTask.status}>
                      {resultName(project.latestTask)}
                    </Status>
                    <span>{date(project.latestTask.createdAt)}</span>
                  </>
                ) : (
                  <>
                    <Clock3 className="size-3.5" />
                    尚无发布记录
                  </>
                )}
              </div>
            </CardContent>
            <CardFooter className="justify-end">
              <Button variant="ghost" onClick={() => enter(project.id)}>
                进入项目 <ArrowRight className="transition-transform group-hover:translate-x-1" />
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      {data.migration?.backup && (
        <Notice>
          工作空间迁移完成：{data.migration.repositories} 个仓库，
          {data.migration.copiedRepositories} 份独立配置，{data.migration.bindings}{' '}
          个服务器绑定。备份：{data.migration.backup}
        </Notice>
      )}
    </div>
  )
}
export function Overview() {
  const { data, targets, open, navigate } = useConsole()
  return (
    <div className="space-y-6">
      <Stats
        items={[
          ['代码仓库', data.repositories.length, '独立的源码与下载配置'],
          ['已绑定服务器', data.servers.length, 'Agent 可由多个项目复用'],
          ['当前环境部署目标', targets.length, '每个服务可以单独发布'],
        ]}
      />
      <Card className="shadow-none">
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="space-y-2">
            <CardTitle>准备下一次交付</CardTitle>
            <CardDescription>
              {data.project.description || '按顺序准备源码、服务器和服务，即可开始发布。'}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => open('workspace', data.project)}>
            <Settings2 />
            编辑项目
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            [GitFork, '添加代码仓库', 'projects', data.repositories.length],
            [Server, '绑定服务器', 'servers', data.servers.length],
            [Box, '配置环境与服务', 'applications', data.environmentSources.length],
            [ArrowUpRight, '部署发布', 'deployments', targets.length],
          ].map(([Icon, label, view, count], i) => (
            <Button
              variant="outline"
              className="h-auto justify-between whitespace-normal p-4 text-left"
              key={view}
              onClick={() => navigate(view)}
            >
              <span className="flex items-center gap-3">
                <Icon className="text-muted-foreground" />
                <span>
                  {i + 1}. {label}
                </span>
              </span>
              {count > 0 ? (
                <CircleCheck className="text-primary" />
              ) : (
                <ArrowRight className="text-muted-foreground" />
              )}
            </Button>
          ))}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">当前环境最近发布</h2>
        <Button variant="ghost" size="sm" onClick={() => navigate('tasks')}>
          全部记录 <ArrowRight />
        </Button>
      </div>
      <Tasks compact />
    </div>
  )
}
export function Repositories() {
  const { data, open, request, endpoint, refresh, confirm, notify } = useConsole()
  const [search, setSearch] = useState('')
  const repos = data.repositories.filter((p) =>
    [p.name, p.repository, p.branch].some((v) => v.toLowerCase().includes(search.toLowerCase())),
  )
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            id="search"
            className="pl-9"
            placeholder="搜索仓库名称、地址或分支…"
            aria-label="搜索代码仓库"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="text-sm text-muted-foreground">{data.repositories.length} 个代码仓库</span>
      </div>
      <div id="project-list" className={grid}>
        {!repos.length && (
          <Empty
            title={search ? '没有匹配的仓库' : '连接第一个代码仓库'}
            description="添加仓库及默认下载分支，在环境与服务中选择发布分支。"
            label="添加仓库"
            action={!search ? () => open('repository') : undefined}
          />
        )}
        {repos.map((repo) => (
          <Card key={repo.id} className="project-card shadow-none">
            <CardHeader>
              <div className="mb-2 flex items-center justify-between">
                <GitFork className="size-5 text-muted-foreground" />
                <Status value={repo.enabled ? repo.status : 'disabled'} />
              </div>
              <CardTitle className="text-lg">{repo.name}</CardTitle>
              <a
                href={repo.repository}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                <span className="truncate">{repo.repository.replace('https://', '')}</span>
                <ArrowUpRight className="size-3 shrink-0" />
              </a>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                默认下载分支
                <Badge variant="secondary" className="max-w-full break-all whitespace-normal">
                  <GitBranch className="size-3" />
                  {repo.branch}
                </Badge>
              </div>
              <dl className="grid gap-3 border-t pt-4 sm:grid-cols-2">
                <Detail label="最近成功同步">
                  {repo.lastSuccess ? date(repo.lastSuccess.at) : '尚未同步'}
                </Detail>
                <Detail label="源码版本 / 大小">
                  {repo.lastSuccess
                    ? `${short(repo.lastSuccess.revision)} · ${(repo.lastSuccess.size / 1024 / 1024).toFixed(2)} MB`
                    : '首次下载时生成'}
                </Detail>
              </dl>
              {repo.needsDownloadTokenReset && (
                <Notice>已迁移独立配置；首次对外下载前请重置下载密码。</Notice>
              )}
              {repo.error && <Notice error>{repo.error}</Notice>}
            </CardContent>
            <CardFooter className={actions}>
              <Action
                onClick={async () => {
                  await copy(downloadPage(repo.id))
                  notify('下载地址已复制')
                }}
              >
                复制地址
              </Action>
              <Button variant="outline" onClick={() => open('repository', repo)}>
                编辑
              </Button>
              <Action
                disabled={!repo.enabled || ['syncing', 'queued'].includes(repo.status)}
                onClick={async () => {
                  await request(`${endpoint}/repositories/${repo.id}/sync`, {})
                  await refresh()
                  notify('源码同步完成')
                }}
              >
                立即同步
              </Action>
              <Button
                variant="ghost"
                onClick={() =>
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
                重置密码
              </Button>
              <Action
                variant="ghost"
                onClick={async () => {
                  await request(`${endpoint}/repositories/${repo.id}/enabled`, {
                    enabled: !repo.enabled,
                  })
                  await refresh()
                }}
              >
                {repo.enabled ? '停用' : '启用'}
              </Action>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  )
}
export function Servers() {
  const { data, scope, open, request, endpoint, refresh, confirm, notify } = useConsole()
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
      <Stats
        items={[
          [
            '已接入',
            data.servers.filter((s) => s.registeredAt && !s.revoked).length,
            '独立身份主动连接中心',
          ],
          ['在线', data.servers.filter((s) => s.online && !s.revoked).length, '60 秒内收到心跳'],
          [
            '仅观察',
            data.servers.filter((s) => s.mode === 'observe' && !s.revoked).length,
            '沿用现有发布方式',
          ],
        ]}
      />
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
                <dl className="grid grid-cols-2 gap-4">
                  <Detail label={server.online ? 'CPU 使用' : '最后 CPU 使用'}>
                    {Number.isFinite(cpu) ? `${cpu.toFixed(1)}%` : '—'}
                  </Detail>
                  <Detail label="内存使用 / 总量">
                    {size(memory.used ?? metrics.memoryUsed)} /{' '}
                    {size(memory.total ?? metrics.memoryTotal)}
                  </Detail>
                  <Detail label="工作目录磁盘">
                    {size(disk.used)} / {size(disk.total)}
                  </Detail>
                  <Detail label="Agent 版本">{server.version || '等待接入'}</Detail>
                </dl>
                <p className="border-t pt-3 text-xs text-muted-foreground">
                  最近采集：{date(server.lastSeenAt)}
                </p>
                {!server.online && server.registeredAt && !server.revoked && (
                  <Notice error>连接已中断，业务当前状态待确认。保留最后上报的状态。</Notice>
                )}
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
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
    </div>
  )
}
export function Services() {
  const { data, environmentId, open, navigate, route } = useConsole()
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
        <div className="flex flex-wrap gap-2">
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
      <Notice>同环境同服务的不同服务器共用源码选择；各部署目标分别保存端口和运行配置。</Notice>
      <div className="flex flex-wrap gap-2">
        {data.environments.map((env) => (
          <Button variant="ghost" size="sm" key={env.id} onClick={() => open('environment', env)}>
            <Settings2 className="size-3" />
            {env.name} · 编辑
          </Button>
        ))}
      </div>
      <div className={grid}>
        {!data.services.length && (
          <Empty
            title="添加第一个服务"
            description="添加 Java 服务或前端静态站点，再为各环境关联代码仓库。"
            label="新增服务"
            action={() => open('service')}
          />
        )}
        {data.services.map((service) => {
          const source = data.environmentSources.find(
            (s) => s.environmentId === environmentId && s.serviceId === service.id,
          )
          return (
            <Card key={service.id} data-service-id={service.id} className="shadow-none">
              <CardHeader>
                <Box className="mb-2 size-5 text-muted-foreground" />
                <CardTitle>{service.name}</CardTitle>
                <CardDescription>
                  {service.kind === 'static' ? '前端静态站点 · 项目目录：' : 'Java · Maven 模块：'}
                  <code>{service.module}</code>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3">
                  <Detail label="当前环境的代码仓库">
                    {data.repositories.find((r) => r.id === source?.sourceProjectId)?.name ||
                      '尚未配置源码'}
                  </Detail>
                  <Detail label="发布分支">{source?.branch || '—'}</Detail>
                </dl>
              </CardContent>
              <CardFooter className={actions}>
                <Button
                  disabled={!environmentId || !data.repositories.length}
                  onClick={() => open('source', service)}
                >
                  配置当前环境源码
                </Button>
                <Button variant="outline" onClick={() => open('service', service)}>
                  编辑服务
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
export function Targets() {
  const { data, targets, find, nameOfTarget, open } = useConsole()
  return (
    <div className="space-y-5">
      <Stats
        items={[
          ['部署目标', targets.length, '独立保存配置和运行版本'],
          [
            '仅观察',
            targets.filter((t) => t.mode === 'observe').length,
            '由 Jenkins 等外部系统发布',
          ],
          ['平台管理', targets.filter((t) => t.mode === 'managed').length, '发布、重启与回退'],
        ]}
      />
      {!targets.length && (
        <Empty
          title="连接服务与服务器"
          description="配置环境与服务的源码并绑定服务器，创建独立部署目标。"
          label="新增部署目标"
          action={() => open('target')}
        />
      )}
      <div className="space-y-4">
        {targets.map((target) => {
          const isStatic = target.config?.kind === 'static'
          const server = find('servers', target.serverId),
            observation = target.observation || {},
            current = target.currentRelease || {}
          const running = observation.state || observation.status,
            health = observation.health || observation.healthStatus
          const canManage =
            target.mode === 'managed' &&
            server?.mode === 'managed' &&
            !server.revoked &&
            server.online
          const busy = data.tasks.some((task) => task.targetId === target.id && !finished(task))
          return (
            <Card className="target-card shadow-none" key={target.id} data-target-id={target.id}>
              <CardHeader className="flex-wrap gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-2">
                  <CardTitle>{nameOfTarget(target)}</CardTitle>
                  <CardDescription>
                    {server?.name || '服务器不可用'}
                    {target.containerName && ` · ${target.containerName}`}
                  </CardDescription>
                </div>
                <Badge variant="secondary">
                  {target.mode === 'observe' ? 'Jenkins / 外部管理 · 仅观察' : '平台管理'}
                </Badge>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-5 border-y py-4 lg:grid-cols-5">
                  <Detail label="运行状态">
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
                  </Detail>
                  <Detail label={server?.online ? '健康状态' : '最后健康状态'}>
                    {{
                      healthy: '健康',
                      unhealthy: '异常',
                      starting: '检查中',
                      none: '未配置检查',
                      unknown: '待确认',
                    }[health] ||
                      health ||
                      '尚未上报'}
                  </Detail>
                  <Detail label="当前版本">
                    {short(current.revision || observation.revision)}
                  </Detail>
                  <Detail label={isStatic ? '访问方式' : '重启次数'}>
                    {isStatic ? '共用 Nginx' : (observation.restartCount ?? '—')}
                  </Detail>
                  <Detail label="最近采集">{date(target.lastObservedAt || observation.at)}</Detail>
                </dl>
                {(current.image || observation.image) && (
                  <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
                    镜像：{current.image || observation.image}
                  </p>
                )}
                {isStatic && (
                  <p className="mt-3 break-all text-xs text-muted-foreground">
                    站点：{target.config.health?.url || '尚未配置'}
                    <br />
                    默认发布目录：/opt/cmr-agent-static/{target.id}/current
                  </p>
                )}
              </CardContent>
              <CardFooter className={actions}>
                {[
                  ['deploy', '发布最新源码'],
                  ['restart', '重启'],
                  ['rollback', '回退版本'],
                ]
                  .filter(([action]) => !isStatic || action !== 'restart')
                  .map(([action, label]) => (
                    <Button
                      key={action}
                      variant={action === 'deploy' ? 'default' : 'outline'}
                      disabled={
                        !canManage || busy || (action !== 'deploy' && !target.currentRelease)
                      }
                      onClick={() => open('release', { target, action })}
                    >
                      {label}
                    </Button>
                  ))}
                <Button variant="ghost" onClick={() => open('target', target)}>
                  <Settings2 />
                  编辑配置
                </Button>
                {(busy || !canManage) && (
                  <span className="text-xs text-muted-foreground">
                    {busy
                      ? '已有任务正在执行'
                      : target.mode === 'observe'
                        ? '由外部系统发布'
                        : '服务器未在线或不可管理'}
                  </span>
                )}
              </CardFooter>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
export function Tasks({ compact = false }) {
  const { tasks, find, nameOfTarget, navigate } = useConsole()
  return (
    <div className="space-y-5">
      {!compact && (
        <Stats
          items={[
            ['正在处理', tasks.filter((t) => !finished(t)).length, '准备源码、排队或执行中'],
            [
              '已成功',
              tasks.filter((t) => ['succeeded', 'success'].includes(t.status)).length,
              '当前环境的最近任务',
            ],
            [
              '需关注',
              tasks.filter((t) => ['failed', 'interrupted', 'rolled_back'].includes(t.status))
                .length,
              '查看日志与回退结果',
            ],
          ]}
        />
      )}
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
