import { useEffect, useState } from 'react'
import {
  Box,
  LayoutDashboard,
  FolderOpen,
  Rocket,
  Cable,
  Network,
  MessageSquare,
  Monitor,
  Users,
  ChevronRight,
  ArrowUpRight,
  Plus,
  RotateCcw,
  FlaskConical,
  GitBranch,
  Clock,
  FileText,
  Bot,
  Code2,
  Palette,
  Layers,
  ArrowRight,
  Settings2,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { usePrototype, pluginCatalog } from './context'
import { Picker, PageHeader, StateBadge, ArrowLink, CopyButton } from './ui'
import { MaterialsPage } from './materials'
import { ArtifactsPage } from './artifacts'
import { ChatPage } from './chat'
import { ServicesPage, ConnectionsPage, ToolsPage, HostsPage, MembersPage } from './operations'

const pages = [
  { id: 'overview', label: '项目概览', icon: LayoutDashboard },
  { id: 'materials', label: '资料与配置', icon: FolderOpen },
  { id: 'services', label: '服务与部署', icon: Rocket },
  { id: 'connections', label: 'MCP 与连接', icon: Cable },
  { id: 'tools', label: '项目工具', icon: Network },
  { id: 'chat', label: 'Agent 对话', icon: MessageSquare },
]
const secondaryPages = [
  { id: 'hosts', label: '我的主机', icon: Monitor },
  { id: 'members', label: '项目成员', icon: Users },
]
const tabLabels = {
  overview: '项目资料',
  documents: '研发资料',
  repository: '仓库与源码',
  resources: '环境资源',
  plugins: '插件配置',
  artifacts: '源码与产物',
}

function Navigation() {
  const { project, projects, projectId, selectProject, route, navigate } = usePrototype()
  const [resetOpen, setResetOpen] = useState(false)
  const { reset } = usePrototype()
  const { setOpenMobile } = useSidebar()
  useEffect(() => {
    setOpenMobile(false)
  }, [route.page, route.tab, route.id, projectId, setOpenMobile])
  return (
    <>
      <Sidebar className="proto-sidebar">
        <SidebarHeader className="gap-6 p-5">
          <div className="flex items-start gap-3">
            <Box className="mt-0.5 size-6" />
            <div>
              <div className="text-lg font-semibold tracking-tight">AutoOps</div>
              <div className="mt-0.5 text-xs text-muted-foreground">项目工作台</div>
            </div>
          </div>
          <Picker
            value={projectId}
            onChange={selectProject}
            options={projects.map((item) => ({ value: item.id, label: item.name }))}
            label="切换项目"
            className="bg-background/70"
          />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="px-3">
            <SidebarGroupLabel>工作空间</SidebarGroupLabel>
            <SidebarMenu className="gap-1">
              {pages.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    onClick={() => navigate(id)}
                    isActive={route.page === id}
                    className="h-10 gap-3 px-3"
                  >
                    <Icon className="size-[18px]" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup className="mt-auto px-3 pb-3">
            <SidebarGroupLabel>协作与资源</SidebarGroupLabel>
            <SidebarMenu className="gap-1">
              {secondaryPages.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    className="h-10 gap-3 px-3"
                    onClick={() => navigate(id)}
                    isActive={route.page === id}
                  >
                    <Icon className="size-[18px]" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t p-4">
          <div className="flex items-center gap-3">
            <div className="proto-avatar">T</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">陶涛</div>
              <div className="text-xs text-muted-foreground">项目管理员</div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="重置示例数据"
              onClick={() => setResetOpen(true)}
            >
              <RotateCcw className="size-4" />
            </Button>
          </div>
          <div className="mt-3 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-amber-500" />
            交互原型 · 模拟数据
          </div>
        </SidebarFooter>
      </Sidebar>
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置示例数据？</DialogTitle>
            <DialogDescription>
              这会清除本浏览器中两个示例项目的配置、产物和对话，恢复最初的演示状态。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              保留数据
            </Button>
            <Button
              onClick={() => {
                reset()
                setResetOpen(false)
              }}
            >
              重置示例
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Overview() {
  const { project, environment, environmentLabel, navigate } = usePrototype()
  const services = project.services.filter((service) => service.environment === environment)
  return (
    <div className="proto-page">
      <PageHeader title={project.name}>
        <Button variant="outline" onClick={() => navigate('materials')}>
          <FolderOpen />
          管理资料
        </Button>
        <Button onClick={() => navigate('chat', 'new')}>
          <MessageSquare />
          开始问答
        </Button>
      </PageHeader>
      <div className="proto-overview-meta">
        <span>
          <FlaskConical />
          {environmentLabel}环境
        </span>
        <Separator orientation="vertical" />
        <span>
          <Settings2 />
          项目配置 v{project.configVersion} · 已生效
        </span>
        <Separator orientation="vertical" />
        <span>
          <Users />
          团队成员 {project.members.length} 人
        </span>
      </div>
      <div className="proto-home-top">
        <Card className="gap-0 py-0">
          <CardHeader className="proto-card-header">
            <CardTitle>服务与部署</CardTitle>
            <ArrowLink onClick={() => navigate('services')}>全部服务</ArrowLink>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="space-y-3">
              {services.map((service, index) => {
                const Icon = [Box, Monitor, Network][index % 3]
                return (
                  <div key={service.id} className="proto-service-row">
                    <Icon className="size-6 shrink-0 text-muted-foreground" />
                    <div className="proto-service-name">
                      <Button
                        variant="link"
                        className="h-auto justify-start p-0 text-sm"
                        onClick={() => navigate('services', '', service.id)}
                      >
                        {service.name}
                        <ChevronRight className="size-3.5" />
                      </Button>
                      <p>{service.description}</p>
                    </div>
                    <StateBadge tone={service.status === 'running' ? 'success' : 'warning'}>
                      {service.status === 'running' ? '运行中' : '发布中'}
                    </StateBadge>
                    <div className="proto-service-version">
                      <span>
                        <GitBranch className="size-3.5" />
                        {service.branch}
                      </span>
                      <span className="font-mono text-xs">
                        {service.commit}
                        <CopyButton value={service.commit} />
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate('services', 'release', service.id)}
                    >
                      更新
                      <ArrowUpRight className="size-3.5" />
                    </Button>
                  </div>
                )
              })}
            </div>
            <div className="mt-5 flex items-center gap-2 border-t pt-4 text-xs text-muted-foreground">
              <Clock className="size-4" />
              {project.releases[0]
                ? `最近发布 · ${project.releases[0].serviceName} · ${project.releases[0].status}`
                : '最近发布 · 今天 14:20 · API 服务更新成功'}
            </div>
          </CardContent>
        </Card>
        <Card className="gap-0 py-0">
          <CardHeader className="proto-card-header">
            <CardTitle>项目资料</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="proto-material-links">
              {[
                {
                  icon: FileText,
                  name: '研发设计',
                  detail: `${project.documents.length} 份资料`,
                  tab: 'documents',
                },
                { icon: Code2, name: '代码仓库', detail: '后端服务 · main', tab: 'repository' },
                {
                  icon: GitBranch,
                  name: '最新源码',
                  detail: `${project.config.branch} · 38e20cf`,
                  tab: 'artifacts',
                },
                {
                  icon: Layers,
                  name: '处理产物',
                  detail: `${project.artifacts.length} 份产物 · 可独立使用`,
                  tab: 'artifacts',
                },
              ].map(({ icon: Icon, name, detail, tab }) => (
                <Button
                  key={name}
                  variant="ghost"
                  className="proto-material-link"
                  onClick={() => navigate('materials', tab)}
                >
                  <span className="proto-icon-box">
                    <Icon />
                  </span>
                  <span className="flex-1 text-left">
                    <span className="block text-sm font-medium">{name}</span>
                    <span className="mt-1 block text-xs font-normal text-muted-foreground">
                      {detail}
                    </span>
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </Button>
              ))}
            </div>
            <div className="mt-4">
              <ArrowLink onClick={() => navigate('materials', 'artifacts')}>
                查看资料与产物
              </ArrowLink>
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="proto-home-bottom">
        <Card className="gap-0 py-0">
          <CardHeader className="proto-card-header">
            <CardTitle>项目工具</CardTitle>
            <ArrowLink onClick={() => navigate('tools')}>管理项目工具</ArrowLink>
          </CardHeader>
          <CardContent className="px-5 pb-3">
            {pluginCatalog.map(({ id, name, icon: Icon }) => (
              <div className="proto-list-row" key={id}>
                <Icon className="size-5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{name}</span>
                  {id === 'cabinet' && (
                    <span className="ml-2 hidden text-xs text-muted-foreground xl:inline">
                      cabinet-router
                    </span>
                  )}
                </div>
                <StateBadge tone={project.config.plugins[id].enabled ? 'success' : 'muted'}>
                  {project.config.plugins[id].enabled ? '已启用' : '未启用'}
                </StateBadge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    navigate(
                      project.config.plugins[id].enabled ? 'tools' : 'materials',
                      project.config.plugins[id].enabled ? id : 'plugins',
                      id,
                    )
                  }
                >
                  {project.config.plugins[id].enabled ? '打开' : '去启用'}
                  <ArrowUpRight className="size-3.5" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="gap-0 py-0">
          <CardHeader className="proto-card-header">
            <CardTitle>可用 Agent</CardTitle>
            <Button size="sm" variant="outline" onClick={() => navigate('chat', 'new')}>
              选择 Agent
            </Button>
          </CardHeader>
          <CardContent className="px-5 pb-3">
            {project.agents.map((agent, index) => {
              const Icon = [Bot, Code2, Palette][index % 3]
              return (
                <Button
                  key={agent.id}
                  variant="ghost"
                  className="proto-agent-row"
                  onClick={() => navigate('chat', 'new')}
                >
                  <Icon className="size-5 text-muted-foreground" />
                  <span className="flex-1 text-left">
                    <span className="block text-sm font-medium">{agent.name}</span>
                    <span className="mt-1 block text-xs font-normal text-muted-foreground">
                      {agent.provider} · {agent.host}
                    </span>
                  </span>
                  <StateBadge tone={agent.online ? 'success' : 'muted'}>
                    {agent.online ? '可用' : '离线'}
                  </StateBadge>
                  <ChevronRight className="size-4" />
                </Button>
              )
            })}
          </CardContent>
        </Card>
      </div>
      <Card className="gap-0 py-0">
        <CardContent className="proto-activity">
          <div className="flex shrink-0 items-center gap-2 font-medium">
            <Clock className="size-4" />
            最近动态
          </div>
          <div className="flex-1 space-y-2">
            {project.activities.slice(0, 2).map((activity) => (
              <div key={activity.id} className="flex flex-wrap items-center gap-3 text-xs">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                <span className="w-20 text-muted-foreground">{activity.time}</span>
                <span>{activity.title}</span>
              </div>
            ))}
          </div>
          <ArrowLink onClick={() => navigate('services', 'history')}>发布记录</ArrowLink>
        </CardContent>
      </Card>
    </div>
  )
}

function Content() {
  const { route, projectId } = usePrototype()
  const page = route.page
  return (
    <div key={projectId} className={page === 'chat' ? 'proto-chat-container' : ''}>
      {page === 'overview' && <Overview />}
      {page === 'materials' &&
        (route.tab === 'artifacts' ? (
          <ArtifactsPage selectedId={route.id} />
        ) : (
          <MaterialsPage tab={route.tab} selectedId={route.id} />
        ))}
      {page === 'services' && <ServicesPage />}
      {page === 'connections' && <ConnectionsPage />}
      {page === 'tools' && <ToolsPage />}
      {page === 'hosts' && <HostsPage />}
      {page === 'members' && <MembersPage />}
      {page === 'chat' && <ChatPage tab={route.tab} selectedId={route.id} />}
      {![...pages, ...secondaryPages].some((item) => item.id === page) && <Overview />}
    </div>
  )
}

export default function PrototypeApp() {
  const { project, route, environment, setEnvironment, storageError, hasDraftChanges, navigate } =
    usePrototype()
  const label =
    [...pages, ...secondaryPages].find((item) => item.id === route.page)?.label || '项目概览'
  return (
    <TooltipProvider>
      <SidebarProvider className="prototype-shell" style={{ '--sidebar-width': '216px' }}>
        <Navigation />
        <SidebarInset className="proto-main">
          <header className="proto-header">
            <div className="flex min-w-0 items-center gap-3">
              <SidebarTrigger />
              <Separator orientation="vertical" className="hidden !h-4 sm:block" />
              <div className="proto-breadcrumb">
                <span>项目</span>
                <ChevronRight />
                <span>{project.name}</span>
                <ChevronRight />
                <strong>
                  {route.page === 'materials' && route.tab ? tabLabels[route.tab] || label : label}
                </strong>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {hasDraftChanges && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="hidden text-amber-700 sm:inline-flex"
                  onClick={() => navigate('materials', 'plugins')}
                >
                  有待应用草稿
                </Button>
              )}
              <span className="hidden text-xs text-muted-foreground lg:inline">当前环境</span>
              <Picker
                value={environment}
                onChange={setEnvironment}
                label="切换环境"
                options={[
                  { value: 'test', label: '测试' },
                  { value: 'production', label: '生产' },
                ]}
                className="w-24"
              />
              <div className="proto-avatar hidden sm:flex">T</div>
            </div>
          </header>
          {storageError && (
            <Alert variant="destructive" className="mx-5 mt-4 w-auto">
              <AlertCircle />
              <AlertDescription>
                浏览器存储已满，本次修改暂时仅保留在内存中。请下载需要的产物后重置示例。
              </AlertDescription>
            </Alert>
          )}
          <main className="proto-content">
            <Content />
          </main>
        </SidebarInset>
      </SidebarProvider>
      <Toaster position="top-center" visibleToasts={1} duration={2400} />
    </TooltipProvider>
  )
}
