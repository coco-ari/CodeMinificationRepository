import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
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
              ['构建参数', config.buildArgs?.join(' ')],
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
              ['JVM 参数', config.jvmArgs?.join(' ')],
              ['应用参数', config.args?.join(' ')],
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
    <div className="grid gap-5 lg:grid-cols-2">
      {groups.map(([title, values]) => (
        <Card key={title}>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-5 sm:grid-cols-2">
              {values.map(([label, value]) => (
                <Detail key={label} label={label}>
                  <span className="whitespace-pre-wrap break-all">{value || '未设置'}</span>
                </Detail>
              ))}
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
          <Button variant="ghost" className="mb-3 -ml-3" onClick={() => navigate('applications')}>
            <ArrowLeft />
            返回环境与服务
          </Button>
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
        <TabsList>
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
              {find('servers', target.serverId)?.name} ·{' '}
              {target.mode === 'observe' ? '仅观察' : '平台管理'}
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
    [showConfig, setShowConfig] = useState(false)
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
          <Button variant="ghost" className="mb-3 -ml-3" onClick={() => navigate('deployments')}>
            <ArrowLeft />
            返回部署发布
          </Button>
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
        <Card className="release-selection">
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
                      disabled={busy}
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
                        {history?.refreshedAt
                          ? `更新于 ${date(history.refreshedAt)}`
                          : '尚未获取提交记录'}
                      </span>
                    </div>
                    <div
                      role="group"
                      aria-label="选择发布提交"
                      className="commit-list"
                      aria-busy={busy}
                    >
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
                    <p className="text-xs text-muted-foreground">
                      显示当前分支最近 100 条提交；“更新代码”只刷新记录，不会发布服务。
                    </p>
                  </>
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
                ? target.mode === 'observe'
                  ? '此目标由 Jenkins / 外部管理，仅供查看。'
                  : '服务器离线或未启用平台部署。'
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
export function StageFlow({ task, selected, onSelect }) {
  const history = task.stageHistory || [],
    detailed = history.some((s) => s.stage.startsWith('source_'))
  const center =
    task.action === 'deploy'
      ? detailed
        ? [
            ['source_fetch', '拉取代码'],
            ['source_resolve', '固定提交'],
            ['source_archive', '打包 ZIP'],
          ]
        : [['preparing', '准备源码']]
      : []
  const image = task.detailedAgentStages || history.some((s) => s.stage === 'image')
  const agent =
    task.action === 'deploy'
      ? [
          ['downloading', '拉取源码'],
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
  return (
    <div id="deploy-task-progress" className="space-y-4">
      {[
        [Cloud, '中心服务', center, 'center'],
        [Server, 'Agent · 服务器', agent, 'agent'],
      ]
        .filter((v) => v[2].length)
        .map(([Icon, title, steps, owner]) => (
          <Card key={owner} className={`flow-group ${owner}`}>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Icon className="size-4" />
                {title}
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {owner === 'center' ? '固定源码' : '执行与验证'}
              </span>
            </CardHeader>
            <CardContent>
              <div className="stage-list">
                {steps.map(([stage, label], i) => {
                  const entries = history.filter((e) => e.stage === stage),
                    running = !finished(task) && task.stage === stage
                  const failed =
                    finished(task) &&
                    task.status !== 'succeeded' &&
                    entries.some((e) => e === history.at(-1))
                  const ms = entries.reduce(
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
                  return (
                    <div
                      key={stage}
                      className={`stage-step ${running ? 'active' : entries.length ? 'complete' : ''}`}
                    >
                      <div className="stage-connector" />
                      <Button
                        variant="ghost"
                        aria-pressed={selected === stage}
                        className={`stage-button ${failed ? 'text-destructive' : ''}`}
                        onClick={() => onSelect(selected === stage ? '' : stage)}
                      >
                        <span
                          className={`stage-token ${running ? 'active' : entries.length ? 'complete' : ''}`}
                        >
                          {running ? (
                            <LoaderCircle className="size-4 animate-spin" />
                          ) : entries.length && !failed ? (
                            <Check className="size-4" />
                          ) : (
                            i + 1
                          )}
                        </span>
                        <span className="text-xs font-medium">{label}</span>
                        <span className="stage-time">
                          {entries.length ? msLabel(ms) : finished(task) ? '无记录' : '等待'}
                        </span>
                      </Button>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        ))}
      {history.some((e) => e.stage === 'queued') && (
        <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Package className="size-3.5" />
          源码交接 · 服务器队列{' '}
          {msLabel(
            history
              .filter((e) => e.stage === 'queued')
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
              ),
          )}
          {task.status === 'queued' && ' · 等待 Agent 领取'}
        </p>
      )}
    </div>
  )
}
export function TaskWorkbench({ id }) {
  const { request, endpoint, find, version, navigate, nameOfTarget } = useConsole()
  const [task, setTask] = useState(null),
    [logs, setLogs] = useState([]),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(''),
    [showConfig, setShowConfig] = useState(false),
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
  }, [logs, selected])
  const target = find('targets', task?.targetId),
    outcome = task?.result
  return (
    <div className="space-y-6" id="task-workbench">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button
            variant="ghost"
            className="mb-3 -ml-3"
            onClick={() => navigate('tasks')}
            data-close-task
          >
            <ArrowLeft />
            返回发布记录
          </Button>
          <h1 id="page-title" className="text-xl font-semibold">
            {task
              ? `${actionNames[task.action]} ${find('services', target?.serviceId)?.name || '服务'}`
              : '发布详情'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {task && nameOfTarget(target)}
            {target && ` / ${find('servers', target.serverId)?.name || ''}`}
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowConfig((v) => !v)}>
          查看本次配置
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {task ? (
        <>
          <Card>
            <CardContent
              id="deploy-task-info"
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <Status value={task.status}>{resultName(task)}</Status>
              <Commit value={revisionOf(task)} />
              <span className="flex items-center gap-2 text-sm">
                <Clock3 className="size-4 text-muted-foreground" />
                总耗时 {duration({ ...task, startedAt: task.createdAt })}
              </span>
              <span className="text-xs text-muted-foreground">{date(task.createdAt)}</span>
            </CardContent>
          </Card>
          {showConfig && (
            <Configuration
              target={{
                ...target,
                config:
                  task.action === 'rollback' ? task.release?.config || task.config : task.config,
              }}
            />
          )}
          <StageFlow task={task} selected={selected} onSelect={setSelected} />
          <div id="deploy-task-result" className="space-y-2">
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
            {outcome?.release?.image && (
              <p className="break-all font-mono text-xs">镜像：{outcome.release.image}</p>
            )}
            {outcome?.release?.kind === 'static' && (
              <p className="break-all text-xs">静态版本：{outcome.release.artifact}</p>
            )}
          </div>
        </>
      ) : (
        <Skeleton className="h-56" />
      )}
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">
            执行日志{selected && ` · ${stageLabel(selected, task?.config?.kind)}`}
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setSelected('')}>
            全部日志
          </Button>
        </CardHeader>
        <CardContent>
          <pre
            id="deploy-task-logs"
            ref={output}
            aria-label="执行日志"
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget
              nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
            }}
            className="h-80 max-w-full overflow-auto rounded-lg bg-muted/60 p-4 font-mono text-xs leading-6"
          >
            {[
              ...(task?.stageHistory || [])
                .filter((e) => e.stage.startsWith('source_') && (!selected || e.stage === selected))
                .map((e) => `[${date(e.startedAt)}] [中心] ${stageLabel(e.stage)}\n`),
              ...logs
                .filter((l) => !selected || l.stage === selected)
                .map(
                  (l) =>
                    `[${date(l.at)}] [${stageLabel(l.stage, task?.config?.kind)}] ${l.message}\n`,
                ),
            ].join('') || '等待任务日志…'}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
