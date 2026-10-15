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
  Server,
  Package,
  Cloud,
  LoaderCircle,
  FileCode2,
  Clock3,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { Action, Detail, Empty, Notice, Status } from './shared'
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
        [isStatic ? '前端目录' : 'Maven 模块', config.module || '.'],
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
              ['Docker 网络', config.networks?.join('\n') || '平台自动创建目标网络'],
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
export function ConfigurationPage() {
  const { data, route, find, navigate, open, endpoint, request, scope } = useConsole(),
    target = find('targets', route.targetId)
  const [tab, setTab] = useState('config'),
    [configTab, setConfigTab] = useState('next'),
    [releases, setReleases] = useState([]),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (target)
      request(`${endpoint}/targets/${target.id}/releases`)
        .then((r) => {
          if (active) setReleases(r.releases)
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
  const configuration = configTab === 'current' ? target.currentRelease?.config : target.config
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
          <Button variant="outline" onClick={() => open('service', service)}>
            编辑服务
          </Button>
          <Button
            disabled={target.mode !== 'managed'}
            onClick={() => open('release', { target, action: 'deploy' })}
          >
            更新服务 <ArrowRight />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <NativeSelect
          aria-label="部署位置"
          value={target.id}
          onChange={(e) => {
            const t = find('targets', e.target.value)
            location.hash = routeUrl('configuration', scope, t.environmentId, null, {
              targetId: t.id,
            })
          }}
        >
          {data.targets
            .filter((t) => t.serviceId === service.id)
            .map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {find('environments', t.environmentId)?.name} / {find('servers', t.serverId)?.name}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" className="section-tabs">
          <TabsTrigger value="config">配置</TabsTrigger>
          <TabsTrigger value="runtime">运行状态</TabsTrigger>
          <TabsTrigger value="versions">版本链</TabsTrigger>
          <TabsTrigger value="logs">发布日志</TabsTrigger>
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
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>源码与模块</CardTitle>
              <Button variant="outline" size="sm" onClick={() => open('source', service)}>
                编辑关联
              </Button>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-5 sm:grid-cols-2">
                <Detail label="代码仓库">{repo?.name || '未关联'}</Detail>
                <Detail label="Gitee 地址">{repo?.repository || '—'}</Detail>
                <Detail label="发布分支">{source?.branch || '—'}</Detail>
                <Detail label={service.kind === 'static' ? '前端目录' : 'Maven 模块'}>
                  {service.module}
                </Detail>
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">
                当前环境源码选择；已执行任务的提交与配置保存在发布日志中。
              </p>
            </CardContent>
          </Card>
          <div className="flex justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {find('servers', target.serverId)?.name}
            </span>
            <Button variant="outline" onClick={() => open('target', target)}>
              编辑运行配置
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
                {find('servers', target.serverId)?.online ? '在线' : '离线 · 当前状态待确认'}
              </Detail>
              <Detail label="最近运行状态">
                {target.observation?.state || target.observation?.status || '尚未上报'}
              </Detail>
              <Detail label="最近健康状态">{target.observation?.health || '尚未上报'}</Detail>
              <Detail label="当前版本">
                <Commit value={target.currentRelease?.revision} />
              </Detail>
              <Detail label="镜像">
                {target.currentRelease?.image || target.observation?.image || '—'}
              </Detail>
              <Detail label="最近采集">{date(target.lastObservedAt)}</Detail>
            </dl>
          </CardContent>
        </Card>
      )}
      {tab === 'versions' && (
        <Card>
          <CardContent>
            {releases.map((r) => (
              <div className="version-item" key={r.id}>
                <span className="status-dot good mt-2" />
                <div className="min-w-0 flex-1">
                  <Commit value={r.revision} />
                  <p className="mt-1 text-xs text-muted-foreground">{date(r.createdAt)}</p>
                </div>
                <Badge variant="outline">
                  {target.currentRelease?.id === r.id
                    ? '当前版本'
                    : r.available
                      ? '可回退'
                      : '已清理'}
                </Badge>
              </div>
            ))}
            {!releases.length && <p className="text-sm text-muted-foreground">尚无成功版本</p>}
            <Button
              className="mt-4"
              variant="outline"
              disabled={!releases.some((r) => r.available && r.id !== target.currentRelease?.id)}
              onClick={() => open('release', { target, action: 'rollback' })}
            >
              回退版本
            </Button>
          </CardContent>
        </Card>
      )}
      {tab === 'logs' && (
        <Card>
          <CardContent>
            {tasks.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b py-4"
              >
                <Status value={t.status}>{resultName(t)}</Status>
                <span className="text-xs text-muted-foreground">
                  {date(t.createdAt)} · {duration(t)}
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
  const { data, route, find, request, endpoint, navigate, open, environmentId } = useConsole()
  const target = find('targets', route.targetId),
    source = data.environmentSources.find(
      (s) => s.environmentId === target?.environmentId && s.serviceId === target?.serviceId,
    )
  const server = find('servers', target?.serverId),
    service = find('services', target?.serviceId)
  const [history, setHistory] = useState(null),
    [releases, setReleases] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [choice, setChoice] = useState('latest'),
    [tab, setTab] = useState(route.action === 'rollback' ? 'releases' : 'commits'),
    [releaseId, setReleaseId] = useState(''),
    [showConfig, setShowConfig] = useState(false),
    [loading, setLoading] = useState(true)
  const live = useRef(true),
    locked = useRef(false),
    generation = useRef(0)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const signature = `${source?.sourceProjectId}:${source?.branch}:${find('repositories', source?.sourceProjectId)?.repository}`
  useEffect(() => {
    let active = true
    generation.current++
    locked.current = false
    setBusy(false)
    setLoading(true)
    setHistory(null)
    setChoice('latest')
    setReleases([])
    setError('')
    if (!target) return
    Promise.allSettled([
      request(`${endpoint}/targets/${target.id}/source`),
      request(`${endpoint}/targets/${target.id}/releases`),
    ]).then(([h, r]) => {
      if (!active) return
      setLoading(false)
      if (h.status === 'fulfilled') setHistory(h.value)
      else if (h.reason.name !== 'AbortError') setError(`源码记录：${h.reason.message}`)
      if (r.status === 'fulfilled') {
        setReleases(r.value.releases)
        setReleaseId(
          r.value.releases.find((v) => v.available && v.id !== target.currentRelease?.id)?.id || '',
        )
      } else if (r.reason.name !== 'AbortError') setError(`版本记录：${r.reason.message}`)
    })
    return () => {
      active = false
    }
  }, [target?.id, signature])
  if (!target)
    return (
      <Empty
        title="部署目标不存在"
        description="返回项目选择有效的服务和服务器。"
        action={() => navigate('deployments')}
        label="返回部署发布"
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
  const selectedRevision =
    action === 'rollback'
      ? selectedRelease?.revision
      : action === 'restart'
        ? target.currentRelease?.revision
        : choice === 'latest'
          ? null
          : choice
  const releaseSource =
    action === 'rollback'
      ? selectedRelease?.sourceSnapshot ||
        data.tasks.find((t) => t.id === selectedRelease?.id)?.sourceSnapshot
      : null
  const config =
    action === 'rollback'
      ? selectedRelease?.config || target.config
      : action === 'restart'
        ? target.currentRelease?.config || target.config
        : target.config
  async function updateCode() {
    if (locked.current) return
    locked.current = true
    const epoch = generation.current
    setBusy(true)
    setError('')
    try {
      const result = await request(`${endpoint}/targets/${target.id}/source/refresh`, {})
      if (live.current && generation.current === epoch) {
        setHistory(result)
        setChoice(result.commits[0]?.revision || 'latest')
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
  return (
    <div className="space-y-6" id="release-workbench">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="page-title" className="text-xl font-semibold">
            {action === 'restart' ? '重启' : '更新'} {service?.name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {data.project.name} / {find('environments', target.environmentId)?.name} /{' '}
            {server?.name}
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowConfig((v) => !v)}>
          <FileCode2 />
          查看服务配置
        </Button>
      </div>
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
      <div className="release-layout">
        <Card className="release-selection" aria-busy={loading || busy}>
          <CardContent className="space-y-6 pt-0">
            {action !== 'restart' ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Tabs value={tab} onValueChange={setTab}>
                    <TabsList>
                      <TabsTrigger value="commits">Git 提交</TabsTrigger>
                      <TabsTrigger value="releases">已发布版本</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {tab === 'commits' && (
                    <Button
                      variant="outline"
                      onClick={updateCode}
                      disabled={loading || busy}
                      id="refresh-commits"
                    >
                      <RefreshCw className={busy ? 'animate-spin' : ''} />
                      {busy ? '正在更新…' : '更新代码'}
                    </Button>
                  )}
                </div>
                {tab === 'commits' ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <GitBranch className="size-3.5" />
                        {history?.repositoryName ||
                          find('repositories', source?.sourceProjectId)?.name}{' '}
                        / {source?.branch}
                      </span>
                      <span>
                        {loading
                          ? '正在读取提交记录…'
                          : history?.refreshedAt
                            ? `更新于 ${date(history.refreshedAt)}`
                            : '尚未获取提交记录'}
                      </span>
                    </div>
                    <div
                      role="group"
                      aria-label="选择发布提交"
                      className="commit-list"
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
                        <Button
                          variant="ghost"
                          disabled={busy}
                          aria-pressed={choice === 'latest'}
                          className={`commit-option ${choice === 'latest' ? 'selected' : ''}`}
                          onClick={() => setChoice('latest')}
                        >
                          <RefreshCw className="size-4 shrink-0" />
                          <span className="text-left">
                            <span className="block font-medium">最新代码</span>
                            <span className="mt-1 block text-xs font-normal text-muted-foreground">
                              发布时重新拉取该分支最新提交
                            </span>
                          </span>
                          {choice === 'latest' && <Check className="ml-auto size-4" />}
                        </Button>
                        {busy && !history?.commits.length && (
                          <div className="space-y-3 py-3">
                            <Skeleton className="h-20" />
                            <Skeleton className="h-20" />
                            <Skeleton className="h-20" />
                          </div>
                        )}
                        {history?.commits.map((commit, index) => (
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
                            ) : index === 0 ? (
                              <Badge variant="secondary">最新记录</Badge>
                            ) : null}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      显示当前分支最近 100 条提交；“更新代码”只刷新记录，不会发布服务。
                    </p>
                  </>
                ) : loading ? (
                  <div role="status" aria-label="正在读取发布版本">
                    <Skeleton className="h-64" />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <label className="text-sm font-medium" htmlFor="deploy-releaseId">
                      恢复到版本
                    </label>
                    <NativeSelect
                      id="deploy-releaseId"
                      value={releaseId}
                      onChange={(e) => setReleaseId(e.target.value)}
                    >
                      <NativeSelectOption value="">请选择成功版本</NativeSelectOption>
                      {releases
                        .filter((r) => r.available && r.id !== target.currentRelease?.id)
                        .map((r) => (
                          <NativeSelectOption key={r.id} value={r.id}>
                            {short(r.revision)} · {date(r.createdAt)}
                          </NativeSelectOption>
                        ))}
                    </NativeSelect>
                    <div className="version-chain">
                      {releases.map((r) => (
                        <div key={r.id} className="version-item">
                          <span className="status-dot good mt-1.5" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Commit value={r.revision} />
                              <Badge variant="secondary">
                                {r.id === target.currentRelease?.id
                                  ? '当前版本'
                                  : r.available
                                    ? '可回退'
                                    : '已清理'}
                              </Badge>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {date(r.createdAt)}
                            </p>
                          </div>
                        </div>
                      ))}
                      {!releases.length && (
                        <p className="py-8 text-sm text-muted-foreground">尚无成功发布版本</p>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <Notice>重启当前成功版本，随后重新检查健康状态。</Notice>
            )}
          </CardContent>
        </Card>
        <Card className="release-review">
          <CardHeader>
            <CardTitle>发布确认</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <dl className="review-details">
              <Detail label="项目">{data.project.name}</Detail>
              <Detail label="环境">{find('environments', target.environmentId)?.name}</Detail>
              <Detail label="服务">{service?.name}</Detail>
              <Detail label="代码仓库">
                {action === 'rollback'
                  ? releaseSource?.name || '历史未保存'
                  : find('repositories', source?.sourceProjectId)?.name || '—'}
              </Detail>
              <Detail label="分支">
                {action === 'rollback'
                  ? releaseSource?.branch || '历史未保存'
                  : source?.branch || '—'}
              </Detail>
              <Detail label="服务器">
                <NativeSelect
                  aria-label="发布服务器"
                  value={target.id}
                  onChange={(e) => {
                    location.hash = routeUrl('release', data.project.id, environmentId, null, {
                      targetId: e.target.value,
                    })
                  }}
                >
                  {candidates.map((t) => (
                    <NativeSelectOption key={t.id} value={t.id}>
                      {find('servers', t.serverId)?.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Detail>
            </dl>
            <div className="space-y-3 border-t pt-4">
              <p className="text-xs text-muted-foreground">版本变化</p>
              <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                <span>{short(target.currentRelease?.revision)}</span>
                <ArrowRight className="size-3.5" />
                <span>{selectedRevision ? short(selectedRevision) : '分支最新提交'}</span>
              </div>
              {selectedRevision && <Commit value={selectedRevision} />}
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
                (action === 'rollback' && !selectedRelease?.available) ||
                (action === 'restart' && !target.currentRelease)
              }
              onClick={async () => {
                const result = await request(`${endpoint}/tasks`, {
                  targetId: target.id,
                  action,
                  ...(action === 'rollback' ? { releaseId } : {}),
                  ...(action === 'deploy'
                    ? {
                        sourceKey: history?.sourceKey,
                        ...(choice !== 'latest' ? { revision: choice } : {}),
                      }
                    : {}),
                })
                if (live.current) navigate('tasks', result.task.id, target.environmentId)
              }}
            >
              确认{actionNames[action]} <ArrowRight />
            </Action>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {!managed
                ? '服务器离线、接入已撤销或目标已停用。'
                : action === 'rollback'
                  ? '恢复所选成功版本的产物和运行配置。'
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
    if (nearBottom.current && output.current) output.current.scrollTop = output.current.scrollHeight
  }, [logs, selected, tab, task?.stage])
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
  const source = task?.action === 'rollback' ? task.release?.sourceSnapshot : task?.sourceSnapshot
  const renderLogs = () => (
    <Card className="overflow-hidden task-log-card">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-sm">
          {tab === 'logs'
            ? '完整日志'
            : `${stageTitle || stageLabel(logStage, task?.config?.kind)} · 日志`}
        </CardTitle>
        {tab === 'logs' ? (
          <Action
            variant="outline"
            size="sm"
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
      </CardHeader>
      <CardContent>
        <pre
          id="deploy-task-logs"
          ref={output}
          aria-label={tab === 'logs' ? '完整日志' : '当前阶段日志'}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget
            nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
          }}
          className="task-log-text"
        >
          {allLogs
            .filter((l) => !logStage || l.stage === logStage)
            .map((l) => l.text)
            .join('') || '等待任务日志…'}
        </pre>
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
              再次更新 <ArrowRight />
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
