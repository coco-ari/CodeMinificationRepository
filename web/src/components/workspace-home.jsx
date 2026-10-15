import { Fragment, useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, Plus, GitCommitHorizontal, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
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
export function HostResources({ server, showConnection = true, showTimestamp = false }) {
  const online = server?.online && !server?.revoked
  return (
    <div className="space-y-3" aria-label="整台服务器资源">
      <div className="grid grid-cols-3 gap-3">
        {hostMetrics(server).map(({ label, value, known, level, message, remaining }) => (
          <div key={label} className="min-w-0 space-y-1.5" data-resource={label} data-level={level}>
            <div className="flex justify-between gap-1 text-xs">
              <span className="text-muted-foreground">{label}</span>
              <span className="tabular-nums">{known ? `${Math.round(value)}%` : '—'}</span>
            </div>
            <Progress
              value={known ? Math.min(100, Math.max(0, value)) : null}
              aria-label={`${label}（整机）`}
              aria-valuetext={
                known ? `${Math.round(value)}%${message ? `，${message}` : ''}` : '暂无有效数据'
              }
              className={`h-1.5 ${!known ? '[&_[data-slot=progress-indicator]]:invisible' : level === 'critical' ? '[&_[data-slot=progress-indicator]]:bg-destructive' : level === 'warning' ? '[&_[data-slot=progress-indicator]]:bg-amber-500' : ''}`}
            />
            {message && (
              <p
                className={`text-xs ${level === 'critical' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`}
              >
                {message}
              </p>
            )}
            {label === '磁盘' && known && remaining != null && (
              <p className="text-xs text-muted-foreground">剩余 {size(remaining)}</p>
            )}
          </div>
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
export function ServiceState({ targets, servers }) {
  const health = serviceHealth(targets, servers)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={health.description}>
          <Status value={health.value}>{health.label}</Status>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">{health.description}</TooltipContent>
    </Tooltip>
  )
}

function ServiceVersion({ row, onDetails }) {
  const { version } = row
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      data-service-version
    >
      {version.kind === 'mixed' ? (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onDetails}>
          {version.label}
          <ArrowRight />
        </Button>
      ) : (
        <>
          <span
            className={`min-w-0 break-all ${version.kind === 'drift' ? 'text-destructive' : ''}`}
          >
            {version.kind === 'released' ? `已发布 · ${version.label}` : version.label}
          </span>
          {version.revision && <Commit value={version.revision} subject={version.subject} />}
        </>
      )}
    </div>
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
  const active = rows.filter((row) => row.activeTasks.length).length
  const healthy = rows.filter((row) => row.health.value === 'healthy').length
  const pending = rows.filter((row) => row.health.value === 'disabled').length
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
        <div className="space-y-2" aria-label="当前环境服务汇总">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>当前环境 · 全部部署位置</span>
            {rows.length > 3 && <span>优先显示待处理与发布中服务</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{rows.length} 个服务</Badge>
            {attention > 0 && <Status value="unhealthy">{attention} 个待处理</Status>}
            {active > 0 && <Status value="running">{active} 个发布中</Status>}
            {healthy > 0 && <Status value="healthy">{healthy} 个健康</Status>}
            {pending > 0 && <Badge variant="outline">{pending} 个待配置 / 确认</Badge>}
          </div>
        </div>
        <div
          className="tile-services"
          aria-label={`${project.name} ${environment?.name || ''}服务列表`}
          key={environment?.id}
        >
          {!rows.length && (
            <Empty title="暂无服务" description="添加服务后即可配置当前环境的部署位置。" />
          )}
          {rows.slice(0, 3).map((row, index) => {
            const target = row.targets.length === 1 ? row.targets[0] : null
            const task = row.activeTasks.length === 1 ? row.activeTasks[0] : null
            const details = () => go('service', { serviceId: row.id })
            const targetServer = target && db.servers.find((s) => s.id === target.serverId)
            const publishReason = !target
              ? ''
              : !targetServer?.online || targetServer.revoked
                ? '服务器未在线'
                : !row.repository?.enabled
                  ? '请先配置并启用源码仓库'
                  : ''
            const lastFailed = !!row.failedTask
            return (
              <Fragment key={row.id}>
                {index > 0 && <Separator />}
                <div className="tile-service space-y-2" data-home-service={row.id}>
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                    <Button
                      variant="link"
                      className="h-auto min-w-0 max-w-full justify-start p-0 text-sm font-medium"
                      onClick={details}
                      title={row.name}
                    >
                      <span className="truncate">{row.name}</span>
                    </Button>
                    <ServiceState targets={row.targets} servers={db.servers} />
                  </div>
                  <ServiceVersion row={row} onDetails={details} />
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                      <p>
                        {row.targets.length
                          ? `${row.targets.length} 个部署位置`
                          : '尚未配置部署位置'}
                      </p>
                      {row.lastDeployedAt && (
                        <p className="mt-1">最近发布：{date(row.lastDeployedAt)}</p>
                      )}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={!row.activeTasks.length && publishReason ? 0 : undefined}>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!row.activeTasks.length && !!publishReason}
                            aria-label={`${row.name} · ${row.activeTasks.length ? '查看进度' : target ? '发布' : row.targets.length ? '选择目标发布' : '配置'}`}
                            onClick={() => {
                              if (task)
                                location.hash = routeUrl(
                                  'tasks',
                                  project.id,
                                  environment?.id,
                                  task.id,
                                )
                              else if (row.activeTasks.length)
                                go('service', { serviceId: row.id, tab: 'history' })
                              else if (target) go('release', { targetId: target.id })
                              else if (row.targets.length) details()
                              else go('setup', { serviceId: row.id })
                            }}
                          >
                            {row.activeTasks.length
                              ? '查看进度'
                              : target
                                ? '发布'
                                : row.targets.length
                                  ? '选择目标…'
                                  : '配置'}
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {publishReason && !row.activeTasks.length && (
                        <TooltipContent>{publishReason}</TooltipContent>
                      )}
                    </Tooltip>
                  </div>
                  {row.activeTasks.length > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto w-full justify-between gap-2 p-0 text-xs"
                      onClick={() =>
                        task
                          ? (location.hash = routeUrl(
                              'tasks',
                              project.id,
                              environment?.id,
                              task.id,
                            ))
                          : go('service', { serviceId: row.id, tab: 'history' })
                      }
                    >
                      <span className="inline-flex items-center gap-1">
                        <LoaderCircle className="size-3 animate-spin" />
                        {task ? stageLabel(task.stage) : `${row.activeTasks.length} 个任务进行中`}
                      </span>
                      {task && <span>{duration(task)}</span>}
                    </Button>
                  ) : (
                    lastFailed && (
                      <Button
                        variant="link"
                        className="h-auto max-w-full whitespace-normal p-0 text-left text-xs text-destructive"
                        onClick={() => {
                          location.hash = routeUrl(
                            'tasks',
                            project.id,
                            environment?.id,
                            row.failedTask.id,
                          )
                        }}
                      >
                        {row.targets.length > 1 ? '部分位置最近任务' : '最近任务'}：
                        {statusNames[row.failedTask.status]}
                        <ArrowRight />
                      </Button>
                    )
                  )}
                </div>
              </Fragment>
            )
          })}
        </div>
        <Card className="gap-0 rounded-lg bg-muted/30 py-3 shadow-none">
          <CardContent className="space-y-3 px-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={servers.length > 1 ? hostId : undefined}>服务器资源</Label>
              <span className="text-xs text-muted-foreground">项目共享 · 整机指标</span>
            </div>
            {servers.length > 1 ? (
              <Selection
                id={hostId}
                aria-label={`${project.name}的资源服务器`}
                value={server?.id || ''}
                onChange={(e) => setServerId(e.target.value)}
              >
                {servers.map((s) => (
                  <SelectionOption key={s.id} value={s.id}>
                    {s.name}
                  </SelectionOption>
                ))}
              </Selection>
            ) : (
              <p className="break-words text-sm">{server?.name || '未绑定服务器'}</p>
            )}
            <HostResources server={server} showTimestamp />
          </CardContent>
        </Card>
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
        <Button variant="ghost" size="sm" onClick={() => go('services')}>
          查看全部 {rows.length} 个服务
          <ArrowRight />
        </Button>
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
