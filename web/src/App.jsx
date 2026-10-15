import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { navigateSafely, hasUnsavedChanges, setGuardHandler } from '@/lib/navigation-guard'
import { ServiceList, Environments, ServiceSetup, ServiceDetail } from './components/service-pages'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  FolderKanban,
  LayoutDashboard,
  GitFork,
  Server,
  Layers,
  Rocket,
  History,
  KeyRound,
  ListChecks,
  ChevronDown,
  LogOut,
  LockKeyhole,
  Plus,
  RefreshCw,
  ArrowRight,
  Download,
  LoaderCircle,
  Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Skeleton } from '@/components/ui/skeleton'
import { Selection, SelectionOption } from '@/components/selection'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { ConsoleContext, pageNames, parseRoute, routeUrl } from '@/lib/console'
import { Field, Notice } from './components/shared'
import {
  Overview,
  Repositories,
  Servers,
  Services,
  Targets,
  Tasks,
  Credentials,
  Activity,
} from './components/pages'
import { WorkspaceHome } from './components/workspace-home'
import { ReleaseWorkbench, TaskWorkbench, ConfigurationPage } from './components/release-workbench'
import { Confirmation, Dialogs } from './components/dialogs'

const blank = {
  projects: [],
  repositories: [],
  servers: [],
  environments: [],
  services: [],
  targets: [],
  tasks: [],
  environmentSources: [],
  credentials: [],
  events: [],
}
const views = {
  home: WorkspaceHome,
  release: ReleaseWorkbench,
  configuration: ServiceDetail,
  service: ServiceDetail,
  setup: ServiceSetup,
  services: ServiceList,
  environments: Environments,
  overview: Overview,
  projects: Repositories,
  servers: Servers,
  'system-servers': Servers,
  applications: Services,
  deployments: Targets,
  tasks: Tasks,
  credentials: Credentials,
  activity: Activity,
}
const createLabels = {
  home: ['创建项目', 'workspace'],
  projects: ['添加仓库', 'repository'],
  servers: ['接入新服务器', 'server'],
  services: ['新增服务', 'service'],
  environments: ['新增环境', 'environment'],
  credentials: ['新增凭证', 'credential'],
  'system-servers': ['接入服务器', 'server'],
}
function Brand() {
  return (
    <div className="flex items-center gap-3">
      <Box className="size-5" />
      <span className="text-base font-semibold tracking-tight">AutoOps</span>
    </div>
  )
}
async function readResponse(response) {
  const result = await response.json()
  if (!response.ok) {
    const error = new Error(result.error || '请求失败')
    error.status = response.status
    throw error
  }
  return result
}
export default function App() {
  const [session, setSession] = useState(null),
    [error, setError] = useState(''),
    [route, setRoute] = useState(parseRoute)
  const download = /^\/download\/([a-f0-9-]{36})$/.exec(location.pathname)
  const reloadSession = useCallback(async () => {
    try {
      const result = await readResponse(await fetch('/api/session'))
      setSession(result)
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }, [])
  useEffect(() => {
    if (!download) reloadSession()
    let accepted = location.hash
    const change = () => {
      const next = location.hash
      if (hasUnsavedChanges()) {
        history.replaceState(null, '', location.pathname + location.search + accepted)
        navigateSafely(() => {
          location.hash = next
        })
      } else {
        accepted = next
        setRoute(parseRoute())
      }
    }
    const unload = (event) => {
      if (hasUnsavedChanges()) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', unload)
    window.addEventListener('hashchange', change)
    return () => {
      window.removeEventListener('hashchange', change)
      window.removeEventListener('beforeunload', unload)
    }
  }, [])
  if (download) return <DownloadPage id={download[1]} />
  if (!session)
    return (
      <div className="mx-auto max-w-md p-8 pt-28">
        <Brand />
        <div className="mt-8 space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        {error && (
          <Notice error>
            {error}
            <Button variant="outline" onClick={reloadSession}>
              重试
            </Button>
          </Notice>
        )}
      </div>
    )
  if (!session.authenticated) return <Auth session={session} onSuccess={reloadSession} />
  return (
    <TooltipProvider>
      <Console
        key={route.workspaceId || `system:${route.view}`}
        route={route}
        session={session}
        reloadSession={reloadSession}
      />
    </TooltipProvider>
  )
}
function Auth({ session, onSuccess }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <main id="auth-view" className="grid min-h-svh place-items-center p-5">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex justify-center">
          <Brand />
        </div>
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl">
              {session.initialized ? '登录工作台' : '创建管理账号'}
            </CardTitle>
            <CardDescription>
              {session.initialized
                ? '进入项目空间，管理每一次交付。'
                : '输入中心的初始化口令，设置管理员账号。'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              id="auth-form"
              className="space-y-5"
              onSubmit={async (e) => {
                e.preventDefault()
                if (busy) return
                const input = Object.fromEntries(new FormData(e.currentTarget))
                setBusy(true)
                setError('')
                try {
                  await readResponse(
                    await fetch(session.initialized ? '/api/login' : '/api/setup', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(input),
                    }),
                  )
                  await onSuccess()
                } catch (e) {
                  setError(e.message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {!session.initialized && (
                <div id="bootstrap-field">
                  <Field
                    name="bootstrapToken"
                    label="初始化口令"
                    required
                    type="password"
                    autoComplete="off"
                  />
                </div>
              )}
              <Field
                name="username"
                label="管理员账号"
                defaultValue="admin"
                required
                autoComplete="username"
              />
              <Field
                name="password"
                label="密码"
                type="password"
                required
                minLength={session.initialized ? 1 : 12}
                autoComplete={session.initialized ? 'current-password' : 'new-password'}
                hint={!session.initialized ? '至少 12 位字符。' : undefined}
              />
              {error && (
                <p id="auth-error" role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
                {session.initialized ? '登录工作台' : '创建账号并进入'}
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground">项目 · 环境 · 服务 · 发布</p>
      </div>
    </main>
  )
}
function Console({ route, session, reloadSession }) {
  const scope = route.workspaceId,
    endpoint = scope ? `/api/workspaces/${scope}` : '/api/deploy'
  const [data, setData] = useState(blank),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [version, setVersion] = useState(0)
  const [dialog, setDialog] = useState(null),
    [confirmation, setConfirmation] = useState(null)
  const life = useRef({ active: true, controller: new AbortController() }),
    refreshState = useRef({ busy: false, again: false })
  useEffect(
    () =>
      setGuardHandler((action) =>
        setConfirmation({
          title: '离开未保存的配置？',
          description: '当前步骤的修改尚未保存。离开将放弃这些修改，已保存的步骤会保留。',
          action,
          confirmLabel: '放弃修改并离开',
        }),
      ),
    [],
  )
  const request = useCallback(
    async (url, body, method) => {
      const current = life.current
      const response = await fetch(url, {
        signal: current.controller.signal,
        method: method || (body !== undefined ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      if (!current.active) throw new DOMException('项目已切换', 'AbortError')
      try {
        const value = await readResponse(response)
        if (!current.active) throw new DOMException('项目已切换', 'AbortError')
        return value
      } catch (e) {
        if (e.status === 401 && url !== '/api/password') await reloadSession()
        throw e
      }
    },
    [session.csrf, reloadSession],
  )
  const refresh = useCallback(async () => {
    const current = life.current,
      queue = refreshState.current
    if (queue.busy) {
      queue.again = true
      return
    }
    queue.busy = true
    try {
      let value
      if (scope) {
        const [workspace, credentials] = await Promise.all([
          request(endpoint),
          request('/api/credentials'),
        ])
        value = { ...blank, ...workspace, credentials: credentials.credentials }
      } else if (route.view === 'home') value = { ...blank, ...(await request('/api/workspaces')) }
      else if (route.view === 'system-servers')
        value = { ...blank, ...(await request('/api/deploy/overview')) }
      else value = { ...blank, ...(await request('/api/overview')) }
      if (current.active) {
        setData(value)
        setLoaded(true)
        setError('')
        setVersion((v) => v + 1)
      }
    } catch (e) {
      if (current.active && e.name !== 'AbortError') setError(`加载失败：${e.message}`)
    } finally {
      queue.busy = false
      if (current.active && queue.again) {
        queue.again = false
        queueMicrotask(refresh)
      }
    }
  }, [scope, route.view, request, endpoint])
  useEffect(() => {
    refresh()
  }, [refresh])
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) refresh()
    }, 5000)
    return () => {
      clearInterval(interval)
    }
  }, [refresh])
  useEffect(() => {
    if (!scope && route.view !== 'system-servers') return
    let timer
    const stream = new EventSource(`${endpoint}/events`)
    const schedule = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        refresh()
      }, 250)
    }
    stream.addEventListener('update', schedule)
    stream.onopen = schedule
    return () => {
      stream.close()
      clearTimeout(timer)
    }
  }, [scope, endpoint, refresh])
  useEffect(
    () => () => {
      life.current.active = false
      life.current.controller.abort()
    },
    [],
  )
  const linkedTarget = data.targets.find(
    (t) =>
      t.id === (route.targetId || data.tasks.find((task) => task.id === route.taskId)?.targetId),
  )
  const environmentId = data.environments.some((e) => e.id === route.environmentId)
    ? route.environmentId
    : linkedTarget?.environmentId ||
      data.environments.find((e) => e.name === '测试')?.id ||
      data.environments[0]?.id ||
      null
  useEffect(() => {
    if (loaded && scope && route.environmentId !== environmentId)
      history.replaceState(
        null,
        '',
        routeUrl(route.view, scope, environmentId, route.taskId, route),
      )
  }, [loaded, scope, environmentId, route])
  useEffect(() => {
    setDialog(null)
    setConfirmation(null)
  }, [route.view, route.environmentId, route.taskId, route.targetId, route.serviceId])
  useEffect(() => {
    if (loaded && route.editor === 'service') {
      location.hash = routeUrl('setup', scope, environmentId)
    }
  }, [loaded, route.editor])
  const targets = data.targets.filter((t) => !environmentId || t.environmentId === environmentId)
  const tasks = data.tasks.filter(
    (t) =>
      !environmentId ||
      data.targets.some((v) => v.id === t.targetId && v.environmentId === environmentId),
  )
  const find = (list, id) => data[list]?.find((v) => v.id === id)
  const nameOfTarget = (target) =>
    target
      ? `${data.project?.name || '项目'} / ${find('environments', target.environmentId)?.name || '环境'} / ${find('services', target.serviceId)?.name || '服务'}`
      : '已归档目标'
  const navigate = (view, taskId, env = environmentId) =>
    navigateSafely(() => {
      view =
        { applications: 'services', deployments: 'services', configuration: 'service' }[view] ||
        view
      const target = data.targets.find((t) => t.id === route.targetId)
      const serviceId = route.serviceId || target?.serviceId
      const nextTarget =
        data.targets.find(
          (t) =>
            t.serviceId === serviceId && t.environmentId === env && t.serverId === target?.serverId,
        ) || data.targets.find((t) => t.serviceId === serviceId && t.environmentId === env)
      location.hash = routeUrl(
        view === 'release' && !nextTarget ? 'services' : view,
        scope,
        env,
        taskId,
        ['release', 'service', 'setup'].includes(view)
          ? { serviceId, targetId: nextTarget?.id, step: route.step, tab: route.tab }
          : {},
      )
    })
  const enter = (id) =>
    navigateSafely(() => {
      location.hash = routeUrl('overview', id)
    })
  const notify = (text) => {
    if (life.current.active) toast.success(text)
  }
  const open = (kind, item) => {
    if (kind === 'setup' || (kind === 'service' && !item)) {
      navigateSafely(() => {
        location.hash = routeUrl('setup', scope, environmentId, null, { serviceId: item?.id })
      })
      return
    }
    if (kind === 'release') {
      location.hash = routeUrl('release', scope, item.target.environmentId, null, {
        targetId: item.target.id,
        action: item.action,
        releaseId: item.releaseId,
      })
      return
    }
    if (life.current.active) navigateSafely(() => setDialog({ kind, item }))
  }
  const confirm = (title, description, action) => setConfirmation({ title, description, action })
  const inlineEditor = [
    'workspace',
    'repository',
    'service',
    'source',
    'target',
    'environment',
    'server',
    'binding',
  ].includes(dialog?.kind)
  const Page = views[route.view]
  return (
    <ConsoleContext.Provider
      value={{
        data,
        scope,
        route,
        environmentId,
        endpoint,
        request,
        refresh,
        loaded,
        find,
        nameOfTarget,
        targets,
        tasks,
        navigate,
        enter,
        open,
        confirm,
        notify,
        version,
        reloadSession,
        formLayout: inlineEditor ? 'page' : 'dialog',
      }}
    >
      <SidebarProvider
        className="console-shell"
        style={{ '--sidebar-width': 'var(--console-sidebar-width)' }}
      >
        <Navigation
          route={route}
          data={data}
          session={session}
          navigate={navigate}
          open={open}
          request={request}
          reloadSession={reloadSession}
        />
        <SidebarInset id="app-view" className="console-main min-w-0">
          <header className="console-header">
            <SidebarTrigger aria-label="切换导航" />
            <Breadcrumb className="min-w-0 flex-1">
              <BreadcrumbList>
                {scope ? (
                  <>
                    <BreadcrumbItem className="breadcrumb-home">
                      <BreadcrumbLink href={routeUrl('home')}>项目</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="breadcrumb-home" />
                    <BreadcrumbItem>
                      <BreadcrumbLink
                        id="workspace-name"
                        className="breadcrumb-project"
                        href={routeUrl('overview', scope, environmentId)}
                      >
                        {data.project?.name || '正在加载…'}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    {route.taskId && (
                      <>
                        <BreadcrumbItem>
                          <BreadcrumbLink
                            data-close-task
                            href={routeUrl('tasks', scope, environmentId)}
                          >
                            发布记录
                          </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                      </>
                    )}
                    <BreadcrumbItem>
                      <BreadcrumbPage>
                        {route.taskId ? '发布详情' : pageNames[route.view][0]}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                ) : (
                  <BreadcrumbItem>
                    <BreadcrumbPage>{pageNames[route.view][0]}</BreadcrumbPage>
                  </BreadcrumbItem>
                )}
              </BreadcrumbList>
            </Breadcrumb>
            {scope && !['projects', 'servers', 'environments'].includes(route.view) && (
              <div className="flex max-w-48 items-center gap-2">
                <LabelText />
                <Selection
                  id="environment-select"
                  aria-label="当前环境"
                  value={environmentId || ''}
                  disabled={!loaded || !data.environments.length}
                  onChange={(e) => navigate(route.view, null, e.target.value)}
                >
                  {data.environments.map((env) => (
                    <SelectionOption key={env.id} value={env.id}>
                      {env.name}
                    </SelectionOption>
                  ))}
                </Selection>
              </div>
            )}
            <Badge variant="outline" className="hidden gap-1.5 text-xs sm:flex">
              <span className="size-1.5 rounded-full bg-primary" />
              管理员
            </Badge>
          </header>
          <main className="console-body">
            {!['home', 'release', 'configuration', 'service', 'setup'].includes(route.view) &&
              !route.taskId &&
              !inlineEditor && (
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h1 id="page-title" className="text-xl font-semibold tracking-tight">
                      {pageNames[route.view][0]}
                    </h1>
                  </div>
                  <div className="ml-auto flex flex-wrap justify-end gap-2">
                    {route.view === 'overview' && (
                      <Button
                        variant="outline"
                        disabled={!loaded}
                        onClick={() => open('workspace', data.project)}
                      >
                        <Settings2 />
                        项目设置
                      </Button>
                    )}
                    {route.view === 'servers' && scope && (
                      <Button
                        className="bind-server"
                        variant="outline"
                        disabled={!loaded}
                        onClick={() => open('binding')}
                      >
                        <Plus />
                        绑定已接入服务器
                      </Button>
                    )}
                    {createLabels[route.view] && (
                      <Button
                        id="create-button"
                        variant={route.view === 'servers' ? 'outline' : 'default'}
                        disabled={!loaded}
                        onClick={() => open(createLabels[route.view][1])}
                      >
                        <Plus />
                        {createLabels[route.view][0]}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            {error && (
              <Notice error>
                <span id="connection-error">{error}</span>
                <Button size="sm" variant="outline" onClick={refresh}>
                  <RefreshCw />
                  重试
                </Button>
              </Notice>
            )}
            {!loaded ? (
              <div className="grid gap-4 sm:grid-cols-3" aria-label="正在加载">
                <Skeleton className="h-36" />
                <Skeleton className="h-36" />
                <Skeleton className="h-36" />
              </div>
            ) : (
              <div
                id="deploy-view"
                data-page={route.view}
                className="view-enter"
                key={`${route.view}:${environmentId}:${route.targetId || ''}:${route.serviceId || ''}:${route.taskId || ''}`}
              >
                {inlineEditor ? (
                  <Dialogs
                    key={`${dialog.kind}:${dialog.item?.id || 'new'}`}
                    value={dialog}
                    onClose={() => setDialog(null)}
                  />
                ) : route.taskId ? (
                  <TaskWorkbench key={route.taskId} id={route.taskId} />
                ) : (
                  <Page />
                )}
              </div>
            )}
          </main>
        </SidebarInset>
      </SidebarProvider>
      {dialog && !inlineEditor && (
        <Dialogs
          key={`${dialog.kind}:${dialog.item?.id || ''}`}
          value={dialog}
          onClose={() => setDialog(null)}
        />
      )}
      {confirmation && <Confirmation value={confirmation} onClose={() => setConfirmation(null)} />}
      <Toaster />
    </ConsoleContext.Provider>
  )
}
function LabelText() {
  return <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">当前环境</span>
}
function Navigation({ route, data, session, navigate, open, request, reloadSession }) {
  const { setOpenMobile } = useSidebar()
  const storageKey = 'cmr:setup-navigation:' + route.workspaceId
  const [setupOpen, setSetupOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== 'closed'
    } catch {
      return true
    }
  })
  const changeSetup = (value) => {
    setSetupOpen(value)
    try {
      localStorage.setItem(storageKey, value ? 'open' : 'closed')
    } catch {}
  }
  const nav = (view, label, Icon) => (
    <SidebarMenuItem key={view}>
      <SidebarMenuButton
        asChild
        isActive={
          route.view === view ||
          (view === 'services' && ['release', 'service', 'setup'].includes(route.view))
        }
        tooltip={label}
      >
        <a
          href={routeUrl(view, route.workspaceId, route.environmentId)}
          data-view={view}
          aria-current={route.view === view ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault()
            navigate(view)
            setOpenMobile(false)
          }}
        >
          <Icon />
          <span>{label}</span>
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="px-4 py-5">
        <Brand />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{nav('home', '项目', FolderKanban)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {route.workspaceId && (
          <SidebarGroup>
            <SidebarGroupLabel className="mb-2 truncate">
              {data.project?.name || '项目空间'}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {nav('overview', '项目概览', LayoutDashboard)}
                <SidebarMenuItem>
                  <Collapsible open={setupOpen} onOpenChange={changeSetup}>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton>
                        <ListChecks />
                        <span>接入配置</span>
                        <ChevronDown className={setupOpen ? 'ml-auto rotate-180' : 'ml-auto'} />
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenu className="mt-1 ml-3 w-auto border-l pl-2">
                        {nav('projects', '代码仓库', GitFork)}
                        {nav('environments', '环境管理', Layers)}
                        {nav('servers', '项目服务器', Server)}
                      </SidebarMenu>
                    </CollapsibleContent>
                  </Collapsible>
                </SidebarMenuItem>
                {nav('services', '服务与部署', Rocket)}
                {nav('tasks', '发布记录', History)}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarGroup className="mt-4">
          <SidebarGroupLabel>系统管理</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {[
                ['system-servers', '服务器管理', Server],
                ['credentials', '共享凭证', KeyRound],
                ['activity', '操作记录', ListChecks],
              ].map((args) => nav(...args))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-12 w-full justify-between">
              <span className="flex items-center gap-3">
                <span className="grid size-8 place-items-center rounded-full border bg-background text-xs font-semibold">
                  {session.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="text-left">
                  <span className="block text-xs font-semibold">{session.username}</span>
                  <span className="text-[10px] font-normal text-muted-foreground">系统管理员</span>
                </span>
              </span>
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel>账号管理</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setOpenMobile(false)
                open('password')
              }}
            >
              <LockKeyhole />
              修改密码
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                try {
                  await request('/api/logout', {})
                  await reloadSession()
                } catch {
                  await reloadSession()
                }
              }}
            >
              <LogOut />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
function DownloadPage({ id }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [progress, setProgress] = useState('')
  return (
    <main id="download-view" className="grid min-h-svh place-items-center p-5">
      <div className="w-full max-w-lg space-y-8">
        <Brand />
        <Card>
          <CardHeader>
            <CardTitle>下载交付源码</CardTitle>
            <CardDescription>输入专属下载密码，获取仓库默认下载分支的最新源码包。</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              id="download-form"
              className="space-y-5"
              onSubmit={async (e) => {
                e.preventDefault()
                if (busy) return
                const form = e.currentTarget
                const token = new FormData(form).get('token').trim()
                setBusy(true)
                setError('')
                setProgress('正在验证密码、同步最新源码并准备下载…')
                try {
                  const response = await fetch(`/api/projects/${id}/source/latest`, {
                    headers: { Authorization: `Bearer ${token}` },
                  })
                  if (!response.ok) throw new Error((await response.json()).error || '下载失败')
                  const blob = await response.blob()
                  const url = URL.createObjectURL(blob),
                    link = document.createElement('a')
                  link.href = url
                  link.download = `source-${(response.headers.get('X-Source-Revision') || 'latest').slice(0, 12)}.zip`
                  document.body.append(link)
                  link.click()
                  link.remove()
                  setTimeout(() => URL.revokeObjectURL(url), 60000)
                  setProgress(
                    `下载完成 · ${(blob.size / 1024 / 1024).toFixed(2)} MB · SHA-256：${response.headers.get('X-Archive-SHA256')}`,
                  )
                  form.reset()
                } catch (e) {
                  setError(e.message)
                  setProgress('未下载源码包，请修正密码或稍后重试。')
                } finally {
                  setBusy(false)
                }
              }}
            >
              <Field name="token" label="下载密码" type="password" required autoComplete="off" />
              <Button className="w-full" type="submit" disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Download />}下载最新源码
              </Button>
              {error && (
                <p id="download-error" role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {progress && (
                <p
                  id="download-progress"
                  role="status"
                  className="break-all text-xs text-muted-foreground"
                >
                  {progress}
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
