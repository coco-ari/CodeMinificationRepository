import { useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  Circle,
  Code2,
  Copy,
  Database,
  Download,
  FileSearch,
  GitBranch,
  Globe,
  HardDrive,
  History,
  Laptop,
  Link2,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Network,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Terminal,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { usePrototype, pluginCatalog } from './context'
import { PageHeader, Picker, StateBadge, ArrowLink, CopyButton, copyText, SmallEmpty } from './ui'

export function ServicesPage() {
  const { project, environment, environmentLabel, route, navigate, updateProject } = usePrototype()
  const [serviceId, setServiceId] = useState(route.tab === 'release' ? route.id : null)
  const [progress, setProgress] = useState(null)
  const [sourceId, setSourceId] = useState(
    project.artifacts.find((artifact) => artifact.type === 'source')?.id || '',
  )
  const [result, setResult] = useState(null)
  const timer = useRef(null)
  useEffect(() => () => clearInterval(timer.current), [])
  useEffect(() => {
    if (route.tab === 'release') {
      setServiceId(route.id)
      setResult(null)
    }
  }, [route.tab, route.id])
  const service = project.services.find((item) => item.id === serviceId)
  const source = project.artifacts.find((item) => item.id === sourceId)
  const launch = () => {
    if (!source || !service) {
      toast.error('请选择可用的源码快照')
      return
    }
    let original = source
    const visited = new Set()
    while (original && !visited.has(original.id)) {
      visited.add(original.id)
      const parent = project.artifacts.find((item) => item.id === original.sourceId)
      if (!parent) break
      original = parent
    }
    const snapshot = {
      serviceName: service.name,
      serviceId: service.id,
      configVersion: project.configVersion,
      sourceId,
      environment: service.environment,
      commit: original.commit || original.sourceId || '示例快照',
    }
    setProgress(0)
    let step = 0
    timer.current = setInterval(() => {
      step += 1
      setProgress(step * 25)
      if (step === 4) {
        clearInterval(timer.current)
        const release = {
          ...snapshot,
          id: crypto.randomUUID(),
          status: '发布成功',
          createdAt: new Date().toLocaleString('zh-CN'),
          simulated: true,
        }
        updateProject((current) => ({
          ...current,
          services: current.services.map((item) =>
            item.id === service.id ? { ...item, commit: snapshot.commit, status: 'running' } : item,
          ),
          releases: [release, ...current.releases],
          activities: [
            {
              id: crypto.randomUUID(),
              title: `${service.name} 模拟发布成功`,
              time: '刚刚',
              type: 'deploy',
            },
            ...current.activities,
          ].slice(0, 30),
        }))
        setResult(release)
        toast.success('模拟发布成功', { description: '未连接服务器，原型运行版本已更新。' })
      }
    }, 500)
  }
  const stop = () => {
    clearInterval(timer.current)
    setProgress(null)
    toast.info('已取消模拟发布')
  }
  const close = () => {
    clearInterval(timer.current)
    setServiceId(null)
    setProgress(null)
    setResult(null)
  }
  return (
    <div className="proto-page">
      <PageHeader title="服务与部署">
        <Button variant="outline" onClick={() => navigate('materials', 'repository')}>
          <Settings2 />
          管理源码配置
        </Button>
      </PageHeader>
      <Tabs
        value={route.tab === 'history' ? 'history' : 'services'}
        onValueChange={(value) => navigate('services', value === 'history' ? 'history' : '')}
      >
        <TabsList>
          <TabsTrigger value="services">环境服务</TabsTrigger>
          <TabsTrigger value="history">发布记录</TabsTrigger>
        </TabsList>
        <TabsContent value="services">
          <div className="mt-5 grid gap-5 lg:grid-cols-3">
            {project.services
              .filter((item) => item.environment === environment)
              .map((item) => (
                <Card key={item.id} className="gap-5">
                  <CardHeader>
                    <div className="mb-3 flex items-center justify-between">
                      <span className="proto-icon-box">
                        <BoxIcon id={item.id} />
                      </span>
                      <StateBadge>运行中</StateBadge>
                    </div>
                    <CardTitle className="text-lg">{item.name}</CardTitle>
                    <CardDescription>{item.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">运行环境</span>
                      <span>{environmentLabel}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">发布分支</span>
                      <span className="flex items-center gap-2">
                        <GitBranch className="size-3.5" />
                        {item.branch}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">运行版本</span>
                      <span className="flex items-center font-mono text-xs">
                        {item.commit}
                        <CopyButton value={item.commit} />
                      </span>
                    </div>
                    <Separator />
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        onClick={() => {
                          setServiceId(item.id)
                          setProgress(null)
                          setResult(null)
                        }}
                      >
                        <Rocket />
                        发布更新
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={`查看${item.name}发布记录`}
                        onClick={() => navigate('services', 'history')}
                      >
                        <History />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
          </div>
          <p className="mt-5 text-xs text-muted-foreground">
            当前为模拟环境，发布流程仅更新浏览器中的示例版本与记录。
          </p>
        </TabsContent>
        <TabsContent value="history">
          <Card className="mt-5">
            <CardHeader>
              <CardTitle>发布记录</CardTitle>
            </CardHeader>
            <CardContent>
              {!project.releases.length ? (
                <SmallEmpty
                  title="暂无本轮体验记录"
                  description="发起一次模拟发布，查看固定源码与配置版本。"
                >
                  <Button onClick={() => navigate('services')}>查看环境服务</Button>
                </SmallEmpty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>服务</TableHead>
                      <TableHead>环境</TableHead>
                      <TableHead>源码</TableHead>
                      <TableHead>配置</TableHead>
                      <TableHead>结果</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {project.releases.map((release) => (
                      <TableRow key={release.id}>
                        <TableCell>
                          {release.serviceName}
                          <p className="mt-1 text-xs text-muted-foreground">{release.createdAt}</p>
                        </TableCell>
                        <TableCell>{release.environment === 'test' ? '测试' : '生产'}</TableCell>
                        <TableCell>
                          <Button
                            variant="link"
                            className="p-0"
                            onClick={() => navigate('materials', 'artifacts', release.sourceId)}
                          >
                            {release.sourceId}
                            <ArrowUpRight />
                          </Button>
                        </TableCell>
                        <TableCell>v{release.configVersion}</TableCell>
                        <TableCell>
                          <StateBadge>{release.status}</StateBadge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <Dialog
        open={Boolean(service)}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{result ? '发布完成' : `发布 ${service?.name || ''}`}</DialogTitle>
            <DialogDescription>
              {environmentLabel}环境 · 模拟发布使用确定的源码和配置版本。
            </DialogDescription>
          </DialogHeader>
          {progress === null ? (
            <div className="space-y-5 py-2">
              <div className="space-y-2">
                <Label>源码快照</Label>
                <Picker
                  value={sourceId}
                  onChange={setSourceId}
                  options={project.artifacts
                    .filter((artifact) => artifact.type === 'source')
                    .map((artifact) => ({ value: artifact.id, label: artifact.name }))}
                  label="发布源码快照"
                />
              </div>
              <div className="rounded-xl border bg-muted/30 p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">配置版本</span>
                  <span>v{project.configVersion}</span>
                </div>
                <div className="mt-3 flex justify-between">
                  <span className="text-muted-foreground">服务当前版本</span>
                  <span className="font-mono">{service?.commit}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-5 py-3">
              <Progress value={progress} />
              <div className="grid grid-cols-4 gap-2">
                {['准备源码', '构建产物', '发布服务', '健康检查'].map((label, index) => (
                  <div className="space-y-2 text-center text-xs" key={label}>
                    {progress >= (index + 1) * 25 ? (
                      <CheckCircle2 className="mx-auto size-5 text-emerald-600" />
                    ) : progress >= index * 25 ? (
                      <LoaderCircle className="mx-auto size-5 animate-spin" />
                    ) : (
                      <Circle className="mx-auto size-5 text-muted-foreground" />
                    )}
                    <div>{label}</div>
                  </div>
                ))}
              </div>
              {result && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                  健康检查通过，模拟运行版本已更新为 {result.commit}。
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {progress === null ? (
              <>
                <Button variant="outline" onClick={close}>
                  取消
                </Button>
                <Button onClick={launch} disabled={!source}>
                  <Rocket />
                  确认模拟发布
                </Button>
              </>
            ) : result ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    close()
                    navigate('services', 'history')
                  }}
                >
                  查看记录
                </Button>
                <Button onClick={close}>完成</Button>
              </>
            ) : (
              <Button variant="outline" onClick={stop}>
                取消模拟发布
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BoxIcon({ id }) {
  return id.includes('web') ? <Monitor /> : id.includes('device') ? <Network /> : <Server />
}

export function ConnectionsPage() {
  const { project, environment, environmentLabel, updateProject, navigate } = usePrototype()
  const [busy, setBusy] = useState(null)
  const [details, setDetails] = useState(null)
  const connectionState = project.connectionStates || {}
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const toggle = (resource) => {
    setBusy(resource.id)
    timer.current = setTimeout(() => {
      updateProject((current) => ({
        ...current,
        connectionStates: {
          ...current.connectionStates,
          [resource.id]: !(current.connectionStates?.[resource.id] ?? resource.connected),
        },
      }))
      setBusy(null)
      toast.success('模拟连接状态已更新')
    }, 700)
  }
  const resources = project.config.resources.filter(
    (resource) => resource.environment === environment && resource.type.toLowerCase() !== 'service',
  )
  return (
    <div className="proto-page">
      <PageHeader title="MCP 与连接">
        <Button variant="outline" onClick={() => navigate('materials', 'resources')}>
          <Settings2 />
          配置环境资源
        </Button>
      </PageHeader>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {resources.map((resource) => {
          const connected = connectionState[resource.id] ?? resource.connected
          const Icon = /^mysql$/i.test(resource.type)
            ? Database
            : /^redis$/i.test(resource.type)
              ? HardDrive
              : Server
          return (
            <Card key={resource.id}>
              <CardHeader>
                <div className="mb-3 flex items-center justify-between">
                  <span className="proto-icon-box">
                    <Icon />
                  </span>
                  <StateBadge tone={connected ? 'success' : 'muted'}>
                    {connected ? '已连接' : '未连接'}
                  </StateBadge>
                </div>
                <CardTitle>{resource.name}</CardTitle>
                <CardDescription>
                  {resource.type} · {environmentLabel}环境
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="rounded-xl border bg-muted/30 p-3 font-mono text-xs break-all">
                  {resource.endpoint}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="size-4" />
                  查询与分析 · 不执行真实连接
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    disabled={busy !== null}
                    onClick={() => toggle(resource)}
                  >
                    {busy === resource.id ? <LoaderCircle className="animate-spin" /> : <Link2 />}
                    {connected ? '断开连接' : '测试并连接'}
                  </Button>
                  <Button variant="outline" onClick={() => setDetails(resource)}>
                    能力
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
      <Dialog open={Boolean(details)} onOpenChange={(open) => !open && setDetails(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{details?.name} · 可用能力</DialogTitle>
            <DialogDescription>
              这些能力来自模拟连接，只用于体验项目内的工具调用。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {(/^mysql$/i.test(details?.type)
              ? ['查看表结构', '只读查询', '解释查询计划']
              : /^redis$/i.test(details?.type)
                ? ['浏览允许的 Key', '读取缓存值', '查看过期时间']
                : ['读取服务日志', '查看文件目录', '查询服务器状态']
            ).map((item) => (
              <div className="flex items-center gap-3 rounded-lg border p-3 text-sm" key={item}>
                <CheckCircle2 className="size-4 text-emerald-600" />
                {item}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setDetails(null)
                navigate('chat', 'new')
              }}
            >
              <MessageSquare />
              使用 Agent 分析
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function ToolsPage() {
  const { project, route, navigate, editDraft, updateProject } = usePrototype()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [apiPath, setApiPath] = useState('/devices')
  const [apiResult, setApiResult] = useState(null)
  const [querying, setQuerying] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const selected = pluginCatalog.find((plugin) => plugin.id === route.tab)
  const config = selected && project.config.plugins[selected.id]
  const openConfig = (id) => navigate('materials', 'plugins', id)
  if (!selected)
    return (
      <div className="proto-page">
        <PageHeader title="项目工具">
          <Button variant="outline" onClick={() => openConfig('cabinet')}>
            <Settings2 />
            管理插件配置
          </Button>
        </PageHeader>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {pluginCatalog.map(({ id, name, icon: Icon }) => (
            <Card key={id}>
              <CardHeader>
                <div className="mb-3 flex items-center justify-between">
                  <span className="proto-icon-box">
                    <Icon />
                  </span>
                  <StateBadge tone={project.config.plugins[id].enabled ? 'success' : 'muted'}>
                    {project.config.plugins[id].enabled ? '已启用' : '未启用'}
                  </StateBadge>
                </div>
                <CardTitle>{name}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="mb-5 flex items-center gap-2 text-xs text-muted-foreground">
                  <Link2 className="size-3.5" />
                  引用项目配置 v{project.configVersion}
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    variant={project.config.plugins[id].enabled ? 'default' : 'outline'}
                    onClick={() =>
                      project.config.plugins[id].enabled ? navigate('tools', id) : openConfig(id)
                    }
                  >
                    {project.config.plugins[id].enabled ? '打开工具' : '前往启用'}
                    <ArrowUpRight />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={`配置${name}`}
                    onClick={() => openConfig(id)}
                  >
                    <Settings2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <Card className="mt-6">
          <CardContent className="flex flex-col items-start gap-3 pt-5 sm:flex-row sm:items-center">
            <LayersIcon />
            <div className="flex-1">
              <p className="text-sm font-medium">在资料区配置一次，在工具中持续使用</p>
              <p className="mt-1 text-xs text-muted-foreground">
                工具启用和参数修改保存在草稿，应用后生效。
              </p>
            </div>
            <ArrowLink onClick={() => navigate('materials', 'plugins')}>查看配置</ArrowLink>
          </CardContent>
        </Card>
      </div>
    )
  if (!config.enabled)
    return (
      <div className="proto-page">
        <PageHeader title={selected.name} />
        <Card>
          <CardContent>
            <SmallEmpty
              title="先启用并应用配置"
              description="配置保留在资料区，启用后可在这里使用。"
            >
              <Button onClick={() => openConfig(selected.id)}>前往插件配置</Button>
            </SmallEmpty>
          </CardContent>
        </Card>
      </div>
    )
  const devices = project.devices.filter(
    (device) =>
      (!search || `${device.id} ${device.name}`.toLowerCase().includes(search.toLowerCase())) &&
      (statusFilter === 'all' || device.status === statusFilter),
  )
  return (
    <div className="proto-page">
      <PageHeader title={config.name || selected.name}>
        <Button variant="outline" onClick={() => navigate('tools')}>
          全部工具
        </Button>
        <Button variant="outline" onClick={() => openConfig(selected.id)}>
          <Settings2 />
          查看配置
        </Button>
      </PageHeader>
      {selected.id === 'cabinet' && (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <Database className="size-4" />
              {project.config.resources.find((resource) => resource.id === config.databaseId)?.name}
            </span>
            <span>·</span>
            <span>{config.group}</span>
            <StateBadge>模拟服务可用</StateBadge>
          </div>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap gap-3">
                <div className="relative min-w-48 flex-1">
                  <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索设备编号或名称"
                    aria-label="搜索设备"
                  />
                </div>
                <Picker
                  value={statusFilter}
                  onChange={setStatusFilter}
                  label="筛选设备状态"
                  options={[
                    { value: 'all', label: '全部状态' },
                    { value: 'online', label: '在线' },
                    { value: 'offline', label: '离线' },
                  ]}
                  className="w-36"
                />
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>设备</TableHead>
                    <TableHead>所属分组</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>最后心跳</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {devices.map((device) => (
                    <TableRow key={device.id}>
                      <TableCell>
                        <div className="font-mono text-xs">{device.id}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{device.name}</div>
                      </TableCell>
                      <TableCell>{config.group}</TableCell>
                      <TableCell>
                        <StateBadge tone={device.status === 'online' ? 'success' : 'muted'}>
                          {device.status === 'online' ? '在线' : '离线'}
                        </StateBadge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {device.heartbeat}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedDevice(device)}
                        >
                          查看设备
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!devices.length && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                        没有匹配的设备
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Dialog
            open={Boolean(selectedDevice)}
            onOpenChange={(open) => !open && setSelectedDevice(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{selectedDevice?.name}</DialogTitle>
                <DialogDescription>设备归属与接入信息均来自本地示例数据。</DialogDescription>
              </DialogHeader>
              <dl className="space-y-4 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">设备编号</dt>
                  <dd className="flex items-center">
                    {selectedDevice?.id}
                    <CopyButton value={selectedDevice?.id} label="复制设备编号" />
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">分组</dt>
                  <dd>{config.group}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">最后心跳</dt>
                  <dd>{selectedDevice?.heartbeat}</dd>
                </div>
              </dl>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setSelectedDevice(null)
                    navigate('chat', 'new')
                  }}
                >
                  <MessageSquare />
                  交给 Agent 分析
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
      {selected.id === 'api' && (
        <Card>
          <CardHeader>
            <CardTitle>发送示例请求</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Label htmlFor="api-path">请求路径</Label>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">GET</Badge>
              <Input
                id="api-path"
                className="min-w-40 flex-1 font-mono"
                value={apiPath}
                onChange={(event) => setApiPath(event.target.value)}
              />
              <Button
                disabled={querying}
                onClick={() => {
                  setQuerying(true)
                  timer.current = setTimeout(() => {
                    setQuerying(false)
                    setApiResult(
                      apiPath.startsWith('/devices')
                        ? { status: 200, simulated: true, data: project.devices }
                        : {
                            status: 404,
                            simulated: true,
                            message: '示例接口不存在，请尝试 /devices',
                          },
                    )
                  }, 650)
                }}
              >
                {querying ? <LoaderCircle className="animate-spin" /> : <ArrowUpRight />}发送请求
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">基础地址：{config.baseUrl}</p>
            {apiResult && <pre className="proto-code">{JSON.stringify(apiResult, null, 2)}</pre>}
          </CardContent>
        </Card>
      )}
      {selected.id === 'logs' && (
        <Card>
          <CardHeader>
            <CardTitle>设备日志分析</CardTitle>
            <CardDescription>
              保留周期 {config.retention} 天 · 使用已绑定的服务器资源。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <pre className="proto-code">
              {
                '[14:32:01] INFO  SOL-00128 heartbeat received\n[14:32:02] WARN  SOL-00129 heartbeat timeout\n[14:32:03] INFO  SOL-00130 heartbeat received\n[14:32:04] WARN  SOL-00131 route group mismatch\n\n以上为模拟日志。'
              }
            </pre>
            <Button onClick={() => navigate('chat', 'new')}>
              <MessageSquare />让 Agent 分析日志
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function LayersIcon() {
  return (
    <span className="proto-icon-box">
      <Link2 />
    </span>
  )
}

export function HostsPage() {
  const { project, updateProject } = usePrototype()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('Codex')
  const addHost = () => {
    if (!name.trim()) {
      toast.error('请填写主机名称')
      return
    }
    updateProject((current) => ({
      ...current,
      agents: [
        ...current.agents,
        {
          id: crypto.randomUUID(),
          name: `${provider} 助手`,
          provider,
          host: name.trim(),
          owner: '陶涛',
          online: true,
          shared: false,
        },
      ],
    }))
    setOpen(false)
    setName('')
    toast.success('模拟主机已接入', { description: '默认仅自己使用，可开启项目共享。' })
  }
  return (
    <div className="proto-page">
      <PageHeader title="我的主机">
        <Button onClick={() => setOpen(true)}>
          <Plus />
          接入主机
        </Button>
      </PageHeader>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {project.agents.map((agent) => (
          <Card key={agent.id}>
            <CardHeader>
              <div className="mb-3 flex items-center justify-between">
                <span className="proto-icon-box">
                  {agent.id === 'builtin' ? <Server /> : <Laptop />}
                </span>
                <StateBadge tone={agent.online ? 'success' : 'muted'}>
                  {agent.online ? '在线' : '离线'}
                </StateBadge>
              </div>
              <CardTitle>{agent.host}</CardTitle>
              <CardDescription>
                {agent.owner} · {agent.provider}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-xl border bg-muted/20 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Bot className="size-4" />
                  {agent.name}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">问答、分析、生成产物</p>
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor={`share-${agent.id}`} className="text-sm">
                  允许本项目使用
                </Label>
                <Switch
                  id={`share-${agent.id}`}
                  checked={agent.shared}
                  disabled={agent.id === 'builtin'}
                  onCheckedChange={(checked) => {
                    updateProject((current) => ({
                      ...current,
                      agents: current.agents.map((item) =>
                        item.id === agent.id ? { ...item, shared: checked } : item,
                      ),
                    }))
                    toast.success(checked ? '已开启项目共享' : '已设为个人 Agent')
                  }}
                />
              </div>
              <Button
                className="w-full"
                variant="outline"
                disabled={agent.id === 'builtin'}
                onClick={() => {
                  updateProject((current) => ({
                    ...current,
                    agents: current.agents.map((item) =>
                      item.id === agent.id ? { ...item, online: !item.online } : item,
                    ),
                  }))
                  toast.info(agent.online ? '模拟主机已断开' : '模拟主机已连接')
                }}
              >
                {agent.id === 'builtin' ? '平台内置运行器' : agent.online ? '模拟断开' : '模拟连接'}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>接入一台模拟主机</DialogTitle>
            <DialogDescription>
              体验主机登记与共享流程，不需要安装或执行任何命令。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <Label htmlFor="host-name">主机名称</Label>
              <Input
                id="host-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：我的开发电脑"
              />
            </div>
            <div className="space-y-2">
              <Label>Agent 运行方式</Label>
              <Picker
                value={provider}
                onChange={setProvider}
                label="Agent 运行方式"
                options={['Codex', 'Claude Code'].map((value) => ({ value, label: value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={addHost}>完成模拟接入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function MembersPage() {
  const { project, updateProject } = usePrototype()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState('查看成员')
  const add = () => {
    if (!name.trim()) {
      toast.error('请填写成员名称')
      return
    }
    updateProject((current) => ({
      ...current,
      members: [
        ...current.members,
        {
          id: crypto.randomUUID(),
          name: name.trim(),
          initials: name.trim()[0],
          role,
          email: 'demo@example.com',
        },
      ],
    }))
    setOpen(false)
    setName('')
    toast.success('示例成员已添加')
  }
  return (
    <div className="proto-page">
      <PageHeader title="项目成员">
        <Button onClick={() => setOpen(true)}>
          <Plus />
          添加示例成员
        </Button>
      </PageHeader>
      <Card>
        <CardContent className="pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>权限范围</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {project.members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="proto-avatar">{member.initials}</div>
                      <div className="font-medium">
                        {member.name}
                        <p className="mt-1 text-xs font-normal text-muted-foreground">
                          {member.email}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{member.role}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {member.role === '项目管理员'
                      ? '配置、成员及全部项目功能'
                      : member.role === '操作成员'
                        ? '维护资料、使用工具与模拟发布'
                        : '查看资料、查询与问答'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加示例成员</DialogTitle>
            <DialogDescription>只更新本地原型数据，不会发送邀请或消息。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="member-name">成员名称</Label>
              <Input
                id="member-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>项目角色</Label>
              <Picker
                value={role}
                onChange={setRole}
                label="项目角色"
                options={['查看成员', '操作成员', '项目管理员'].map((value) => ({
                  value,
                  label: value,
                }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={add}>添加成员</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
