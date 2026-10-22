import { useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Bot,
  Boxes,
  FileText,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Plus,
  Search,
  Server,
  Settings,
  Users,
  Activity,
  Layers,
  RotateCcw,
  LockKeyhole,
} from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useWorkbench, uid } from './store'
import {
  Button,
  Input,
  Textarea,
  Badge,
  Picker,
  Panel,
  PageHeader,
  Field,
  Modal,
  Confirm,
  Empty,
  toast,
} from './ui'
import { MaterialsPage } from './materials'
import { AgentsPage, ChatPage, useAgentRuntime } from './agents'
import { CabinetPage } from './cabinet'
import {
  OverviewPage,
  SettingsPage,
  ResourcesPage,
  ServicesPage,
  TasksPage,
  AccountAdminPage,
  NotificationsPage,
} from './operations'
const nav = [
  ['overview', '项目概览', LayoutDashboard],
  ['documents', '资料与配置', FolderOpen],
  ['services', '服务与部署', Layers],
  ['chat', 'Agent 对话', MessageSquare],
  ['tasks', '任务与审计', Activity],
  ['settings', '项目设置', Settings],
]
const materialPages = ['documents', 'repositories', 'artifacts', 'resources']
const pageLabels = {
  documents: '研发资料',
  repositories: '仓库与源码',
  artifacts: '处理产物',
  resources: '环境与资源',
  agents: 'Agent 管理',
}
function Login() {
  const { state, update, navigate } = useWorkbench()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('Demo123!')
  const [error, setError] = useState('')
  function submit(e) {
    e.preventDefault()
    const u = state.users.find((u) => u.username === username && u.password === password)
    if (!u) {
      setError('用户名或密码错误。忘记密码请联系管理员重置。')
      return
    }
    update((d) => {
      d.userId = u.id
    })
    navigate('/')
  }
  return (
    <div className="wb-login">
      <div className="wb-login-art">
        <div className="wb-brand">
          <span>
            <Boxes />
          </span>
          AutoOps
        </div>
        <div className="wb-login-title">项目工作台</div>
        <div className="wb-login-map">
          <div className="wb-map-center">
            <Layers />
            <strong>项目</strong>
          </div>
          <div className="wb-map-item">
            <FileText />
            <span>资料与源码</span>
          </div>
          <div className="wb-map-item">
            <Server />
            <span>环境与服务</span>
          </div>
          <div className="wb-map-item">
            <Bot />
            <span>Agent 与会话</span>
          </div>
        </div>
        <div className="wb-login-meta">
          <span>INTERACTIVE PROTOTYPE</span>
          <span>V2 / 2026</span>
        </div>
      </div>
      <div className="wb-login-form">
        <Panel title="登录工作台">
          <form onSubmit={submit} className="wb-stack">
            <Field label="用户名">
              <Input
                aria-label="用户名"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            <Field label="密码">
              <Input
                aria-label="密码"
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && (
              <p role="alert" className="wb-danger">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full">
              登录
              <ArrowUpRight />
            </Button>
            <div className="wb-demo-accounts">
              <span className="wb-muted">填入演示账号 · 密码 Demo123!</span>
              <div className="wb-row">
                {[
                  ['admin', '管理员'],
                  ['lin', '林夏'],
                  ['chen', '陈默'],
                ].map(([id, name]) => (
                  <Button
                    key={id}
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => {
                      setUsername(id)
                      setPassword('Demo123!')
                      setError('')
                    }}
                  >
                    {name}
                  </Button>
                ))}
              </div>
            </div>
            <p className="wb-muted text-xs">
              账号与连接均为虚构演示数据。原型不会操作真实服务器、数据库或机柜。
            </p>
          </form>
        </Panel>
      </div>
    </div>
  )
}
function ProjectsPage() {
  const { state, user, update, navigate, audit } = useWorkbench()
  const [search, setSearch] = useState('')
  const [form, setForm] = useState(null)
  const projects = Object.values(state.projects).filter(
    (p) =>
      (user.role === 'admin' || p.memberIds.includes(user.id)) &&
      p.name.toLowerCase().includes(search.toLowerCase()),
  )
  function create() {
    if (!form.name.trim()) return toast.error('请输入项目名称')
    const id = uid('project')
    update((d) => {
      d.projects[id] = {
        id,
        name: form.name.trim(),
        description: form.description,
        memberIds: [user.id],
        environments: [],
        resources: [],
        services: [],
        documents: [],
        repositories: [],
        artifacts: [],
        rules: [],
      }
    })
    audit({ projectId: id, action: '创建项目', object: form.name })
    setForm(null)
    navigate(`/p/${id}/overview`)
  }
  return (
    <div className="wb-page">
      <PageHeader title="项目">
        <Button onClick={() => setForm({ name: '', description: '' })}>
          <Plus />
          创建项目
        </Button>
      </PageHeader>
      <div className="wb-search">
        <Search />
        <Input
          aria-label="搜索项目"
          placeholder="搜索项目名称"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="wb-project-grid">
        {projects.map((p) => (
          <Panel
            key={p.id}
            title={
              <Button
                variant="link"
                className="p-0 h-auto text-lg font-semibold"
                onClick={() => navigate(`/p/${p.id}/overview`)}
              >
                {p.name}
                <ArrowUpRight />
              </Button>
            }
          >
            <p className="text-sm mb-7 wb-muted">{p.description || '暂无项目描述'}</p>
            <div className="wb-row wb-project-meta">
              <span>
                <Users />
                {p.memberIds.length} 位成员
              </span>
              <span>
                <Layers />
                {p.environments.length} 个环境
              </span>
              <span>
                <Server />
                {p.services.length} 个服务
              </span>
            </div>
          </Panel>
        ))}
      </div>
      {!projects.length && (
        <Empty>{search ? '没有匹配的项目' : '尚未加入项目，可以创建一个新项目。'}</Empty>
      )}
      <div className="wb-section-heading">
        <h2>全局工具</h2>
      </div>
      <Button variant="outline" className="wb-tool-entry" onClick={() => navigate('/cabinet')}>
        <span className="wb-icon">
          <Boxes />
        </span>
        <span className="flex-1 text-left">机柜迁移</span>
        <Badge variant="secondary">全局机柜池</Badge>
        <ArrowUpRight />
      </Button>
      <Modal
        title="创建项目"
        open={!!form}
        onClose={() => setForm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button onClick={create}>创建并进入</Button>
          </>
        }
      >
        {form && (
          <div className="wb-stack">
            <Field label="项目名称">
              <Input
                aria-label="新项目名称"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="项目描述（可选）">
              <Textarea
                aria-label="新项目描述"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  )
}
function WorkbenchApp() {
  const { state, user, project, route, update, navigate, reset, canViewAgent } = useWorkbench()
  const { setOpenMobile } = useSidebar()
  useAgentRuntime()
  const [account, setAccount] = useState(false)
  const [pass, setPass] = useState({ old: '', next: '', confirm: '' })
  const [resetting, setResetting] = useState(false)
  const pathname = route.split('?')[0]
  const path = pathname.split('/')[3] || 'overview'
  const navKey = materialPages.includes(path) ? 'documents' : path === 'agents' ? 'chat' : path
  const activeNav = nav.find((n) => n[0] === navKey)
  const accessible = Object.values(state.projects).filter(
    (p) => user && (user.role === 'admin' || p.memberIds.includes(user.id)),
  )
  const unread = user
    ? state.notifications.filter(
        (n) =>
          !(n.readBy || []).includes(user.id) &&
          (!n.projectId || accessible.some((p) => p.id === n.projectId)) &&
          canViewAgent(n.agentId, n.projectId),
      ).length
    : 0
  function go(path) {
    navigate(path)
    setOpenMobile(false)
  }
  const sidebar = (
    <>
      <Button variant="ghost" className="wb-brand" onClick={() => go('/')}>
        <span>
          <Boxes />
        </span>
        AutoOps
      </Button>
      <div className="wb-sidebar-main">
        {project ? (
          <>
            <Button variant="ghost" className="wb-back" onClick={() => go('/')}>
              <ArrowLeft />
              全部项目
            </Button>
            <div className="wb-project-picker">
              <Picker
                label="切换项目"
                value={project.id}
                onChange={(id) => go(`/p/${id}/overview`)}
                options={accessible.map((p) => ({ value: p.id, label: p.name }))}
              />
            </div>
            <nav aria-label="项目导航">
              {nav.map(([key, label, Icon]) => (
                <Button
                  variant="ghost"
                  key={key}
                  className={`wb-nav-item ${navKey === key ? 'is-active' : ''}`}
                  aria-current={navKey === key ? 'page' : undefined}
                  onClick={() => go(`/p/${project.id}/${key}`)}
                >
                  <Icon />
                  {label}
                </Button>
              ))}
            </nav>
          </>
        ) : (
          <nav aria-label="全局导航">
            <Button
              variant="ghost"
              className={`wb-nav-item ${route === '/' ? 'is-active' : ''}`}
              onClick={() => go('/')}
            >
              <LayoutDashboard />
              项目
            </Button>
          </nav>
        )}
        <div className="wb-nav-group-label">全局</div>
        <Button
          variant="ghost"
          className={`wb-nav-item ${route === '/cabinet' ? 'is-active' : ''}`}
          onClick={() => go('/cabinet')}
        >
          <Boxes />
          机柜迁移
          <ArrowUpRight className="ml-auto size-3.5" />
        </Button>
        {user?.role === 'admin' && (
          <Button
            variant="ghost"
            className={`wb-nav-item ${route === '/accounts' ? 'is-active' : ''}`}
            onClick={() => go('/accounts')}
          >
            <Users />
            平台账号
          </Button>
        )}
      </div>
      <div className="wb-sidebar-bottom">
        <div className="wb-prototype-note">
          <span className="wb-dot" />
          交互原型 · 本地模拟
        </div>
        <Button variant="ghost" size="sm" onClick={() => setResetting(true)}>
          <RotateCcw />
          重置演示数据
        </Button>
      </div>
    </>
  )
  let page
  if (pathname === '/') page = <ProjectsPage />
  else if (pathname === '/cabinet') page = <CabinetPage />
  else if (pathname === '/accounts') page = <AccountAdminPage />
  else if (pathname === '/notifications') page = <NotificationsPage />
  else if (!project)
    page = (
      <Empty>
        <p>项目不存在或当前账号没有访问权限。</p>
        <Button variant="outline" className="mt-4" onClick={() => go('/')}>
          返回项目列表
        </Button>
      </Empty>
    )
  else if (['documents', 'repositories', 'artifacts'].includes(path))
    page = <MaterialsPage key={`${project.id}-${path}`} tab={path} />
  else
    page = {
      overview: <OverviewPage />,
      resources: <ResourcesPage />,
      services: <ServicesPage />,
      settings: <SettingsPage />,
      tasks: <TasksPage />,
      agents: <AgentsPage />,
      chat: <ChatPage />,
    }[path] || <OverviewPage />
  return (
    <>
      {!user ? (
        <Login />
      ) : (
        <div className="wb-shell">
          <Sidebar className="wb-sidebar" collapsible="offcanvas">
            {sidebar}
          </Sidebar>
          <div className="wb-main">
            <header className="wb-header">
              <div className="wb-row min-w-0">
                <SidebarTrigger className="wb-mobile-trigger" aria-label="打开导航" />
                <Breadcrumb className="wb-breadcrumb">
                  <BreadcrumbList>
                    <BreadcrumbItem className="wb-root-crumb">
                      <BreadcrumbLink href="#/">工作台</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="wb-root-crumb" />
                    {project && (
                      <>
                        <BreadcrumbItem>
                          <BreadcrumbLink href={`#/p/${project.id}/overview`}>
                            {project.name}
                          </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                      </>
                    )}
                    <BreadcrumbItem>
                      {project && pageLabels[path] ? (
                        <BreadcrumbLink href={`#/p/${project.id}/${navKey}`}>
                          {activeNav?.[1]}
                        </BreadcrumbLink>
                      ) : (
                        <BreadcrumbPage>
                          {project
                            ? activeNav?.[1] || '项目概览'
                            : pathname === '/cabinet'
                              ? '机柜迁移'
                              : pathname === '/accounts'
                                ? '平台账号'
                                : pathname === '/notifications'
                                  ? '通知'
                                  : '项目'}
                        </BreadcrumbPage>
                      )}
                    </BreadcrumbItem>
                    {pageLabels[path] && project && (
                      <>
                        <BreadcrumbSeparator className="wb-detail-crumb" />
                        <BreadcrumbItem className="wb-detail-crumb">
                          <BreadcrumbPage>{pageLabels[path]}</BreadcrumbPage>
                        </BreadcrumbItem>
                      </>
                    )}
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
              <div className="wb-row shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`站内通知 ${unread} 条未读`}
                  onClick={() => go('/notifications')}
                  className="relative"
                >
                  <Bell />
                  {unread > 0 && <span className="wb-unread">{unread > 9 ? '9+' : unread}</span>}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="wb-user-button" aria-label="账号菜单">
                      <span className="wb-avatar">{user.name.slice(-2)}</span>
                      <span className="wb-user-name">{user.name}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        setPass({ old: '', next: '', confirm: '' })
                        setAccount(true)
                      }}
                    >
                      <LockKeyhole />
                      修改密码
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        update((d) => {
                          d.userId = null
                        })
                        go('/')
                      }}
                    >
                      <LogOut />
                      退出登录
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>
            {!state.connected && (
              <div className="wb-connection-alert" role="status">
                连接已中断 · 正在保留会话进度
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    update((d) => {
                      d.connected = true
                    })
                  }
                >
                  恢复连接
                </Button>
              </div>
            )}
            <main
              className={`wb-content ${path === 'chat' && project ? 'is-chat' : ''}`}
              key={project?.id || pathname}
            >
              {page}
            </main>
          </div>
        </div>
      )}
      <Modal
        title="修改密码"
        open={account}
        onClose={() => setAccount(false)}
        footer={
          <Button
            onClick={() => {
              if (pass.old !== user.password) return toast.error('原密码错误')
              if (pass.next.length < 6) return toast.error('新密码至少 6 位')
              if (pass.next !== pass.confirm) return toast.error('两次新密码不一致')
              update((d) => {
                d.users.find((u) => u.id === user.id).password = pass.next
              })
              setAccount(false)
              toast.success('密码已修改')
            }}
          >
            保存密码
          </Button>
        }
      >
        <div className="wb-stack">
          {[
            ['old', '原密码'],
            ['next', '新密码'],
            ['confirm', '确认新密码'],
          ].map(([key, label]) => (
            <Field label={label} key={key}>
              <Input
                aria-label={label}
                type="password"
                autoComplete={key === 'old' ? 'current-password' : 'new-password'}
                value={pass[key]}
                onChange={(e) => setPass({ ...pass, [key]: e.target.value })}
              />
            </Field>
          ))}
        </div>
      </Modal>
      <Confirm
        title="重置演示数据"
        open={resetting}
        onClose={() => setResetting(false)}
        danger
        onConfirm={() => {
          reset()
          setResetting(false)
          setOpenMobile(false)
          toast.success('已恢复初始演示数据')
        }}
      >
        <p>会清除本浏览器中的原型改动、上传文件和会话，并退出登录。外部系统不受影响。</p>
      </Confirm>
      <Toaster
        className="wb-toast-layer"
        position="top-right"
        offset={76}
        mobileOffset={72}
        closeButton
        richColors
      />
    </>
  )
}

export default function App() {
  return (
    <SidebarProvider className="wb-provider">
      <WorkbenchApp />
    </SidebarProvider>
  )
}
