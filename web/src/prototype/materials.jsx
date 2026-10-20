import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Code2,
  Database,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Info,
  Link2,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  Save,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { usePrototype, pluginCatalog } from './context'

const sections = [
  ['overview', '概览'],
  ['documents', '研发资料'],
  ['repository', '仓库与源码'],
  ['resources', '环境资源'],
  ['plugins', '插件配置'],
  ['artifacts', '源码与产物'],
]

const environmentLabels = { test: '测试', production: '生产' }

function Field({ label, htmlFor, hint, children }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Choice({ id, value, onChange, options, placeholder = '请选择' }) {
  return (
    <Select
      value={value || '__none'}
      onValueChange={(next) => onChange(next === '__none' ? '' : next)}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">{placeholder}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function VersionStrip() {
  const { project, hasDraftChanges } = usePrototype()
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/35 px-4 py-3 text-sm">
      <span className="text-muted-foreground">当前生效</span>
      <Badge variant="secondary">v{project.configVersion}</Badge>
      {hasDraftChanges ? (
        <>
          <ArrowRight className="mx-1 size-4 text-muted-foreground" />
          <span className="text-amber-700">待应用</span>
          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
            v{Number(project.configVersion) + 1}
          </Badge>
        </>
      ) : (
        <span className="flex items-center gap-1 text-xs text-emerald-700">
          <Check className="size-3.5" /> 与当前配置一致
        </span>
      )}
      <span className="ml-auto text-xs text-muted-foreground">保存草稿不会影响正在运行的任务</span>
    </div>
  )
}

export function MaterialsPage({ tab = 'overview', selectedId }) {
  tab = tab || 'overview'
  const { navigate, saveDraft, applyDraft, hasDraftChanges } = usePrototype()

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">资料与配置</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={
              hasDraftChanges
                ? 'border-amber-200 bg-amber-50 text-amber-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
            }
          >
            <span
              className={`mr-1 size-1.5 rounded-full ${hasDraftChanges ? 'bg-amber-500' : 'bg-emerald-500'}`}
            />
            {hasDraftChanges ? '有待应用草稿' : '配置已生效'}
          </Badge>
          <Button variant="outline" onClick={saveDraft}>
            <Save />
            保存草稿
          </Button>
          <Button onClick={applyDraft} disabled={!hasDraftChanges}>
            <Check />
            应用配置
          </Button>
        </div>
      </div>
      <Tabs value={tab} onValueChange={(next) => navigate('materials', next)}>
        <div className="overflow-x-auto border-b pb-1">
          <TabsList variant="line" className="h-10 gap-3">
            {sections.map(([value, label]) => (
              <TabsTrigger key={value} value={value} className="px-3">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
      {tab === 'overview' && <OverviewSection />}
      {tab === 'documents' && <DocumentsSection selectedId={selectedId} />}
      {tab === 'repository' && <RepositorySection />}
      {tab === 'resources' && <ResourcesSection selectedId={selectedId} />}
      {tab === 'plugins' && <PluginsSection selectedId={selectedId} />}
      {!sections.some(([value]) => value === tab) && (
        <Card>
          <CardContent>
            未找到此资料分类。
            <Button variant="link" onClick={() => navigate('materials', 'overview')}>
              返回概览
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function OverviewSection() {
  const { project, editDraft, navigate } = usePrototype()
  const draft = project.draft
  const summaries = [
    {
      title: '研发资料',
      description: '需求、原型和技术文档',
      value: `${project.documents.length} 份资料`,
      icon: FileText,
      tab: 'documents',
    },
    {
      title: '仓库与源码',
      description: draft.repository || '添加项目 Git 仓库',
      value: draft.branch || 'main',
      icon: GitBranch,
      tab: 'repository',
    },
    {
      title: '环境资源',
      description: '服务器、数据库与缓存',
      value: `${draft.resources.length} 个资源`,
      icon: Database,
      tab: 'resources',
    },
    {
      title: '插件配置',
      description: '共用资源，独立配置',
      value: `${Object.values(draft.plugins).filter((plugin) => plugin.enabled).length} 个已选择`,
      icon: Settings2,
      tab: 'plugins',
    },
  ]
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader>
          <CardTitle>项目基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <Field label="项目名称" htmlFor="project-name">
            <Input
              id="project-name"
              value={draft.name}
              onChange={(event) =>
                editDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </Field>
          <Field label="项目说明" htmlFor="project-description">
            <Textarea
              id="project-description"
              value={draft.description}
              rows={5}
              onChange={(event) =>
                editDraft((current) => ({ ...current, description: event.target.value }))
              }
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            {summaries.map(({ title, description, value, icon: Icon, tab }) => (
              <Button
                key={tab}
                variant="outline"
                className="h-auto min-w-0 justify-start gap-3 whitespace-normal p-4 text-left"
                onClick={() => navigate('materials', tab)}
              >
                <span className="rounded-lg bg-muted p-2">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {title}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{value}</span>
                  </span>
                  <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
                    {description}
                  </span>
                </span>
                <ChevronRight className="size-4" />
              </Button>
            ))}
          </div>
          <VersionStrip />
        </CardContent>
      </Card>
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle>统一的项目资料</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            <div className="flex gap-3">
              <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">给团队看，也给工具用</p>
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  一份资料保留版本，通过统一接口提供给部署、插件与 Agent。
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">配置只维护一次</p>
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  插件引用公共环境资源。资源调整后，在应用配置前查看影响范围。
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">项目之间相互隔离</p>
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  本原型的变更保存在当前浏览器，每个项目单独维护。
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>继续探索</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button
              className="w-full justify-between"
              variant="outline"
              onClick={() => navigate('materials', 'artifacts')}
            >
              查看源码处理产物
              <ArrowRight />
            </Button>
            <Button
              className="w-full justify-between"
              variant="outline"
              onClick={() => navigate('chat')}
            >
              让 Agent 读取资料
              <ArrowRight />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function DocumentsSection({ selectedId }) {
  const { project, projectId, updateProject, navigate } = usePrototype()
  const [query, setQuery] = useState('')
  const [viewId, setViewId] = useState(selectedId || project.documents[0]?.id)
  const [editor, setEditor] = useState(null)
  const fileRef = useRef(null)
  const selected = project.documents.find((document) => document.id === viewId)
  const documents = project.documents.filter((document) =>
    `${document.name} ${document.type}`.toLowerCase().includes(query.toLowerCase()),
  )

  useEffect(() => {
    setViewId(selectedId || project.documents[0]?.id)
    setQuery('')
    setEditor(null)
  }, [projectId, selectedId])

  function saveDocument() {
    if (!editor.name.trim() || !editor.content.trim()) {
      toast.error('请填写资料名称和正文')
      return
    }
    const document = {
      id: editor.id || `doc-${Date.now()}`,
      name: editor.name.trim(),
      type: editor.type || 'Markdown',
      version: editor.id ? Number(editor.version || 1) + 1 : 1,
      content: editor.content,
      updatedAt: '刚刚',
    }
    updateProject((current) => ({
      ...current,
      documents: editor.id
        ? current.documents.map((item) => (item.id === editor.id ? document : item))
        : [...current.documents, document],
    }))
    setViewId(document.id)
    setEditor(null)
    toast.success(editor.id ? '资料已保存为新版本' : '资料已添加，可供 Agent 和插件引用')
  }

  function uploadDocument(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 256 * 1024) {
      toast.error('原型支持上传 256 KB 以内的文本文件')
      return
    }
    if (!/\.(txt|md|json)$/i.test(file.name)) {
      toast.error('请选择 .txt、.md 或 .json 文本文件')
      return
    }
    const reader = new FileReader()
    reader.onload = () =>
      setEditor({
        name: file.name,
        type: file.name.endsWith('.json') ? 'JSON' : 'Markdown',
        content: String(reader.result),
      })
    reader.onerror = () => toast.error('文件读取失败，请重试')
    reader.readAsText(file)
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索研发资料"
            placeholder="搜索资料名称、类型…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          <Input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.json"
            className="hidden"
            aria-label="上传资料文件"
            onChange={uploadDocument}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload />
            上传资料
          </Button>
          <Button onClick={() => setEditor({ name: '', content: '', type: 'Markdown' })}>
            <Plus />
            新增资料
          </Button>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="gap-0 overflow-hidden py-3">
          <CardContent className="space-y-1 px-3">
            {documents.map((document) => (
              <Button
                key={document.id}
                variant={viewId === document.id ? 'secondary' : 'ghost'}
                className="h-auto w-full justify-start gap-3 p-3 text-left"
                onClick={() => setViewId(document.id)}
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{document.name}</span>
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    {document.type} · v{document.version} · {document.updatedAt}
                  </span>
                </span>
                <ChevronRight className="size-3.5 shrink-0" />
              </Button>
            ))}
            {!documents.length && (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                没有找到相关资料
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="min-h-[450px]">
          {selected ? (
            <>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle>{selected.name}</CardTitle>
                    <CardDescription className="mt-2">
                      {selected.type} · 版本 v{selected.version} · 更新于 {selected.updatedAt}
                    </CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setEditor({ ...selected })}>
                    <Pencil />
                    编辑资料
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-5">
                <div className="flex-1 whitespace-pre-wrap break-words text-sm leading-8 text-foreground/85">
                  {selected.content}
                </div>
                <Separator />
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="size-4 text-emerald-600" />
                    已纳入项目资料，可通过项目接口读取
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate('chat', 'new', selected.id)}
                  >
                    向 Agent 提问
                    <ArrowRight />
                  </Button>
                </div>
              </CardContent>
            </>
          ) : (
            <CardContent className="flex min-h-80 flex-col items-center justify-center gap-3 text-muted-foreground">
              <BookOpen className="size-8" />
              <p className="text-sm">选择一份资料查看正文，或创建第一份项目资料。</p>
            </CardContent>
          )}
        </Card>
      </div>
      <Dialog
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null)
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editor?.id ? '编辑项目资料' : '新增项目资料'}</DialogTitle>
            <DialogDescription>
              资料保存在当前项目。保存后可由已授权的插件与 Agent 读取。
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              <Field label="资料名称" htmlFor="document-name">
                <Input
                  id="document-name"
                  value={editor.name}
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  placeholder="例如：设备接入说明"
                />
              </Field>
              <Field
                label="正文"
                htmlFor="document-content"
                hint="支持纯文本和 Markdown 内容；上传文件会先在此预览。"
              >
                <Textarea
                  id="document-content"
                  className="min-h-64 font-mono text-sm"
                  value={editor.content}
                  onChange={(event) => setEditor({ ...editor, content: event.target.value })}
                  placeholder="记录业务背景、接口约定或运维说明…"
                />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>
              取消
            </Button>
            <Button onClick={saveDocument}>
              <Save />
              保存资料
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function RepositorySection() {
  const { project, projectId, editDraft, updateProject, navigate, hasDraftChanges } = usePrototype()
  const [syncing, setSyncing] = useState(false)
  const timerRef = useRef(null)
  useEffect(
    () => () => {
      clearTimeout(timerRef.current)
    },
    [],
  )
  useEffect(() => {
    clearTimeout(timerRef.current)
    setSyncing(false)
  }, [projectId])
  function syncRepository() {
    if (!project.config.repository || !project.config.branch) {
      toast.error('请先填写仓库和分支，并应用配置')
      return
    }
    setSyncing(true)
    timerRef.current = setTimeout(() => {
      updateProject((current) => ({
        ...current,
        repositorySync: {
          commit: current.sourceCommit || '38e20cf',
          at: new Date().toLocaleString('zh-CN'),
          status: 'success',
        },
      }))
      setSyncing(false)
      toast.success('模拟同步完成，当前源码快照已就绪')
    }, 1100)
  }
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <CardHeader>
          <CardTitle>Git 仓库</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <Field label="仓库地址" htmlFor="repository-url">
            <Input
              id="repository-url"
              value={project.draft.repository}
              onChange={(event) =>
                editDraft((current) => ({ ...current, repository: event.target.value }))
              }
              placeholder="https://github.com/team/project.git"
            />
          </Field>
          <Field label="默认分支" htmlFor="repository-branch">
            <Input
              id="repository-branch"
              value={project.draft.branch}
              onChange={(event) =>
                editDraft((current) => ({ ...current, branch: event.target.value }))
              }
              placeholder="main"
            />
          </Field>
          <div className="rounded-xl border bg-muted/20 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 font-medium">
                  <GitCommitHorizontal className="size-4" />
                  当前源码快照
                </p>
                <p className="mt-2 font-mono text-sm">
                  {project.repositorySync?.commit || project.sourceCommit || '38e20cf'}{' '}
                  <span className="font-sans text-muted-foreground">
                    · {project.config.branch || 'main'}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {project.repositorySync
                    ? `最近同步 ${project.repositorySync.at}`
                    : '演示源码快照已就绪'}
                </p>
              </div>
              <Badge variant="outline" className="text-emerald-700">
                可用
              </Badge>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" onClick={syncRepository} disabled={syncing}>
                {syncing ? <LoaderCircle className="animate-spin" /> : <GitBranch />}
                {syncing ? '正在模拟同步…' : '同步已生效仓库'}
              </Button>
              <Button variant="outline" onClick={() => navigate('materials', 'artifacts')}>
                查看源码与产物
                <ArrowRight />
              </Button>
            </div>
            {hasDraftChanges && (
              <p className="mt-3 text-xs text-amber-700">
                草稿尚未应用，同步使用当前已生效的仓库配置。
              </p>
            )}
          </div>
          <VersionStrip />
        </CardContent>
      </Card>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>从源码到可用产物</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {[
            ['01', '确定源码版本', '记录仓库与提交，供其他模块稳定引用。'],
            ['02', '生成独立文件树', '移除 Git 历史，保留可追溯来源。'],
            ['03', '脱敏并打包', '脱敏目录、报告与 ZIP 均可独立复用。'],
          ].map(([number, title, text]) => (
            <div key={number} className="flex gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs text-muted-foreground">
                {number}
              </span>
              <div>
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-1 text-xs leading-6 text-muted-foreground">{text}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function ResourcesSection({ selectedId }) {
  const { project, projectId, environment, editDraft } = usePrototype()
  const [editor, setEditor] = useState(null)
  const [filter, setFilter] = useState('current')
  const resources = project.draft.resources.filter(
    (resource) => filter === 'all' || resource.environment === environment,
  )
  useEffect(() => {
    const resource = project.draft.resources.find((item) => item.id === selectedId)
    setEditor(resource ? { ...resource, type: resource.type.toLowerCase() } : null)
  }, [projectId, selectedId])
  function saveResource() {
    if (!editor.name.trim() || !editor.endpoint.trim()) {
      toast.error('请填写资源名称和连接地址')
      return
    }
    const resource = {
      ...editor,
      name: editor.name.trim(),
      endpoint: editor.endpoint.trim(),
      id: editor.id || `resource-${Date.now()}`,
      connected: editor.connected ?? false,
    }
    editDraft((current) => ({
      ...current,
      resources: editor.id
        ? current.resources.map((item) => (item.id === editor.id ? resource : item))
        : [...current.resources, resource],
    }))
    setEditor(null)
    toast.success('资源已写入草稿，应用配置后供插件使用')
  }
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">公共环境资源</h2>
        </div>
        <div className="flex gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-36" aria-label="资源环境筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">当前{environmentLabels[environment]}环境</SelectItem>
              <SelectItem value="all">全部环境</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={() =>
              setEditor({ name: '', type: 'mysql', environment, endpoint: '', connected: false })
            }
          >
            <Plus />
            添加资源
          </Button>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {resources.map((resource) => {
          const Icon = /server|service/i.test(resource.type) ? Server : Database
          const connected = project.connectionStates?.[resource.id] ?? resource.connected
          const referenceCount = Object.values(project.draft.plugins).filter(
            (plugin) => plugin.enabled && Object.values(plugin).includes(resource.id),
          ).length
          return (
            <Card key={resource.id} className="gap-4">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <span className="rounded-xl border bg-muted/30 p-2.5">
                    <Icon className="size-5 text-muted-foreground" />
                  </span>
                  <Badge
                    variant="outline"
                    className={connected ? 'text-emerald-700' : 'text-muted-foreground'}
                  >
                    {connected ? '模拟连接正常' : '待检查'}
                  </Badge>
                </div>
                <CardTitle className="mt-2">{resource.name}</CardTitle>
                <CardDescription>
                  {resource.type} ·{' '}
                  {environmentLabels[resource.environment] || resource.environment}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p
                  className="truncate rounded-lg border bg-muted/30 p-2.5 font-mono text-xs"
                  title={resource.endpoint}
                >
                  {resource.endpoint}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {referenceCount ? `${referenceCount} 个插件引用此资源` : '可供插件引用'}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditor({ ...resource, type: resource.type.toLowerCase() })}
                  >
                    <Pencil />
                    编辑
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
      {!resources.length && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            当前环境还没有资源，可添加资源或切换查看全部环境。
          </CardContent>
        </Card>
      )}
      <VersionStrip />
      <Dialog
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editor?.id ? '编辑环境资源' : '添加环境资源'}</DialogTitle>
            <DialogDescription>此处只配置演示连接信息，请勿填写真实密码或密钥。</DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              <Field label="资源名称" htmlFor="resource-name">
                <Input
                  id="resource-name"
                  value={editor.name}
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  placeholder="例如：测试业务库"
                />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="资源类型" htmlFor="resource-type">
                  <Choice
                    id="resource-type"
                    value={editor.type?.toLowerCase()}
                    onChange={(value) => setEditor({ ...editor, type: value })}
                    options={[
                      { id: 'mysql', name: 'MySQL' },
                      { id: 'redis', name: 'Redis' },
                      { id: 'server', name: '服务器' },
                      { id: 'service', name: '服务入口' },
                    ]}
                  />
                </Field>
                <Field label="所属环境" htmlFor="resource-environment">
                  <Choice
                    id="resource-environment"
                    value={editor.environment}
                    onChange={(value) => setEditor({ ...editor, environment: value })}
                    options={[
                      { id: 'test', name: '测试' },
                      { id: 'production', name: '生产' },
                    ]}
                  />
                </Field>
              </div>
              <Field
                label="连接地址"
                htmlFor="resource-endpoint"
                hint="使用演示域名或私有示例地址即可。"
              >
                <Input
                  id="resource-endpoint"
                  value={editor.endpoint}
                  onChange={(event) =>
                    setEditor({ ...editor, endpoint: event.target.value, connected: false })
                  }
                  placeholder="mysql.demo.local:3306"
                />
              </Field>
              <div className="flex items-center justify-between rounded-xl border bg-muted/20 p-3">
                <span className="text-sm">
                  {editor.connected ? '模拟检查通过' : '可检查示例资源配置'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!editor.endpoint.trim()}
                  onClick={() => {
                    setEditor({ ...editor, connected: true })
                    toast.success('模拟连接检查通过')
                  }}
                >
                  <Network />
                  检查连接
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>
              取消
            </Button>
            <Button disabled={!editor?.type || !editor?.environment} onClick={saveResource}>
              保存到草稿
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function PluginsSection({ selectedId }) {
  const { project, projectId, environment, editDraft, navigate, hasDraftChanges } = usePrototype()
  const [activeId, setActiveId] = useState(selectedId || 'cabinet')
  const [historyOpen, setHistoryOpen] = useState(false)
  useEffect(() => {
    setActiveId(selectedId || 'cabinet')
  }, [selectedId, projectId])
  const definition = pluginCatalog.find((plugin) => plugin.id === activeId) || pluginCatalog[0]
  const plugin = project.draft.plugins[definition.id] || { enabled: false, name: definition.name }
  const currentPlugin = project.config.plugins[definition.id]
  const databases = project.draft.resources
    .filter(
      (resource) =>
        /mysql|database/i.test(resource.type) &&
        (resource.environment === environment || resource.id === plugin.databaseId),
    )
    .map((resource) => ({
      ...resource,
      name:
        resource.environment === environment
          ? resource.name
          : `${resource.name}（${environmentLabels[resource.environment]}环境）`,
    }))
  const services = project.draft.resources
    .filter(
      (resource) =>
        /server|service/i.test(resource.type) &&
        (resource.environment === environment || resource.id === plugin.serviceId),
    )
    .map((resource) => ({
      ...resource,
      name:
        resource.environment === environment
          ? resource.name
          : `${resource.name}（${environmentLabels[resource.environment]}环境）`,
    }))
  const servers = project.draft.resources.filter((resource) => /server/i.test(resource.type))
  const selectedDatabase = project.draft.resources.find(
    (resource) => resource.id === plugin.databaseId,
  )
  const selectedService = project.draft.resources.find(
    (resource) => resource.id === plugin.serviceId,
  )
  const selectedServer = project.draft.resources.find((resource) => resource.id === plugin.serverId)
  const selectedDocument = project.documents.find(
    (document) => document.id === plugin.prototypeDocId,
  )
  const Icon = definition.icon || Network
  function changePlugin(changes) {
    editDraft((current) => ({
      ...current,
      plugins: {
        ...current.plugins,
        [definition.id]: { ...current.plugins[definition.id], ...changes },
      },
    }))
  }
  return (
    <>
      <div className="grid gap-5 xl:grid-cols-[230px_minmax(0,1fr)_275px]">
        <Card className="gap-4 xl:min-h-[620px]">
          <CardHeader className="px-4">
            <CardTitle>项目工具</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col px-3">
            <div className="space-y-2">
              {pluginCatalog.map((item) => {
                const ItemIcon = item.icon || Code2
                const enabled = project.draft.plugins[item.id]?.enabled || false
                return (
                  <div
                    key={item.id}
                    className={`flex items-center gap-1 rounded-xl p-1 ${activeId === item.id ? 'bg-muted/70' : ''}`}
                  >
                    <Button
                      variant="ghost"
                      className="min-w-0 flex-1 justify-start gap-2 px-2"
                      onClick={() => setActiveId(item.id)}
                    >
                      <ItemIcon className="size-4 shrink-0" />
                      <span className="truncate">{item.name}</span>
                    </Button>
                    <Switch
                      className="mr-2 shrink-0"
                      aria-label={`${enabled ? '停用' : '启用'}${item.name}`}
                      checked={enabled}
                      onCheckedChange={(checked) => {
                        setActiveId(item.id)
                        editDraft((current) => ({
                          ...current,
                          plugins: {
                            ...current.plugins,
                            [item.id]: { ...current.plugins[item.id], enabled: checked },
                          },
                        }))
                      }}
                    />
                  </div>
                )
              })}
            </div>
            <p className="mt-auto flex items-start gap-2 px-2 pt-8 text-xs leading-6 text-muted-foreground">
              <Info className="mt-1 size-3.5 shrink-0" />
              启用后显示配置；应用配置后在项目工具中使用。
            </p>
          </CardContent>
        </Card>
        <Card className="gap-5">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-3">
              <Icon className="size-5" />
              <CardTitle>{definition.name}</CardTitle>
              <Badge
                variant="outline"
                className={plugin.enabled ? 'text-emerald-700' : 'text-muted-foreground'}
              >
                {plugin.enabled ? '已选择启用' : '未启用'}
              </Badge>
              <span className="text-xs text-muted-foreground">v1.0</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {!plugin.enabled ? (
              <div className="flex min-h-80 flex-col items-center justify-center gap-4 text-center">
                <span className="rounded-2xl bg-muted/60 p-5">
                  <Icon className="size-8 text-muted-foreground" />
                </span>
                <div>
                  <p className="font-medium">为项目开启{definition.name}</p>
                  <p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">
                    开启后在这里配置公共资源引用，再应用配置即可使用。
                  </p>
                </div>
                <Button onClick={() => changePlugin({ enabled: true })}>
                  <Plus />
                  开启插件
                </Button>
              </div>
            ) : (
              <>
                <Separator />
                <h3 className="text-sm font-semibold">基本设置</h3>
                <Field label="显示名称" htmlFor="plugin-name">
                  <Input
                    id="plugin-name"
                    value={plugin.name ?? definition.name}
                    onChange={(event) => changePlugin({ name: event.target.value })}
                  />
                </Field>
                {definition.id === 'cabinet' && (
                  <>
                    <Field label="服务入口" htmlFor="plugin-service">
                      <Choice
                        id="plugin-service"
                        value={plugin.serviceId}
                        onChange={(value) => changePlugin({ serviceId: value })}
                        options={services}
                        placeholder={`选择${environmentLabels[environment]}环境服务`}
                      />
                    </Field>
                    <Separator />
                    <h3 className="text-sm font-semibold">共享资源</h3>
                    <Field
                      label="数据库"
                      htmlFor="plugin-database"
                      hint="引用环境资源中的 MySQL 配置，无需重复维护凭据。"
                    >
                      <div className="flex flex-wrap gap-2">
                        <div className="min-w-0 flex-1">
                          <Choice
                            id="plugin-database"
                            value={plugin.databaseId}
                            onChange={(value) => changePlugin({ databaseId: value })}
                            options={databases}
                            placeholder={`选择${environmentLabels[environment]}环境数据库`}
                          />
                        </div>
                        <Button
                          variant="outline"
                          disabled={!selectedDatabase}
                          onClick={() => navigate('materials', 'resources', plugin.databaseId)}
                        >
                          查看资源
                        </Button>
                      </div>
                    </Field>
                    <Field label="设备分组" htmlFor="plugin-group">
                      <Input
                        id="plugin-group"
                        value={plugin.group ?? ''}
                        placeholder={project.name}
                        onChange={(event) => changePlugin({ group: event.target.value })}
                      />
                    </Field>
                    <Field label="关联项目资料" htmlFor="plugin-document">
                      <Choice
                        id="plugin-document"
                        value={plugin.prototypeDocId}
                        onChange={(value) => changePlugin({ prototypeDocId: value })}
                        options={project.documents}
                        placeholder="选择一份设计或原型资料（可选）"
                      />
                    </Field>
                    <div className="rounded-xl border bg-muted/25 p-4">
                      <p className="mb-3 text-xs text-muted-foreground">包含的功能</p>
                      <div className="flex flex-wrap gap-5 text-sm">
                        {['设备列表', '二维码', '照片'].map((name) => (
                          <span key={name} className="flex items-center gap-2">
                            <CheckCircle2 className="size-4 text-emerald-700" />
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                {definition.id === 'api' && (
                  <>
                    <Field
                      label="请求基础地址"
                      htmlFor="plugin-base-url"
                      hint="配置示例 API 服务地址，后续由接口调试工具引用。"
                    >
                      <Input
                        id="plugin-base-url"
                        value={plugin.baseUrl ?? ''}
                        placeholder="https://api.demo.local"
                        onChange={(event) => changePlugin({ baseUrl: event.target.value })}
                      />
                    </Field>
                    <div className="rounded-xl border bg-muted/20 p-4 text-sm leading-7 text-muted-foreground">
                      共享项目信息和环境上下文。原型中的请求返回本地模拟结果。
                    </div>
                  </>
                )}
                {definition.id === 'logs' && (
                  <>
                    <Field
                      label="服务器"
                      htmlFor="plugin-log-server"
                      hint="引用环境资源中的服务器，用于读取该资源的模拟日志。"
                    >
                      <Choice
                        id="plugin-log-server"
                        value={plugin.serverId}
                        onChange={(value) => changePlugin({ serverId: value })}
                        options={servers}
                        placeholder="选择日志来源服务器"
                      />
                    </Field>
                    <Field label="日志保留天数" htmlFor="plugin-retention">
                      <Input
                        id="plugin-retention"
                        type="number"
                        min={1}
                        max={90}
                        value={plugin.retention ?? 7}
                        onChange={(event) =>
                          changePlugin({
                            retention: event.target.value === '' ? '' : Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                    <div className="rounded-xl border bg-muted/20 p-4 text-sm leading-7 text-muted-foreground">
                      读取当前项目的演示服务日志，支持关键字过滤和级别筛选。
                    </div>
                  </>
                )}
                {definition.id === 'cabinet' &&
                  (!plugin.databaseId || !plugin.serviceId || !plugin.group?.trim()) && (
                    <p
                      role="status"
                      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-800"
                    >
                      应用前请填写服务入口、数据库和设备分组。
                    </p>
                  )}
              </>
            )}
            <VersionStrip />
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>引用关系</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {selectedDatabase && (
                <ReferenceRow
                  icon={Database}
                  name={selectedDatabase.name}
                  onClick={() => navigate('materials', 'resources', selectedDatabase.id)}
                />
              )}
              {selectedService && (
                <ReferenceRow
                  icon={Server}
                  name={selectedService.name}
                  onClick={() => navigate('materials', 'resources', selectedService.id)}
                />
              )}
              {selectedServer && (
                <ReferenceRow
                  icon={Server}
                  name={selectedServer.name}
                  onClick={() => navigate('materials', 'resources', selectedServer.id)}
                />
              )}
              {selectedDocument && (
                <ReferenceRow
                  icon={FileText}
                  name={`${selectedDocument.name} v${selectedDocument.version}`}
                  onClick={() => navigate('materials', 'documents', selectedDocument.id)}
                />
              )}
              {!selectedDatabase && !selectedService && !selectedServer && !selectedDocument && (
                <p className="text-sm leading-6 text-muted-foreground">
                  配置公共资源后，可在此查看插件的引用关系。
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>应用影响</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <p className="flex items-start gap-2 text-sm leading-6">
                <span
                  className={`mt-2 size-2 shrink-0 rounded-full ${hasDraftChanges ? 'bg-amber-500' : 'bg-emerald-500'}`}
                />
                {definition.name}：
                {!hasDraftChanges
                  ? '配置与生效版本一致'
                  : plugin.enabled === currentPlugin?.enabled
                    ? '更新配置'
                    : plugin.enabled
                      ? '启用项目入口'
                      : '停用项目入口，保留历史'}
              </p>
              <p className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
                <span className="mt-2 size-2 shrink-0 rounded-full bg-slate-400" />
                正在运行的任务继续使用原配置版本
              </p>
              <Separator />
              <Button
                variant="ghost"
                className="w-full justify-between px-0 text-sm"
                onClick={() => setHistoryOpen(true)}
              >
                <Clock3 />
                查看版本记录
                <ChevronRight />
              </Button>
              {currentPlugin?.enabled && (
                <Button
                  variant="outline"
                  className="w-full justify-between"
                  onClick={() => navigate('tools', definition.id)}
                >
                  打开项目工具
                  <ArrowRight />
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>配置版本记录</DialogTitle>
            <DialogDescription>运行任务使用发起时的已生效配置版本。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {hasDraftChanges && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-800">
                  v{Number(project.configVersion) + 1} · 待应用草稿
                </p>
                <p className="mt-1 text-xs text-amber-700">保存草稿不会改变工具当前使用的配置。</p>
              </div>
            )}
            <div className="rounded-xl border bg-muted/20 p-4">
              <p className="text-sm font-medium">v{project.configVersion} · 当前生效</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {Object.values(project.config.plugins).filter((item) => item.enabled).length}{' '}
                个插件已启用 · {project.config.resources.length} 个环境资源
              </p>
            </div>
            {project.configVersion > 1 && (
              <p className="text-xs leading-6 text-muted-foreground">
                演示初始版本之前的历史未加载。后续应用会更新当前配置版本。
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ReferenceRow({ icon: Icon, name, onClick }) {
  return (
    <Button
      variant="outline"
      className="h-auto w-full justify-start gap-2 px-3 py-3 text-left"
      onClick={onClick}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs">{name}</span>
      <ChevronRight className="size-3.5 shrink-0" />
    </Button>
  )
}
