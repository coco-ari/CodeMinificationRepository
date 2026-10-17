import { ScrollArea } from '@/components/ui/scroll-area'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  Copy,
  AlertCircle,
  ArrowRight,
  Check,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  RotateCw,
  Server,
  Package,
  Cloud,
  LoaderCircle,
  FileCode2,
  Clock3,
  MoreHorizontal,
  Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchField } from './search-field'
import { ReleaseInfo, ReleaseBuildDetails } from './release-info'
import { navigateSafely } from '@/lib/navigation-guard'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Choice, Selection, SelectionOption } from '@/components/selection'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { Action, Detail, Empty, Notice, Status, TargetStatus } from './shared'
import { Commit } from './workspace-home'
import {
  useConsole,
  routeUrl,
  date,
  short,
  revisionOf,
  resultName,
  duration,
  finished,
  stageLabel,
  actionNames,
  copy,
} from '@/lib/console'

export function Configuration({ target }) {
  if (!target) return <Empty title="部署目标不存在" />
  const config = target.config || {},
    isStatic = config.kind === 'static'
  const groups = [
    [
      '构建配置',
      [
        ['构建镜像', config.buildImage],
        [isStatic ? '前端项目目录' : 'Maven 模块目录', config.module || '.'],
        ['产物路径', config.artifactPath],
        ['构建资源', `${config.build?.cpus ?? '—'} CPU / ${config.build?.memoryMb ?? '—'} MB`],
        ...(isStatic
          ? [
              ['包管理器', config.packageManager],
              ['构建脚本', config.buildScript],
              ['构建参数', config.buildArgs?.join('\n')],
            ]
          : []),
      ],
    ],
    ...(isStatic
      ? [
          [
            '站点发布',
            [
              ['发布目录', `/opt/cmr-agent-static/${target.id}/current`],
              ['访问方式', '已有 Nginx 读取 current 目录'],
            ],
          ],
        ]
      : [
          [
            '运行配置',
            [
              ['运行镜像', config.runtimeImage],
              ['Spring Profile', config.profile],
              ['JVM 参数', config.jvmArgs?.join('\n')],
              ['应用参数', config.args?.join('\n')],
              [
                '运行资源',
                `${config.runtime?.cpus ?? '—'} CPU / ${config.runtime?.memoryMb ?? '—'} MB`,
              ],
            ],
          ],
          [
            '端口、网络与存储',
            [
              [
                '端口映射',
                config.ports?.map((p) => `${p.host}:${p.hostPort}:${p.containerPort}`).join('\n'),
              ],
              [
                'Docker 网络',
                [
                  ...new Set([
                    ...(config.networks || []),
                    ...(target.networkIdentity ? [target.networkIdentity.network] : []),
                  ]),
                ].join('\n') || '平台自动创建目标网络',
              ],
              ...(target.networkIdentity
                ? [
                    [
                      '部署位置固定别名',
                      `${target.networkIdentity.alias}（${target.networkIdentity.network}，发布与回退保留）`,
                    ],
                  ]
                : []),
              ['数据卷', config.volumes?.map((v) => `${v.name} → ${v.mountPath}`).join('\n')],
            ],
          ],
        ]),
    [
      '健康检查',
      [
        [isStatic ? '站点地址' : '检查路径', isStatic ? config.health?.url : config.health?.path],
        ...(!isStatic ? [['容器端口', config.health?.port]] : []),
        ['HTTP 状态码', config.health?.status],
        ['响应包含', config.health?.bodyIncludes],
        ['最长等待', `${config.health?.timeoutSeconds ?? '—'} 秒`],
        ['检查间隔', `${config.health?.intervalSeconds ?? '—'} 秒`],
      ],
    ],
  ]
  return (
    <div className="configuration-stack">
      {groups.map(([title, values]) => (
        <Card key={title} data-config-section={title}>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="configuration-details">
              {values.map(([label, value]) => {
                const code = ['JVM 参数', '应用参数', '构建参数', '端口映射', '数据卷'].includes(
                  label,
                )
                return (
                  <div key={label} className={code ? 'config-wide' : ''}>
                    <Detail label={label}>
                      <span className={code && value ? 'config-code' : 'config-value'}>
                        {value === 0 ? 0 : value || '未设置'}
                      </span>
                    </Detail>
                  </div>
                )
              })}
            </dl>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
export function ConfigurationPage({ selectedTarget }) {
  const { data, route, find, navigate, open, endpoint, request, scope, confirm } = useConsole(),
    target = selectedTarget || find('targets', route.targetId)
  const tab = ['config', 'runtime', 'history'].includes(route.tab) ? route.tab : 'runtime'
  const setTab = (value) =>
    navigateSafely(() => {
      location.hash = routeUrl('service', scope, target.environmentId, null, {
        targetId: target.id,
        serviceId: target.serviceId,
        tab: value,
      })
    })
  const [configTab, setConfigTab] = useState('next'),
    [releases, setReleases] = useState([]),
    [releaseNext, setReleaseNext] = useState(null),
    [error, setError] = useState('')
  const historyGeneration = useRef(0)
  useEffect(() => {
    let active = true
    historyGeneration.current++
    setReleases([])
    setReleaseNext(null)
    setError('')
    if (target)
      request(`${endpoint}/targets/${target.id}/releases`)
        .then((r) => {
          if (active) {
            setReleases(r.releases)
            setReleaseNext(r.nextOffset)
          }
        })
        .catch((e) => {
          if (active && e.name !== 'AbortError') setError(e.message)
        })
    return () => {
      active = false
    }
  }, [target?.id])
  if (!target) return <Empty title="部署目标不存在" />
  const service = find('services', target.serviceId),
    source = data.environmentSources.find(
      (s) => s.serviceId === target.serviceId && s.environmentId === target.environmentId,
    ),
    repo = find('repositories', source?.sourceProjectId)
  const tasks = data.tasks.filter((t) => t.targetId === target.id)
  const configuration =
    configTab === 'current'
      ? target.currentRelease?.config
      : { ...target.config, module: service.module === '.' ? '' : service.module }
  const server = find('servers', target.serverId)
  const activeTask = tasks.find((task) => !finished(task))
  const sourceConfig = configTab === 'current' ? target.currentRelease?.sourceSnapshot : null
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 id="page-title" className="text-xl font-semibold">
            {service?.name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {data.project.name} / {find('environments', target.environmentId)?.name}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={
              target.mode !== 'managed' || !server?.online || server?.revoked || !!activeTask
            }
            onClick={() => open('release', { target, action: 'deploy' })}
          >
            发布 <ArrowRight />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          onClick={() => {
            location.hash = routeUrl('setup', scope, target.environmentId, null, {
              serviceId: service.id,
              step: '3',
            })
          }}
        >
          新增部署位置
        </Button>
        <Selection
          aria-label="部署位置"
          value={target.id}
          onChange={(e) => {
            const t = find('targets', e.target.value)
            location.hash = routeUrl('configuration', scope, t.environmentId, null, {
              targetId: t.id,
              tab,
            })
          }}
        >
          {data.targets
            .filter((t) => t.serviceId === service.id && t.environmentId === target.environmentId)
            .map((t) => (
              <SelectionOption key={t.id} value={t.id}>
                {find('servers', t.serverId)?.name}
              </SelectionOption>
            ))}
        </Selection>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" className="section-tabs">
          <TabsTrigger value="runtime">运行状态</TabsTrigger>
          <TabsTrigger value="config">配置</TabsTrigger>
          <TabsTrigger value="history">发布记录</TabsTrigger>
        </TabsList>
      </Tabs>
      {error && <Notice error>{error}</Notice>}
      {tab === 'config' && (
        <>
          <Tabs value={configTab} onValueChange={setConfigTab}>
            <TabsList>
              <TabsTrigger value="next">下次发布配置</TabsTrigger>
              <TabsTrigger value="current" disabled={!target.currentRelease}>
                已部署配置
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {configTab === 'next' && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                服务名称、类型和模块目录对该服务的所有环境生效。
              </p>
              <Button variant="outline" onClick={() => open('service', service)}>
                编辑服务信息
              </Button>
            </div>
          )}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>源码与模块</CardTitle>
              <Button
                variant="outline"
                size="sm"
                disabled={configTab === 'current'}
                onClick={() => open('source', service)}
              >
                编辑关联
              </Button>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-5 sm:grid-cols-2">
                <Detail label="代码仓库">
                  {configTab === 'current'
                    ? sourceConfig?.name || '见对应发布记录'
                    : repo?.name || '未关联'}
                </Detail>
                <Detail label="Gitee 地址">
                  {configTab === 'current'
                    ? sourceConfig?.repository || '—'
                    : repo?.repository || '—'}
                </Detail>
                <Detail label="发布分支">
                  {configTab === 'current'
                    ? sourceConfig?.branch || '见对应发布记录'
                    : '每次发布时选择'}
                </Detail>
                <Detail label={service.kind === 'static' ? '前端项目目录' : 'Maven 模块目录'}>
                  {configTab === 'current' ? configuration?.module || '—' : service.module}
                </Detail>
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">
                仓库关联影响当前服务、当前环境；模块目录影响服务的所有环境。已执行任务保留原始快照。
              </p>
            </CardContent>
          </Card>
          <div className="flex justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {find('servers', target.serverId)?.name}
            </span>
            <Button
              variant="outline"
              disabled={configTab === 'current'}
              onClick={() => open('target', target)}
            >
              编辑部署配置
            </Button>
          </div>
          <Configuration target={{ ...target, config: configuration }} />
        </>
      )}
      {tab === 'runtime' && (
        <Card>
          <CardContent>
            <dl className="grid gap-5 sm:grid-cols-2">
              <Detail label="服务器连接">
                <Status value={server?.online && !server.revoked ? 'online' : 'disabled'}>
                  {server?.revoked ? '已撤销' : server?.online ? '在线' : '失联 · 状态待确认'}
                </Status>
              </Detail>
              <Detail label="运行与健康">
                <TargetStatus target={target} server={server} />
              </Detail>
              <Detail label="当前版本">
                <Commit
                  value={target.currentRelease?.revision}
                  subject={target.currentRelease?.commitSubject}
                  summary
                />
              </Detail>
              <Detail label="来源分支">
                {target.currentRelease?.sourceSnapshot?.branch || '历史未记录'}
              </Detail>
              <Detail label="镜像">
                {target.currentRelease?.image || target.observation?.image || '—'}
              </Detail>
              <Detail label="最近采集">{date(target.lastObservedAt)}</Detail>
            </dl>
          </CardContent>
        </Card>
      )}
      {tab === 'history' && (
        <Card>
          <CardContent>
            {releases.map((r) => (
              <div className="version-item flex-col sm:flex-row" key={r.id} data-release-id={r.id}>
                <div className="w-full min-w-0 flex-1">
                  <ReleaseInfo release={r} />
                  <ReleaseBuildDetails release={r} />
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 self-start">
                  {target.currentRelease?.id === r.id ? (
                    <Badge variant="secondary" className="h-6 self-center font-normal">
                      当前版本
                    </Badge>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          tabIndex={
                            !r.available || !server?.online || server?.revoked || activeTask
                              ? 0
                              : undefined
                          }
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              !r.available ||
                              !server?.online ||
                              server?.revoked ||
                              !!activeTask ||
                              target.mode !== 'managed'
                            }
                            onClick={() =>
                              open('release', { target, action: 'rollback', releaseId: r.id })
                            }
                          >
                            回退
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {!r.available
                          ? '此版本不可回退'
                          : !server?.online || server?.revoked
                            ? '服务器未在线'
                            : activeTask
                              ? '请等待当前任务完成'
                              : '选择此版本，核对配置后确认回退'}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {r.archiveStatus === 'available' ? (
                    <>
                      <Button variant="ghost" size="sm" asChild>
                        <a href={`${endpoint}/releases/${r.id}/source`}>下载源码</a>
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`版本 ${short(r.revision)} · 更多操作`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={r.archiveProtected}
                            onSelect={() =>
                              confirm(
                                '清理源码档案',
                                `清理 ${r.sourceSnapshot?.branch || '历史分支'} / ${short(r.revision)} 的源码后，此版本将不能通过中心重建。版本说明和操作记录仍保留；其他版本共享的源码包继续保留。`,
                                async () => {
                                  await request(`${endpoint}/releases/${r.id}/source`, {}, 'DELETE')
                                  const page = await request(
                                    `${endpoint}/targets/${target.id}/releases`,
                                  )
                                  setReleases(page.releases)
                                  setReleaseNext(page.nextOffset)
                                },
                                { destructive: true },
                              )
                            }
                          >
                            清理源码
                          </DropdownMenuItem>
                          {r.archiveProtected && (
                            <p className="max-w-52 px-2 py-1.5 text-xs text-muted-foreground">
                              当前版本、恢复基线或执行中任务引用的版本不能清理。
                            </p>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
            {!releases.length && <p className="text-sm text-muted-foreground">尚无成功版本</p>}
            {releaseNext != null && (
              <Action
                variant="outline"
                className="mt-4 mr-3"
                onClick={async () => {
                  const epoch = historyGeneration.current
                  const page = await request(
                    `${endpoint}/targets/${target.id}/releases?offset=${releaseNext}`,
                  )
                  if (historyGeneration.current === epoch) {
                    setReleases((old) => [...old, ...page.releases])
                    setReleaseNext(page.nextOffset)
                  }
                }}
              >
                加载更早版本
              </Action>
            )}
          </CardContent>
        </Card>
      )}
      {tab === 'history' && (
        <Card>
          <CardContent>
            {tasks.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b py-4"
              >
                <Status value={t.status}>{resultName(t)}</Status>
                <span className="min-w-0 break-all text-xs text-muted-foreground">
                  {t.sourceSnapshot?.branch ||
                    t.release?.sourceSnapshot?.branch ||
                    '历史分支未记录'}{' '}
                  / {short(revisionOf(t))}
                </span>
                <span className="text-xs text-muted-foreground">
                  {actionNames[t.action]} · {date(t.createdAt)} · {duration(t)}
                  {t.result?.recoveryMethod
                    ? ` · ${t.result.recoveryMethod === 'cache' ? '缓存恢复' : '源码重建'}`
                    : ''}
                </span>
                <Button
                  variant="ghost"
                  onClick={() => navigate('tasks', t.id, target.environmentId)}
                >
                  查看日志 <ArrowRight />
                </Button>
              </div>
            ))}
            {!tasks.length && <p className="text-sm text-muted-foreground">暂无发布记录</p>}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
export function ReleaseWorkbench() {
  const { data, route, find, request, endpoint, navigate, open, confirm } = useConsole()
  const target = find('targets', route.targetId),
    source = data.environmentSources.find(
      (s) => s.environmentId === target?.environmentId && s.serviceId === target?.serviceId,
    )
  const server = find('servers', target?.serverId),
    service = find('services', target?.serviceId)
  const [history, setHistory] = useState(null),
    [releases, setReleases] = useState([]),
    [releaseNext, setReleaseNext] = useState(null),
    [branchInfo, setBranchInfo] = useState(null),
    [branch, setBranch] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [choice, setChoice] = useState(''),
    [commitQuery, setCommitQuery] = useState(''),
    [releaseQuery, setReleaseQuery] = useState(''),
    [tab, setTab] = useState(route.action === 'rollback' ? 'releases' : 'commits'),
    [releaseId, setReleaseId] = useState(''),
    [showConfig, setShowConfig] = useState(false),
    [loading, setLoading] = useState(true)
  const live = useRef(true),
    locked = useRef(false),
    generation = useRef(0),
    submission = useRef(null)
  useEffect(() => setCommitQuery(''), [branch, target?.id])
  const visibleCommits = (history?.commits || []).filter((commit) =>
    [commit.revision, commit.subject, commit.author]
      .join(' ')
      .toLocaleLowerCase()
      .includes(commitQuery.trim().toLocaleLowerCase()),
  )
  const visibleReleases = releases.filter((release) =>
    [
      release.sourceSnapshot?.branch,
      release.revision,
      release.commitSubject,
      release.id,
      date(release.createdAt),
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(releaseQuery.trim().toLocaleLowerCase()),
  )
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const signature = JSON.stringify([
    source?.sourceProjectId,
    source?.branch,
    find('repositories', source?.sourceProjectId)?.repository,
    target?.config,
    service?.module,
  ])
  useEffect(() => {
    let active = true
    generation.current++
    locked.current = false
    setBusy(false)
    setLoading(true)
    setHistory(null)
    setChoice('')
    setBranch('')
    setBranchInfo(null)
    setReleaseNext(null)
    setReleaseId('')
    setReleaseQuery('')
    setTab(route.action === 'rollback' ? 'releases' : 'commits')
    setReleases([])
    setError('')
    if (!target) return
    Promise.allSettled([
      source?.sourceProjectId && !['rollback', 'restart'].includes(route.action)
        ? request(`${endpoint}/repositories/${source.sourceProjectId}/branches`)
        : Promise.resolve({ branches: [], defaultBranch: null }),
      request(`${endpoint}/targets/${target.id}/releases`),
      route.releaseId && route.action === 'rollback'
        ? request(`${endpoint}/targets/${target.id}/releases/${route.releaseId}`)
        : Promise.resolve(null),
    ]).then(([h, r, selected]) => {
      if (!active) return
      setLoading(false)
      if (h.status === 'fulfilled') {
        setBranchInfo(h.value)
        const running = target.currentRelease?.sourceSnapshot
        const preferred =
          running?.id === source?.sourceProjectId &&
          running.repository === find('repositories', source?.sourceProjectId)?.repository
            ? running.branch
            : source?.branch || h.value.defaultBranch || ''
        setBranch(preferred)
        if (
          preferred &&
          h.value.branches.some((item) => item.name === preferred) &&
          !['rollback', 'restart'].includes(route.action)
        )
          loadBranch(preferred)
        else if (preferred && route.action !== 'rollback' && route.action !== 'restart')
          setError(`原分支 ${preferred} 已不存在，请选择其他分支；历史版本仍可从发布记录恢复。`)
      } else if (
        h.reason.name !== 'AbortError' &&
        route.action !== 'rollback' &&
        route.action !== 'restart'
      )
        setError(`仓库分支：${h.reason.message}`)
      if (r.status === 'fulfilled') {
        const chosen = selected.status === 'fulfilled' ? selected.value?.release : null
        const items = r.value.releases
        setReleases(
          chosen && !items.some((item) => item.id === chosen.id) ? [...items, chosen] : items,
        )
        setReleaseNext(r.value.nextOffset)
        if (route.releaseId && route.action === 'rollback') {
          setReleaseId(chosen?.id || '')
          if (!chosen) setError('所选历史版本不存在或不属于当前部署位置，请返回发布记录重新选择。')
        } else {
          setReleaseId(
            items.find((v) => v.available && v.id !== target.currentRelease?.id)?.id || '',
          )
        }
      } else if (r.reason.name !== 'AbortError') setError(`版本记录：${r.reason.message}`)
    })
    return () => {
      active = false
    }
  }, [target?.id, signature, route.action, route.releaseId])
  if (!target)
    return (
      <Empty
        title="部署目标不存在"
        description="返回项目选择有效的服务和服务器。"
        action={() => navigate('deployments')}
        label="返回服务与部署"
      />
    )
  const activeTask = data.tasks.find((t) => t.targetId === target.id && !finished(t))
  const action = route.action === 'restart' ? 'restart' : tab === 'releases' ? 'rollback' : 'deploy'
  const selectedRelease = releases.find((r) => r.id === releaseId)
  const candidates = data.targets.filter(
    (t) => t.serviceId === target.serviceId && t.environmentId === target.environmentId,
  )
  const managed =
    target.mode === 'managed' && server?.mode === 'managed' && server?.online && !server?.revoked
  const restartReason =
    (service?.kind || target.config?.kind) === 'static'
      ? '静态站点无需重启'
      : !target.currentRelease
        ? '尚无成功发布版本，请先发布服务'
        : activeTask
          ? '此部署位置有任务正在执行，请等待任务结束'
          : !server?.online || server?.revoked
            ? '服务器离线或接入已撤销，暂不可重启'
            : !managed
              ? '此部署位置不可操作'
              : ''
  const selectedRevision =
    action === 'rollback'
      ? selectedRelease?.revision
      : action === 'restart'
        ? target.currentRelease?.revision
        : choice
  const releaseSource =
    action === 'rollback'
      ? selectedRelease?.sourceSnapshot ||
        data.tasks.find((t) => t.id === selectedRelease?.id)?.sourceSnapshot
      : action === 'restart'
        ? target.currentRelease?.sourceSnapshot
        : null
  const config =
    action === 'rollback'
      ? selectedRelease?.config || target.config
      : action === 'restart'
        ? target.currentRelease?.config || target.config
        : { ...target.config, module: service.module === '.' ? '' : service.module }
  async function loadBranch(nextBranch, preserve = false) {
    if (!nextBranch) return
    const previousChoice = preserve ? choice : ''
    const epoch = ++generation.current
    setBranch(nextBranch)
    setChoice('')
    setHistory(null)
    locked.current = true
    setBusy(true)
    setError('')
    try {
      const result = await request(`${endpoint}/targets/${target.id}/source/refresh`, {
        branch: nextBranch,
      })
      if (live.current && generation.current === epoch) {
        setHistory(result)
        setChoice(
          preserve
            ? result.commits.some((c) => c.revision === previousChoice)
              ? previousChoice
              : ''
            : result.commits[0]?.revision || '',
        )
        if (
          preserve &&
          previousChoice &&
          !result.commits.some((c) => c.revision === previousChoice)
        )
          setError('原提交已不在刷新后的列表中，请重新选择。')
      }
    } catch (e) {
      if (live.current && generation.current === epoch && e.name !== 'AbortError')
        setError(e.message)
    } finally {
      if (live.current && generation.current === epoch) {
        locked.current = false
        setBusy(false)
      }
    }
  }
  async function updateCode() {
    if (!locked.current) await loadBranch(branch, true)
  }
  async function refreshBranches() {
    if (!source?.sourceProjectId) {
      setError('请先关联源码仓库')
      return
    }
    const epoch = ++generation.current
    locked.current = false
    setBusy(true)
    setChoice('')
    setHistory(null)
    setError('')
    try {
      const info = await request(
        `${endpoint}/repositories/${source.sourceProjectId}/branches/refresh`,
        {},
      )
      if (!live.current || generation.current !== epoch) return
      setBranchInfo(info)
      const preferred = branch || info.defaultBranch
      if (preferred && info.branches.some((item) => item.name === preferred))
        await loadBranch(preferred, preferred === branch)
      else if (preferred) setError('原分支已不存在，请选择其他分支。')
    } catch (e) {
      if (live.current && generation.current === epoch) setError(e.message)
    } finally {
      if (live.current && generation.current === epoch) setBusy(false)
    }
  }
  return (
    <div className="space-y-6" id="release-workbench">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="page-title" className="text-xl font-semibold">
            {actionNames[action]} {service?.name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {data.project.name} / {find('environments', target.environmentId)?.name} /{' '}
            {server?.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(service?.kind || target.config?.kind) !== 'static' && action !== 'restart' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={restartReason ? 0 : undefined}>
                  <Button
                    id="restart-current-version"
                    variant="outline"
                    disabled={!!restartReason}
                    aria-describedby={restartReason ? 'restart-disabled-reason' : undefined}
                    onClick={() => open('release', { target, action: 'restart' })}
                  >
                    <RotateCw />
                    重启当前版本
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {restartReason || '重启此服务器上当前已部署的版本，确认后执行。'}
              </TooltipContent>
            </Tooltip>
          )}
          <Button variant="outline" onClick={() => setShowConfig((v) => !v)}>
            <FileCode2 />
            查看服务配置
          </Button>
        </div>
      </div>
      {(service?.kind || target.config?.kind) !== 'static' && restartReason && (
        <p id="restart-disabled-reason" className="text-sm text-muted-foreground" role="status">
          {restartReason}
        </p>
      )}
      {error && <Notice error>{error}</Notice>}
      {activeTask && (
        <Notice>
          <span>此服务有任务正在执行。</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('tasks', activeTask.id, target.environmentId)}
          >
            查看进度
          </Button>
        </Notice>
      )}
      {showConfig && <Configuration target={{ ...target, config }} />}
      <div className={action === 'restart' ? 'mx-auto w-full max-w-3xl' : 'release-layout'}>
        {action !== 'restart' && (
          <Card className="release-selection" aria-busy={loading || busy}>
            <CardContent className="space-y-6 pt-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Tabs
                  value={tab}
                  onValueChange={(value) => {
                    setTab(value)
                    if (value === 'commits' && !history && source?.sourceProjectId)
                      refreshBranches()
                  }}
                >
                  <TabsList>
                    <TabsTrigger value="commits">Git 提交</TabsTrigger>
                    <TabsTrigger value="releases">已发布版本</TabsTrigger>
                  </TabsList>
                </Tabs>
                {tab === 'commits' && (
                  <Button
                    variant="outline"
                    onClick={updateCode}
                    disabled={loading || busy || !branch}
                    id="refresh-commits"
                  >
                    <RefreshCw className={busy ? 'animate-spin' : ''} />
                    {busy ? '正在刷新…' : '刷新提交'}
                  </Button>
                )}
              </div>
              {tab === 'commits' ? (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="release-branch">
                      发布分支
                    </label>
                    <div className="flex min-w-0 gap-2">
                      <Choice
                        id="release-branch"
                        aria-label="发布分支"
                        searchable
                        value={branch}
                        options={(branchInfo?.branches || []).map((item) => ({
                          value: item.name,
                          label:
                            item.name +
                            (item.name === branchInfo.defaultBranch ? '（默认分支）' : ''),
                        }))}
                        onValueChange={(value) => loadBranch(value)}
                        disabled={loading}
                        className="min-w-0 flex-1"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label="刷新分支列表"
                        disabled={loading || busy || !source?.sourceProjectId}
                        onClick={refreshBranches}
                      >
                        <RefreshCw />
                      </Button>
                    </div>
                    {!loading && branchInfo && !branchInfo.branches.length && (
                      <p className="text-sm text-muted-foreground">
                        暂无可用分支，请确认仓库已有提交。
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <GitBranch className="size-3.5" />
                      {history?.repositoryName ||
                        find('repositories', source?.sourceProjectId)?.name}{' '}
                      / {branch || '请选择分支'}
                    </span>
                    <span>
                      {loading
                        ? '正在读取提交记录…'
                        : history?.refreshedAt
                          ? `更新于 ${date(history.refreshedAt)}`
                          : '尚未获取提交记录'}
                    </span>
                  </div>
                  <SearchField
                    label="搜索提交"
                    placeholder="提交 SHA、说明或作者"
                    value={commitQuery}
                    onChange={setCommitQuery}
                    disabled={loading || busy}
                  />
                  {commitQuery.trim() && (
                    <p className="text-xs text-muted-foreground" role="status">
                      匹配 {visibleCommits.length} / {history?.commits.length || 0} 条提交
                      {choice && !visibleCommits.some((c) => c.revision === choice)
                        ? ' · 已选提交保留在发布确认中'
                        : ''}
                    </p>
                  )}
                  <ScrollArea className="max-h-[540px] [&_[data-slot=scroll-area-viewport]]:max-h-[540px]">
                    <div
                      role="group"
                      aria-label="选择发布提交"
                      className="pr-3"
                      aria-busy={loading || busy}
                    >
                      {loading && (
                        <div className="space-y-4 py-3" role="status" aria-label="正在读取提交记录">
                          <Skeleton className="h-16" />
                          <Skeleton className="h-16" />
                          <Skeleton className="h-16" />
                        </div>
                      )}
                      <div hidden={loading}>
                        {busy && !history?.commits.length && (
                          <div className="space-y-3 py-3">
                            <Skeleton className="h-20" />
                            <Skeleton className="h-20" />
                            <Skeleton className="h-20" />
                          </div>
                        )}
                        {visibleCommits.map((commit) => (
                          <Button
                            key={commit.revision}
                            variant="ghost"
                            disabled={busy}
                            aria-pressed={choice === commit.revision}
                            data-commit={commit.revision}
                            className={`commit-option ${choice === commit.revision ? 'selected' : ''}`}
                            onClick={() => setChoice(commit.revision)}
                          >
                            <GitCommitHorizontal className="size-4 shrink-0" />
                            <span className="min-w-0 flex-1 text-left">
                              <span className="block whitespace-normal break-words font-medium">
                                {commit.subject || '无提交说明'}
                              </span>
                              <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground">
                                <code className="commit-sha">{commit.revision}</code>
                                <span>{commit.author}</span>
                                <span>{date(commit.at)}</span>
                              </span>
                            </span>
                            {choice === commit.revision ? (
                              <Check className="size-4 shrink-0" />
                            ) : commit.revision === history?.commits[0]?.revision ? (
                              <Badge variant="secondary">最新提交</Badge>
                            ) : null}
                          </Button>
                        ))}
                        {commitQuery.trim() && !visibleCommits.length && !busy && (
                          <p className="py-6 text-sm text-muted-foreground">
                            最近 100 条提交中没有匹配结果。可清空搜索、切换分支或刷新提交。
                          </p>
                        )}
                      </div>
                    </div>
                  </ScrollArea>
                  <p className="text-xs text-muted-foreground">
                    显示所选分支最近 100 条提交；刷新只更新列表，确认发布后固定所选提交。
                  </p>
                </>
              ) : loading ? (
                <div role="status" aria-label="正在读取发布版本">
                  <Skeleton className="h-64" />
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm font-medium" id="release-list-label">
                    恢复到版本
                  </p>
                  <SearchField
                    label="搜索已发布版本"
                    placeholder="分支、提交说明、SHA 或版本 ID"
                    value={releaseQuery}
                    onChange={setReleaseQuery}
                  />
                  <ScrollArea className="max-h-[540px] [&_[data-slot=scroll-area-viewport]]:max-h-[540px]">
                    <div role="group" aria-labelledby="release-list-label" className="pr-3">
                      {visibleReleases.map((r) => {
                        const current = r.id === target.currentRelease?.id
                        const selected = releaseId === r.id && r.available && !current
                        return (
                          <Button
                            key={r.id}
                            type="button"
                            variant="ghost"
                            disabled={current || !r.available}
                            aria-pressed={selected}
                            data-release-option={r.id}
                            className={`commit-option disabled:opacity-100 ${selected ? 'selected' : ''}`}
                            onClick={() => setReleaseId(r.id)}
                          >
                            <Package className="size-4 shrink-0 text-muted-foreground" />
                            <ReleaseInfo
                              release={r}
                              selectable
                              badge={
                                current ? (
                                  <Badge variant="secondary">当前版本</Badge>
                                ) : !r.available ? (
                                  <Badge variant="outline">不可回退</Badge>
                                ) : null
                              }
                            />
                            {selected && <Check className="size-4 shrink-0" aria-label="已选择" />}
                          </Button>
                        )
                      })}
                      {!visibleReleases.length && (
                        <p className="py-8 text-sm text-muted-foreground" role="status">
                          {releases.length ? '已加载版本中没有匹配结果。' : '尚无成功发布版本'}
                        </p>
                      )}
                    </div>
                  </ScrollArea>
                  <p className="text-xs text-muted-foreground" role="status">
                    已加载 {releases.length} 个版本
                    {releaseQuery.trim() && `，匹配 ${visibleReleases.length} 个`}。
                    点击记录选择，确认后恢复该次发布的源码与配置。
                  </p>
                  {releaseNext != null && (
                    <Action
                      variant="outline"
                      onClick={async () => {
                        const page = await request(
                          `${endpoint}/targets/${target.id}/releases?offset=${releaseNext}`,
                        )
                        if (live.current) {
                          setReleases((items) => [
                            ...items,
                            ...page.releases.filter(
                              (next) => !items.some((item) => item.id === next.id),
                            ),
                          ])
                          setReleaseNext(page.nextOffset)
                        }
                      }}
                    >
                      加载更多历史版本
                    </Action>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}
        <Card className="release-review">
          <CardHeader>
            <CardTitle>{actionNames[action]}确认</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {action === 'restart' && (
              <Notice>
                {(service?.kind || target.config?.kind) === 'static'
                  ? '静态站点无需重启，请使用发布或回退。'
                  : '重启此部署位置的当前版本，随后检查健康状态。不会重新拉取源码、编译或应用下次发布配置。'}
              </Notice>
            )}
            <dl className="review-details">
              <Detail label="项目">{data.project.name}</Detail>
              <Detail label="环境">{find('environments', target.environmentId)?.name}</Detail>
              <Detail label="服务">{service?.name}</Detail>
              <Detail label="代码仓库">
                {action === 'rollback' || action === 'restart'
                  ? releaseSource?.name || '历史未保存'
                  : find('repositories', source?.sourceProjectId)?.name || '—'}
              </Detail>
              <Detail label="分支">
                {action === 'rollback'
                  ? releaseSource?.branch || '历史未保存'
                  : action === 'restart'
                    ? target.currentRelease?.sourceSnapshot?.branch || '—'
                    : branch || '—'}
              </Detail>
              <Detail label="服务器">
                <Selection
                  aria-label="发布服务器"
                  value={target.id}
                  onChange={(e) => {
                    location.hash = routeUrl(
                      'release',
                      data.project.id,
                      target.environmentId,
                      null,
                      {
                        targetId: e.target.value,
                        action,
                      },
                    )
                  }}
                >
                  {candidates.map((t) => (
                    <SelectionOption key={t.id} value={t.id}>
                      {find('servers', t.serverId)?.name}
                    </SelectionOption>
                  ))}
                </Selection>
              </Detail>
            </dl>
            <div className="space-y-3 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                {action === 'restart' ? '重启版本' : '版本变化'}
              </p>
              {action !== 'restart' && (
                <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                  <span>{short(target.currentRelease?.revision)}</span>
                  <ArrowRight className="size-3.5" />
                  <span>
                    {selectedRevision
                      ? short(selectedRevision)
                      : action === 'rollback'
                        ? '请选择历史版本'
                        : '请选择具体提交'}
                  </span>
                </div>
              )}
              {selectedRevision && (
                <Commit
                  value={selectedRevision}
                  subject={
                    action === 'deploy'
                      ? history?.commits.find((c) => c.revision === choice)?.subject
                      : action === 'rollback'
                        ? selectedRelease?.commitSubject
                        : target.currentRelease?.commitSubject
                  }
                  summary
                />
              )}
              {action === 'rollback' && selectedRelease && (
                <p
                  className="text-xs text-muted-foreground break-all"
                  data-selected-release={selectedRelease.id}
                >
                  发布于 {date(selectedRelease.createdAt)} · 版本 {selectedRelease.id}
                </p>
              )}
            </div>
            <dl className="review-details">
              <Detail label={config.kind === 'static' ? '站点' : '端口'}>
                {config.kind === 'static'
                  ? config.health?.url
                  : config.ports
                      ?.map((p) => `${p.host}:${p.hostPort}:${p.containerPort}`)
                      .join(', ') || '未映射'}
              </Detail>
              {config.kind !== 'static' && (
                <Detail label="Profile">{config.profile || '默认'}</Detail>
              )}
            </dl>
            <Action
              id="confirm-release"
              variant="default"
              className="w-full"
              disabled={
                !managed ||
                !!activeTask ||
                busy ||
                loading ||
                (action === 'deploy' &&
                  (!choice || !history?.sourceKey || !branch || !history?.configKey)) ||
                (action === 'rollback' &&
                  (!selectedRelease?.available ||
                    selectedRelease.id === target.currentRelease?.id)) ||
                (action === 'restart' && !!restartReason)
              }
              onClick={async () => {
                const payload = {
                  targetId: target.id,
                  action,
                  ...(action === 'rollback' ? { releaseId } : {}),
                  ...(action === 'deploy'
                    ? {
                        sourceKey: history?.sourceKey,
                        configKey: history?.configKey,
                        branch,
                        revision: choice,
                      }
                    : {}),
                }
                const fingerprint = JSON.stringify(payload)
                if (submission.current?.fingerprint !== fingerprint)
                  submission.current = { fingerprint, requestId: crypto.randomUUID() }
                const requestId = submission.current.requestId
                confirm(
                  `确认${actionNames[action]}`,
                  action === 'rollback'
                    ? '恢复所选版本的源码和历史配置，操作范围如下。'
                    : action === 'restart'
                      ? '重启以下服务器上的当前版本，期间服务会短暂不可用；随后执行健康检查。不会拉取源码、编译或应用下次发布配置。'
                      : '核对以下信息后提交任务，本次仅操作所选部署位置。',
                  async () => {
                    const result = await request(`${endpoint}/tasks`, { ...payload, requestId })
                    if (live.current) navigate('tasks', result.task.id, target.environmentId)
                  },
                  {
                    details: [
                      ['服务', service?.name],
                      ['环境', find('environments', target.environmentId)?.name],
                      ['服务器', server?.name],
                      [
                        '分支',
                        action === 'deploy'
                          ? branch
                          : releaseSource?.branch ||
                            target.currentRelease?.sourceSnapshot?.branch ||
                            '历史分支未记录',
                      ],
                      [
                        '提交说明',
                        action === 'deploy'
                          ? history?.commits.find((c) => c.revision === choice)?.subject
                          : action === 'rollback'
                            ? selectedRelease?.commitSubject
                            : target.currentRelease?.commitSubject,
                      ],
                      ['Commit', selectedRevision],
                      ...(action === 'rollback'
                        ? [
                            ['发布时间', date(selectedRelease.createdAt)],
                            ['版本 ID', selectedRelease.id],
                          ]
                        : []),
                    ],
                  },
                )
              }}
            >
              确认{actionNames[action]} <ArrowRight />
            </Action>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {!managed
                ? '服务器离线、接入已撤销或目标已停用。'
                : action === 'rollback'
                  ? '优先恢复已核验的本机产物；缓存缺失时使用中心原源码包和历史配置重建。'
                  : action === 'restart'
                    ? restartReason || '仅重启此部署位置的当前版本，保留已部署配置。'
                    : '本次只操作这个部署目标。提交任务后固定源码与配置。'}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

const msLabel = (ms) =>
  ms < 1000
    ? `${Math.round(ms)} 毫秒`
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)} 秒`
      : `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`
const stageDuration = (task, stage) =>
  (task.stageHistory || [])
    .filter((e) => e.stage === stage)
    .reduce(
      (sum, e) =>
        sum +
        (e.durationMs ??
          Math.max(
            0,
            Date.parse(e.finishedAt || task.finishedAt || new Date().toISOString()) -
              Date.parse(e.startedAt),
          )),
      0,
    )
function taskStages(task) {
  const history = task.stageHistory || []
  const center =
    task.action !== 'deploy'
      ? []
      : history.some((s) => s.stage.startsWith('source_'))
        ? [
            ['source_fetch', '拉取代码'],
            ['source_resolve', '固定提交'],
            ['source_archive', '打包 ZIP'],
          ]
        : [['preparing', '准备源码']]
  const image = task.detailedAgentStages || history.some((s) => s.stage === 'image')
  const agent =
    task.action === 'deploy'
      ? [
          ['downloading', '下载源码包'],
          [
            'building',
            task.config?.kind === 'static' ? '构建前端' : image ? '编译 JAR' : '编译 / 镜像',
          ],
          ...(image ? [['image', '构建镜像']] : []),
          ['deploying', task.config?.kind === 'static' ? '切换站点' : '更新服务'],
          ['verifying', '健康检查'],
        ]
      : [
          ['deploying', task.action === 'restart' ? '重启服务' : '恢复版本'],
          ['verifying', '健康检查'],
        ]
  return { center, agent }
}
function failedStage(task) {
  if (!finished(task) || task.status === 'succeeded') return null
  const history = task.stageHistory || []
  if (task.status === 'rolled_back' && task.action === 'deploy')
    return history.findLast((e) => e.stage === 'verifying')?.stage || history.at(-1)?.stage
  if ([...taskStages(task).center, ...taskStages(task).agent].some(([s]) => s === task.stage))
    return task.stage
  return history.at(-1)?.stage
}
export function StageFlow({ task, selected, onSelect }) {
  const { center, agent } = taskStages(task),
    history = task.stageHistory || [],
    failure = failedStage(task)
  const steps = [...center, ...agent],
    done = steps.filter(
      ([stage]) =>
        stage !== failure &&
        history.some((e) => e.stage === stage && (e.finishedAt || finished(task))) &&
        (finished(task) || task.stage !== stage),
    ).length
  const current =
    steps.find(([stage]) => stage === task.stage)?.[1] || stageLabel(task.stage, task.config?.kind)
  const lane = (owner, title, Icon, stages) => (
    <Card className={`flow-group ${owner}`}>
      <CardHeader className="flow-heading">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="size-4" />
          {title}
        </CardTitle>
        <span className="text-xs tabular-nums text-muted-foreground" data-lane-duration={owner}>
          {msLabel(stages.reduce((sum, [stage]) => sum + stageDuration(task, stage), 0))}
        </span>
      </CardHeader>
      <CardContent>
        <div className="stage-list" aria-label={`${title}处理阶段`}>
          {stages.map(([stage, label], i) => {
            const entries = history.filter((e) => e.stage === stage),
              running = !finished(task) && task.stage === stage,
              failed = stage === failure
            const state = failed
              ? 'failed'
              : running
                ? 'active'
                : entries.length
                  ? 'complete'
                  : 'waiting'
            return (
              <div key={stage} className={`stage-step ${state}`}>
                <div className="stage-connector" />
                <Button
                  variant="ghost"
                  aria-pressed={selected === stage}
                  aria-label={`${label} · ${entries.length ? msLabel(stageDuration(task, stage)) : '等待'}`}
                  className="stage-button"
                  data-stage={stage}
                  onClick={() => onSelect(stage)}
                >
                  <span className={`stage-token ${state}`}>
                    {failed ? (
                      <AlertCircle className="size-4" />
                    ) : running ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : entries.length ? (
                      <Check className="size-4" />
                    ) : (
                      (owner === 'agent' ? center.length : 0) + i + 1
                    )}
                  </span>
                  <span className="stage-label">{label}</span>
                  <span className="stage-time">
                    {entries.length
                      ? msLabel(stageDuration(task, stage))
                      : finished(task)
                        ? '未记录'
                        : '等待'}
                  </span>
                </Button>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
  return (
    <div id="deploy-task-progress" className="space-y-4">
      <div className="flow-summary">
        <span className="text-sm" aria-live="polite">
          {finished(task)
            ? resultName(task)
            : task.status === 'queued'
              ? '等待同一服务器上的前序任务'
              : current}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          总耗时 {duration({ ...task, startedAt: task.createdAt })} · 排队{' '}
          {msLabel(stageDuration(task, 'queued'))}
        </span>
      </div>
      <Progress
        value={steps.length ? (done / steps.length) * 100 : 0}
        className="h-1"
        aria-label="发布阶段完成进度"
        aria-valuetext={`已完成 ${done} / ${steps.length} 个阶段`}
      />
      {center.length > 0 && lane('center', '中心服务', Cloud, center)}
      {center.length > 0 && (
        <div className={`flow-handoff ${task.status === 'queued' ? 'active' : ''}`}>
          <ArrowDown className="size-4" />
          <span>
            {task.status === 'queued'
              ? '源码已准备，等待 Agent 领取'
              : '固定 Commit · 完整源码 ZIP · 校验后交付'}
          </span>
        </div>
      )}
      {lane('agent', '服务器 Agent', Server, agent)}
    </div>
  )
}
export function TaskWorkbench({ id }) {
  const { request, endpoint, find, version, open, notify, nameOfTarget } = useConsole()
  const [task, setTask] = useState(null),
    [logs, setLogs] = useState([]),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(null),
    [tab, setTab] = useState('flow'),
    [logQuery, setLogQuery] = useState(''),
    [, tick] = useState(0)
  const cursor = useRef(0),
    output = useRef(null),
    nearBottom = useRef(true),
    pollRef = useRef(() => {})
  useEffect(() => {
    let active = true,
      busy = false,
      timer
    async function poll() {
      if (!active || busy) return
      busy = true
      try {
        const result = await request(`${endpoint}/tasks/${id}?after=${cursor.current}`)
        if (!active) return
        setTask(result.task)
        setError('')
        const extra = result.logs
          .filter((l) => l.seq > cursor.current)
          .sort((a, b) => a.seq - b.seq)
        if (extra.length) {
          cursor.current = extra.at(-1).seq
          setLogs((old) => [...old, ...extra])
        }
        if (cursor.current < result.task.lastSeq) timer = setTimeout(poll, 150)
      } catch (e) {
        if (active && e.name !== 'AbortError') setError(e.message)
      } finally {
        busy = false
      }
    }
    pollRef.current = poll
    poll()
    const interval = setInterval(() => {
      poll()
      tick((v) => v + 1)
    }, 1000)
    return () => {
      active = false
      clearInterval(interval)
      clearTimeout(timer)
    }
  }, [id, endpoint])
  useEffect(() => {
    pollRef.current()
  }, [version])
  useEffect(() => {
    if (!logQuery.trim() && nearBottom.current && output.current)
      output.current.scrollTop = output.current.scrollHeight
  }, [logs, selected, tab, task?.stage, logQuery])
  const target = find('targets', task?.targetId),
    outcome = task?.result
  const currentStage =
    task && (finished(task) ? logs.at(-1)?.stage || task.stageHistory?.at(-1)?.stage : task.stage)
  const logStage = tab === 'logs' ? null : selected || currentStage
  const stageTitle =
    task &&
    [...taskStages(task).center, ...taskStages(task).agent].find(([s]) => s === logStage)?.[1]
  const allLogs = [
    ...(task?.stageHistory || [])
      .filter((e) => e.stage.startsWith('source_'))
      .map((e) => ({
        stage: e.stage,
        text: `[${date(e.startedAt)}] [中心] ${stageLabel(e.stage)}\n`,
      })),
    ...logs.map((l) => ({
      stage: l.stage,
      text: `[${date(l.at)}] [${stageLabel(l.stage, task?.config?.kind)}] ${l.message}\n`,
    })),
  ]
  const stageLogs = allLogs.filter((l) => !logStage || l.stage === logStage)
  const logLines = stageLogs
    .map((l) => l.text)
    .join('')
    .split('\n')
  if (logLines.at(-1) === '') logLines.pop()
  const query = logQuery.trim().toLocaleLowerCase()
  const matchingLines = query
    ? logLines.filter((line) => line.toLocaleLowerCase().includes(query))
    : logLines
  const backfilling = task && cursor.current < task.lastSeq
  function downloadLogs() {
    const text = allLogs.map((l) => l.text).join('')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `autoops-${id}.log`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify(finished(task) ? '完整日志已下载' : '截至当前的日志已下载')
  }
  const source = task?.action === 'rollback' ? task.release?.sourceSnapshot : task?.sourceSnapshot
  const renderLogs = () => (
    <Card className="overflow-hidden task-log-card">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-sm">
          {tab === 'logs'
            ? '完整日志'
            : `${stageTitle || stageLabel(logStage, task?.config?.kind)} · 日志`}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {tab === 'logs' ? (
            <Action
              variant="outline"
              size="sm"
              disabled={!task || backfilling}
              onClick={async () => {
                await copy(allLogs.map((l) => l.text).join(''))
                notify('日志已复制')
              }}
            >
              <Copy />
              复制日志
            </Action>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={!selected}
              onClick={() => setSelected(null)}
            >
              跟随当前阶段
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!task || backfilling || !allLogs.length}
            onClick={downloadLogs}
          >
            <Download />
            下载日志
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <SearchField
          label="搜索日志"
          placeholder={tab === 'logs' ? '搜索完整日志中的关键字' : '搜索当前阶段中的关键字'}
          value={logQuery}
          onChange={(value) => {
            setLogQuery(value)
            nearBottom.current = !value.trim()
            if (output.current) output.current.scrollTop = 0
          }}
        />
        {(query || backfilling) && (
          <p className="text-xs text-muted-foreground" role="status">
            {backfilling ? '正在补齐历史日志… ' : ''}
            {query &&
              `匹配 ${matchingLines.length} / ${logLines.length} 行 · 下载保留全部已加载日志`}
          </p>
        )}
        <ScrollArea
          className="task-log-scroll h-80 rounded-md border bg-muted/30"
          viewportRef={output}
          onViewportScroll={(e) => {
            const el = e.currentTarget
            nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
          }}
        >
          <pre
            id="deploy-task-logs"
            aria-label={tab === 'logs' ? '完整日志' : '当前阶段日志'}
            tabIndex={0}
            className="task-log-text !max-h-none !overflow-visible !border-0"
          >
            {matchingLines.join('\n') ||
              (query ? '没有匹配的日志，请修改关键字或清空搜索。' : '等待任务日志…')}
          </pre>
        </ScrollArea>
      </CardContent>
    </Card>
  )
  return (
    <div className="space-y-5" id="task-workbench">
      <div className="page-title">
        <div>
          <h1 id="page-title" className="text-xl font-semibold">
            {task
              ? `${find('services', target?.serviceId)?.name || '服务'} · ${actionNames[task.action]}`
              : '发布详情'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {task && nameOfTarget(target)}
            {target && ` / ${find('servers', target.serverId)?.name || ''}`}
          </p>
        </div>
        <div className="page-actions">
          <Action
            variant="outline"
            size="sm"
            onClick={async () => {
              await copy(location.href)
              notify('任务地址已复制')
            }}
          >
            <Copy />
            复制任务地址
          </Action>
          {task && finished(task) && target?.mode === 'managed' && (
            <Button size="sm" onClick={() => open('release', { target, action: 'deploy' })}>
              再次发布 <ArrowRight />
            </Button>
          )}
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="task-toolbar" id="deploy-task-info">
          <TabsList variant="line" className="section-tabs">
            <TabsTrigger value="flow">发布进度</TabsTrigger>
            <TabsTrigger value="snapshot">任务快照</TabsTrigger>
            <TabsTrigger value="logs">完整日志</TabsTrigger>
          </TabsList>
          {task && <Status value={task.status}>{resultName(task)}</Status>}
        </div>
        <TabsContent value="flow" className="space-y-4 pt-4">
          {task ? (
            <>
              <StageFlow task={task} selected={selected || currentStage} onSelect={setSelected} />
              <div id="deploy-task-result" className="space-y-3">
                {task.error && <Notice error>{task.error}</Notice>}
                {typeof outcome === 'string' && <Notice>{outcome}</Notice>}
                {outcome?.message && <Notice>{outcome.message}</Notice>}
                {outcome?.error && outcome.error !== task.error && (
                  <Notice error>{outcome.error}</Notice>
                )}
                {outcome?.rollback && (
                  <Notice>
                    自动回退：
                    {outcome.rollback.status === 'succeeded'
                      ? '成功'
                      : outcome.rollback.status === 'unavailable'
                        ? '没有可恢复的基线'
                        : '失败'}
                    {outcome.rollback.error && ` · ${outcome.rollback.error}`}
                  </Notice>
                )}
                {outcome?.cleanupError && <Notice error>{outcome.cleanupError}</Notice>}
                {outcome?.release?.kind === 'static' && (
                  <p className="text-xs text-muted-foreground wrap-anywhere">
                    静态版本：{outcome.release.artifact}
                  </p>
                )}
              </div>
            </>
          ) : (
            <Skeleton className="h-56" />
          )}
          {renderLogs()}
        </TabsContent>
        <TabsContent value="snapshot" className="space-y-5 pt-4" id="task-snapshot">
          {task && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>固定源码</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="configuration-details">
                    <Detail label="代码仓库">{source?.name || '历史未记录'}</Detail>
                    <Detail label="发布分支">{source?.branch || '历史未记录'}</Detail>
                    <Detail label="Commit">
                      <Commit value={revisionOf(task)} />
                    </Detail>
                    <Detail label="创建时间">{date(task.createdAt)}</Detail>
                    <Detail label="Maven 模块 / 前端目录">{task.config?.module || '.'}</Detail>
                    <Detail label="任务 ID">
                      <span className="config-value font-mono text-xs">{task.id}</span>
                    </Detail>
                    <div className="config-wide">
                      <Detail label="发布产物">
                        <span className="config-code">
                          {outcome?.release?.image ||
                            outcome?.release?.artifact ||
                            task.release?.image ||
                            task.release?.artifact ||
                            '尚未生成'}
                        </span>
                      </Detail>
                    </div>
                  </dl>
                </CardContent>
              </Card>
              <Configuration
                target={{
                  ...target,
                  config:
                    task.action === 'rollback' ? task.release?.config || task.config : task.config,
                }}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="logs" className="pt-4">
          {renderLogs()}
        </TabsContent>
      </Tabs>
    </div>
  )
}
