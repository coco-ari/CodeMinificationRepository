import { useId, useLayoutEffect, useRef, useState } from 'react'
import {
  Plus,
  GitBranch,
  GitCommitHorizontal,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
  Server,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Selection, SelectionOption } from '@/components/selection'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Progress } from '@/components/ui/progress'
import { Empty, Action, Status } from './shared'
import {
  useConsole,
  copy,
  duration,
  stageLabel,
  routeUrl,
  date,
  size,
  statusNames,
} from '@/lib/console'
import { homeServices, hostMetrics, serviceHealth } from '@/lib/home-summary'

export function Commit({ value, subject, summary = false, compact = false }) {
  const { notify } = useConsole()
  const text = typeof subject === 'string' ? subject || '无提交说明' : '提交说明暂缺'
  const subjectRef = useRef(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const element = subjectRef.current
    if (!element) return
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [value, subject, summary])
  return value ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Action
          variant="ghost"
          className={`commit-button${summary ? ' commit-summary' : ''}${compact ? ' tile-commit' : ''}`}
          aria-label={`复制 commit ${value}${summary ? `；${text}` : ''}`}
          onClick={async () => {
            await copy(value)
            notify('Commit 已复制')
          }}
        >
          {summary && (
            <span className="commit-subject" ref={subjectRef} data-overflow={overflow}>
              {text}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <GitCommitHorizontal className="size-3.5 shrink-0" />
            <code className="commit-sha">{value.slice(0, compact ? 14 : 10)}</code>
          </span>
        </Action>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 break-words">
        {(summary || typeof subject === 'string') && (
          <p className="mb-1 whitespace-normal">{text}</p>
        )}
        <p className="break-all font-mono text-xs">{value}</p>
        <p className="mt-1 text-xs">点击复制提交号</p>
      </TooltipContent>
    </Tooltip>
  ) : (
    <span className="text-xs text-muted-foreground">版本待识别</span>
  )
}
export function HostResources({
  server,
  showConnection = true,
  showTimestamp = false,
  compact = false,
}) {
  const online = server?.online && !server?.revoked
  return (
    <div className="space-y-3" aria-label="整台服务器资源">
      <div className="grid grid-cols-3 gap-3">
        {hostMetrics(server).map(({ label, value, known, level, message, remaining }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <div
                tabIndex={compact ? 0 : undefined}
                className="min-w-0 space-y-1.5"
                data-resource={label}
                data-level={level}
                aria-label={`${label}：${known ? `${Math.round(value)}%${message ? `，${message}` : ''}${remaining != null ? `，剩余 ${size(remaining)}` : ''}` : '暂无有效数据'}`}
              >
                <div className="flex justify-between gap-1 text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span
                    className={`tabular-nums ${level === 'critical' || level === 'warning' ? 'text-destructive' : ''}`}
                  >
                    {known ? `${Math.round(value)}%` : '—'}
                  </span>
                </div>
                <Progress
                  value={known ? Math.min(100, Math.max(0, value)) : null}
                  aria-label={`${label}（整机）`}
                  aria-valuetext={
                    known ? `${Math.round(value)}%${message ? `，${message}` : ''}` : '暂无有效数据'
                  }
                  className={`${compact ? 'h-[3px]' : 'h-1.5'} ${!known ? '[&_[data-slot=progress-indicator]]:invisible' : level === 'critical' || level === 'warning' ? '[&_[data-slot=progress-indicator]]:bg-destructive' : ''}`}
                />
                {!compact && message && <p className="text-xs text-destructive">{message}</p>}
                {!compact && label === '磁盘' && known && remaining != null && (
                  <p className="text-xs text-muted-foreground">剩余 {size(remaining)}</p>
                )}
              </div>
            </TooltipTrigger>
            {compact && (
              <TooltipContent>
                <p>
                  {known
                    ? `${label} ${Math.round(value)}%${message ? ` · ${message}` : ''}`
                    : '暂无有效数据'}
                </p>
                {known && remaining != null && <p>剩余 {size(remaining)}</p>}
                <p className="mt-1">最近采集：{date(server?.lastSeenAt)}</p>
              </TooltipContent>
            )}
          </Tooltip>
        ))}
      </div>
      {(showConnection || showTimestamp) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          {showConnection && (
            <Status value={online ? 'online' : 'disabled'}>
              {server ? (online ? '在线' : server.revoked ? '已撤销' : '离线') : '未绑定服务器'}
            </Status>
          )}
          {showTimestamp && <span>最近采集：{date(server?.lastSeenAt)}</span>}
        </div>
      )}
    </div>
  )
}
export function ServiceState({ targets, servers, failedTask }) {
  const health = serviceHealth(targets, servers)
  const label =
    {
      健康: '运行中',
      健康待确认: '运行中',
      失联待确认: '离线',
      状态待上报: '待上报',
      健康异常: '异常',
    }[health.label] || health.label.replace(' 待处理', ' 异常')
  const description = `${health.description}${failedTask ? `；最近任务：${statusNames[failedTask.status]}` : ''}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="ghost"
          tabIndex={0}
          className={`tile-runtime ${health.value === 'healthy' ? 'text-emerald-700 dark:text-emerald-400' : health.value === 'unhealthy' ? 'text-destructive' : 'text-muted-foreground'}`}
          aria-label={description}
        >
          <span className="size-1 shrink-0 rounded-full bg-current" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">{description}</TooltipContent>
    </Tooltip>
  )
}

function ServiceVersion({ row, onDetails }) {
  const { version, source } = row
  const branch = version.branch || source?.branch
  const branchDescription = version.branch
    ? '当前发布版本的分支'
    : source?.branch
      ? '配置的发布分支；运行版本所属分支尚未确认'
      : '尚未识别分支'
  return (
    <div className="tile-version" data-service-version>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="link"
            className="tile-branch"
            onClick={onDetails}
            aria-label={`${branchDescription}：${branch || '分支待识别'}`}
          >
            <GitBranch />
            <span className="truncate">{branch || '分支待识别'}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-80 space-y-1">
          <p>
            {branchDescription}：{branch || '—'}
          </p>
          <p>{version.repositoryName || row.repository?.name || '未关联仓库'}</p>
          <p>
            {row.targets.length} 个部署位置
            {version.kind === 'drift' ? '；实际运行 Commit 与发布记录不同' : ''}
          </p>
          {row.lastDeployedAt && <p>最近发布：{date(row.lastDeployedAt)}</p>}
          <p>点击查看服务详情</p>
        </TooltipContent>
      </Tooltip>
      <span aria-hidden="true">·</span>
      {version.revision ? (
        <Commit value={version.revision} subject={version.subject} compact />
      ) : version.kind === 'mixed' ? (
        <Button variant="link" className="tile-version-detail" onClick={onDetails}>
          版本不同
        </Button>
      ) : (
        <span className="tile-version-unknown">{row.targets.length ? '版本待识别' : '—'}</span>
      )}
    </div>
  )
}

function ServiceAction({ row, servers, go, onTask }) {
  const reason = (target) => {
    const server = servers.find((item) => item.id === target.serverId)
    return target.mode !== 'managed'
      ? '此目标不由平台管理，请查看服务配置'
      : !server?.online || server.revoked
        ? '服务器未在线'
        : !row.repository?.enabled
          ? '请先配置并启用源码仓库'
          : ''
  }
  if (row.activeTasks.length) {
    const task = row.activeTasks.length === 1 ? row.activeTasks[0] : null
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="tile-service-action"
            aria-label={`${row.name} · 查看进度`}
            onClick={() =>
              task ? onTask(task.id) : go('service', { serviceId: row.id, tab: 'history' })
            }
          >
            进度
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {task
            ? `${stageLabel(task.stage)} · ${duration(task)}`
            : `${row.activeTasks.length} 个任务进行中`}
        </TooltipContent>
      </Tooltip>
    )
  }
  if (row.targets.length > 1)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="tile-service-action"
            aria-label={`${row.name} · 选择目标更新`}
          >
            更新
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-80">
          <DropdownMenuLabel>选择部署位置</DropdownMenuLabel>
          {row.targets.map((target) => {
            const disabledReason = reason(target)
            return (
              <DropdownMenuItem
                key={target.id}
                disabled={!!disabledReason}
                onSelect={() => go('release', { targetId: target.id })}
              >
                <div className="min-w-0">
                  <p className="break-words">
                    {servers.find((item) => item.id === target.serverId)?.name || '服务器不存在'}
                  </p>
                  {disabledReason && (
                    <p className="mt-1 text-xs text-muted-foreground">{disabledReason}</p>
                  )}
                </div>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  const target = row.targets[0],
    disabledReason = target ? reason(target) : ''
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={disabledReason ? 0 : undefined}>
          <Button
            variant="outline"
            size="sm"
            className="tile-service-action"
            disabled={!!disabledReason}
            aria-label={`${row.name} · ${target ? '更新' : '配置'}`}
            onClick={() =>
              target ? go('release', { targetId: target.id }) : go('setup', { serviceId: row.id })
            }
          >
            {target ? '更新' : '配置'}
          </Button>
        </span>
      </TooltipTrigger>
      {disabledReason && <TooltipContent>{disabledReason}</TooltipContent>}
    </Tooltip>
  )
}

export function ProjectTile({ project }) {
  const db = project.dashboard,
    storageKey = `cmr:environment:${project.id}`
  const hostId = useId()
  const [chosen, setChosen] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey)
    } catch {
      return null
    }
  })
  const environment =
    db.environments.find((e) => e.id === chosen) ||
    db.environments.find((e) => e.name === '测试') ||
    db.environments[0]
  const [serverId, setServerId] = useState('')
  const [pageSelection, setPageSelection] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`${storageKey}:page`))
    } catch {
      return null
    }
  })
  const servers = db.servers.filter((s) => !s.revoked)
  const server = servers.find((s) => s.id === serverId) || servers[0]
  const rows = homeServices(db, environment?.id)
  const pageCount = Math.max(1, Math.ceil(rows.length / 3))
  const requestedPage =
    pageSelection?.environmentId === environment?.id && Number.isInteger(pageSelection?.index)
      ? pageSelection.index
      : 0
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1)
  const attention = rows.filter((row) => row.needsAttention).length
  const go = (view, extra = {}) => {
    location.hash = routeUrl(view, project.id, environment?.id, null, extra)
  }
  const changePage = (index, environmentId = environment?.id) => {
    const selection = { environmentId, index }
    setPageSelection(selection)
    try {
      sessionStorage.setItem(`${storageKey}:page`, JSON.stringify(selection))
    } catch {}
  }
  const changeEnvironment = (id) => {
    setChosen(id)
    changePage(0, id)
    try {
      sessionStorage.setItem(storageKey, id)
    } catch {}
  }
  return (
    <Card className="project-tile workspace-card" data-workspace-id={project.id}>
      <CardHeader className="tile-heading">
        <CardTitle className="min-w-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="link" className="tile-project-name">
                <a
                  href={routeUrl('overview', project.id, environment?.id)}
                  aria-label={`进入 ${project.name}`}
                >
                  <span className="truncate">{project.name}</span>
                  <ArrowUpRight />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{project.name}</TooltipContent>
          </Tooltip>
        </CardTitle>
        {db.environments.length > 2 ? (
          <Selection
            value={environment?.id || ''}
            onChange={(e) => changeEnvironment(e.target.value)}
            className="tile-environment-select"
            aria-label={`${project.name}的环境`}
          >
            {db.environments.map((env) => (
              <SelectionOption key={env.id} value={env.id}>
                {env.name}
              </SelectionOption>
            ))}
          </Selection>
        ) : db.environments.length > 1 ? (
          <Tabs
            value={environment?.id || ''}
            onValueChange={changeEnvironment}
            className="tile-environments"
          >
            <TabsList aria-label={`${project.name}的环境`}>
              {db.environments.map((env) => (
                <TabsTrigger key={env.id} value={env.id}>
                  <span className="truncate">{env.name}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : (
          <Badge variant="secondary" className="tile-environment-single">
            {environment?.name || '未配置环境'}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="tile-resources" data-host-resources>
        <div className="tile-host-heading">
          <div className="tile-host-identity">
            <Server className="size-3.5 shrink-0" />
            {servers.length > 1 ? (
              <Selection
                id={hostId}
                className="tile-host-select"
                aria-label={`${project.name}的资源服务器`}
                value={server?.id || ''}
                onChange={(e) => setServerId(e.target.value)}
              >
                {servers.map((item) => (
                  <SelectionOption key={item.id} value={item.id}>
                    {item.name}
                  </SelectionOption>
                ))}
              </Selection>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="truncate" tabIndex={0}>
                    {server?.name || '未绑定服务器'}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{server?.name || '未绑定服务器'}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="tile-host-scope" tabIndex={0}>
                  整机
                </span>
              </TooltipTrigger>
              <TooltipContent>
                整台服务器的资源；选择服务器仅切换指标，服务列表仍显示当前环境全部服务。
              </TooltipContent>
            </Tooltip>
          </div>
          <Badge variant="ghost" className="tile-connection">
            <span
              className={`size-1 shrink-0 rounded-full ${server?.online ? 'bg-emerald-600 dark:bg-emerald-400' : 'bg-muted-foreground'}`}
            />
            {server ? (server.online ? '在线' : '离线') : '待绑定'}
          </Badge>
        </div>
        <HostResources server={server} showConnection={false} compact />
      </CardContent>
      <div
        className="tile-services"
        aria-label={`${project.name} ${environment?.name || ''}服务列表`}
      >
        <div className="tile-service-page" key={`${environment?.id}-${page}`}>
          {!rows.length && (
            <div className="tile-empty">
              <span>还没有服务</span>
              <Button variant="outline" size="sm" onClick={() => go('setup')}>
                <Plus />
                添加服务
              </Button>
            </div>
          )}
          {rows.slice(page * 3, page * 3 + 3).map((row) => (
            <div className="tile-service" data-home-service={row.id} key={row.id}>
              <div className="min-w-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="link"
                      className="tile-service-name"
                      onClick={() => go('service', { serviceId: row.id })}
                    >
                      <span className="truncate">{row.name}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{row.name}</TooltipContent>
                </Tooltip>
                <ServiceVersion row={row} onDetails={() => go('service', { serviceId: row.id })} />
              </div>
              <div className="tile-service-end">
                <ServiceAction
                  row={row}
                  servers={db.servers}
                  go={go}
                  onTask={(id) => {
                    location.hash = routeUrl('tasks', project.id, environment?.id, id)
                  }}
                />
                <ServiceState
                  targets={row.targets}
                  servers={db.servers}
                  failedTask={row.failedTask}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <CardFooter className="tile-footer">
        <div className="tile-footer-links">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`为${project.name}新增服务`}
                onClick={() => go('setup')}
              >
                <Plus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>新增服务</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => go('services')}
                aria-label={`查看全部 ${rows.length} 个服务${attention ? `，${attention} 个待处理` : ''}`}
              >
                {rows.length} 个服务
                <ArrowUpRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {attention ? `${attention} 个服务需要处理；查看全部服务` : '查看当前环境的全部服务'}
            </TooltipContent>
          </Tooltip>
        </div>
        <nav className="tile-pagination" aria-label={`${project.name}服务分页`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="上一页服务"
            disabled={page === 0}
            onClick={() => changePage(page - 1)}
          >
            <ChevronLeft />
          </Button>
          <span aria-live="polite">
            {page + 1} / {pageCount}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="下一页服务"
            disabled={page === pageCount - 1}
            onClick={() => changePage(page + 1)}
          >
            <ChevronRight />
          </Button>
        </nav>
      </CardFooter>
    </Card>
  )
}
export function WorkspaceHome() {
  const { data, open } = useConsole(),
    [search, setSearch] = useState('')
  const projects = data.projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="page-title" className="text-xl font-semibold">
          项目
        </h1>
        <div className="flex items-center gap-2">
          <Input
            aria-label="搜索项目"
            placeholder="搜索项目…"
            className="w-32 sm:w-44"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button id="create-button" onClick={() => open('workspace')}>
            <Plus />
            创建项目
          </Button>
        </div>
      </div>
      <div id="workspace-home" className="home-grid">
        {projects.map((project) => (
          <ProjectTile key={project.id} project={project} />
        ))}
        {!projects.length && (
          <Empty
            title={search ? '没有匹配的项目' : '创建第一个项目'}
            description=""
            action={!search ? () => open('workspace') : undefined}
            label="创建项目"
          />
        )}
      </div>
    </div>
  )
}
