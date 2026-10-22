import { useEffect, useRef, useState } from 'react'
import './operations.css'
import {
  ArrowUpRight,
  Plus,
  Server,
  Database,
  Activity,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Play,
  Square,
  History,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Bot,
  Layers,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Clock3,
  Monitor,
  PackageOpen,
  ShieldCheck,
  Search,
  Copy,
  Download,
  Settings2,
  Terminal,
  Circle,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react'
import { useWorkbench, uid, stamp, removeEnvironment, removeProject } from './store'
import {
  Button,
  Input,
  Textarea,
  Switch,
  Checkbox,
  Badge,
  Picker,
  PageHeader,
  Panel,
  Field,
  Modal,
  Confirm,
  Status,
  Empty,
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
  CopyButton,
  download,
} from './ui'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
const time = (t) =>
  new Date(t).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
const types = {
  deploy: '发布',
  source: '源码',
  transform: '处理',
  agent: '问答',
  connection: '连接',
  operation: '运维',
}
const connectionMatch = ({ host, port, username, password, type, environmentId }) => ({
  host,
  port,
  username,
  password,
  type,
  environmentId,
})
function envName(p, id) {
  return p.environments.find((e) => e.id === id)?.name || '项目公共'
}
function validateBase(value) {
  if (!value) return true
  try {
    const u = new URL(value)
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password &&
      (u.pathname === '/' || u.pathname === '')
    )
  } catch {
    return false
  }
}
function sourceForService(project, service) {
  const artifact = project.artifacts.find((item) => item.id === service.artifactId)
  return {
    artifact,
    branch: artifact?.ref || (service.type === 'image' ? '镜像' : '—'),
    commit: artifact?.commit || '',
  }
}
function ServiceIdentity({ project, service, onOpen }) {
  const { branch, commit } = sourceForService(project, service)
  return (
    <div className="op-service-identity">
      <Button variant="link" className="op-name-link" onClick={onOpen}>
        {service.name}
        <ArrowUpRight className="size-3.5" />
      </Button>
      <div className="op-meta-line">
        <span>{envName(project, service.environmentId)}</span>
        <span>
          <GitBranch className="size-3" />
          {branch}
        </span>
        {commit && (
          <span className="op-commit">
            <code title={commit}>{commit.slice(0, 8)}</code>
            <CopyButton value={commit} />
          </span>
        )}
      </div>
    </div>
  )
}
export function OverviewPage() {
  const { state, project: p, navigate, canViewAgent, canUseAgent } = useWorkbench()
  const [environment, setEnvironment] = useState('all')
  const services = p.services.filter(
    (service) => environment === 'all' || service.environmentId === environment,
  )
  const tasks = state.tasks
    .filter((task) => task.projectId === p.id && canViewAgent(task.agentId, p.id))
    .slice(0, 4)
  const agents = state.agents.filter((agent) => canUseAgent(agent, p.id)).slice(0, 3)
  const latestSource = p.artifacts.find(
    (artifact) => !artifact.deleted && artifact.type === 'source',
  )
  const sanitized = p.artifacts.find(
    (artifact) => !artifact.deleted && artifact.type === 'sanitized',
  )
  const documents = p.documents.filter((document) => document.kind !== 'folder')
  const running = state.tasks.filter(
    (task) =>
      task.projectId === p.id && task.status === 'running' && canViewAgent(task.agentId, p.id),
  )
  return (
    <div className="wb-page op-overview">
      <PageHeader title={p.name}>
        <Button variant="outline" onClick={() => navigate(`/p/${p.id}/documents`)}>
          <FolderOpen />
          管理资料
        </Button>
        <Button onClick={() => navigate(`/p/${p.id}/chat`)}>
          <Bot />
          开始问答
        </Button>
      </PageHeader>
      <div className="op-overview-meta">
        <div className="op-meta-line">
          <Layers className="size-4" />
          <Picker
            label="概览环境"
            value={environment}
            onChange={setEnvironment}
            options={[
              { value: 'all', label: '全部环境' },
              ...p.environments.map((item) => ({ value: item.id, label: item.name })),
            ]}
          />
          <span>{p.memberIds.length} 位成员</span>
          <span>{p.repositories.length} 个仓库</span>
          {running.length > 0 && (
            <Button variant="link" onClick={() => navigate(`/p/${p.id}/tasks`)}>
              {running.length} 个任务进行中
              <ArrowUpRight />
            </Button>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${p.id}/settings`)}>
          项目设置
          <ArrowUpRight />
        </Button>
      </div>
      <div className="op-overview-main">
        <Panel
          title="服务与部署"
          className="op-compact-panel"
          actions={
            <Button variant="link" size="sm" onClick={() => navigate(`/p/${p.id}/services`)}>
              全部服务
              <ArrowUpRight />
            </Button>
          }
        >
          {services.length ? (
            <div className="op-overview-services">
              {services.slice(0, 4).map((service) => {
                const task = running.find((item) => item.serviceId === service.id)
                return (
                  <div className="op-overview-service" key={service.id}>
                    <div className="op-service-icon">
                      {service.type === 'static' ? <Monitor /> : <Server />}
                    </div>
                    <ServiceIdentity
                      project={p}
                      service={service}
                      onOpen={() => navigate(`/p/${p.id}/services?service=${service.id}`)}
                    />
                    <div className="op-overview-service-state">
                      <Status
                        value={
                          task
                            ? 'running'
                            : service.status === 'running'
                              ? 'active'
                              : service.status
                        }
                      />
                      <span className="op-caption">{service.version || '尚未发布'}</span>
                    </div>
                    <div className="op-host-caption">
                      <Server className="size-3.5" />
                      <span>
                        {p.resources.find((resource) => resource.id === service.hostIds[0])?.name ||
                          '未配置主机'}
                        {service.hostIds.length > 1 ? ` +${service.hostIds.length - 1}` : ''}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(task)}
                      onClick={() =>
                        navigate(`/p/${p.id}/services?service=${service.id}&action=deploy`)
                      }
                    >
                      <RefreshCw className="size-3.5" />
                      发布
                    </Button>
                    {task && <Progress value={task.progress} className="op-service-row-progress" />}
                  </div>
                )
              })}
            </div>
          ) : (
            <Empty>
              <p>{p.environments.length ? '此环境还没有服务' : '创建环境后即可配置服务与发布'}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() =>
                  navigate(`/p/${p.id}/${p.environments.length ? 'services' : 'settings'}`)
                }
              >
                {p.environments.length ? '配置服务' : '创建环境'}
                <ArrowUpRight />
              </Button>
            </Empty>
          )}
          <div className="op-panel-foot">
            <Clock3 className="size-3.5" />
            {tasks.find((task) => task.type === 'deploy') ? (
              <span>
                最近发布 · {time(tasks.find((task) => task.type === 'deploy').createdAt)} ·{' '}
                {tasks.find((task) => task.type === 'deploy').title}
              </span>
            ) : (
              <span>暂无发布任务</span>
            )}
          </div>
        </Panel>
        <Panel title="项目资料" className="op-compact-panel op-material-summary">
          {[
            [
              FolderOpen,
              '研发文档',
              `${documents.length} 份文档 · ${p.documents.filter((item) => item.kind === 'folder').length} 个文件夹`,
              'documents',
            ],
            [
              GitBranch,
              '代码仓库',
              p.repositories.map((repository) => repository.name).join('、') || '尚未添加',
              'repositories',
            ],
            [
              PackageOpen,
              '最新源码',
              latestSource
                ? `${latestSource.ref || '固定提交'} · ${latestSource.commit?.slice(0, 8) || latestSource.name}`
                : '尚未获取源码',
              'artifacts',
            ],
            [ShieldCheck, '脱敏资料', sanitized ? sanitized.name : '尚未准备脱敏资料', 'artifacts'],
          ].map(([Icon, title, detail, path]) => (
            <Button
              variant="ghost"
              className="op-summary-row"
              key={title}
              onClick={() => navigate(`/p/${p.id}/${path}`)}
            >
              <span className="op-summary-icon">
                <Icon />
              </span>
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
              <ChevronRight className="size-4" />
            </Button>
          ))}
        </Panel>
      </div>
      <div className="op-overview-bottom">
        <Panel
          title="可用 Agent"
          className="op-compact-panel"
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate(`/p/${p.id}/agents`)}>
              管理 Agent
              <ArrowUpRight />
            </Button>
          }
        >
          {agents.length ? (
            agents.map((agent) => (
              <Button
                variant="ghost"
                className="op-agent-row"
                key={agent.id}
                onClick={() => navigate(`/p/${p.id}/chat?agent=${agent.id}`)}
              >
                <Bot className="size-5" />
                <span className="op-agent-name">{agent.name}</span>
                <span className="op-caption">平台 Agent</span>
                <Status value={agent.status} />
                <ChevronRight className="size-4" />
              </Button>
            ))
          ) : (
            <Empty>当前没有可用 Agent，请联系管理员配置平台 Agent。</Empty>
          )}
        </Panel>
        <Panel
          title="近期任务"
          className="op-compact-panel"
          actions={
            <Button variant="link" size="sm" onClick={() => navigate(`/p/${p.id}/tasks`)}>
              全部任务
              <ArrowUpRight />
            </Button>
          }
        >
          {tasks.length ? (
            tasks.map((task) => (
              <Button
                variant="ghost"
                key={task.id}
                className="op-activity-row"
                onClick={() => navigate(`/p/${p.id}/tasks?task=${task.id}`)}
              >
                <span className={`op-event-dot is-${task.status}`} />
                <span className="op-activity-name">
                  {task.title}
                  <small>
                    {state.users.find((person) => person.id === task.actorId)?.name} ·{' '}
                    {time(task.createdAt)}
                  </small>
                </span>
                <Status value={task.status} />
                <ChevronRight className="size-4" />
              </Button>
            ))
          ) : (
            <Empty>暂无任务</Empty>
          )}
        </Panel>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { state, user, project: p, updateProject, update, audit, navigate } = useWorkbench()
  const [tab, setTab] = useState('environments')
  const [edit, setEdit] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [member, setMember] = useState('')
  const [name, setName] = useState(p.name)
  const [description, setDescription] = useState(p.description)
  const [confirmName, setConfirmName] = useState('')
  const active = state.tasks.some((t) => t.projectId === p.id && t.status === 'running')
  function saveEnv() {
    if (!edit.name.trim()) return toast.error('请输入环境名称')
    if (p.environments.some((e) => e.name === edit.name.trim() && e.id !== edit.id))
      return toast.error('环境名称不能重复')
    if (!validateBase(edit.authBase))
      return toast.error('填写 HTTP/S 基础地址，可带端口，不含路径、参数或凭据')
    const value = {
      ...edit,
      name: edit.name.trim(),
      authBase: edit.authBase.trim().replace(/\/$/, ''),
    }
    updateProject((d, draft) => {
      const i = d.environments.findIndex((e) => e.id === value.id)
      if (i < 0) d.environments.push(value)
      else d.environments[i] = value
      if (!value.authBase) {
        for (const device of draft.cabinet.devices) {
          if (device.targetId === `env:${p.id}:${value.id}`) {
            device.targetId = null
            device.revision = (device.revision || 0) + 1
          }
        }
      }
    })
    audit({ projectId: p.id, action: '保存环境', object: value.name })
    setEdit(null)
    toast.success('已保存，全局机柜目标同步更新')
  }
  function deleteEnv() {
    if (active) return toast.error('项目有运行中的任务，请先等待完成或停止')
    if (p.services.some((s) => s.environmentId === deleting.id))
      return toast.error('环境仍有关联服务，请先将服务配置移动到其他环境')
    update((d) => removeEnvironment(d, p.id, deleting.id))
    audit({ projectId: p.id, action: '删除环境', object: deleting.name })
    setDeleting(null)
    toast.success('环境已删除，相关机柜保留并变为未分配')
  }
  return (
    <div className="wb-page">
      <PageHeader title="项目设置" />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          <TabsTrigger value="environments">环境</TabsTrigger>
          <TabsTrigger value="members">成员</TabsTrigger>
          <TabsTrigger value="project">项目信息</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'environments' && (
        <Panel
          title="环境"
          actions={
            <Button onClick={() => setEdit({ id: uid('env'), name: '', authBase: '' })}>
              <Plus />
              创建环境
            </Button>
          }
        >
          {p.environments.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>机柜鉴权基础地址</TableHead>
                  <TableHead>资源</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.environments.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium">{e.name}</TableCell>
                    <TableCell>{e.authBase || '未配置'}</TableCell>
                    <TableCell>
                      {p.resources.filter((r) => r.environmentId === e.id).length}
                    </TableCell>
                    <TableCell>
                      <div className="wb-table-actions">
                        <Button variant="outline" size="sm" onClick={() => setEdit({ ...e })}>
                          编辑
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleting(e)}>
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>环境可自由命名，按需创建。</Empty>
          )}
        </Panel>
      )}
      {tab === 'members' && (
        <Panel title="项目成员">
          <div className="wb-row mb-5">
            <div className="min-w-48 flex-1">
              <Picker
                label="选择已有用户"
                value={member}
                onChange={setMember}
                options={[
                  { value: '', label: '选择已有用户' },
                  ...state.users
                    .filter((u) => !p.memberIds.includes(u.id))
                    .map((u) => ({ value: u.id, label: `${u.name} · ${u.username}` })),
                ]}
              />
            </div>
            <Button
              disabled={!member}
              onClick={() => {
                updateProject((d) => d.memberIds.push(member))
                audit({
                  projectId: p.id,
                  action: '添加成员',
                  object: state.users.find((u) => u.id === member)?.name,
                })
                setMember('')
                toast.success('已加入项目，无需接受邀请')
              }}
            >
              添加成员
            </Button>
          </div>
          {p.memberIds.map((id) => {
            const u = state.users.find((u) => u.id === id)
            return (
              u && (
                <div className="wb-list-row" key={id}>
                  <div className="wb-avatar">{u.name.slice(-2)}</div>
                  <div className="flex-1">
                    <strong>{u.name}</strong>
                    <p className="wb-muted">
                      {u.username} · {u.role === 'admin' ? '管理员' : '成员'}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => setDeleting({ id, name: u.name, kind: 'member' })}
                  >
                    移出
                  </Button>
                </div>
              )
            )
          })}
          <p className="wb-muted mt-5">项目成员均可管理本项目。平台管理员可访问全部项目。</p>
        </Panel>
      )}
      {tab === 'project' && (
        <>
          <Panel title="项目信息">
            <div className="wb-stack">
              <Field label="项目名称">
                <Input
                  aria-label="项目名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="项目描述">
                <Textarea
                  aria-label="项目描述"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <div>
                <Button
                  onClick={() => {
                    if (!name.trim()) return toast.error('请输入项目名称')
                    updateProject((d) => {
                      d.name = name.trim()
                      d.description = description
                    })
                    audit({ projectId: p.id, action: '修改项目', object: name })
                    toast.success('已保存，全局自动目标名称同步更新')
                  }}
                >
                  保存项目
                </Button>
              </div>
            </div>
          </Panel>
          <Panel title="删除项目">
            <p className="mb-4 text-sm">
              删除本平台内的资料、会话和历史。外部服务器、数据库及运行服务保持原状；机柜保留在全局池内并变为未分配。
            </p>
            {active && (
              <p role="alert" className="wb-danger mb-4">
                存在进行中的任务，请在任务页等待完成或停止。
              </p>
            )}
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmName('')
                setDeleting({ kind: 'project', name: p.name })
              }}
              disabled={active}
            >
              删除项目
            </Button>
          </Panel>
        </>
      )}
      <Modal
        title={p.environments.some((e) => e.id === edit?.id) ? '编辑环境' : '创建环境'}
        open={!!edit}
        onClose={() => setEdit(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              取消
            </Button>
            <Button onClick={saveEnv}>保存环境</Button>
          </>
        }
      >
        {edit && (
          <div className="wb-stack">
            <Field label="环境名称">
              <Input
                aria-label="环境名称"
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder="例如：联调、生产、新加坡"
              />
            </Field>
            <Field
              label="机柜鉴权基础地址（可选）"
              hint="填写后自动添加到全局机柜目标，所有登录用户都可看到并使用。"
            >
              <Input
                aria-label="机柜鉴权基础地址"
                value={edit.authBase}
                onChange={(e) => setEdit({ ...edit, authBase: e.target.value })}
                placeholder="https://api.example.test:8443"
              />
            </Field>
            {edit.authBase && (
              <div className="wb-note break-all">
                {edit.authBase.replace(/\/$/, '')}/communication/ybt/api/iot/client/con
              </div>
            )}
          </div>
        )}
      </Modal>
      <Confirm
        title={
          deleting?.kind === 'project'
            ? '删除整个项目'
            : deleting?.kind === 'member'
              ? '移出项目成员'
              : '删除环境'
        }
        open={!!deleting}
        onClose={() => setDeleting(null)}
        danger
        confirmLabel="确认删除"
        onConfirm={() => {
          if (deleting.kind === 'project') {
            if (confirmName !== p.name) return toast.error('请输入完整项目名称')
            if (active) return toast.error('任务尚未结束')
            update((d) => removeProject(d, p.id))
            navigate('/')
            toast.success('项目已删除，外部资源未更改')
          } else if (deleting.kind === 'member') {
            updateProject((d) => {
              d.memberIds = d.memberIds.filter((x) => x !== deleting.id)
            })
            audit({ projectId: p.id, action: '移出成员', object: deleting.name })
            setDeleting(null)
            if (deleting.id === user.id && user.role !== 'admin') navigate('/')
          } else deleteEnv()
        }}
      >
        <div className="wb-stack">
          <p>
            确认{deleting?.kind === 'member' ? '移出' : '删除'}「{deleting?.name}」？
          </p>
          {deleting?.kind === 'project' ? (
            <Field label={`输入项目名称 ${p.name}`}>
              <Input
                aria-label="确认项目名称"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
              />
            </Field>
          ) : (
            deleting?.kind !== 'member' && (
              <p className="wb-muted">
                环境内资源配置一并移除。机柜保留，外部资源不变；运行任务或关联服务会阻止删除。
              </p>
            )
          )}
        </div>
      </Confirm>
    </div>
  )
}

export function ResourcesPage() {
  const { state, project: p, updateProject, audit, startTask } = useWorkbench()
  const [scope, setScope] = useState('all')
  const [edit, setEdit] = useState(null)
  const [detail, setDetail] = useState(null)
  const [scenario, setScenario] = useState('success')
  const [deleting, setDeleting] = useState(null)
  const selected = p.resources.find((r) => r.id === detail)
  const rows = p.resources.filter(
    (r) => scope === 'all' || (scope === 'common' ? !r.environmentId : r.environmentId === scope),
  )
  function save() {
    if (!edit.name.trim() || !edit.host.trim()) return toast.error('请填写资源名称和主机')
    if (!/^\d+$/.test(String(edit.port)) || Number(edit.port) < 1 || Number(edit.port) > 65535)
      return toast.error('端口应为 1–65535')
    if (
      p.services.some(
        (service) =>
          service.hostIds.includes(edit.id) &&
          (edit.type !== 'Server' ||
            (edit.environmentId && edit.environmentId !== service.environmentId)),
      )
    )
      return toast.error('资源仍被服务引用，不能变更为其他类型或移到不匹配的环境')
    const value = {
      ...edit,
      name: edit.name.trim(),
      host: edit.host.trim(),
      environmentId: edit.environmentId || null,
      status: 'untested',
    }
    updateProject((d) => {
      const i = d.resources.findIndex((r) => r.id === value.id)
      if (i < 0) d.resources.push(value)
      else d.resources[i] = value
    })
    audit({ projectId: p.id, action: '保存资源', object: value.name })
    setEdit(null)
    toast.success('已立即保存，正在运行的任务继续使用原快照')
  }
  function connect(r, read = false) {
    if (state.tasks.some((t) => t.status === 'running' && t.resourceId === r.id))
      return toast.info('连接任务正在进行')
    startTask({
      projectId: p.id,
      type: 'connection',
      resourceId: r.id,
      title: `${read ? '读取预置能力' : '测试连接'} · ${r.name}`,
      duration: 2500,
      outcome: scenario,
      logs: [
        `连接 ${r.host}:${r.port}`,
        `使用${r.type}预置能力`,
        read ? '连接后只读获取状态' : '校验模拟凭据',
      ],
      effects: [
        {
          op: 'patch',
          path: ['projects', p.id, 'resources'],
          id: r.id,
          ifMatch: connectionMatch(r),
          value: { status: 'connected', lastChecked: stamp(), cpu: 29, memory: 51, disk: 36 },
        },
      ],
      failureEffects: [
        {
          op: 'patch',
          path: ['projects', p.id, 'resources'],
          id: r.id,
          ifMatch: connectionMatch(r),
          value: { status: 'failed', lastChecked: stamp() },
        },
      ],
    })
    toast.info('连接任务已开始，可在任务页查看结果')
  }
  return (
    <div className="wb-page">
      <PageHeader title="环境与资源">
        <Button
          onClick={() =>
            setEdit({
              id: uid('resource'),
              name: '',
              type: 'Server',
              environmentId: '',
              host: '',
              port: '22',
              username: '',
              password: '',
              status: 'untested',
            })
          }
        >
          <Plus />
          添加资源
        </Button>
      </PageHeader>
      <div className="wb-toolbar">
        <Picker
          label="筛选资源环境"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: '全部环境' },
            { value: 'common', label: '项目公共' },
            ...p.environments.map((e) => ({ value: e.id, label: e.name })),
          ]}
        />
        <DemoScenario value={scenario} onChange={setScenario} connection />
      </div>
      <Panel title="连接配置">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>资源</TableHead>
                <TableHead>环境</TableHead>
                <TableHead>连接</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <strong>{r.name}</strong>
                    <p className="wb-muted">{r.type}</p>
                  </TableCell>
                  <TableCell>{envName(p, r.environmentId)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.host}:{r.port}
                  </TableCell>
                  <TableCell>
                    <Status
                      value={
                        state.tasks.some((t) => t.resourceId === r.id && t.status === 'running')
                          ? 'running'
                          : r.status
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="wb-table-actions">
                      <Button variant="outline" size="sm" onClick={() => connect(r)}>
                        {r.status === 'failed' ? '重试连接' : '测试连接'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDetail(r.id)}>
                        预置能力
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEdit({ ...r, environmentId: r.environmentId || '' })}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除资源 ${r.name}`}
                        onClick={() => setDeleting(r)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>添加 Server、MySQL 或 Redis 连接。凭据仅在本项目使用。</Empty>
        )}
      </Panel>
      <Modal
        title={p.resources.some((r) => r.id === edit?.id) ? '编辑资源' : '添加资源'}
        open={!!edit}
        onClose={() => setEdit(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              取消
            </Button>
            <Button onClick={save}>保存资源</Button>
          </>
        }
      >
        {edit && (
          <div className="wb-form-grid">
            <Field label="资源名称">
              <Input
                aria-label="资源名称"
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <Field label="类型">
              <Picker
                label="资源类型"
                value={edit.type}
                onChange={(type) =>
                  setEdit({
                    ...edit,
                    type,
                    port: type === 'Server' ? '22' : type === 'MySQL' ? '3306' : '6379',
                  })
                }
                options={['Server', 'MySQL', 'Redis'].map((x) => ({ value: x, label: x }))}
              />
            </Field>
            <Field label="所属环境">
              <Picker
                label="资源所属环境"
                value={edit.environmentId}
                onChange={(environmentId) => setEdit({ ...edit, environmentId })}
                options={[
                  { value: '', label: '项目公共' },
                  ...p.environments.map((e) => ({ value: e.id, label: e.name })),
                ]}
              />
            </Field>
            <Field label="主机地址">
              <Input
                aria-label="资源主机地址"
                value={edit.host}
                onChange={(e) => setEdit({ ...edit, host: e.target.value })}
                placeholder="host.example.test"
              />
            </Field>
            <Field label="端口">
              <Input
                aria-label="资源端口"
                type="number"
                min="1"
                max="65535"
                value={edit.port}
                onChange={(e) => setEdit({ ...edit, port: e.target.value })}
              />
            </Field>
            <Field label="用户名">
              <Input
                aria-label="资源用户名"
                value={edit.username}
                onChange={(e) => setEdit({ ...edit, username: e.target.value })}
              />
            </Field>
            <Field label="密码 / 密钥" hint="原型仅填写虚构信息。保存后供本项目后续操作使用。">
              <Input
                aria-label="资源密码"
                type="password"
                autoComplete="new-password"
                value={edit.password}
                onChange={(e) => setEdit({ ...edit, password: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Modal>
      <Modal
        title={selected?.name || '预置能力'}
        open={!!selected}
        onClose={() => setDetail(null)}
        footer={<Button onClick={() => connect(selected, true)}>读取状态（自动连接）</Button>}
      >
        {selected && (
          <div className="wb-stack">
            <div className="wb-row">
              <Badge>{selected.type}</Badge>
              <Status value={selected.status} />
              <span>{envName(p, selected.environmentId)}</span>
            </div>
            {selected.status === 'failed' && (
              <p className="wb-danger">模拟连接失败，检查地址和凭据后重试。</p>
            )}
            {selected.type === 'Server' ? (
              <>
                <div className="wb-grid">
                  <Metric title="CPU" value={selected.cpu || 0} />
                  <Metric title="内存" value={selected.memory || 0} />
                  <Metric title="磁盘" value={selected.disk || 0} />
                </div>
                <p className="wb-muted">Linux · {selected.host} · 可读取状态、通过服务发布部署</p>
              </>
            ) : (
              <div className="wb-note">
                预置只读能力：连接状态、
                {selected.type === 'MySQL' ? '数据库概要与查询分析' : '缓存概要与统计'}，供 Agent
                与工具按需调用。
              </div>
            )}
            <p className="wb-muted">
              上次检查：{selected.lastChecked ? time(selected.lastChecked) : '尚未检查'}
              。本原型不会访问真实网络。
            </p>
          </div>
        )}
      </Modal>
      <Confirm
        title="删除资源配置"
        open={!!deleting}
        onClose={() => setDeleting(null)}
        danger
        onConfirm={() => {
          if (p.services.some((s) => s.hostIds.includes(deleting.id)))
            return toast.error('仍被服务引用，请先修改服务主机')
          if (
            state.tasks.some(
              (t) =>
                t.projectId === p.id &&
                t.status === 'running' &&
                (t.resourceId === deleting.id ||
                  t.configSnapshot?.some((r) => r.id === deleting.id)),
            )
          )
            return toast.error('运行任务正在使用该资源，请等待完成或停止')
          updateProject((d) => {
            d.resources = d.resources.filter((r) => r.id !== deleting.id)
          })
          audit({ projectId: p.id, action: '删除资源', object: deleting.name })
          setDeleting(null)
        }}
      >
        <p>删除「{deleting?.name}」的本平台连接配置，外部资源不受影响。</p>
      </Confirm>
    </div>
  )
}
function Metric({ title, value }) {
  return (
    <div className="wb-metric">
      <div className="wb-row justify-between">
        <span>{title}</span>
        <strong>{value}%</strong>
      </div>
      <Progress value={value} />
    </div>
  )
}

function serviceType(type) {
  return type === 'java' ? 'Java 服务' : type === 'static' ? '前端静态站点' : '容器镜像'
}
const deploymentPhases = [
  { id: 'prepare', name: '固定输入', start: 0, end: 12 },
  { id: 'build', name: '构建 / 拉取', start: 12, end: 42 },
  { id: 'deploy', name: '传输与启动', start: 42, end: 71 },
  { id: 'health', name: '健康检查', start: 71, end: 87 },
  { id: 'finish', name: '结果与回退', start: 87, end: 100 },
]
function DemoScenario({ value, onChange, connection = false }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="op-demo-trigger">
          <Settings2 className="size-3.5" />
          演示场景
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>仅影响本次模拟</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {(connection
            ? [
                ['success', '连接成功'],
                ['failed', '连接失败'],
              ]
            : [
                ['success', '发布成功'],
                ['health-failed', '健康检查失败'],
                ['start-failed', '启动失败'],
              ]
          ).map(([id, name]) => (
            <DropdownMenuRadioItem key={id} value={id}>
              {name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
function VersionPicker({ project, service, source, value, onChange, allowHistory }) {
  const [search, setSearch] = useState('')
  const [repository, setRepository] = useState('all')
  const [branch, setBranch] = useState('all')
  useEffect(() => {
    setSearch('')
    setRepository('all')
    setBranch('all')
  }, [service.id])
  const branches = [
    ...new Set(
      source
        .filter((artifact) => repository === 'all' || artifact.repositoryId === repository)
        .map((artifact) => artifact.ref)
        .filter(Boolean),
    ),
  ]
  const rows = source.filter(
    (artifact) =>
      (repository === 'all' || artifact.repositoryId === repository) &&
      (branch === 'all' || artifact.ref === branch) &&
      `${artifact.name} ${artifact.commit} ${artifact.repositoryName} ${artifact.ref}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  )
  const versions = service.versions.filter(
    (version) => version.status !== 'removed' && version.status !== 'failed',
  )
  return (
    <div className="op-version-picker">
      <Tabs value={value.mode || 'source'} onValueChange={(mode) => onChange({ mode })}>
        <TabsList variant="line">
          <TabsTrigger value="source">
            {service.type === 'image' ? '容器镜像' : '源码产物'}
          </TabsTrigger>
          {allowHistory && <TabsTrigger value="history">已发布版本</TabsTrigger>}
        </TabsList>
      </Tabs>
      {value.mode === 'history' ? (
        <div className="op-version-list">
          {versions.length ? (
            versions.map((version) => (
              <Button
                variant="ghost"
                className={`op-version-option ${value.releaseId === version.id ? 'is-selected' : ''}`}
                aria-pressed={value.releaseId === version.id}
                key={version.id}
                disabled={version.name === service.version}
                onClick={() => onChange({ releaseId: version.id })}
              >
                <span className="op-selection-mark">
                  {value.releaseId === version.id ? (
                    <Check className="size-4" />
                  ) : (
                    <Circle className="size-3.5" />
                  )}
                </span>
                <span className="op-version-copy">
                  <strong>{version.name}</strong>
                  <small>
                    {time(version.createdAt)} ·{' '}
                    {version.artifactId
                      ? project.artifacts.find((artifact) => artifact.id === version.artifactId)
                          ?.name || '产物已删除'
                      : version.image}
                  </small>
                </span>
                {version.name === service.version && <Badge variant="secondary">当前版本</Badge>}
              </Button>
            ))
          ) : (
            <Empty>尚无可回退版本</Empty>
          )}
        </div>
      ) : service.type === 'image' ? (
        <div className="op-image-input">
          <Field label="镜像地址与标签">
            <Input
              aria-label={`镜像 ${service.name}`}
              value={value.image}
              onChange={(event) => onChange({ image: event.target.value })}
              placeholder="registry.example.invalid/team/app:1.0.0"
            />
          </Field>
          <div className="op-current-image">
            <PackageOpen className="size-5" />
            <div>
              <span className="op-section-label">当前运行镜像</span>
              <code>{service.image || '尚未发布'}</code>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="op-source-filters">
            <Field label="代码仓库">
              <Picker
                label="发布仓库筛选"
                value={repository}
                onChange={(id) => {
                  setRepository(id)
                  setBranch('all')
                }}
                options={[
                  { value: 'all', label: '全部仓库' },
                  ...project.repositories.map((item) => ({ value: item.id, label: item.name })),
                ]}
              />
            </Field>
            <Field label="分支 / 标签">
              <Picker
                label="发布分支筛选"
                value={branch}
                onChange={setBranch}
                options={[
                  { value: 'all', label: '全部引用' },
                  ...branches.map((ref) => ({ value: ref, label: ref })),
                ]}
              />
            </Field>
          </div>
          <div className="op-search">
            <Search className="size-4" />
            <Input
              aria-label="搜索发布版本"
              placeholder="搜索产物名称、分支或完整提交号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="清空版本搜索"
                onClick={() => setSearch('')}
              >
                ×
              </Button>
            )}
          </div>
          <div className="op-selection-count">
            {rows.length} 个可用源码产物{value.artifactId ? ' · 选中版本保留在右侧确认中' : ''}
          </div>
          <div className="op-version-list">
            {rows.length ? (
              rows.map((artifact) => (
                <div
                  className={`op-version-candidate ${value.artifactId === artifact.id ? 'is-selected' : ''}`}
                  key={artifact.id}
                >
                  <Button
                    variant="ghost"
                    aria-label={`选择发布产物 ${artifact.name}`}
                    aria-pressed={value.artifactId === artifact.id}
                    className="op-candidate-main"
                    onClick={() => onChange({ artifactId: artifact.id })}
                  >
                    <span className="op-selection-mark">
                      {value.artifactId === artifact.id ? (
                        <Check className="size-4" />
                      ) : (
                        <Circle className="size-3.5" />
                      )}
                    </span>
                    <span className="op-version-copy">
                      <strong>{artifact.name}</strong>
                      <small>
                        {artifact.type === 'source'
                          ? '原始源码'
                          : artifact.type === 'sanitized'
                            ? '脱敏源码'
                            : '去 Git 源码'}{' '}
                        · {artifact.repositoryName || '项目产物'} · {artifact.ref || '固定提交'}
                      </small>
                    </span>
                    <span className="op-caption">{time(artifact.createdAt)}</span>
                  </Button>
                  <div className="op-candidate-commit">
                    <GitBranch className="size-3.5" />
                    <code title={artifact.commit}>
                      {artifact.commit?.slice(0, 12) || '未记录提交'}
                    </code>
                    {artifact.commit && <CopyButton value={artifact.commit} />}
                    <span>{artifact.files?.length || 0} 个文件</span>
                  </div>
                </div>
              ))
            ) : (
              <Empty>
                {source.length
                  ? '没有匹配产物，清空搜索或调整筛选。'
                  : '尚无可发布源码，先从代码仓库获取固定提交。'}
              </Empty>
            )}
          </div>
        </>
      )}
    </div>
  )
}
function OperationLogs({ entries, filename, phase = 'all', onClearPhase, running = false }) {
  const [search, setSearch] = useState('')
  const [follow, setFollow] = useState(true)
  const logRef = useRef(null)
  const visible = entries.filter(
    (entry) =>
      (phase === 'all' || entry.phase === phase) &&
      entry.text.toLowerCase().includes(search.toLowerCase()),
  )
  const text = entries.map((entry) => entry.text).join('\n')
  useEffect(() => {
    if (follow && !search && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [entries.length, follow, search])
  return (
    <div className="op-log-viewer">
      <div className="op-log-toolbar">
        <div className="op-search">
          <Search className="size-4" />
          <Input
            aria-label="搜索任务日志"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="检索已加载日志"
          />
        </div>
        <div className="wb-row gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={!entries.length}
            onClick={() =>
              navigator.clipboard
                .writeText(text)
                .then(() => toast.success('已复制全部已加载日志'))
                .catch(() => toast.error('无法复制，请下载日志'))
            }
          >
            <Copy className="size-3.5" />
            复制
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!entries.length}
            onClick={() => download(filename, text)}
          >
            <Download className="size-3.5" />
            下载
          </Button>
        </div>
      </div>
      <div className="op-log-status">
        <span>
          {visible.length} / {entries.length} 行{running ? ' · 持续接收中' : ''}
        </span>
        {phase !== 'all' && (
          <Button variant="link" size="sm" onClick={onClearPhase}>
            当前阶段 · 查看全部
          </Button>
        )}
        <label className="op-follow">
          <Switch
            aria-label="日志自动跟随"
            checked={follow && !search}
            onCheckedChange={setFollow}
            disabled={Boolean(search)}
          />
          自动跟随
        </label>
      </div>
      <div
        className="op-log-lines"
        ref={logRef}
        role="log"
        aria-live={running ? 'polite' : 'off'}
        tabIndex={0}
      >
        {visible.length ? (
          visible.map((entry, index) => (
            <div
              key={entry.id ?? index}
              className={
                /失败|503|错误/.test(entry.text)
                  ? 'is-error'
                  : /恢复|回退/.test(entry.text)
                    ? 'is-warning'
                    : ''
              }
            >
              <span className="op-line-number">{entries.indexOf(entry) + 1}</span>
              <code>{entry.text}</code>
            </div>
          ))
        ) : (
          <p className="op-log-empty">{entries.length ? '没有匹配日志' : '等待任务事件…'}</p>
        )}
      </div>
    </div>
  )
}
function taskLogEntries(task) {
  const elapsed =
    task.status === 'running' || task.status === 'stopped' ? task.elapsed || 0 : Infinity
  if (task.logSchedule)
    return [
      ...task.logSchedule
        .filter((entry) => entry.at <= elapsed)
        .map((entry, index) => ({
          ...entry,
          id: `scheduled-${index}`,
          text: `[+${(entry.at / 1000).toFixed(1)}s] ${entry.text}`,
        })),
      ...(task.logs || []).map((entry, index) => ({
        id: `final-${index}`,
        phase: 'finish',
        text: typeof entry === 'string' ? entry : JSON.stringify(entry),
      })),
    ]
  const logs = task.logs || []
  const loaded =
    task.status === 'running' && !task.runtimeManaged
      ? logs.slice(0, Math.max(1, Math.ceil((logs.length * (task.progress || 0)) / 100)))
      : logs
  return loaded.map((entry, index) => ({
    id: index,
    phase: 'other',
    text: typeof entry === 'string' ? entry : JSON.stringify(entry),
  }))
}

export function ServicesPage() {
  const {
    state,
    project: p,
    updateProject,
    audit,
    startTask,
    stopTask,
    navigate,
    route,
  } = useWorkbench()
  const [selected, setSelected] = useState([])
  const [edit, setEdit] = useState(null)
  const [deploy, setDeploy] = useState(null)
  const query = new URLSearchParams(route.split('?')[1] || '')
  const detail = query.get('service')
  const [focus, setFocus] = useState(detail || '')
  const [serviceFilter, setServiceFilter] = useState('all')
  const [serviceSearch, setServiceSearch] = useState('')
  const [action, setAction] = useState(null)
  const [versionToRemove, setVersionToRemove] = useState(null)
  const live = p.services.find((s) => s.id === detail)
  const source = p.artifacts.filter(
    (a) =>
      !a.deleted && a.status === 'ready' && ['source', 'stripped', 'sanitized'].includes(a.type),
  )
  const servers = p.resources.filter((r) => r.type === 'Server')
  const busy = (s) => state.tasks.find((t) => t.serviceId === s.id && t.status === 'running')
  function openDeploy(ids, keepRoute = false) {
    const values = {}
    for (const id of ids) {
      const s = p.services.find((x) => x.id === id)
      values[id] = {
        artifactId: query.has('artifact')
          ? source.some((item) => item.id === query.get('artifact'))
            ? query.get('artifact')
            : ''
          : source.some((item) => item.id === s.artifactId)
            ? s.artifactId
            : source[0]?.id || '',
        mode: 'source',
        releaseId: '',
        image: s.image || 'registry.example.test/team/api:1.9.0',
        version: `v${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.${s.versions.length + 1}`,
        scenario: 'success',
      }
    }
    setDeploy({ ids, values, originArtifact: query.get('artifact') })
    setFocus(ids[0])
    if (!keepRoute)
      navigate(
        `/p/${p.id}/services?service=${ids[0]}&action=deploy${ids.length > 1 ? `&batch=${ids.join(',')}` : ''}${query.get('artifact') ? `&artifact=${query.get('artifact')}` : ''}`,
      )
  }
  useEffect(() => {
    if (query.get('action') !== 'deploy') {
      setDeploy(null)
      return
    }
    const ids = (query.get('batch') || query.get('service') || '')
      .split(',')
      .filter((id) => p.services.some((service) => service.id === id))
    if (
      ids.length &&
      (!deploy ||
        deploy.ids.join(',') !== ids.join(',') ||
        deploy.originArtifact !== query.get('artifact'))
    )
      openDeploy(ids, true)
  }, [route, p.id])
  function launch() {
    const started = []
    const batchId = uid('batch')
    for (const id of deploy.ids) {
      const s = p.services.find((x) => x.id === id)
      const v = deploy.values[id]
      if (!v.version.trim()) return toast.error(`${s.name}：请输入版本标识`)
      if (s.versions.some((x) => x.name === v.version.trim() && x.status !== 'removed'))
        return toast.error(`${s.name}：版本标识已存在`)
      if (s.type !== 'image' && !source.some((x) => x.id === v.artifactId))
        return toast.error(`${s.name}：请选择可用源码产物`)
      if (s.type === 'image' && !v.image.trim()) return toast.error(`${s.name}：请填写镜像名称`)
      if (
        !s.hostIds.length ||
        s.hostIds.some(
          (h) =>
            !servers.some(
              (r) => r.id === h && (!r.environmentId || r.environmentId === s.environmentId),
            ),
        )
      )
        return toast.error(`${s.name}：请配置有效目标主机`)
      if (busy(s)) return toast.error(`${s.name}：已有运行任务`)
    }
    for (const id of deploy.ids) {
      const s = p.services.find((x) => x.id === id),
        v = deploy.values[id],
        previous = structuredClone(s),
        isFailure = v.scenario !== 'success',
        outcome = isFailure ? (s.version ? 'rolledback' : 'failed') : 'success',
        createdAt = stamp(),
        release = {
          id: uid('release'),
          name: v.version,
          artifactId: s.type === 'image' ? null : v.artifactId,
          image: s.type === 'image' ? v.image : null,
          status: 'retained',
          createdAt,
          configSnapshot: {
            type: s.type,
            environmentId: s.environmentId,
            hostIds: [...s.hostIds],
            command: s.command,
            healthPath: s.healthPath,
            port: s.port,
          },
        }
      const targetResults = s.hostIds.map((h, i) => ({
        id: h,
        host: servers.find((r) => r.id === h)?.host,
        status: isFailure && i === 0 ? 'failed' : 'success',
      }))
      const taskId = startTask({
        projectId: p.id,
        type: 'deploy',
        batchId,
        scenario: v.scenario,
        previousVersion: s.version,
        targetResults,
        deploymentSnapshot: {
          ...release.configSnapshot,
          serviceName: s.name,
          version: v.version,
          previousVersion: s.version,
          image: release.image,
        },
        sourceSnapshot:
          s.type === 'image'
            ? null
            : {
                id: v.artifactId,
                name: source.find((item) => item.id === v.artifactId)?.name,
                commit: source.find((item) => item.id === v.artifactId)?.commit,
                ref: source.find((item) => item.id === v.artifactId)?.ref,
              },
        serviceId: s.id,
        title: `${s.name} · ${v.version} 发布`,
        duration: 7000,
        outcome,
        artifactIds: s.type === 'image' ? [] : [v.artifactId],
        configSnapshot: structuredClone(p.resources.filter((r) => s.hostIds.includes(r.id))),
        logs: [],
        logSchedule: [
          { at: 0, phase: 'prepare', text: `创建发布任务；固定版本 ${v.version}` },
          {
            at: 450,
            phase: 'prepare',
            text: `已读取启动时配置，目标 ${s.hostIds.length} 台 Linux 主机`,
          },
          {
            at: 1000,
            phase: 'build',
            text: s.type === 'image' ? `拉取镜像 ${v.image}` : `执行构建：${s.command}`,
          },
          {
            at: 2400,
            phase: 'build',
            text: s.type === 'image' ? '镜像校验完成' : '构建完成，生成发布文件',
          },
          ...s.hostIds.map((hostId, index) => ({
            at: 3000 + index * 180,
            phase: 'deploy',
            text: `连接 ${servers.find((resource) => resource.id === hostId)?.host}，传输发布文件`,
          })),
          { at: 4000, phase: 'deploy', text: '切换服务并等待启动' },
          {
            at: 5000,
            phase: 'health',
            text: isFailure
              ? v.scenario === 'start-failed'
                ? '启动失败，无法完成健康检查'
                : `健康检查 ${s.healthPath} → 503`
              : `健康检查 ${s.healthPath} → 200`,
          },
          {
            at: 6100,
            phase: 'finish',
            text: isFailure
              ? s.version
                ? `恢复上一版本 ${s.version}，重新执行健康检查`
                : '首次部署没有可回退版本'
              : `确认所有目标，记录发布版本 ${v.version}`,
          },
        ],
        effects: [
          {
            op: 'patch',
            path: ['projects', p.id, 'services'],
            id: s.id,
            value: {
              version: v.version,
              artifactId: release.artifactId,
              image: release.image,
              status: 'running',
              targetResults,
              versions: [release, ...s.versions],
              logs: [`[${createdAt}] ${v.version} 发布成功`, '健康检查通过'],
              lastRelease: createdAt,
            },
          },
          ...s.hostIds.map((h) => ({
            op: 'patch',
            path: ['projects', p.id, 'resources'],
            id: h,
            ifMatch: connectionMatch(servers.find((r) => r.id === h)),
            value: { status: 'connected' },
          })),
        ],
        failureEffects: [
          {
            op: 'patch',
            path: ['projects', p.id, 'services'],
            id: s.id,
            value: {
              ...previous,
              status: s.version ? 'running' : 'failed',
              targetResults,
              logs: [
                `[${createdAt}] ${v.version} 发布失败`,
                s.version ? `已自动恢复 ${s.version}` : '首次部署失败，无上一版本',
              ],
              versions: [{ ...release, status: 'failed' }, ...s.versions],
            },
          },
        ],
      })
      started.push(taskId)
    }
    setDeploy(null)
    setSelected([])
    navigate(`/p/${p.id}/tasks?task=${started[0]}`)
    toast.success('发布任务已创建，各服务独立执行')
  }
  function saveService() {
    if (!edit.name.trim() || !edit.environmentId) return toast.error('请填写名称并选择环境')
    if (busy(edit)) return toast.error('该服务有正在运行的任务，请结束后修改配置')
    if (!/^\d+$/.test(String(edit.port)) || Number(edit.port) < 1 || Number(edit.port) > 65535)
      return toast.error('服务端口应为 1–65535')
    if (!edit.healthPath.startsWith('/')) return toast.error('健康检查路径应以 / 开头')
    if (edit.type !== 'image' && !edit.command.trim()) return toast.error('请填写构建命令')
    if (!edit.hostIds.length) return toast.error('请至少选择一台主机')
    if (
      edit.hostIds.some(
        (id) =>
          !servers.some(
            (r) => r.id === id && (!r.environmentId || r.environmentId === edit.environmentId),
          ),
      )
    )
      return toast.error('主机必须属于所选环境或项目公共')
    updateProject((d) => {
      const i = d.services.findIndex((s) => s.id === edit.id)
      if (i < 0) d.services.push(edit)
      else {
        const { name, type, environmentId, hostIds, command, healthPath, port } = edit
        Object.assign(d.services[i], {
          name,
          type,
          environmentId,
          hostIds,
          command,
          healthPath,
          port,
        })
      }
    })
    audit({ projectId: p.id, action: '保存服务配置', object: edit.name })
    setEdit(null)
    toast.success('服务配置已保存')
  }
  function perform() {
    const { s, kind, version } = action
    if (busy(s)) return toast.error('该服务有正在运行的任务')
    if (kind !== 'rollback' && !s.version) return toast.error('请先成功发布一个版本')
    if (
      !s.hostIds.length ||
      s.hostIds.some(
        (id) =>
          !servers.some(
            (r) => r.id === id && (!r.environmentId || r.environmentId === s.environmentId),
          ),
      )
    )
      return toast.error('请先修正目标主机配置，主机必须属于服务环境或项目公共')
    if (
      kind === 'rollback' &&
      version.artifactId &&
      !source.some((a) => a.id === version.artifactId)
    )
      return toast.error('版本源码产物不可用')
    const taskId = startTask({
      projectId: p.id,
      type: 'operation',
      configSnapshot: structuredClone(
        p.resources.filter((resource) => s.hostIds.includes(resource.id)),
      ),
      deploymentSnapshot: {
        serviceName: s.name,
        environmentId: s.environmentId,
        hostIds: [...s.hostIds],
        command: s.command,
        healthPath: s.healthPath,
        port: s.port,
        version: version?.name || s.version,
      },
      serviceId: s.id,
      title: `${s.name} · ${kind === 'stop' ? '停止' : kind === 'start' ? '启动' : kind === 'restart' ? '重启' : '回退至 ' + version?.name}`,
      duration: 3000,
      artifactIds: version?.artifactId ? [version.artifactId] : [],
      logs: [
        `使用当前 ${envName(p, s.environmentId)} 主机快照`,
        kind === 'stop' ? '发送停止信号' : '执行操作并检查服务状态',
      ],
      effects: [
        {
          op: 'patch',
          path: ['projects', p.id, 'services'],
          id: s.id,
          value: {
            status: kind === 'stop' ? 'stopped' : 'running',
            ...(kind === 'rollback'
              ? { version: version.name, artifactId: version.artifactId, image: version.image }
              : {}),
            logs: [`${stamp()} ${kind} 操作完成`],
          },
        },
      ],
    })
    setAction(null)
    navigate(`/p/${p.id}/tasks?task=${taskId}`)
  }
  const serviceUrl = (id, extra = '') => `/p/${p.id}/services${id ? `?service=${id}${extra}` : ''}`
  const beginEdit = (service) => setEdit(structuredClone(service))
  const operationMenu = (service) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={`更多服务操作 ${service.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => navigate(serviceUrl(service.id))}>
          <Activity />
          服务详情与日志
        </DropdownMenuItem>
        <DropdownMenuItem disabled={Boolean(busy(service))} onSelect={() => beginEdit(service)}>
          <Settings2 />
          服务配置
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={Boolean(busy(service)) || !service.version}
          onSelect={() => setAction({ s: service, kind: 'restart' })}
        >
          <RefreshCw />
          重启当前版本
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={Boolean(busy(service)) || !service.version}
          onSelect={() =>
            setAction({ s: service, kind: service.status === 'stopped' ? 'start' : 'stop' })
          }
        >
          {service.status === 'stopped' ? <Play /> : <Square />}
          {service.status === 'stopped' ? '启动服务' : '停止服务'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const deployServices = (deploy?.ids || [])
    .map((id) => p.services.find((item) => item.id === id))
    .filter(Boolean)
  const focusService = deployServices.find((service) => service.id === focus) || deployServices[0]
  const focusValue = focusService && deploy?.values[focusService.id]
  const updateValue = (id, change) =>
    setDeploy((current) => ({
      ...current,
      values: { ...current.values, [id]: { ...current.values[id], ...change } },
    }))
  const focusedArtifact = source.find((item) => item.id === focusValue?.artifactId)
  const filteredServices = p.services.filter(
    (service) =>
      (serviceFilter === 'all' || service.environmentId === serviceFilter) &&
      service.name.toLowerCase().includes(serviceSearch.toLowerCase()),
  )
  const detailTask = live && busy(live)
  const chosenRelease = focusService?.versions.find(
    (version) => version.id === focusValue?.releaseId,
  )
  return (
    <div className="wb-page op-page">
      {deploy && focusService ? (
        <>
          <div className="op-back-row">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(serviceUrl(deploy.ids.length === 1 ? focusService.id : null))}
            >
              <ChevronLeft />
              返回{deploy.ids.length === 1 ? '服务详情' : '服务列表'}
            </Button>
            <span>
              {envName(p, focusService.environmentId)} / {focusService.hostIds.length} 台目标主机
            </span>
          </div>
          <PageHeader
            title={
              deploy.ids.length > 1
                ? `批量发布 · ${deploy.ids.length} 个服务`
                : `发布 ${focusService.name}`
            }
          >
            <DemoScenario
              value={focusValue.scenario}
              onChange={(scenario) => updateValue(focusService.id, { scenario })}
            />
            <Button variant="outline" onClick={() => beginEdit(focusService)}>
              <Settings2 />
              查看服务配置
            </Button>
          </PageHeader>
          {query.has('artifact') &&
            !source.some((artifact) => artifact.id === query.get('artifact')) &&
            !focusValue.artifactId &&
            focusService.type !== 'image' && (
              <div className="op-material-entry" role="status">
                <PackageOpen className="size-4" />
                <span>链接指定的源码产物已删除或不可用，请重新选择可发布的产物。</span>
              </div>
            )}
          <div className="op-release-layout">
            <div className="op-release-main">
              {deploy.ids.length > 1 && (
                <Tabs value={focusService.id} onValueChange={setFocus}>
                  <TabsList variant="line" className="op-scroll-tabs">
                    {deployServices.map((service) => (
                      <TabsTrigger key={service.id} value={service.id}>
                        {service.name}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
              <Panel title="选择发布版本" className="op-release-picker">
                <VersionPicker
                  project={p}
                  service={focusService}
                  source={source}
                  value={focusValue}
                  onChange={(change) => updateValue(focusService.id, change)}
                  allowHistory={deploy.ids.length === 1}
                />
              </Panel>
              {deploy.ids.length > 1 && (
                <Panel title="发布队列" className="op-compact-panel">
                  <div className="op-batch-list">
                    {deployServices.map((service) => (
                      <Button
                        key={service.id}
                        variant="ghost"
                        className={`op-batch-row ${service.id === focusService.id ? 'is-selected' : ''}`}
                        onClick={() => setFocus(service.id)}
                      >
                        <span>
                          <strong>{service.name}</strong>
                          <small>
                            {envName(p, service.environmentId)} · {service.hostIds.length} 台主机
                          </small>
                        </span>
                        <span>{deploy.values[service.id].version}</span>
                        <ChevronRight />
                      </Button>
                    ))}
                  </div>
                </Panel>
              )}
            </div>
            <Panel
              title={focusValue.mode === 'history' ? '回退确认' : '发布确认'}
              className="op-release-confirm"
            >
              <dl className="op-confirm-grid">
                <dt>项目</dt>
                <dd>{p.name}</dd>
                <dt>环境</dt>
                <dd>{envName(p, focusService.environmentId)}</dd>
                <dt>服务</dt>
                <dd>{focusService.name}</dd>
                <dt>类型</dt>
                <dd>{serviceType(focusService.type)}</dd>
              </dl>
              <div className="op-confirm-section">
                <span className="op-section-label">目标主机</span>
                {focusService.hostIds.map((id) => {
                  const host = servers.find((item) => item.id === id)
                  return (
                    <div className="op-confirm-host" key={id}>
                      <Server className="size-4" />
                      <span>
                        <strong>{host?.name || '主机已移除'}</strong>
                        <small>{host?.host || id}</small>
                      </span>
                      <Status value={host?.status || 'failed'} />
                    </div>
                  )
                })}
              </div>
              <div className="op-confirm-section">
                <span className="op-section-label">版本变化</span>
                <div className="op-version-change">
                  <span>{focusService.version || '首次发布'}</span>
                  <ArrowUpRight />
                  <strong>
                    {focusValue.mode === 'history'
                      ? chosenRelease?.name || '请选择版本'
                      : focusValue.version || '待填写'}
                  </strong>
                </div>
                {focusValue.mode !== 'history' && (
                  <Field label="发布版本标识">
                    <Input
                      aria-label={`版本 ${focusService.name}`}
                      value={focusValue.version}
                      onChange={(event) =>
                        updateValue(focusService.id, { version: event.target.value })
                      }
                    />
                  </Field>
                )}
                {focusValue.mode === 'history' ? (
                  <p className="op-caption">
                    {chosenRelease ? time(chosenRelease.createdAt) : '从左侧选择保留版本'}
                  </p>
                ) : (
                  focusedArtifact && (
                    <div className="op-selected-source">
                      <strong>{focusedArtifact.name}</strong>
                      <div className="op-meta-line">
                        <GitBranch className="size-3.5" />
                        {focusedArtifact.ref || '固定提交'}
                        {focusedArtifact.commit && (
                          <span className="op-commit">
                            <code>{focusedArtifact.commit.slice(0, 8)}</code>
                            <CopyButton value={focusedArtifact.commit} />
                          </span>
                        )}
                      </div>
                    </div>
                  )
                )}
              </div>
              <div className="op-confirm-section">
                <span className="op-section-label">服务配置核对</span>
                <dl className="op-confirm-grid">
                  <dt>端口</dt>
                  <dd>{focusService.port}</dd>
                  <dt>健康检查</dt>
                  <dd>
                    <code>{focusService.healthPath}</code>
                  </dd>
                  {focusService.type !== 'image' && (
                    <>
                      <dt>构建命令</dt>
                      <dd>
                        <code>{focusService.command}</code>
                      </dd>
                    </>
                  )}
                </dl>
              </div>
              <Button
                className="op-confirm-button"
                disabled={
                  Boolean(busy(focusService)) ||
                  (focusValue.mode !== 'history' &&
                    focusService.type !== 'image' &&
                    !focusedArtifact) ||
                  (focusValue.mode === 'history' &&
                    (!chosenRelease || chosenRelease.name === focusService.version))
                }
                onClick={() =>
                  focusValue.mode === 'history'
                    ? setAction({ s: focusService, kind: 'rollback', version: chosenRelease })
                    : launch()
                }
              >
                {focusValue.mode === 'history'
                  ? '确认回退'
                  : deploy.ids.length > 1
                    ? `确认发布 ${deploy.ids.length} 个服务`
                    : '确认发布'}
                <ArrowUpRight />
              </Button>
              <p className="op-release-caution">
                发布可能短暂中断。失败时恢复上一运行版本；批量任务逐个服务独立执行。
              </p>
            </Panel>
          </div>
        </>
      ) : live ? (
        <>
          <div className="op-back-row">
            <Button variant="ghost" size="sm" onClick={() => navigate(serviceUrl())}>
              <ChevronLeft />
              全部服务
            </Button>
            <span>
              {envName(p, live.environmentId)} / {serviceType(live.type)}
            </span>
          </div>
          <PageHeader title={live.name}>
            <Button
              variant="outline"
              disabled={Boolean(detailTask)}
              onClick={() => beginEdit(live)}
            >
              <Settings2 />
              配置
            </Button>
            {operationMenu(live)}
            <Button disabled={Boolean(detailTask)} onClick={() => openDeploy([live.id])}>
              <RefreshCw />
              发布版本
            </Button>
          </PageHeader>
          <div className="op-detail-strip">
            <Status
              value={detailTask ? 'running' : live.status === 'running' ? 'active' : live.status}
            />
            <span>
              当前版本 <strong>{live.version || '尚未发布'}</strong>
            </span>
            <span>{live.hostIds.length} 台主机</span>
            <span className="op-caption">
              {live.lastRelease ? `最近发布 ${time(live.lastRelease)}` : '尚无本轮发布'}
            </span>
            {detailTask && (
              <Button
                variant="link"
                size="sm"
                onClick={() => navigate(`/p/${p.id}/tasks?task=${detailTask.id}`)}
              >
                查看进行中的任务
                <ArrowUpRight />
              </Button>
            )}
          </div>
          <div className="op-service-detail-layout">
            <div className="op-service-detail-main">
              <Panel title="运行主机" className="op-compact-panel">
                <div className="op-host-list">
                  {live.hostIds.map((id) => {
                    const host = servers.find((item) => item.id === id),
                      result = live.targetResults?.find((item) => item.id === id)
                    return (
                      <div className="op-host-row" key={id}>
                        <Server className="size-5" />
                        <div>
                          <strong>{host?.name || '主机已移除'}</strong>
                          <small>{host?.host || id} · Linux</small>
                        </div>
                        <span className="op-caption">{live.version || '未发布'}</span>
                        <Status
                          value={
                            detailTask
                              ? 'running'
                              : result?.status ||
                                (live.status === 'running' ? 'active' : live.status)
                          }
                        />
                      </div>
                    )
                  })}
                </div>
              </Panel>
              <Panel
                title="发布记录"
                className="op-compact-panel"
                actions={
                  <span className="op-caption">
                    {live.versions.filter((version) => version.status !== 'removed').length}{' '}
                    个保留版本
                  </span>
                }
              >
                <div className="op-release-history">
                  {live.versions
                    .filter((version) => version.status !== 'removed')
                    .map((version) => (
                      <div className="op-history-row" key={version.id}>
                        <div>
                          <strong>{version.name}</strong>
                          <small>
                            {time(version.createdAt)} ·{' '}
                            {version.status === 'failed'
                              ? '发布失败'
                              : version.artifactId
                                ? p.artifacts.find((artifact) => artifact.id === version.artifactId)
                                    ?.name || '产物已删除'
                                : version.image}
                          </small>
                        </div>
                        {version.name === live.version ? (
                          <Badge variant="secondary">当前版本</Badge>
                        ) : version.status !== 'failed' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={Boolean(detailTask)}
                            onClick={() => {
                              openDeploy([live.id])
                              setDeploy((current) => ({
                                ...current,
                                values: {
                                  ...current.values,
                                  [live.id]: {
                                    ...current.values[live.id],
                                    mode: 'history',
                                    releaseId: version.id,
                                  },
                                },
                              }))
                            }}
                          >
                            回退
                          </Button>
                        ) : (
                          <Status value="failed" />
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`版本操作 ${version.name}`}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={version.name === live.version || Boolean(detailTask)}
                              onSelect={() => setVersionToRemove({ s: live, v: version })}
                            >
                              <Trash2 />
                              清理版本
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ))}
                  {!live.versions.length && <Empty>尚无发布记录</Empty>}
                </div>
              </Panel>
              <Panel title="运行日志" className="op-log-panel">
                <OperationLogs
                  entries={(live.logs || []).map((text, index) => ({
                    id: index,
                    text,
                    phase: 'runtime',
                  }))}
                  filename={`${live.name}-runtime.log`}
                />
              </Panel>
            </div>
            <Panel title="当前配置" className="op-config-aside">
              <dl className="op-confirm-grid">
                <dt>环境</dt>
                <dd>{envName(p, live.environmentId)}</dd>
                <dt>发布类型</dt>
                <dd>{serviceType(live.type)}</dd>
                <dt>监听端口</dt>
                <dd>{live.port}</dd>
                <dt>健康检查</dt>
                <dd>
                  <code>{live.healthPath}</code>
                </dd>
                <dt>构建命令</dt>
                <dd>
                  <code>{live.type === 'image' ? '使用已有镜像' : live.command}</code>
                </dd>
                <dt>源码产物</dt>
                <dd>
                  {p.artifacts.find((artifact) => artifact.id === live.artifactId)?.name ||
                    live.image ||
                    '未选择'}
                </dd>
              </dl>
              <Button
                variant="outline"
                className="w-full mt-5"
                disabled={Boolean(detailTask)}
                onClick={() => beginEdit(live)}
              >
                编辑服务配置
                <ArrowUpRight />
              </Button>
            </Panel>
          </div>
        </>
      ) : (
        <>
          <PageHeader title="服务与部署">
            <Button
              variant="outline"
              disabled={!selected.length}
              onClick={() => openDeploy(selected)}
            >
              批量发布{selected.length ? `（${selected.length}）` : ''}
            </Button>
            <Button
              onClick={() => {
                if (!p.environments.length) return toast.error('请先在项目设置创建环境')
                setEdit({
                  id: uid('service'),
                  name: '',
                  type: 'java',
                  environmentId: p.environments[0].id,
                  hostIds: [],
                  status: 'stopped',
                  version: null,
                  artifactId: null,
                  healthPath: '/health',
                  command: 'mvn package -DskipTests',
                  port: '8080',
                  versions: [],
                  logs: [],
                })
              }}
            >
              <Plus />
              新建服务
            </Button>
          </PageHeader>
          {query.get('artifact') && (
            <div className="op-material-entry">
              <PackageOpen className="size-4" />
              <span>
                使用产物{' '}
                <strong>
                  {source.find((artifact) => artifact.id === query.get('artifact'))?.name ||
                    '该产物不可用于发布'}
                </strong>
                ，请选择要发布的服务。
              </span>
            </div>
          )}
          <div className="op-list-toolbar">
            <div className="op-search">
              <Search className="size-4" />
              <Input
                aria-label="搜索服务"
                placeholder="搜索服务"
                value={serviceSearch}
                onChange={(event) => setServiceSearch(event.target.value)}
              />
            </div>
            <Picker
              label="服务环境筛选"
              value={serviceFilter}
              onChange={setServiceFilter}
              options={[
                { value: 'all', label: '全部环境' },
                ...p.environments.map((environment) => ({
                  value: environment.id,
                  label: environment.name,
                })),
              ]}
            />
            <span className="op-caption">{filteredServices.length} 个服务</span>
          </div>
          <Panel className="op-service-list-panel">
            {filteredServices.length ? (
              <div className="op-service-list">
                {filteredServices.map((service) => {
                  const task = busy(service)
                  return (
                    <div className="op-service-line" key={service.id}>
                      <label className="op-service-selection">
                        <Checkbox
                          aria-label={`选择服务 ${service.name}`}
                          checked={selected.includes(service.id)}
                          disabled={Boolean(task)}
                          onCheckedChange={(value) =>
                            setSelected(
                              value
                                ? [...selected, service.id]
                                : selected.filter((id) => id !== service.id),
                            )
                          }
                        />
                      </label>
                      <span className="op-service-icon">
                        {service.type === 'static' ? <Monitor /> : <Server />}
                      </span>
                      <ServiceIdentity
                        project={p}
                        service={service}
                        onOpen={() => navigate(serviceUrl(service.id))}
                      />
                      <div className="op-service-version">
                        <strong>{service.version || '未发布'}</strong>
                        <small>{serviceType(service.type)}</small>
                      </div>
                      <span className="op-host-caption">
                        <Server className="size-3.5" />
                        {service.hostIds.length} 台主机
                      </span>
                      <Status
                        value={
                          task
                            ? 'running'
                            : service.status === 'running'
                              ? 'active'
                              : service.status
                        }
                      />
                      <div className="wb-row gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={Boolean(task)}
                          onClick={() => openDeploy([service.id])}
                        >
                          发布版本
                        </Button>
                        {operationMenu(service)}
                      </div>
                      {task && (
                        <div className="op-running-line">
                          <Progress value={task.progress} />
                          <span>{task.progress}%</span>
                          <Button
                            variant="link"
                            size="sm"
                            onClick={() => navigate(`/p/${p.id}/tasks?task=${task.id}`)}
                          >
                            查看任务
                            <ArrowUpRight />
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <Empty>暂无匹配服务。可创建 Java、前端静态或容器镜像服务。</Empty>
            )}
          </Panel>
        </>
      )}
      <Modal
        title={p.services.some((s) => s.id === edit?.id) ? '服务配置' : '新建服务'}
        open={!!edit}
        onClose={() => setEdit(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              取消
            </Button>
            <Button onClick={saveService}>保存服务</Button>
          </>
        }
      >
        {edit && (
          <div className="wb-stack">
            <div className="wb-form-grid">
              <Field label="服务名称">
                <Input
                  aria-label="服务名称"
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              </Field>
              <Field label="发布类型">
                <Picker
                  label="发布类型"
                  value={edit.type}
                  onChange={(type) =>
                    setEdit({
                      ...edit,
                      type,
                      command:
                        type === 'java'
                          ? 'mvn package -DskipTests'
                          : type === 'static'
                            ? 'pnpm build'
                            : '',
                    })
                  }
                  options={[
                    { value: 'java', label: 'Java 源码构建' },
                    { value: 'static', label: '前端静态构建' },
                    { value: 'image', label: '已有容器镜像' },
                  ]}
                />
              </Field>
              <Field label="环境">
                <Picker
                  label="服务环境"
                  value={edit.environmentId}
                  onChange={(environmentId) => setEdit({ ...edit, environmentId, hostIds: [] })}
                  options={p.environments.map((e) => ({ value: e.id, label: e.name }))}
                />
              </Field>
              <Field label="服务端口">
                <Input
                  aria-label="服务端口"
                  type="number"
                  value={edit.port}
                  onChange={(e) => setEdit({ ...edit, port: e.target.value })}
                />
              </Field>
            </div>
            <Field label="目标 Linux 主机（可多选）">
              <div className="wb-stack mt-2">
                {servers
                  .filter((r) => !r.environmentId || r.environmentId === edit.environmentId)
                  .map((r) => (
                    <label className="wb-row op-host-selection" key={r.id}>
                      <Checkbox
                        aria-label={`目标主机 ${r.name}`}
                        checked={edit.hostIds.includes(r.id)}
                        onCheckedChange={(v) =>
                          setEdit({
                            ...edit,
                            hostIds: v
                              ? [...edit.hostIds, r.id]
                              : edit.hostIds.filter((id) => id !== r.id),
                          })
                        }
                      />
                      <span>
                        {r.name} · {r.host}
                      </span>
                    </label>
                  ))}
                {!servers.some(
                  (r) => !r.environmentId || r.environmentId === edit.environmentId,
                ) && <p className="wb-muted">此环境没有 Server 资源，请先添加。</p>}
              </div>
            </Field>
            {edit.type !== 'image' && (
              <Field label="构建命令">
                <Input
                  aria-label="构建命令"
                  value={edit.command}
                  onChange={(e) => setEdit({ ...edit, command: e.target.value })}
                />
              </Field>
            )}
            <Field label="健康检查路径">
              <Input
                aria-label="健康检查路径"
                value={edit.healthPath}
                onChange={(e) => setEdit({ ...edit, healthPath: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Modal>
      <Confirm
        title="确认服务操作"
        open={!!action}
        onClose={() => setAction(null)}
        onConfirm={perform}
      >
        <p>
          {action?.s.name}：
          {action?.kind === 'rollback'
            ? `回退至 ${action.version.name}`
            : action?.kind === 'stop'
              ? '停止服务'
              : action?.kind === 'start'
                ? '启动服务'
                : '重启服务'}
          。操作会创建独立任务。
        </p>
      </Confirm>
      <Confirm
        title="清理保留版本"
        open={!!versionToRemove}
        onClose={() => setVersionToRemove(null)}
        danger
        onConfirm={() => {
          updateProject((d) => {
            d.services
              .find((s) => s.id === versionToRemove.s.id)
              .versions.find((v) => v.id === versionToRemove.v.id).status = 'removed'
          })
          audit({ projectId: p.id, action: '清理发布版本', object: versionToRemove.v.name })
          setVersionToRemove(null)
        }}
      >
        <p>清理 {versionToRemove?.v.name} 后，不能再回退到此版本，其产物不再受此版本保护。</p>
      </Confirm>
    </div>
  )
}

export function TasksPage() {
  const {
    state,
    user,
    project: p,
    update,
    stopTask,
    canViewAgent,
    navigate,
    route,
  } = useWorkbench()
  const query = new URLSearchParams(route.split('?')[1] || '')
  const tab = query.get('view') === 'audit' ? 'audit' : 'tasks'
  const [filter, setFilter] = useState({ type: 'all', status: 'all', actor: 'all' })
  const [clean, setClean] = useState(null)
  const [phase, setPhase] = useState('all')
  const tasks = state.tasks.filter(
    (task) => task.projectId === p.id && canViewAgent(task.agentId, p.id),
  )
  const selected = tasks.find((task) => task.id === query.get('task'))
  const shown = tasks.filter(
    (task) =>
      (filter.type === 'all' || task.type === filter.type) &&
      (filter.status === 'all' || task.status === filter.status) &&
      (filter.actor === 'all' || task.actorId === filter.actor),
  )
  const audits = state.audit.filter(
    (entry) => entry.projectId === p.id && canViewAgent(entry.agentId, p.id),
  )
  useEffect(() => setPhase('all'), [query.get('task')])
  const openTask = (id) => navigate(`/p/${p.id}/tasks?task=${id}`)
  const related = selected?.batchId ? tasks.filter((task) => task.batchId === selected.batchId) : []
  const stages =
    selected?.type === 'deploy'
      ? deploymentPhases
      : [
          { id: 'prepare', name: '固定输入', start: 0, end: 15 },
          { id: 'other', name: '执行任务', start: 15, end: 90 },
          { id: 'finish', name: '记录结果', start: 90, end: 100 },
        ]
  function phaseState(stage) {
    if (selected.status === 'running')
      return (selected.progress || 0) >= stage.end
        ? 'success'
        : (selected.progress || 0) >= stage.start
          ? 'running'
          : 'waiting'
    if (selected.status === 'stopped')
      return (selected.progress || 0) >= stage.end
        ? 'success'
        : (selected.progress || 0) >= stage.start
          ? 'stopped'
          : 'waiting'
    if (['failed', 'rolledback', 'unknown'].includes(selected.status)) {
      const failedStage = selected.scenario === 'start-failed' ? 'deploy' : 'health'
      if (stage.id === failedStage) return 'failed'
      if (stage.id === 'finish')
        return selected.status === 'rolledback' ? 'success' : selected.status
    }
    return 'success'
  }
  return (
    <div className="wb-page op-page">
      {selected ? (
        <>
          <div className="op-back-row">
            <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${p.id}/tasks`)}>
              <ChevronLeft />
              全部任务
            </Button>
            <code>{selected.id}</code>
            <CopyButton value={selected.id} label="复制任务 ID" />
          </div>
          <PageHeader title={selected.title}>
            <Status value={selected.status} />
            {selected.status === 'running' ? (
              <Button variant="outline" onClick={() => stopTask(selected.id)}>
                <Square />
                停止任务
              </Button>
            ) : (
              selected.serviceId && (
                <Button
                  variant="outline"
                  onClick={() => navigate(`/p/${p.id}/services?service=${selected.serviceId}`)}
                >
                  返回服务
                  <ArrowUpRight />
                </Button>
              )
            )}
          </PageHeader>
          <div className="op-detail-strip">
            <span>{types[selected.type] || selected.type}</span>
            <span>
              {state.users.find((person) => person.id === selected.actorId)?.name ||
                selected.actorId}
            </span>
            <span>开始于 {time(selected.createdAt)}</span>
            <span>
              {selected.finishedAt
                ? `结束于 ${time(selected.finishedAt)}`
                : `已运行 ${Math.floor((selected.elapsed || 0) / 1000)} 秒`}
            </span>
          </div>
          {related.length > 1 && (
            <div className="op-batch-task-links">
              {related.map((task) => (
                <Button
                  key={task.id}
                  variant={task.id === selected.id ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => openTask(task.id)}
                >
                  {p.services.find((service) => service.id === task.serviceId)?.name || task.title}
                  <Status value={task.status} />
                </Button>
              ))}
            </div>
          )}
          <Panel
            title="任务进度"
            className="op-task-progress"
            actions={<span className="op-caption">{selected.progress || 0}%</span>}
          >
            <div className="op-phase-list">
              {stages.map((stage, index) => {
                const status = phaseState(stage),
                  Icon =
                    status === 'success'
                      ? CheckCircle2
                      : status === 'failed'
                        ? XCircle
                        : status === 'running'
                          ? Loader2
                          : Circle
                const duration = ((selected.duration || 4500) * (stage.end - stage.start)) / 100
                const spent = Math.min(
                  duration,
                  Math.max(
                    0,
                    (selected.elapsed || 0) - ((selected.duration || 4500) * stage.start) / 100,
                  ),
                )
                return (
                  <Button
                    variant="ghost"
                    key={stage.id}
                    className={`op-phase is-${status} ${phase === stage.id ? 'is-selected' : ''}`}
                    onClick={() => setPhase(phase === stage.id ? 'all' : stage.id)}
                  >
                    <span className="op-phase-index">
                      <Icon className={status === 'running' ? 'animate-spin' : ''} />
                    </span>
                    <span>
                      <strong>{stage.name}</strong>
                      <small>
                        {status === 'waiting'
                          ? '等待执行'
                          : status === 'running'
                            ? `${(spent / 1000).toFixed(1)}s · 进行中`
                            : status === 'failed'
                              ? '失败'
                              : status === 'stopped'
                                ? '已停止'
                                : `${(duration / 1000).toFixed(1)}s`}
                      </small>
                    </span>
                    {index < stages.length - 1 && <ChevronRight className="op-phase-arrow" />}
                  </Button>
                )
              })}
            </div>
            <Progress value={selected.progress || 0} className="op-task-progress-bar" />
          </Panel>
          <div className="op-task-layout">
            <Panel
              title="完整日志"
              className="op-log-panel"
              actions={
                phase !== 'all' && (
                  <Badge variant="outline">
                    {stages.find((stage) => stage.id === phase)?.name}
                  </Badge>
                )
              }
            >
              <OperationLogs
                entries={taskLogEntries(selected)}
                filename={`${selected.id}.log`}
                phase={phase}
                onClearPhase={() => setPhase('all')}
                running={selected.status === 'running'}
              />
            </Panel>
            <Panel title="任务快照" className="op-task-snapshot">
              <div className="op-snapshot-section">
                <span className="op-section-label">发布内容</span>
                <dl className="op-confirm-grid">
                  <dt>服务</dt>
                  <dd>
                    {selected.deploymentSnapshot?.serviceName ||
                      p.services.find((service) => service.id === selected.serviceId)?.name ||
                      '—'}
                  </dd>
                  <dt>目标版本</dt>
                  <dd>{selected.deploymentSnapshot?.version || '—'}</dd>
                  <dt>环境</dt>
                  <dd>
                    {selected.deploymentSnapshot?.environmentId
                      ? envName(p, selected.deploymentSnapshot.environmentId)
                      : '—'}
                  </dd>
                  {selected.deploymentSnapshot?.command && (
                    <>
                      <dt>构建命令</dt>
                      <dd>
                        <code>{selected.deploymentSnapshot.command}</code>
                      </dd>
                    </>
                  )}
                  {selected.deploymentSnapshot?.healthPath && (
                    <>
                      <dt>健康检查</dt>
                      <dd>
                        <code>{selected.deploymentSnapshot.healthPath}</code>
                      </dd>
                    </>
                  )}
                </dl>
              </div>
              <div className="op-snapshot-section">
                <span className="op-section-label">固定源码</span>
                {selected.sourceSnapshot ? (
                  <div className="op-snapshot-artifact">
                    <strong>{selected.sourceSnapshot.name}</strong>
                    <div className="op-meta-line">
                      <GitBranch className="size-3.5" />
                      {selected.sourceSnapshot.ref || '固定提交'}
                    </div>
                    {selected.sourceSnapshot.commit && (
                      <div className="op-commit">
                        <code>{selected.sourceSnapshot.commit.slice(0, 12)}</code>
                        <CopyButton value={selected.sourceSnapshot.commit} />
                      </div>
                    )}
                  </div>
                ) : selected.artifactIds?.length ? (
                  selected.artifactIds.map((id) => {
                    const artifact = p.artifacts.find((item) => item.id === id)
                    return (
                      <p className="op-caption" key={id}>
                        {artifact?.name || id}
                        {!artifact || artifact.deleted ? ' · 已删除，无法下载' : ''}
                      </p>
                    )
                  })
                ) : (
                  <p className="op-caption">
                    {selected.deploymentSnapshot?.image || '该任务未引用源码产物'}
                  </p>
                )}
              </div>
              <div className="op-snapshot-section">
                <span className="op-section-label">启动时资源配置</span>
                {selected.configSnapshot?.length ? (
                  selected.configSnapshot.map((resource) => (
                    <div className="op-snapshot-resource" key={resource.id}>
                      <Server className="size-4" />
                      <span>
                        <strong>{resource.name}</strong>
                        <code>
                          {resource.host}:{resource.port}
                        </code>
                        <small>{resource.type} · 凭据已隐藏</small>
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="op-caption">未使用外部资源</p>
                )}
              </div>
            </Panel>
          </div>
        </>
      ) : query.get('task') ? (
        <Empty>
          <p>该任务已清理，或当前账号没有查看权限。</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate(`/p/${p.id}/tasks`)}>
            返回任务列表
          </Button>
        </Empty>
      ) : (
        <>
          <PageHeader title="任务与审计">
            <Button
              variant="outline"
              onClick={() => setClean(tab)}
              disabled={tab === 'audit' && user.role !== 'admin'}
            >
              <Trash2 className="size-4" />
              清理{tab === 'audit' ? '审计' : '完成历史'}
            </Button>
          </PageHeader>
          <Tabs
            value={tab}
            onValueChange={(value) =>
              navigate(`/p/${p.id}/tasks${value === 'audit' ? '?view=audit' : ''}`)
            }
          >
            <TabsList variant="line">
              <TabsTrigger value="tasks">任务</TabsTrigger>
              <TabsTrigger value="audit">操作审计</TabsTrigger>
            </TabsList>
          </Tabs>
          {tab === 'tasks' ? (
            <>
              <div className="op-list-toolbar">
                <Picker
                  label="任务类型"
                  value={filter.type}
                  onChange={(type) => setFilter({ ...filter, type })}
                  options={[
                    { value: 'all', label: '全部类型' },
                    ...Array.from(new Set(tasks.map((task) => task.type))).map((value) => ({
                      value,
                      label: types[value] || value,
                    })),
                  ]}
                />
                <Picker
                  label="任务状态"
                  value={filter.status}
                  onChange={(status) => setFilter({ ...filter, status })}
                  options={[
                    { value: 'all', label: '全部状态' },
                    { value: 'running', label: '进行中' },
                    { value: 'success', label: '成功' },
                    { value: 'failed', label: '失败' },
                    { value: 'rolledback', label: '已自动回退' },
                    { value: 'stopped', label: '已停止' },
                    { value: 'unknown', label: '结果待核查' },
                  ]}
                />
                <Picker
                  label="任务发起人"
                  value={filter.actor}
                  onChange={(actor) => setFilter({ ...filter, actor })}
                  options={[
                    { value: 'all', label: '全部发起人' },
                    ...state.users.map((person) => ({ value: person.id, label: person.name })),
                  ]}
                />
                <span className="op-caption">{shown.length} 条记录</span>
              </div>
              <Panel className="op-task-list-panel">
                {shown.length ? (
                  <Table className="op-task-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>任务</TableHead>
                        <TableHead>发起人</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>开始时间</TableHead>
                        <TableHead>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.map((task) => (
                        <TableRow key={task.id}>
                          <TableCell>
                            <Button
                              variant="link"
                              className="op-name-link"
                              onClick={() => openTask(task.id)}
                            >
                              {task.title}
                              <ArrowUpRight className="size-3.5" />
                            </Button>
                            <p className="op-caption">
                              {types[task.type] || task.type} · {task.id}
                            </p>
                          </TableCell>
                          <TableCell>
                            {state.users.find((person) => person.id === task.actorId)?.name ||
                              task.actorId}
                          </TableCell>
                          <TableCell>
                            <Status value={task.status} />
                            {task.status === 'running' && (
                              <Progress value={task.progress || 0} className="mt-2 w-24" />
                            )}
                          </TableCell>
                          <TableCell className="op-caption">{time(task.createdAt)}</TableCell>
                          <TableCell>
                            {task.status === 'running' ? (
                              <Button variant="outline" size="sm" onClick={() => stopTask(task.id)}>
                                停止任务
                              </Button>
                            ) : (
                              <Button variant="ghost" size="sm" onClick={() => openTask(task.id)}>
                                详情
                                <ChevronRight className="size-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <Empty>没有符合条件的任务</Empty>
                )}
              </Panel>
            </>
          ) : (
            <Panel className="op-task-list-panel">
              {audits.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>操作人</TableHead>
                      <TableHead>操作 / 对象</TableHead>
                      <TableHead>结果</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {audits.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="op-caption">{time(entry.createdAt)}</TableCell>
                        <TableCell>
                          {state.users.find((person) => person.id === entry.actorId)?.name ||
                            entry.actorId}
                        </TableCell>
                        <TableCell>
                          {entry.action}
                          <p className="op-caption">{entry.object}</p>
                        </TableCell>
                        <TableCell>{entry.result}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Empty>暂无操作审计</Empty>
              )}
              {user.role !== 'admin' && <p className="op-caption mt-4">仅平台管理员可清理审计。</p>}
            </Panel>
          )}
        </>
      )}
      <Confirm
        title={clean === 'audit' ? '清理项目审计' : '清理完成任务历史'}
        open={Boolean(clean)}
        onClose={() => setClean(null)}
        danger
        onConfirm={() => {
          if (clean === 'audit' && user.role !== 'admin') return
          update((draft) => {
            if (clean === 'audit')
              draft.audit = draft.audit.filter(
                (entry) => entry.projectId !== p.id || !canViewAgent(entry.agentId, p.id),
              )
            else
              draft.tasks = draft.tasks.filter(
                (task) =>
                  task.projectId !== p.id ||
                  task.status === 'running' ||
                  !canViewAgent(task.agentId, p.id),
              )
          })
          setClean(null)
          toast.success('历史已清理')
        }}
      >
        <p>
          {clean === 'audit'
            ? '删除当前可见的项目操作审计记录。'
            : '删除当前有权查看的已结束任务记录，运行中的任务和产物保留。'}
          此操作无法恢复。
        </p>
      </Confirm>
    </div>
  )
}

export function AccountAdminPage() {
  const { state, user, update, audit } = useWorkbench()
  const [edit, setEdit] = useState(null)
  const [reset, setReset] = useState(null)
  const [password, setPassword] = useState('')
  if (user.role !== 'admin') return <Empty>仅管理员可管理平台账号。</Empty>
  function save() {
    if (!edit.name.trim() || !edit.username.trim() || edit.password.length < 6)
      return toast.error('请填写姓名、用户名和至少 6 位密码')
    if (state.users.some((u) => u.username === edit.username && u.id !== edit.id))
      return toast.error('用户名已存在')
    update((d) => d.users.push(edit))
    audit({ action: '创建账号', object: edit.username })
    setEdit(null)
    toast.success('账号已创建，可使用该账号登录')
  }
  return (
    <div className="wb-page">
      <PageHeader title="平台账号">
        <Button
          onClick={() =>
            setEdit({ id: uid('user'), name: '', username: '', password: '', role: 'member' })
          }
        >
          <Plus />
          创建账号
        </Button>
      </PageHeader>
      <Panel title="用户">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>姓名</TableHead>
              <TableHead>用户名</TableHead>
              <TableHead>平台角色</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  {u.name}
                  {u.id === user.id && (
                    <Badge variant="secondary" className="ml-2">
                      当前
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{u.username}</TableCell>
                <TableCell>{u.role === 'admin' ? '管理员' : '成员'}</TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setPassword('')
                      setReset(u)
                    }}
                  >
                    重置密码
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
      <Modal
        title="创建平台账号"
        open={!!edit}
        onClose={() => setEdit(null)}
        footer={<Button onClick={save}>创建账号</Button>}
      >
        {edit && (
          <div className="wb-stack">
            <Field label="姓名">
              <Input
                aria-label="用户姓名"
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </Field>
            <Field label="用户名">
              <Input
                aria-label="新用户名"
                value={edit.username}
                onChange={(e) => setEdit({ ...edit, username: e.target.value })}
              />
            </Field>
            <Field label="初始密码">
              <Input
                aria-label="初始密码"
                type="password"
                autoComplete="new-password"
                value={edit.password}
                onChange={(e) => setEdit({ ...edit, password: e.target.value })}
              />
            </Field>
            <Field label="平台角色">
              <Picker
                label="平台角色"
                value={edit.role}
                onChange={(role) => setEdit({ ...edit, role })}
                options={[
                  { value: 'member', label: '成员' },
                  { value: 'admin', label: '管理员' },
                ]}
              />
            </Field>
          </div>
        )}
      </Modal>
      <Modal
        title={`重置 ${reset?.name || ''} 的密码`}
        open={!!reset}
        onClose={() => setReset(null)}
        footer={
          <Button
            onClick={() => {
              if (password.length < 6) return toast.error('密码至少 6 位')
              update((d) => {
                d.users.find((u) => u.id === reset.id).password = password
              })
              audit({ action: '重置账号密码', object: reset.username })
              setReset(null)
              toast.success('密码已重置')
            }}
          >
            确认重置
          </Button>
        }
      >
        <Field label="新密码">
          <Input
            aria-label="重置新密码"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </Modal>
    </div>
  )
}
export function NotificationsPage() {
  const { state, user, update, navigate, canViewAgent } = useWorkbench()
  const accessible = (n) =>
    (!n.projectId ||
      (state.projects[n.projectId] &&
        (user.role === 'admin' || state.projects[n.projectId].memberIds.includes(user.id)))) &&
    canViewAgent(n.agentId, n.projectId)
  const items = state.notifications.filter(accessible)
  return (
    <div className="wb-page">
      <PageHeader title="站内通知">
        <Button
          variant="outline"
          onClick={() =>
            update((d) => {
              for (const n of d.notifications.filter(accessible))
                n.readBy = [...new Set([...(n.readBy || []), user.id])]
            })
          }
        >
          全部标为已读
        </Button>
      </PageHeader>
      <Panel title="通知">
        {items.length ? (
          items.map((n) => (
            <div className="wb-list-row" key={n.id}>
              <div
                className={`wb-notice-dot ${(n.readBy || []).includes(user.id) ? 'is-read' : ''}`}
              />
              <div className="flex-1">
                <strong>{n.title}</strong>
                <p className="wb-muted">
                  {n.projectId ? state.projects[n.projectId]?.name : '全局工具'} ·{' '}
                  {time(n.createdAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  update((d) => {
                    const item = d.notifications.find((x) => x.id === n.id)
                    item.readBy = [...new Set([...(item.readBy || []), user.id])]
                  })
                  navigate(n.projectId ? `/p/${n.projectId}/tasks` : '/cabinet')
                }}
              >
                查看
                <ArrowUpRight />
              </Button>
            </div>
          ))
        ) : (
          <Empty>暂无通知</Empty>
        )}
      </Panel>
    </div>
  )
}
