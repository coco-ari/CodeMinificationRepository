import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileText,
  FolderOpen,
  History,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Pin,
  PinOff,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useDemo } from './use-demo'
import { discardDraft, suspendDrafts } from './use-draft'
import { Chat, STATUS } from './Chat'
import { FilePreview } from './Content'
import { fileUrl } from './api'

const getSelected = () =>
  new URLSearchParams(location.hash.replace(/^#/, '')).get('conversation') || ''
const runtimeModelLabel = (runtime) => {
  if (!runtime.model) return '未提供'
  const provider = runtime.provider === 'cpa' ? 'CPA' : runtime.provider
  return provider ? `${runtime.model}（${provider}）` : runtime.model
}
const timeLabel = (value) => {
  const date = new Date(value || Date.now())
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
const artifactLabel = (file, turns = []) => {
  const turnIndex = turns.findIndex((turn) => turn.id === file.turnId)
  const date = new Date(file.createdAt)
  const time = Number.isFinite(date.getTime())
    ? [
        date.toDateString() !== new Date().toDateString()
          ? date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
          : '',
        date.toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }),
      ]
        .filter(Boolean)
        .join(' ')
    : ''
  return [
    turnIndex >= 0 ? `第 ${turnIndex + 1} 轮` : '',
    time,
    file.size ? `${Math.max(1, Math.round(file.size / 1024))} KB` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function SelectField({ label, value, onChange, options, disabled = false }) {
  return (
    <div className="workbench-demo-field">
      <Label>{label}</Label>
      <NativeSelect
        aria-label={label}
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}

function Login({ login, error: initialError }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <main className="workbench-demo-login">
      <Card className="workbench-demo-login-card">
        <div className="workbench-demo-brand workbench-demo-login-brand">
          <span>A</span>
          <strong>AutoOps</strong>
        </div>
        <h1>登录工作台</h1>
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            if (busy) return
            setBusy(true)
            setError('')
            try {
              await login(username, password)
            } catch (failure) {
              setError(failure.message)
            } finally {
              setBusy(false)
            }
          }}
        >
          <div className="workbench-demo-field">
            <Label htmlFor="workbench-demo-username">账号</Label>
            <Input
              id="workbench-demo-username"
              aria-label="用户名"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="workbench-demo-field">
            <Label htmlFor="workbench-demo-password">密码</Label>
            <Input
              id="workbench-demo-password"
              aria-label="密码"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {(error || initialError) && (
            <div className="workbench-demo-inline-error" role="alert">
              <CircleAlert size={15} />
              {error || initialError}
            </div>
          )}
          <Button
            disabled={busy || !username.trim() || !password}
            type="submit"
            className="workbench-demo-login-submit"
          >
            {busy ? (
              <LoaderCircle className="workbench-demo-spin" size={16} />
            ) : (
              <ArrowRight size={16} />
            )}
            {busy ? '正在登录…' : '登录'}
          </Button>
        </form>
        <div className="workbench-demo-demo-account">
          <span>测试账号：admin / lin / chen</span>
          <span>演示口令：Demo123!</span>
        </div>
      </Card>
    </main>
  )
}

function NewConversation({
  open,
  onClose,
  onCloseAutoFocus,
  projects,
  agents,
  runtime,
  initialProjectId,
  onCreate,
}) {
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    const project = projects.find((item) => item.id === initialProjectId) || projects[0]
    setForm({
      projectId: project?.id || '',
      environmentId: project?.environments?.[0]?.id || '',
      agentId: agents.find((item) => item.projectIds?.includes(project?.id))?.id || '',
      visibility: 'project',
      mode: runtime.liveAvailable ? 'live' : 'scenario',
      title: '',
    })
    setError('')
  }, [open])
  const project = projects.find((item) => item.id === form?.projectId)
  const available = agents.filter((item) => item.projectIds?.includes(form?.projectId))
  const patch = (key, value) => setForm((old) => ({ ...old, [key]: value }))
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose()
      }}
    >
      <DialogContent className="workbench-demo-new-dialog" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
          <DialogDescription className="sr-only">
            选择固定的项目、环境、Agent 和会话可见范围。
          </DialogDescription>
        </DialogHeader>
        {form && (
          <form
            onSubmit={async (event) => {
              event.preventDefault()
              if (busy) return
              setBusy(true)
              setError('')
              try {
                await onCreate({ ...form, environmentId: form.environmentId || null })
                onClose()
              } catch (failure) {
                setError(failure.message)
              } finally {
                setBusy(false)
              }
            }}
          >
            <SelectField
              label="所属项目"
              value={form.projectId}
              options={projects.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(id) => {
                const next = projects.find((item) => item.id === id)
                setForm((old) => ({
                  ...old,
                  projectId: id,
                  environmentId: next?.environments?.[0]?.id || '',
                  agentId: agents.find((item) => item.projectIds?.includes(id))?.id || '',
                }))
              }}
            />
            <SelectField
              label="会话 Agent"
              value={form.agentId}
              options={available.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => patch('agentId', value)}
            />
            <div className="workbench-demo-form-pair">
              <SelectField
                label="固定环境"
                value={form.environmentId}
                options={[
                  ...(project?.environments || []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                ]}
                onChange={(value) => patch('environmentId', value)}
              />
              <SelectField
                label="可见范围"
                value={form.visibility}
                options={[
                  { value: 'project', label: '项目成员共享' },
                  { value: 'private', label: '仅自己可见' },
                ]}
                onChange={(value) => patch('visibility', value)}
              />
            </div>
            <SelectField
              label="运行模式"
              value={form.mode}
              options={[
                {
                  value: 'live',
                  label: runtime.model ? `真实运行 · ${runtimeModelLabel(runtime)}` : '真实运行器',
                  disabled: !runtime.liveAvailable,
                },
                { value: 'scenario', label: '场景演示 · 验证交互时序' },
              ]}
              onChange={(value) => patch('mode', value)}
            />
            {!runtime.liveAvailable && (
              <div className="workbench-demo-form-note">
                <CircleAlert size={14} />
                <span>
                  真实运行器暂不可用。{runtime.reason || '当前仅能使用明确标识的场景模式。'}
                </span>
              </div>
            )}
            <div className="workbench-demo-field">
              <Label htmlFor="workbench-demo-new-title">
                会话名称 <span className="workbench-demo-muted">可选</span>
              </Label>
              <Input
                id="workbench-demo-new-title"
                aria-label="会话名称"
                placeholder="例如：测试环境发布前检查"
                value={form.title}
                onChange={(event) => patch('title', event.target.value)}
                maxLength={120}
              />
            </div>
            {error && (
              <div role="alert" className="workbench-demo-inline-error">
                {error}
              </div>
            )}
            <div className="workbench-demo-dialog-actions">
              <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !form.projectId ||
                  !form.agentId ||
                  !form.environmentId ||
                  (form.mode === 'live' && !runtime.liveAvailable)
                }
              >
                {busy && <LoaderCircle size={14} className="workbench-demo-spin" />}创建会话
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function HistoryPanel({
  conversations,
  selected,
  search,
  setSearch,
  onSelect,
  onNew,
  project,
  showArchived,
  setShowArchived,
  onPreference,
  preferenceBusy,
}) {
  const needle = search.trim().toLowerCase()
  const textOf = (item) => (item.messages || []).map((message) => message.content || '').join('\n')
  const filtered = conversations.filter(
    (item) =>
      Boolean(item.archived) === showArchived &&
      (!needle ||
        item.title.toLowerCase().includes(needle) ||
        textOf(item).toLowerCase().includes(needle)),
  )
  const groups = [
    { title: '置顶', items: filtered.filter((item) => item.pinned) },
    {
      title: '今天',
      items: filtered.filter(
        (item) =>
          !item.pinned && new Date(item.updatedAt).toDateString() === new Date().toDateString(),
      ),
    },
    {
      title: '更早',
      items: filtered.filter(
        (item) =>
          !item.pinned && new Date(item.updatedAt).toDateString() !== new Date().toDateString(),
      ),
    },
  ]
  return (
    <div className="workbench-demo-history-inner">
      <div className="workbench-demo-history-top">
        <span className="workbench-demo-section-label">{showArchived ? '已归档' : '会话'}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={showArchived ? '返回会话列表' : '查看已归档会话'}
          aria-pressed={showArchived}
          onClick={() => setShowArchived(!showArchived)}
        >
          <Archive size={16} />
        </Button>
        <Button size="icon-sm" variant="outline" aria-label="新建会话" onClick={onNew}>
          <Plus size={17} />
        </Button>
      </div>
      <div className="workbench-demo-search">
        <Search size={15} />
        <Input
          aria-label="搜索会话"
          placeholder="搜索标题或正文"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="workbench-demo-history-list">
        {groups.map(
          (group) =>
            group.items.length > 0 && (
              <section className="workbench-demo-history-group" key={group.title}>
                <h2>{group.title}</h2>
                {group.items.map((item) => (
                  <div className="workbench-demo-history-row" key={item.id}>
                    <Button
                      variant="ghost"
                      className={`workbench-demo-history-item ${selected === item.id ? 'is-selected' : ''}`}
                      onClick={() => onSelect(item.id)}
                      aria-current={selected === item.id ? 'page' : undefined}
                    >
                      {item.pinned ? <Pin size={15} /> : <MessageSquare size={16} />}
                      <div>
                        <strong>{item.title}</strong>
                        {needle && !item.title.toLowerCase().includes(needle) && (
                          <span className="workbench-demo-search-excerpt">
                            {(() => {
                              const body = textOf(item)
                              const at = body.toLowerCase().indexOf(needle)
                              return `${at > 15 ? '…' : ''}${body.slice(Math.max(0, at - 15), at + needle.length + 45).replace(/\s+/g, ' ')}`
                            })()}
                          </span>
                        )}
                        <small>
                          <span
                            className={
                              item.activeTurnId
                                ? 'workbench-demo-history-status is-active'
                                : 'workbench-demo-history-status'
                            }
                          >
                            {item.activeTurnId && <i />}
                            {STATUS[item.status] || '就绪'}
                          </span>
                          {item.mode === 'scenario' && <span>场景</span>}
                        </small>
                      </div>
                      <time>{timeLabel(item.updatedAt)}</time>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="workbench-demo-history-menu"
                          aria-label={`会话操作 ${item.id}`}
                          disabled={Boolean(preferenceBusy[item.id])}
                        >
                          <MoreHorizontal size={15} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem
                          onSelect={() => onPreference(item.id, { pinned: !item.pinned })}
                        >
                          {item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                          {item.pinned ? '取消置顶' : '置顶会话'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => onPreference(item.id, { archived: !item.archived })}
                        >
                          {item.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          {item.archived ? '移出归档' : '归档会话'}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </section>
            ),
        )}
        {!filtered.length && (
          <div className="workbench-demo-history-empty">
            <MessageSquare size={23} />
            <span>
              {search ? '没有匹配的会话' : showArchived ? '没有已归档的会话' : '还没有会话'}
            </span>
            {!search && !showArchived && (
              <Button variant="outline" size="sm" onClick={onNew}>
                开始新会话
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="workbench-demo-history-footer">
        <FolderOpen size={14} />
        <span>{project?.name || '项目工作台'}</span>
      </div>
    </div>
  )
}

function ContextPanel({ conversation, project, agent, runtime, onPreview, readDocument }) {
  const environment = project?.environments.find((item) => item.id === conversation?.environmentId)
  const resources = (project?.resources || []).filter(
    (item) => !item.environmentId || item.environmentId === conversation?.environmentId,
  )
  const files = conversation?.artifacts || []
  return (
    <Tabs defaultValue="context" className="workbench-demo-context-inner">
      <TabsList className="workbench-demo-context-tabs">
        <TabsTrigger value="context">上下文</TabsTrigger>
        <TabsTrigger value="files">
          结果{files.length > 0 && <span>{files.length}</span>}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="context" className="workbench-demo-context-content">
        <section className="workbench-demo-context-section">
          <h2>本次会话</h2>
          <dl>
            <div>
              <dt>Agent</dt>
              <dd>{agent?.name || '—'}</dd>
            </div>
            <div>
              <dt>项目</dt>
              <dd>{project?.name || '—'}</dd>
            </div>
            <div>
              <dt>环境</dt>
              <dd>{environment?.name || '仅项目资料'}</dd>
            </div>
            <div>
              <dt>可见范围</dt>
              <dd>{conversation?.visibility === 'private' ? '仅自己' : '项目成员'}</dd>
            </div>
            <div>
              <dt>{conversation?.mode === 'live' ? '运行器' : '运行方式'}</dt>
              <dd>
                {conversation?.mode === 'live' ? runtime.name || '真实运行器' : '可控场景演示'}
              </dd>
            </div>
            {conversation?.mode === 'live' && (
              <div>
                <dt>当前模型</dt>
                <dd>{runtimeModelLabel(runtime)}</dd>
              </div>
            )}
          </dl>
        </section>
        <section className="workbench-demo-context-section">
          <h2>
            项目资料 <span>{project?.documents?.length || 0}</span>
          </h2>
          <div className="workbench-demo-context-documents">
            {(project?.documents || []).map((document) => (
              <Button
                key={document.id}
                variant="ghost"
                onClick={() => readDocument(document)}
                className="workbench-demo-context-link"
              >
                <FileText size={15} />
                <span>{document.name}</span>
                <ArrowUpRight size={12} />
              </Button>
            ))}
            {!project?.documents?.length && (
              <p className="workbench-demo-muted">此项目还没有可引用资料。</p>
            )}
          </div>
        </section>
        <section className="workbench-demo-context-section">
          <h2>环境资源</h2>
          {resources.map((resource) => (
            <div className="workbench-demo-resource" key={resource.id}>
              <Server size={15} />
              <div>
                <strong>{resource.name}</strong>
                <span>
                  {{ service: '服务', database: '数据库', cabinet: '机柜' }[resource.type] ||
                    '资源'}
                </span>
              </div>
            </div>
          ))}
          {!resources.length && <p className="workbench-demo-muted">当前上下文没有环境资源。</p>}
        </section>
        <div className="workbench-demo-readonly-note">
          <ShieldCheck size={15} />
          <span>只读资料与环境查询</span>
        </div>
      </TabsContent>
      <TabsContent value="files" className="workbench-demo-context-content">
        <section className="workbench-demo-context-section">
          <h2>会话结果</h2>
          {files.length ? (
            files.map((file) => (
              <div className="workbench-demo-artifact-row" key={file.id}>
                <Button
                  variant="ghost"
                  className="workbench-demo-artifact-open"
                  onClick={() => onPreview(file)}
                >
                  <FileText size={19} />
                  <span>
                    <strong>{file.name}</strong>
                    <small title={artifactLabel(file, conversation?.turns)}>
                      {artifactLabel(file, conversation?.turns)}
                    </small>
                  </span>
                </Button>
                {fileUrl(file) && (
                  <Button variant="ghost" size="icon-sm" aria-label={`下载 ${file.name}`} asChild>
                    <a href={fileUrl(file)} download={file.name}>
                      <Download size={14} />
                    </a>
                  </Button>
                )}
              </div>
            ))
          ) : (
            <div className="workbench-demo-context-empty">
              <FileText size={24} />
              <p>生成的报告和文件会保存在这里。</p>
            </div>
          )}
        </section>
      </TabsContent>
    </Tabs>
  )
}

export default function App() {
  const demo = useDemo()
  const [selectedId, setSelectedId] = useState(getSelected)
  const [projectId, setProjectId] = useState('')
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [preferenceBusy, setPreferenceBusy] = useState({})
  const [creating, setCreating] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  const [reference, setReference] = useState(null)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')
  const [manageBusy, setManageBusy] = useState(false)
  const [documentBusy, setDocumentBusy] = useState(false)
  const documentRequest = useRef(0)
  const visibleIds = useRef(new Set())
  const previousUser = useRef(null)
  const focusReturns = useRef(new Map())
  const focusScope = useRef('')
  const viewer = useRef(demo.user?.id)
  viewer.current = demo.user?.id
  const conversations = Object.values(demo.conversations)
  const selected = demo.conversations[selectedId] || null
  const project =
    demo.projects.find((item) => item.id === (selected?.projectId || projectId)) || demo.projects[0]
  const agent = demo.agents.find((item) => item.id === selected?.agentId)
  focusScope.current = `${demo.user?.id || ''}:${selectedId}:${project?.id || ''}`
  const filtered = useMemo(
    () =>
      Object.values(demo.conversations)
        .filter((item) => item.projectId === project?.id)
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    [demo.conversations, project?.id],
  )
  const previewFile = useCallback((file) => setPreview({ ...file, viewerId: viewer.current }), [])
  const rememberFocus = (layer, event) => {
    const element = event?.currentTarget || document.activeElement
    const owner = element?.closest?.('.workbench-demo-history-sheet')
      ? 'history'
      : element?.closest?.('.workbench-demo-context-sheet')
        ? 'context'
        : null
    focusReturns.current.set(layer, {
      scope: focusScope.current,
      hash: location.hash,
      targets: [element, ...(focusReturns.current.get(owner)?.targets || [])],
    })
  }
  const restoreFocus = (layer, event) => {
    event.preventDefault()
    const saved = focusReturns.current.get(layer)
    focusReturns.current.delete(layer)
    if (!saved || saved.scope !== focusScope.current || saved.hash !== location.hash) return
    const target = saved.targets.find(
      (node) =>
        node instanceof HTMLElement &&
        node !== document.body &&
        node.isConnected &&
        node.getClientRects().length &&
        !node.matches(':disabled') &&
        !node.closest('[inert], [role="dialog"][data-state="closed"]'),
    )
    if (!target) return
    const otherLayer = document.querySelector('[role="dialog"][data-state="open"]')
    if (otherLayer && !otherLayer.contains(target)) return
    target.focus({ preventScroll: true })
  }
  const openHistory = (event) => {
    rememberFocus('history', event)
    setHistoryOpen(true)
  }
  const openContext = (event) => {
    rememberFocus('context', event)
    setContextOpen(true)
  }
  const openNew = (event) => {
    rememberFocus('creating', event)
    setCreating(true)
    setHistoryOpen(false)
  }

  const select = (id) => {
    focusReturns.current.clear()
    setSelectedId(id)
    location.hash = id ? `conversation=${encodeURIComponent(id)}` : ''
    setHistoryOpen(false)
    setContextOpen(false)
    setPreview(null)
    documentRequest.current += 1
    setDocumentBusy(false)
  }
  const setPreference = async (id, body) => {
    if (preferenceBusy[id]) return
    setPreferenceBusy((old) => ({ ...old, [id]: true }))
    try {
      await demo.command(`/conversations/${encodeURIComponent(id)}/preferences`, body, 'PATCH')
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message)
    } finally {
      setPreferenceBusy((old) => ({ ...old, [id]: false }))
    }
  }
  useEffect(() => {
    const userId = demo.user?.id || null
    if (previousUser.current !== userId) {
      focusReturns.current.clear()
      if (previousUser.current) {
        suspendDrafts(previousUser.current)
        setSelectedId('')
        location.hash = ''
      }
      setPreview(null)
      setReference(null)
      setEditing(null)
      setCreating(false)
      setHistoryOpen(false)
      setContextOpen(false)
      setSearch('')
      setShowArchived(false)
      setPreferenceBusy({})
      setError('')
      documentRequest.current += 1
      setDocumentBusy(false)
      visibleIds.current.clear()
    }
    previousUser.current = demo.user?.id || null
  }, [demo.user?.id])
  useEffect(() => {
    const update = () => {
      focusReturns.current.clear()
      setSelectedId(getSelected())
      setPreview(null)
      setReference(null)
      setEditing(null)
      setHistoryOpen(false)
      setContextOpen(false)
      documentRequest.current += 1
      setDocumentBusy(false)
    }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  useEffect(() => {
    const viewport = window.visualViewport
    const resize = () =>
      document.documentElement.style.setProperty(
        '--workbench-demo-viewport-height',
        `${viewport?.height || window.innerHeight}px`,
      )
    resize()
    viewport?.addEventListener('resize', resize)
    window.addEventListener('resize', resize)
    return () => {
      viewport?.removeEventListener('resize', resize)
      window.removeEventListener('resize', resize)
    }
  }, [])
  useEffect(() => {
    if (!demo.user) return
    for (const id of visibleIds.current) {
      if (!demo.conversations[id]) discardDraft(demo.user.id, id)
    }
    visibleIds.current = new Set(Object.keys(demo.conversations))
  }, [demo.conversations, demo.user?.id])
  useEffect(() => {
    if (!selectedId || !demo.user) return
    void demo.readConversation(selectedId).catch((failure) => {
      if (failure.name !== 'AbortError') setError(failure.message)
    })
  }, [selectedId, demo.user?.id])
  useEffect(() => {
    if (!demo.user || selectedId || !filtered.length) return
    const first = filtered.find((item) => Boolean(item.archived) === showArchived)
    if (first) select(first.id)
  }, [demo.user?.id, selectedId, filtered, showArchived])

  const history = (
    <HistoryPanel
      showArchived={showArchived}
      setShowArchived={setShowArchived}
      onPreference={setPreference}
      preferenceBusy={preferenceBusy}
      conversations={filtered}
      selected={selected?.id}
      project={project}
      search={search}
      setSearch={setSearch}
      onSelect={select}
      onNew={openNew}
    />
  )
  const readDocument = async (document) => {
    const id = ++documentRequest.current
    setDocumentBusy(true)
    try {
      const result = await demo.api(
        `/projects/${encodeURIComponent(project.id)}/documents/${encodeURIComponent(document.id)}`,
      )
      if (id === documentRequest.current) {
        setPreview({ ...result.document, projectDocument: true, viewerId: demo.user.id })
        setContextOpen(false)
      }
    } catch (failure) {
      if (id === documentRequest.current) setError(failure.message)
    } finally {
      if (id === documentRequest.current) setDocumentBusy(false)
    }
  }
  const openContentLink = (event) => {
    const link = event.target.closest?.('.workbench-demo-markdown a[href]')
    if (!link) return
    let url
    try {
      url = new URL(link.href, location.origin)
    } catch {
      return
    }
    if (url.origin !== location.origin) return
    const match = url.pathname.match(
      /^\/api\/agent-demo\/projects\/([^/]+)\/documents\/([^/]+)\/?$/,
    )
    if (!match) return
    event.preventDefault()
    try {
      const targetProjectId = decodeURIComponent(match[1])
      const documentId = decodeURIComponent(match[2])
      const document = project?.documents?.find((item) => item.id === documentId)
      if (targetProjectId !== project?.id || !document) {
        setError('该资料不属于当前会话可引用的项目资料。')
        return
      }
      void readDocument(document)
    } catch {
      setError('资料链接无法识别。')
    }
  }
  const context = (
    <ContextPanel
      conversation={selected}
      project={project}
      agent={agent}
      runtime={demo.runtime}
      onPreview={previewFile}
      readDocument={readDocument}
    />
  )

  if (demo.booting)
    return (
      <main className="workbench-demo-loading">
        <span className="workbench-demo-brand">
          <span>A</span>
          <strong>AutoOps</strong>
        </span>
        <LoaderCircle className="workbench-demo-spin" size={21} />
        <p>正在打开工作台…</p>
      </main>
    )
  if (!demo.user) return <Login login={demo.login} error={demo.error} />

  return (
    <main className="workbench-demo-app">
      <header className="workbench-demo-topbar">
        <div className="workbench-demo-brand">
          <span>A</span>
          <strong>AutoOps</strong>
          <span className="workbench-demo-brand-divider" />
          <small>Agent 工作台</small>
        </div>
        <div className="workbench-demo-topbar-actions">
          <NativeSelect
            aria-label="当前项目"
            value={project?.id || ''}
            onChange={(event) => {
              const id = event.target.value
              setProjectId(id)
              setSearch('')
              const first = conversations
                .filter((item) => item.projectId === id)
                .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0]
              select(first?.id || '')
            }}
          >
            {demo.projects.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <span
            className="workbench-demo-global-connection"
            title={demo.connection === 'connected' ? '会话事件已连接' : '正在恢复事件连接'}
          >
            <i className={demo.connection === 'connected' ? 'is-connected' : ''} />
            <span>{demo.connection === 'connected' ? '已连接' : '连接中'}</span>
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="workbench-demo-user-button" aria-label="账号菜单">
                <span>{demo.user.name?.slice(-1)}</span>
                <span className="workbench-demo-user-name">{demo.user.name}</span>
                <ChevronDown size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled>
                {demo.user.username} · {demo.user.role === 'admin' ? '管理员' : '成员'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={async () => {
                  try {
                    await demo.logout()
                    suspendDrafts(demo.user.id)
                    setSelectedId('')
                    location.hash = ''
                    visibleIds.current.clear()
                  } catch (failure) {
                    setError(failure.message)
                  }
                }}
              >
                <LogOut size={14} />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {(error || demo.error) && (
        <div className="workbench-demo-global-error" role="alert">
          <CircleAlert size={15} />
          <span>{error || demo.error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError('')
              void demo.bootstrap()
            }}
          >
            重新同步
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="关闭提示" onClick={() => setError('')}>
            <X size={14} />
          </Button>
        </div>
      )}
      <Card className="workbench-demo-workspace">
        <aside className="workbench-demo-history" aria-label="会话历史">
          {history}
        </aside>
        {selected ? (
          <Chat
            conversation={selected}
            project={project}
            agent={agent}
            user={demo.user}
            connection={demo.connection}
            api={demo.api}
            command={demo.command}
            onPreview={previewFile}
            onContentLink={openContentLink}
            onOpenHistory={openHistory}
            onOpenContext={openContext}
            onSelectConversation={select}
            onMore={() =>
              setEditing({
                id: selected.id,
                title: selected.title,
                deleting: false,
                viewerId: demo.user.id,
              })
            }
            refresh={demo.readConversation}
            reference={reference}
          />
        ) : (
          <section className="workbench-demo-no-conversation">
            <Button
              variant="ghost"
              className="workbench-demo-show-history workbench-demo-empty-history"
              onClick={openHistory}
            >
              <History size={17} />
              历史会话
            </Button>
            <span className="workbench-demo-welcome-icon">
              <Bot size={32} />
            </span>
            <h1>{selectedId ? '会话不可用' : '准备开始新的分析'}</h1>
            {selectedId && <p>此会话可能已删除，或你当前没有访问权限。</p>}
            <Button onClick={openNew}>
              <Plus size={16} />
              新建会话
            </Button>
            {!demo.runtime.liveAvailable && (
              <span className="workbench-demo-runtime-note">
                真实运行器暂不可用，可先使用场景模式
              </span>
            )}
          </section>
        )}
        <aside className="workbench-demo-context" aria-label="会话上下文">
          {context}
        </aside>
      </Card>
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="left"
          className="workbench-demo-history-sheet"
          onCloseAutoFocus={(event) => restoreFocus('history', event)}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>会话历史</SheetTitle>
            <SheetDescription>选择历史会话或新建会话。</SheetDescription>
          </SheetHeader>
          {history}
        </SheetContent>
      </Sheet>
      <Sheet open={contextOpen} onOpenChange={setContextOpen}>
        <SheetContent
          side="right"
          className="workbench-demo-context-sheet"
          onCloseAutoFocus={(event) => restoreFocus('context', event)}
        >
          <SheetHeader>
            <SheetTitle>会话上下文</SheetTitle>
            <SheetDescription className="sr-only">
              查看当前项目资料、固定环境和会话结果。
            </SheetDescription>
          </SheetHeader>
          {context}
        </SheetContent>
      </Sheet>
      <NewConversation
        open={creating}
        onClose={() => setCreating(false)}
        onCloseAutoFocus={(event) => restoreFocus('creating', event)}
        projects={demo.projects}
        agents={demo.agents}
        runtime={demo.runtime}
        initialProjectId={project?.id}
        onCreate={async (form) => {
          setShowArchived(false)
          const result = await demo.command('/conversations', form)
          setProjectId(form.projectId)
          select(result.conversation.id)
        }}
      />
      <Dialog
        open={Boolean(editing && editing.viewerId === demo.user.id)}
        onOpenChange={(open) => {
          if (!open && !manageBusy) setEditing(null)
        }}
      >
        <DialogContent className="workbench-demo-edit-dialog">
          <DialogHeader>
            <DialogTitle>{editing?.deleting ? '删除会话？' : '会话设置'}</DialogTitle>
            <DialogDescription className={editing?.deleting ? '' : 'sr-only'}>
              {editing?.deleting
                ? '会话及其内容将被删除；此浏览器中对应的个人草稿也会清理。'
                : '修改会话名称或删除没有运行任务的会话。'}
            </DialogDescription>
          </DialogHeader>
          {!editing?.deleting && (
            <div className="workbench-demo-field">
              <Label htmlFor="workbench-demo-edit-title">会话名称</Label>
              <Input
                id="workbench-demo-edit-title"
                aria-label="修改会话名称"
                value={editing?.title || ''}
                onChange={(event) => setEditing((old) => ({ ...old, title: event.target.value }))}
              />
            </div>
          )}
          <div className="workbench-demo-dialog-actions">
            {!editing?.deleting && (
              <Button
                variant="ghost"
                className="workbench-demo-danger workbench-demo-action-start"
                disabled={Boolean(demo.conversations[editing?.id]?.activeTurnId) || manageBusy}
                title={
                  demo.conversations[editing?.id]?.activeTurnId
                    ? '请先停止正在执行的轮次'
                    : '删除会话'
                }
                onClick={() => setEditing((old) => ({ ...old, deleting: true }))}
              >
                <Trash2 size={14} />
                删除会话
              </Button>
            )}
            <Button variant="ghost" disabled={manageBusy} onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              variant={editing?.deleting ? 'destructive' : 'default'}
              disabled={manageBusy || !editing?.title.trim()}
              onClick={async () => {
                setManageBusy(true)
                try {
                  const id = editing.id
                  await demo.command(
                    `/conversations/${encodeURIComponent(id)}`,
                    editing.deleting ? undefined : { title: editing.title.trim() },
                    editing.deleting ? 'DELETE' : 'PATCH',
                  )
                  if (editing.deleting) {
                    demo.remove(id)
                    discardDraft(demo.user.id, id)
                    if (selectedId === id) select('')
                  }
                  setEditing(null)
                } catch (failure) {
                  setError(failure.message)
                } finally {
                  setManageBusy(false)
                }
              }}
            >
              {manageBusy && <LoaderCircle className="workbench-demo-spin" size={14} />}
              {editing?.deleting ? '确认删除' : '保存修改'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <FilePreview
        file={preview?.viewerId === demo.user.id ? preview : null}
        onClose={() => setPreview(null)}
        onReference={
          preview?.projectDocument && selected
            ? () => {
                setReference({ conversationId: selected.id, name: preview.name, id: Date.now() })
                setPreview(null)
                setContextOpen(false)
              }
            : undefined
        }
      />
      {documentBusy && (
        <div className="workbench-demo-document-loading" role="status">
          <LoaderCircle size={14} className="workbench-demo-spin" />
          正在打开资料…
        </div>
      )}
    </main>
  )
}
