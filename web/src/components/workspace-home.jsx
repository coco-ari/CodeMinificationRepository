import { Fragment, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Plus,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
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

export function Commit({ value, subject, summary = false }) {
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
          className={summary ? 'commit-button commit-summary' : 'commit-button'}
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
            <code className="commit-sha">{value.slice(0, 10)}</code>
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
    <span className="text-xs text-muted-foreground">尚未发布</span>
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
                    className={`tabular-nums ${level === 'critical' ? 'text-destructive' : level === 'warning' ? 'text-amber-700 dark:text-amber-400' : ''}`}
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
                  className={`h-1.5 ${!known ? '[&_[data-slot=progress-indicator]]:invisible' : level === 'critical' ? '[&_[data-slot=progress-indicator]]:bg-destructive' : level === 'warning' ? '[&_[data-slot=progress-indicator]]:bg-amber-500' : ''}`}
                />
                {!compact && message && (
                  <p
                    className={`text-xs ${level === 'critical' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`}
                  >
                    {message}
                  </p>
                )}
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
  const showFailure = failedTask && !health.attention
  const label = showFailure
    ? failedTask.status === 'rolled_back'
      ? '已回退'
      : '发布失败'
    : health.label
  const description = `${health.description}${failedTask ? `；最近任务：${statusNames[failedTask.status]}` : ''}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={description}>
          <Status value={showFailure ? failedTask.status : health.value}>{label}</Status>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">{description}</TooltipContent>
    </Tooltip>
  )
}

function ServiceVersion({ row, onDetails }) {
  const { version } = row
  const label =
    version.kind === 'mixed'
      ? `${row.targets.length} 个位置 · 版本不同`
      : version.kind === 'observed'
        ? '运行版本'
        : version.kind === 'drift'
          ? '运行版本不一致'
          : version.label
  return (
    <div
      className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground"
      data-service-version
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="link"
            className={`h-auto min-w-0 flex-1 shrink justify-start gap-1.5 p-0 text-xs font-normal has-[>svg]:px-0 ${version.kind === 'drift' ? 'text-destructive' : 'text-muted-foreground'}`}
            onClick={onDetails}
          >
            {version.kind === 'released' && <GitBranch className="size-3.5" />}
            <span className="truncate">{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-80 space-y-1">
          <p>{version.repositoryName || row.repository?.name || '未关联仓库'}</p>
          <p>{version.label}</p>
          <p>{row.targets.length} 个部署位置</p>
          {row.lastDeployedAt && <p>最近发布：{date(row.lastDeployedAt)}</p>}
          <p>点击查看服务详情</p>
        </TooltipContent>
      </Tooltip>
      {version.revision && <Commit value={version.revision} subject={version.subject} />}
    </div>
  )
}

function ServiceAction({ row, servers, go, onTask }) {
  const reason = (target) => {
    const server = servers.find((item) => item.id === target.serverId)
    return !server?.online || server.revoked
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
            aria-label={`${row.name} · 查看进度`}
            onClick={() =>
              task ? onTask(task.id) : go('service', { serviceId: row.id, tab: 'history' })
            }
          >
            <LoaderCircle className="size-3 animate-spin" />
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
          <Button variant="outline" size="sm" aria-label={`${row.name} · 选择目标发布`}>
            发布
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
            disabled={!!disabledReason}
            aria-label={`${row.name} · ${target ? '发布' : '配置'}`}
            onClick={() =>
              target ? go('release', { targetId: target.id }) : go('setup', { serviceId: row.id })
            }
          >
            {target ? '发布' : '配置'}
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
  const servers = db.servers.filter((s) => !s.revoked)
  const server = servers.find((s) => s.id === serverId) || servers[0]
  const rows = homeServices(db, environment?.id)
  const attention = rows.filter((row) => row.needsAttention).length
  const go = (view, extra = {}) => {
    location.hash = routeUrl(view, project.id, environment?.id, null, extra)
  }
  return (
    <Card className="project-tile workspace-card" data-workspace-id={project.id}>
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="min-w-0">
            <Button
              asChild
              variant="link"
              className="h-auto max-w-full p-0 text-base font-semibold"
            >
              <a href={routeUrl('overview', project.id, environment?.id)}>
                <span className="truncate">{project.name}</span>
              </a>
            </Button>
          </CardTitle>
          <Button asChild variant="ghost" size="icon" aria-label={`进入 ${project.name}`}>
            <a href={routeUrl('overview', project.id, environment?.id)}>
              <ArrowRight className="size-4" />
            </a>
          </Button>
        </div>
        {db.environments.length > 1 ? (
          <Tabs
            value={environment?.id || ''}
            onValueChange={(id) => {
              setChosen(id)
              try {
                sessionStorage.setItem(storageKey, id)
              } catch {}
            }}
            className="min-w-0"
          >
            <TabsList
              className="max-w-full overflow-x-auto overflow-y-hidden"
              aria-label={`${project.name}的环境`}
            >
              {db.environments.map((env) => (
                <TabsTrigger key={env.id} value={env.id}>
                  {env.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : (
          <Badge variant="secondary" className="w-fit">
            {environment?.name || '未配置环境'}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="tile-body">
        <div className="space-y-3" data-host-resources>
          <div className="flex min-w-0 items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Label
                  htmlFor={hostId}
                  tabIndex={0}
                  className="shrink-0 text-xs font-normal text-muted-foreground"
                >
                  整机资源
                </Label>
              </TooltipTrigger>
              <TooltipContent>项目共享的服务器资源，切换仅影响此区域的指标。</TooltipContent>
            </Tooltip>
            <Selection
              id={hostId}
              className="min-w-0 flex-1 shrink"
              aria-label={`${project.name}的资源服务器`}
              value={server?.id || ''}
              disabled={!servers.length}
              onChange={(e) => setServerId(e.target.value)}
            >
              {!servers.length && <SelectionOption value="">未绑定服务器</SelectionOption>}
              {servers.map((item) => (
                <SelectionOption key={item.id} value={item.id}>
                  {item.name} · {item.online ? '在线' : '离线'}
                </SelectionOption>
              ))}
            </Selection>
          </div>
          <HostResources server={server} showConnection={false} compact />
        </div>
        <div
          className="tile-services"
          aria-label={`${project.name} ${environment?.name || ''}服务列表`}
          key={environment?.id}
        >
          {!rows.length && <Empty title="暂无服务" />}
          {rows.slice(0, 3).map((row, index) => (
            <Fragment key={row.id}>
              {index > 0 && <Separator />}
              <div className="tile-service space-y-2" data-home-service={row.id}>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
                  <Button
                    variant="link"
                    className="h-auto min-w-0 max-w-full justify-start p-0 text-sm font-medium"
                    onClick={() => go('service', { serviceId: row.id })}
                    title={row.name}
                  >
                    <span className="truncate">{row.name}</span>
                  </Button>
                  <ServiceState
                    targets={row.targets}
                    servers={db.servers}
                    failedTask={row.failedTask}
                  />
                  <ServiceAction
                    row={row}
                    servers={db.servers}
                    go={go}
                    onTask={(id) => {
                      location.hash = routeUrl('tasks', project.id, environment?.id, id)
                    }}
                  />
                </div>
                <ServiceVersion row={row} onDetails={() => go('service', { serviceId: row.id })} />
              </div>
            </Fragment>
          ))}
        </div>
      </CardContent>
      <CardFooter className="tile-footer">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => go('setup')}
        >
          <Plus />
          新增服务
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => go('services')}
              aria-label={`查看全部 ${rows.length} 个服务${attention ? `，${attention} 个待处理` : ''}`}
            >
              查看全部 {rows.length} 个服务
              <ArrowRight />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {attention ? `${attention} 个服务需要处理，已优先展示` : '查看当前环境的全部服务'}
          </TooltipContent>
        </Tooltip>
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
