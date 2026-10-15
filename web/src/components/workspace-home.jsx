import { useState } from 'react'
import { ArrowUpRight, Plus, GitCommitHorizontal, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Progress } from '@/components/ui/progress'
import { Empty, Action } from './shared'
import { useConsole, copy, duration, stageLabel, routeUrl } from '@/lib/console'

export function Commit({ value }) {
  const { notify } = useConsole()
  return value ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Action
          variant="ghost"
          className="commit-button"
          aria-label={`复制 commit ${value}`}
          onClick={async () => {
            await copy(value)
            notify('Commit 已复制')
          }}
        >
          <GitCommitHorizontal className="size-3.5 shrink-0" />
          <code className="commit-sha">{value}</code>
        </Action>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 break-all">{value} · 点击复制</TooltipContent>
    </Tooltip>
  ) : (
    <span className="text-xs text-muted-foreground">尚未发布</span>
  )
}
export function HostResources({ server }) {
  const metrics = server?.metrics || {},
    memory = metrics.memory || {},
    disk = metrics.disk || {}
  const ratio = (used, total) =>
    Number.isFinite(used) && Number.isFinite(total) && total > 0 ? (used / total) * 100 : null
  const values = [
    ['CPU', metrics.cpuPercent ?? metrics.cpu?.percent],
    ['内存', ratio(memory.used ?? metrics.memoryUsed, memory.total ?? metrics.memoryTotal)],
    ['磁盘', ratio(disk.used, disk.total)],
  ]
  const online = server?.online && !server?.revoked
  return (
    <div className="space-y-2" aria-label="整台服务器资源">
      <div className="grid grid-cols-3 gap-3">
        {values.map(([label, value]) => {
          const known = online && Number.isFinite(value)
          return (
            <div key={label} className="space-y-2">
              <div className="flex justify-between gap-1 text-xs text-muted-foreground">
                <span>{label}</span>
                <span className="tabular-nums">{known ? `${Math.round(value)}%` : '—'}</span>
              </div>
              <Progress
                value={known ? Math.min(100, Math.max(0, value)) : 0}
                aria-label={`${label}（整机）`}
                className="h-1"
              />
            </div>
          )
        })}
      </div>
      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span>整机资源</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex items-center gap-1.5">
              <span className={`status-dot ${online ? 'good' : ''}`} />
              {server ? (online ? '在线' : server.revoked ? '已撤销' : '离线') : '未绑定服务器'}
              <span>
                {online && Number.isFinite(metrics.centerRttMs)
                  ? `${Math.round(metrics.centerRttMs)} ms`
                  : '延迟 —'}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Agent 与中心的最近一次心跳往返耗时。未上报时显示 —。</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
export function ServiceState({ targets, servers }) {
  const states = targets.map((target) => {
    const server = servers.find((s) => s.id === target.serverId)
    const state = target.observation?.state || target.observation?.status
    const health = target.observation?.health || target.observation?.healthStatus
    return !server?.online || server.revoked
      ? '失联待确认'
      : health === 'unhealthy'
        ? '健康异常'
        : ['running', 'published'].includes(state)
          ? health === 'healthy'
            ? '运行中 · 健康'
            : '运行中 · 健康未确认'
          : ['exited', 'unpublished', 'missing'].includes(state)
            ? '未运行'
            : '状态待上报'
  })
  const label = states.length ? [...new Set(states)].join(' / ') : '尚未配置部署目标'
  const good = states.length > 0 && states.every((s) => s === '运行中 · 健康')
  const bad = states.some((s) => s === '健康异常')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={label}
          className={`status-dot ${good ? 'good' : bad ? 'bad' : ''}`}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
export function ProjectTile({ project }) {
  const { enter } = useConsole()
  const db = project.dashboard,
    storageKey = `cmr:environment:${project.id}`
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
  const go = (view, extra = {}) => {
    location.hash = routeUrl(view, project.id, environment?.id, null, extra)
  }
  return (
    <Card className="project-tile workspace-card" data-workspace-id={project.id}>
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="min-w-0">
            <Button
              variant="link"
              className="h-auto max-w-full p-0 text-base font-semibold"
              onClick={() => enter(project.id)}
            >
              <span className="truncate">{project.name}</span>
            </Button>
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`进入 ${project.name}`}
            onClick={() => enter(project.id)}
          >
            <ArrowUpRight className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="tile-body">
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
          <TabsList className="max-w-full overflow-x-auto overflow-y-hidden">
            {db.environments.map((env) => (
              <TabsTrigger key={env.id} value={env.id}>
                {env.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="tile-hosts space-y-3">
          <NativeSelect
            aria-label={`${project.name}的服务器`}
            value={server?.id || ''}
            onChange={(e) => setServerId(e.target.value)}
            disabled={!servers.length}
          >
            {!servers.length && <NativeSelectOption value="">未绑定服务器</NativeSelectOption>}
            {servers.map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.name} · {s.online ? '在线' : '离线'}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <HostResources server={server} />
        </div>
        <div
          className="tile-services"
          aria-label={`${project.name} ${environment?.name || ''}服务列表`}
          tabIndex={0}
          key={environment?.id}
        >
          {!db.services.length && (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              暂无服务
            </div>
          )}
          {db.services.map((service) => {
            const source = db.environmentSources.find(
              (s) => s.environmentId === environment?.id && s.serviceId === service.id,
            )
            const repository = db.repositories.find((r) => r.id === source?.sourceProjectId)
            const targets = db.targets.filter(
              (t) => t.environmentId === environment?.id && t.serviceId === service.id,
            )
            const target = targets.find((t) => t.serverId === server?.id) || targets[0]
            const active = db.tasks.find((t) => targets.some((v) => v.id === t.targetId))
            return (
              <div className="tile-service" key={service.id} data-home-service={service.id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium">{service.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <ServiceState targets={targets} servers={servers} />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        active
                          ? (location.hash = routeUrl(
                              'tasks',
                              project.id,
                              environment?.id,
                              active.id,
                            ))
                          : target
                            ? go('release', { targetId: target.id })
                            : go('applications')
                      }
                    >
                      {active ? '查看进度' : target ? '更新' : '配置'}
                    </Button>
                  </span>
                </div>
                <div className="service-meta">
                  <span
                    className="truncate"
                    title={`${repository?.name || '未关联仓库'} / ${source?.branch || '—'}`}
                  >
                    {repository?.name || '未关联仓库'} / {source?.branch || '—'}
                  </span>
                  <Commit
                    value={target?.currentRelease?.revision || target?.observation?.revision}
                  />
                </div>
                {active && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-full justify-between px-0 text-xs"
                    onClick={() => {
                      location.hash = routeUrl('tasks', project.id, environment?.id, active.id)
                    }}
                  >
                    <span className="inline-flex items-center gap-1">
                      <LoaderCircle className="size-3 animate-spin" />
                      {stageLabel(active.stage)}
                    </span>
                    <span>{duration(active)}</span>
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
      <CardFooter className="tile-footer">
        <Button variant="ghost" size="sm" onClick={() => go('applications', { editor: 'service' })}>
          <Plus />
          新增服务
        </Button>
        <Button variant="ghost" size="sm" onClick={() => enter(project.id)}>
          进入项目 <ArrowUpRight />
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
