import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Settings2,
  Server,
  Circle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Empty, Notice, Status, TargetStatus } from './shared'
import { DataTable } from './data-table'
import { Commit } from './workspace-home'
import { ServiceForm, SourceForm } from './dialogs'
import { TargetForm } from './target-form'
import { ConfigurationPage } from './release-workbench'
import { ConsoleContext, useConsole, routeUrl, finished, date, stageLabel } from '@/lib/console'
import { navigateSafely } from '@/lib/navigation-guard'
import { targetVersion } from '@/lib/home-summary'

export function TargetActions({ target, service }) {
  const { data, open, scope, environmentId, navigate } = useConsole()
  const server = data.servers.find((s) => s.id === target.serverId)
  const active = data.tasks.find((t) => t.targetId === target.id && !finished(t))
  const source = data.environmentSources.find(
    (s) => s.serviceId === target.serviceId && s.environmentId === target.environmentId,
  )
  const repository = data.repositories.find((r) => r.id === source?.sourceProjectId)
  const reason = active
    ? '当前部署任务尚未结束'
    : !server?.online || server?.revoked
      ? '服务器未在线'
      : target.mode !== 'managed'
        ? '部署目标不可操作'
        : ''
  const publishReason = reason || (!repository?.enabled ? '请先配置并启用源码仓库' : '')
  return (
    <div
      className="card-actions flex shrink-0 items-center justify-end gap-1"
      data-target-actions={target.id}
    >
      {active ? (
        <Button variant="outline" size="sm" onClick={() => navigate('tasks', active.id)}>
          查看进度
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={publishReason ? 0 : undefined}>
              <Button
                variant="outline"
                size="sm"
                disabled={!!publishReason}
                onClick={() => open('release', { target, action: 'deploy' })}
              >
                发布
              </Button>
            </span>
          </TooltipTrigger>
          {publishReason && <TooltipContent>{publishReason}</TooltipContent>}
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`${service.name} · 更多操作`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {(service.kind || 'java') === 'java' && (
            <DropdownMenuItem
              disabled={!!reason || !target.currentRelease}
              onSelect={() => open('release', { target, action: 'restart' })}
            >
              重启服务
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={!!reason || !target.currentRelease}
            onSelect={() => open('release', { target, action: 'rollback' })}
          >
            回退版本
          </DropdownMenuItem>
          {(reason || !target.currentRelease) && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {reason || '尚无成功版本，暂不可重启或回退'}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function ServiceList({ compact = false, serverId }) {
  const { data, environmentId, scope, open, navigate } = useConsole()
  const [expanded, setExpanded] = useState({})
  const rows = data.services
    .map((service) => {
      const source = data.environmentSources.find(
        (s) => s.serviceId === service.id && s.environmentId === environmentId,
      )
      const repository = data.repositories.find((r) => r.id === source?.sourceProjectId)
      const targets = data.targets.filter(
        (t) =>
          t.serviceId === service.id &&
          t.environmentId === environmentId &&
          (!serverId || t.serverId === serverId),
      )
      const active = data.tasks.find(
        (t) => targets.some((v) => v.id === t.targetId) && !finished(t),
      )
      const ready = !!(source && targets.length)
      const unhealthy = targets.some((t) => {
        const server = data.servers.find((s) => s.id === t.serverId)
        return (
          !server?.online ||
          server.revoked ||
          t.observation?.health === 'unhealthy' ||
          ['exited', 'stopped', 'missing', 'unpublished'].includes(
            t.observation?.state || t.observation?.status,
          )
        )
      })
      return {
        ...service,
        source,
        repository,
        targets,
        branches: [...new Set(targets.map((t) => targetVersion(t).branch || '分支待识别'))].join(
          '、',
        ),
        active,
        ready,
        filter: !ready ? 'pending' : active ? 'active' : unhealthy ? 'attention' : 'configured',
      }
    })
    .filter((service) => !serverId || service.targets.length)
  const go = (service, tab) => {
    location.hash = routeUrl('service', scope, environmentId, null, { serviceId: service.id, tab })
  }
  const name = (service) => (
    <div className="min-w-0">
      <Button
        variant="link"
        className="h-auto max-w-full justify-start p-0 text-left font-medium"
        onClick={() => go(service)}
      >
        <span className="break-words whitespace-normal">{service.name}</span>
      </Button>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {service.kind === 'static' ? '静态站点' : 'Java'} · {service.module}
      </p>
    </div>
  )
  const source = (service) => (
    <div className="min-w-0">
      <p className="truncate" title={service.repository?.name}>
        {service.repository?.name || '未关联仓库'}
      </p>
      <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={service.branches}>
        {service.branches || '待配置'}
      </p>
    </div>
  )
  const placement = (service) =>
    service.targets.length > 1 ? (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2"
        aria-expanded={!!expanded[service.id]}
        onClick={() => setExpanded((v) => ({ ...v, [service.id]: !v[service.id] }))}
      >
        {expanded[service.id] ? <ChevronDown /> : <ChevronRight />}
        {service.targets.length} 个部署位置
      </Button>
    ) : service.targets.length ? (
      <div>
        <p className="break-words">
          {data.servers.find((s) => s.id === service.targets[0].serverId)?.name || '服务器不存在'}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {data.servers.find((s) => s.id === service.targets[0].serverId)?.online
            ? '在线'
            : '未在线'}
        </p>
      </div>
    ) : (
      <span className="text-muted-foreground">尚未配置</span>
    )
  const status = (service) => (
    <div className="space-y-1.5">
      {!service.ready ? (
        <Badge variant="secondary">待配置</Badge>
      ) : service.targets.length === 1 ? (
        <TargetStatus
          target={service.targets[0]}
          server={data.servers.find((s) => s.id === service.targets[0].serverId)}
        />
      ) : (
        <Badge variant="outline">
          {service.filter === 'attention' ? '部分位置需要关注' : '展开查看各位置状态'}
        </Badge>
      )}
      {service.active && (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => navigate('tasks', service.active.id)}
        >
          {stageLabel(service.active.stage)} · 查看进度
        </Button>
      )}
    </div>
  )
  const actions = (service) =>
    service.ready && service.targets.length === 1 ? (
      <TargetActions target={service.targets[0]} service={service} />
    ) : (
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          service.ready
            ? setExpanded((v) => ({ ...v, [service.id]: !v[service.id] }))
            : open('setup', service)
        }
      >
        {service.ready ? '选择部署位置' : '继续配置'}
      </Button>
    )
  const details = (service) =>
    expanded[service.id] && service.targets.length > 1 ? (
      <div className="space-y-3">
        {service.targets.map((target) => (
          <div
            key={target.id}
            data-target-id={target.id}
            className="target-card grid gap-3 rounded-md border bg-background p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] lg:items-center"
          >
            <span className="break-words text-sm">
              {data.servers.find((s) => s.id === target.serverId)?.name}
            </span>
            <TargetStatus
              target={target}
              server={data.servers.find((s) => s.id === target.serverId)}
            />
            <Badge variant="outline">{targetVersion(target).branch || '分支待识别'}</Badge>
            <Commit
              value={targetVersion(target).revision}
              subject={targetVersion(target).subject}
              summary
            />
            <TargetActions target={target} service={service} />
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            location.hash = routeUrl('setup', scope, environmentId, null, {
              serviceId: service.id,
              step: '3',
            })
          }}
        >
          <Plus />
          新增部署位置
        </Button>
      </div>
    ) : null
  const columns = [
    {
      accessorKey: 'name',
      header: '服务',
      sortingFn: 'text',
      meta: { className: 'w-[17%] min-w-32' },
      cell: ({ row }) => name(row.original),
    },
    {
      id: 'source',
      header: '仓库 / 分支',
      meta: { className: 'w-[16%] max-w-48' },
      cell: ({ row }) => source(row.original),
    },
    {
      id: 'server',
      header: '部署服务器',
      meta: { className: 'w-[20%]' },
      cell: ({ row }) => placement(row.original),
    },
    {
      id: 'status',
      header: '运行 / 健康',
      meta: { className: 'w-[18%]' },
      cell: ({ row }) => status(row.original),
    },
    {
      id: 'revision',
      header: '当前版本',
      cell: ({ row }) =>
        row.original.targets.length > 1 ? (
          <span className="text-xs text-muted-foreground">按部署位置查看</span>
        ) : (
          <Commit
            value={targetVersion(row.original.targets[0] || {}).revision}
            subject={targetVersion(row.original.targets[0] || {}).subject}
            summary
          />
        ),
    },
    {
      id: 'actions',
      header: '操作',
      meta: { className: 'w-32 text-right' },
      cell: ({ row }) => actions(row.original),
    },
  ]
  if (!rows.length)
    return (
      <Empty
        title="添加第一个服务"
        description="按步骤配置模块、当前环境源码和部署位置，保存后再发起发布。"
        label="新增服务"
        action={() => open('service')}
      />
    )
  return (
    <div className="space-y-4">
      {compact && (
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">当前环境的服务</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate('services')}>
            管理服务 <ArrowRight />
          </Button>
        </div>
      )}
      <DataTable
        data={rows}
        columns={columns}
        searchText={(r) => `${r.name} ${r.module} ${r.repository?.name || ''} ${r.branches}`}
        searchPlaceholder="搜索服务、仓库或分支…"
        filters={[
          { value: 'pending', label: '待配置' },
          { value: 'active', label: '发布中' },
          { value: 'attention', label: '需要关注' },
          { value: 'configured', label: '已配置' },
        ]}
        filterValue={(r) => r.filter}
        rowProps={(r) => ({
          'data-service-id': r.id,
          ...(r.targets.length === 1 ? { 'data-target-id': r.targets[0].id } : {}),
        })}
        renderExpanded={details}
        renderMobile={(r) => (
          <>
            <div className="flex items-start justify-between gap-3">
              {name(r)}
              {actions(r)}
            </div>
            {source(r)}
            {placement(r)}
            {status(r)}
            {r.targets.length === 1 && (
              <Commit
                value={targetVersion(r.targets[0]).revision}
                subject={targetVersion(r.targets[0]).subject}
                summary
              />
            )}
          </>
        )}
      />
    </div>
  )
}

export function OnboardingChecklist() {
  const { data, environmentId, targets, open, navigate } = useConsole()
  const configured = data.services.some(
    (service) =>
      data.environmentSources.some(
        (s) => s.serviceId === service.id && s.environmentId === environmentId,
      ) && targets.some((t) => t.serviceId === service.id),
  )
  const deployed = targets.some((t) => !!t.currentRelease)
  const steps = [
    ['创建项目', !!data.project, () => open('workspace', data.project)],
    [
      '连接代码仓库',
      data.repositories.some((r) => r.enabled && ['ready', 'empty'].includes(r.connectionStatus)),
      () => navigate('projects'),
    ],
    ['确认环境', !!data.environments.length, () => navigate('environments')],
    [
      '接入或绑定服务器',
      data.servers.some((s) => s.registeredAt && !s.revoked),
      () => navigate('servers'),
    ],
    ['配置服务', configured, () => navigate('services')],
    ['首次发布', deployed, () => navigate('services')],
  ]
  const count = steps.filter((s) => s[1]).length
  const next = steps.find((s) => !s[1])
  if (!next) return null
  return (
    <Card className="py-4" data-onboarding>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-0">
        <div>
          <CardTitle>项目接入</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            当前环境 · 已完成 {count} / {steps.length} 项；已保存配置可以随时继续。
          </p>
        </div>
        {next && (
          <Button size="sm" onClick={next[2]}>
            继续接入 <ArrowRight />
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress aria-label="接入进度" value={(count / steps.length) * 100} className="h-1.5" />
        <ol className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {steps.map(([label, complete, action], i) => (
            <li key={label}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start gap-2 px-2 py-2 text-xs font-normal"
                onClick={action}
              >
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-full ${complete ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground'}`}
                >
                  {complete ? <Check className="size-3.5" /> : i + 1}
                </span>
                {label}
                <span className="sr-only">{complete ? '已完成' : '待完成'}</span>
              </Button>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}

export function Environments() {
  const { data, open, confirm, request, endpoint, refresh, notify } = useConsole()
  const actions = (env) => (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => open('environment', env)}>
        编辑
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() =>
          confirm(
            '删除环境',
            `删除「${env.name}」及其源码关联配置；项目服务和代码仓库会保留。有部署位置或发布历史的环境不能删除。`,
            async () => {
              await request(`${endpoint}/environments/${env.id}`, {}, 'DELETE')
              await refresh()
              notify('环境已删除')
            },
          )
        }
      >
        删除
      </Button>
    </div>
  )
  return (
    <DataTable
      data={data.environments}
      rowProps={(env) => ({ 'data-environment-id': env.id })}
      columns={[
        {
          accessorKey: 'name',
          header: '环境名称',
          sortingFn: 'text',
          cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
        },
        {
          id: 'sources',
          header: '已关联服务',
          cell: ({ row }) =>
            data.environmentSources.filter((s) => s.environmentId === row.id).length,
        },
        {
          id: 'targets',
          header: '部署位置',
          cell: ({ row }) => data.targets.filter((t) => t.environmentId === row.id).length,
        },
        {
          id: 'actions',
          header: '操作',
          meta: { className: 'w-40 text-left' },
          cell: ({ row }) => actions(row.original),
        },
      ]}
      searchText={(r) => r.name}
      searchPlaceholder="搜索环境…"
      emptyTitle="尚未创建环境"
      renderMobile={(env) => (
        <div className="space-y-3">
          <p className="break-words font-medium">{env.name}</p>
          <p className="text-sm text-muted-foreground">
            已关联 {data.environmentSources.filter((s) => s.environmentId === env.id).length} 个服务
            · {data.targets.filter((t) => t.environmentId === env.id).length} 个部署位置
          </p>
          {actions(env)}
        </div>
      )}
    />
  )
}

export function ServiceSetup() {
  const context = useConsole()
  const { data, route, scope, environmentId, endpoint, request, refresh } = context
  const service = data.services.find((s) => s.id === route.serviceId)
  const source = data.environmentSources.find(
    (s) => s.serviceId === service?.id && s.environmentId === environmentId,
  )
  const step = service
    ? Math.max(1, Math.min(source ? 3 : 2, Number(route.step) || (source ? 3 : 2)))
    : 1
  const go = (next, id = service?.id) =>
    navigateSafely(() => {
      location.hash = routeUrl('setup', scope, environmentId, null, {
        serviceId: id,
        step: String(next),
      })
    })
  const close = () => {
    location.hash = routeUrl('services', scope, environmentId)
  }
  const targets = data.targets.filter(
    (t) => t.serviceId === service?.id && t.environmentId === environmentId,
  )
  return (
    <div className="space-y-5" data-service-setup>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="page-title" className="text-xl font-semibold">
          {service ? `配置 ${service.name}` : '新增服务'}
        </h1>
        <Button variant="ghost" onClick={() => navigateSafely(close)}>
          稍后继续
        </Button>
      </div>
      <ol className="grid grid-cols-3 gap-2">
        {['服务信息', '当前环境源码', '部署配置'].map((label, i) => (
          <li key={label}>
            <Button
              variant={step === i + 1 ? 'secondary' : 'ghost'}
              className="h-auto w-full justify-start gap-2 px-2 py-3 text-xs sm:text-sm"
              disabled={(i > 0 && !service) || (i === 2 && !source)}
              onClick={() => go(i + 1)}
            >
              <span className="grid size-5 shrink-0 place-items-center rounded-full border">
                {(i === 0 && service) || (i === 1 && source) || (i === 2 && targets.length) ? (
                  <Check className="size-3" />
                ) : (
                  i + 1
                )}
              </span>
              {label}
            </Button>
          </li>
        ))}
      </ol>
      {service && (
        <p className="text-xs text-muted-foreground">
          服务信息已保存{source ? ' · 当前环境源码已保存' : ''}
          {targets.length ? ` · 已有 ${targets.length} 个部署位置` : ''}
          。每个步骤单独保存，保存配置不会自动发布。
        </p>
      )}
      <ConsoleContext.Provider value={{ ...context, formLayout: 'embedded' }}>
        {step === 1 && (
          <ServiceForm
            key={service?.id || 'new'}
            item={service}
            step
            onClose={close}
            onSave={async (input) => {
              const saved = await request(
                `${endpoint}/services${service ? `/${service.id}` : ''}`,
                input,
                service ? 'PUT' : 'POST',
              )
              await refresh()
              go(2, saved.id)
            }}
          />
        )}
        {step === 2 &&
          service &&
          (!data.repositories.length ? (
            <Empty
              title="请先连接代码仓库"
              label="配置代码仓库"
              action={() => context.navigate('projects')}
            />
          ) : (
            <SourceForm
              key={`${service.id}:${environmentId}`}
              item={service}
              onClose={close}
              onSaved={() => go(3)}
            />
          ))}
        {step === 3 &&
          service &&
          (!data.servers.some((s) => !s.revoked) ? (
            <Empty
              title="请先接入或绑定服务器"
              label="配置项目服务器"
              action={() => context.navigate('servers')}
            />
          ) : (
            <TargetForm
              key={`${service.id}:${environmentId}`}
              service={service}
              onClose={close}
              onSaved={(target) => {
                location.hash = routeUrl('service', scope, environmentId, null, {
                  serviceId: service.id,
                  targetId: target.id,
                  tab: 'config',
                })
              }}
            />
          ))}
      </ConsoleContext.Provider>
    </div>
  )
}

export function ServiceDetail() {
  const { data, route, environmentId, open } = useConsole()
  const requested = data.targets.find((t) => t.id === route.targetId)
  const service = data.services.find((s) => s.id === (route.serviceId || requested?.serviceId))
  if (!service) return <Empty title="服务不存在" description="请返回服务列表选择服务。" />
  if (route.targetId && (!requested || requested.serviceId !== service.id))
    return <Empty title="部署位置不存在" description="请返回服务列表重新选择部署位置。" />
  const target =
    requested?.serviceId === service.id && requested?.environmentId === environmentId
      ? requested
      : data.targets.find((t) => t.serviceId === service.id && t.environmentId === environmentId)
  if (!target)
    return (
      <div className="space-y-4">
        <h1 id="page-title" className="text-xl font-semibold">
          {service.name}
        </h1>
        <Empty
          title="当前环境尚未配置部署位置"
          description="已保存的服务信息可复用，继续关联当前环境的仓库并配置部署位置。"
          label="继续配置"
          action={() => open('setup', service)}
        />
      </div>
    )
  return <ConfigurationPage key={target.id} selectedTarget={target} />
}
