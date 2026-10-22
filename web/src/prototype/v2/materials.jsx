import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Box,
  ChevronRight,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderPlus,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Rocket,
  Upload,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu'
import { useWorkbench, uid, stamp } from './store'
import {
  Badge,
  Button,
  Input,
  Textarea,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Progress,
  Picker,
  PageHeader,
  Panel,
  Field,
  Modal,
  Confirm,
  Status,
  Empty,
  CopyButton,
  download,
  downloadArtifact,
  toast,
} from './ui'
import { demoSourceFiles } from './material-seed'
import {
  artifactBlockReason,
  descendantIds,
  documentPath,
  sanitizeFiles,
  simulatedCommit,
  stripGitFiles,
} from './material-utils'
import './materials.css'

const TYPE_NAMES = {
  source: '原始源码',
  stripped: '去 Git 源码',
  sanitized: '脱敏源码',
  zip: 'ZIP 压缩包',
  report: '处理报告',
  file: '文件',
}
const REFERENCE_OPTIONS = [
  { value: 'branch', label: '分支' },
  { value: 'tag', label: '标签' },
  { value: 'commit', label: '提交' },
]
const OUTCOMES = [
  { value: 'success', label: '正常完成' },
  { value: 'failed', label: '模拟失败' },
]
const TEXT_EXTENSIONS = /\.(md|markdown|txt)$/i
const SUPPORTED_EXTENSIONS = /\.(md|markdown|txt|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?)$/i
const prettyTime = (value) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'

const queryValue = (route, key) => new URLSearchParams(route.split('?')[1] || '').get(key)
const sourceTypes = ['source', 'stripped', 'sanitized']
const artifactIcon = (type) =>
  type === 'sanitized'
    ? ShieldCheck
    : type === 'source' || type === 'stripped'
      ? FileCode2
      : type === 'report'
        ? FileText
        : Box
const artifactUsage = (type) =>
  ({
    source: '发布 · 后续处理',
    stripped: '发布 · 后续处理',
    sanitized: 'Agent · 发布',
    zip: '下载交付',
    report: '分析 · 追溯',
    file: '研发资料',
  })[type] || '研发资料'

function MoreMenu({ label, children, outline = false }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={outline ? 'outline' : 'ghost'} size="icon-sm" aria-label={label}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

function SimulationMenu({ value, onChange, label = '演示场景' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} title={label}>
          <SlidersHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>本次演示场景</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {OUTCOMES.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function errorToast(message) {
  toast.error(message)
  return false
}

function validName(name) {
  return name.trim() && !/[\\/]/.test(name) && name.trim() !== '.' && name.trim() !== '..'
}

function DownloadDocument({ document }) {
  function save() {
    if (document.dataUrl) {
      const link = window.document.createElement('a')
      link.href = document.dataUrl
      link.download = document.name
      link.click()
      return
    }
    download(document.name, document.content || '', document.mime || 'text/plain;charset=utf-8')
  }
  return (
    <Button variant="outline" size="sm" onClick={save}>
      <ArrowDownToLine className="size-4" />
      下载
    </Button>
  )
}

function MarkdownPreview({ content }) {
  const blocks = []
  let lines = []
  let list = []
  const flush = () => {
    if (lines.length) blocks.push({ type: 'paragraph', text: lines.join('\n') })
    if (list.length) blocks.push({ type: 'list', items: list })
    lines = []
    list = []
  }
  for (const line of String(content || '').split('\n')) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (!line.trim()) {
      flush()
      continue
    }
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }
    if (bullet) {
      if (lines.length) flush()
      list.push(bullet[1])
      continue
    }
    if (list.length) flush()
    lines.push(line)
  }
  flush()
  return (
    <div className="mat-markdown">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Heading = `h${block.level + 1}`
          return <Heading key={index}>{block.text}</Heading>
        }
        if (block.type === 'list')
          return (
            <ul key={index}>
              {block.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )
        return <p key={index}>{block.text}</p>
      })}
    </div>
  )
}

function DocumentPreview({ document }) {
  if (document.mime?.startsWith('image/'))
    return (
      <img
        src={document.dataUrl}
        alt={document.name}
        className="max-h-[55vh] max-w-full rounded-lg object-contain"
      />
    )
  if (document.mime === 'application/pdf' && document.dataUrl)
    return (
      <object
        data={document.dataUrl}
        type="application/pdf"
        aria-label={`预览 ${document.name}`}
        className="h-[55vh] w-full rounded-lg"
      >
        <p>此浏览器无法内嵌预览 PDF，请下载后打开。</p>
        <DownloadDocument document={document} />
      </object>
    )
  if (/\.(md|markdown)$/i.test(document.name)) return <MarkdownPreview content={document.content} />
  if (/\.txt$/i.test(document.name))
    return <pre className="wb-code whitespace-pre-wrap">{document.content}</pre>
  return (
    <Empty>
      <FileText className="mx-auto mb-3 size-8" />
      <p>Office 文件保留原始格式，可下载查看。</p>
    </Empty>
  )
}

function TaskStrip({ type }) {
  const { state, projectId, stopTask, navigate } = useWorkbench()
  const tasks = state.tasks
    .filter((task) => task.projectId === projectId && type.includes(task.type))
    .slice(0, 2)
  if (!tasks.length) return null
  return (
    <div className="mat-task-strip">
      <Panel
        title="处理任务"
        actions={
          <Button
            variant="link"
            size="sm"
            className="mat-inline-link"
            onClick={() => navigate(`/p/${projectId}/tasks`)}
          >
            全部任务
            <ArrowUpRight className="size-3.5" />
          </Button>
        }
      >
        <div>
          {tasks.map((task) => (
            <div key={task.id} className="mat-task-row">
              <div>
                <Button
                  variant="link"
                  className="mat-inline-link"
                  onClick={() => navigate(`/p/${projectId}/tasks?task=${task.id}`)}
                >
                  {task.title}
                  <ArrowUpRight className="size-3" />
                </Button>
                {task.status === 'running' && (
                  <Progress value={task.progress} aria-label={`${task.title}进度`} />
                )}
              </div>
              <div className="wb-row">
                <Status value={task.status} />
                {task.status === 'running' && (
                  <Button variant="ghost" size="sm" onClick={() => stopTask(task.id)}>
                    停止
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

function DocumentsPage() {
  const { state, project, projectId, route, navigate, updateProject, startTask, audit } =
    useWorkbench()
  const [folderId, setFolderId] = useState(null)
  const [search, setSearch] = useState('')
  const [form, setForm] = useState(null)
  const [previewId, setPreviewId] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [gitForm, setGitForm] = useState(null)
  const [syncDocument, setSyncDocument] = useState(null)
  const [syncOutcome, setSyncOutcome] = useState('success')
  const [mobileDetail, setMobileDetail] = useState(Boolean(queryValue(route, 'document')))
  const uploadRef = useRef(null)
  const documents = project.documents || []
  const preview =
    documents.find((item) => item.id === previewId) ||
    documents.find((item) => item.kind === 'file' && item.parentId === folderId)
  const deleting = documents.find((item) => item.id === deleteId)
  const visible = documents
    .filter((item) =>
      search ? item.name.toLowerCase().includes(search.toLowerCase()) : item.parentId === folderId,
    )
    .sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN') : a.kind === 'folder' ? -1 : 1,
    )
  const folder = documents.find((item) => item.id === folderId)
  const path = folder ? documentPath(documents, folder).split('/') : []
  const gitPaths = [
    ...new Set(
      demoSourceFiles(projectId)
        .filter((file) => TEXT_EXTENSIONS.test(file.name))
        .flatMap((file) => {
          const segments = file.name.split('/')
          return [
            ...segments
              .slice(0, -1)
              .map((_, index) => `${segments.slice(0, index + 1).join('/')}/`),
            file.name,
          ]
        }),
    ),
  ].sort()
  useEffect(() => {
    const requested = documents.find((item) => item.id === queryValue(route, 'document'))
    setFolderId(queryValue(route, 'folder') || requested?.parentId || null)
    setSearch('')
    setPreviewId(requested?.id || null)
  }, [projectId])
  useEffect(() => {
    const requested = documents.find((item) => item.id === queryValue(route, 'document'))
    if (requested) {
      setPreviewId(requested.id)
      setFolderId(requested.parentId)
      setMobileDetail(true)
    } else {
      setFolderId(queryValue(route, 'folder') || null)
      setMobileDetail(false)
    }
  }, [route])
  useEffect(() => {
    if (folderId && !documents.some((item) => item.id === folderId)) setFolderId(null)
  }, [documents, folderId])

  function uniqueName(name, parentId, exceptId) {
    return !documents.some(
      (item) =>
        item.id !== exceptId &&
        item.parentId === parentId &&
        item.name.toLowerCase() === name.toLowerCase(),
    )
  }
  function openDocument(item) {
    setPreviewId(item.id)
    setMobileDetail(true)
    navigate(`/p/${projectId}/documents?document=${encodeURIComponent(item.id)}`)
  }
  function openFolder(id) {
    setFolderId(id)
    setPreviewId(null)
    setSearch('')
    setMobileDetail(false)
    navigate(`/p/${projectId}/documents${id ? `?folder=${encodeURIComponent(id)}` : ''}`)
  }
  function documentMenu(item) {
    return (
      <MoreMenu label={`${item.name} 更多操作`}>
        {item.kind === 'file' && item.source !== 'git' && TEXT_EXTENSIONS.test(item.name) && (
          <DropdownMenuItem
            onSelect={() => setForm({ ...item, mode: 'edit', parentId: item.parentId || 'root' })}
          >
            编辑
          </DropdownMenuItem>
        )}
        {item.source === 'git' && (
          <DropdownMenuItem
            onSelect={() => {
              setSyncDocument(item)
              setSyncOutcome('success')
            }}
          >
            <RefreshCw />
            同步
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => setForm({ ...item, mode: 'manage', parentId: item.parentId || 'root' })}
        >
          移动或重命名
        </DropdownMenuItem>
        {item.kind === 'file' && (
          <DropdownMenuItem onSelect={() => navigate(`/p/${projectId}/chat?document=${item.id}`)}>
            <MessageSquare />
            带入 Agent 问答
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onSelect={() => setDeleteId(item.id)}>
          删除资料
        </DropdownMenuItem>
      </MoreMenu>
    )
  }
  function saveForm() {
    const name = form.name.trim()
    if (!validName(name)) return errorToast('名称不能为空，也不能包含路径分隔符。')
    const parentId = form.parentId === 'root' ? null : form.parentId
    if (!uniqueName(name, parentId, form.id))
      return errorToast('此文件夹已有同名内容，请修改名称。')
    if (form.kind === 'file' && !TEXT_EXTENSIONS.test(name) && ['new', 'edit'].includes(form.mode))
      return errorToast('文本编辑支持 .md、.markdown 或 .txt。其他文件请上传。')
    if (form.mode === 'edit' && form.source === 'git')
      return errorToast('Git 导入文档只读，请通过手动同步更新。')
    const existing = documents.find((item) => item.id === form.id)
    if (existing?.kind === 'folder' && descendantIds(documents, existing.id).has(parentId))
      return errorToast('不能将文件夹移动到自身或其子文件夹。')
    const value = {
      id: form.id || uid('doc'),
      parentId,
      kind: form.kind,
      name,
      source: 'local',
      updatedAt: stamp(),
    }
    if (form.kind === 'file' && (form.mode === 'new' || form.mode === 'edit')) {
      value.content = form.content || ''
      value.mime = /\.txt$/i.test(name) ? 'text/plain' : 'text/markdown'
    }
    updateProject((draft) => {
      if (existing) {
        Object.assign(
          draft.documents.find((item) => item.id === existing.id),
          { ...value, source: existing.source },
        )
      } else draft.documents.push(value)
    })
    audit({
      projectId,
      action: existing ? (form.mode === 'edit' ? '编辑文档' : '移动或重命名资料') : '新增资料',
      object: name,
    })
    toast.success(existing ? '资料已保存' : '资料已创建')
    setForm(null)
    if (value.kind === 'file') openDocument(value)
  }
  async function uploadFiles(event) {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length) return
    const usedNames = new Set(
      documents.filter((item) => item.parentId === folderId).map((item) => item.name.toLowerCase()),
    )
    const created = []
    for (const file of files) {
      if (!SUPPORTED_EXTENSIONS.test(file.name)) {
        toast.error(`${file.name}：不支持此文件格式`)
        continue
      }
      if (file.size > 2 * 1024 * 1024) {
        toast.error(`${file.name}：此本地原型每文件上限 2 MiB`)
        continue
      }
      if (usedNames.has(file.name.toLowerCase())) {
        toast.error(`${file.name}：已有同名文件，请先重命名`)
        continue
      }
      usedNames.add(file.name.toLowerCase())
      const item = {
        id: uid('doc'),
        parentId: folderId,
        kind: 'file',
        source: 'local',
        name: file.name,
        mime: file.type || 'application/octet-stream',
        updatedAt: stamp(),
        size: file.size,
      }
      try {
        if (TEXT_EXTENSIONS.test(file.name)) {
          item.content = await file.text()
          item.mime = /\.txt$/i.test(file.name) ? 'text/plain' : 'text/markdown'
        } else {
          item.dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result)
            reader.onerror = reject
            reader.readAsDataURL(file)
          })
          if (/\.pdf$/i.test(file.name)) item.mime = 'application/pdf'
        }
        created.push(item)
      } catch {
        toast.error(`${file.name}：读取失败，请重新选择文件`)
      }
    }
    if (!created.length) return
    updateProject((draft) => draft.documents.push(...created))
    audit({ projectId, action: '上传资料', object: created.map((item) => item.name).join('、') })
    toast.success(`已上传 ${created.length} 个文件`)
  }
  function importGit() {
    const repository = project.repositories.find((item) => item.id === gitForm.repositoryId)
    if (!repository) return errorToast('请先配置一个 Git 仓库。')
    if (repository.enabled === false) return errorToast('仓库连接已停用，请先启用。')
    if (!gitForm.ref.trim()) return errorToast('请填写要导入的分支、标签或提交。')
    const chosen = demoSourceFiles(projectId).filter(
      (file) =>
        file.name === gitForm.path ||
        file.name.startsWith(gitForm.path.endsWith('/') ? gitForm.path : `${gitForm.path}/`),
    )
    if (!chosen.length) return errorToast('该路径没有可导入的文件。')
    const name = gitForm.name.trim()
    if (!validName(name) || !uniqueName(name, folderId))
      return errorToast('请填写一个不重复的目标名称。')
    if (
      state.tasks.some(
        (task) =>
          task.status === 'running' &&
          task.projectId === projectId &&
          task.effects?.some(
            (effect) =>
              effect.path?.at(-1) === 'documents' &&
              effect.value?.name === name &&
              effect.value?.parentId === folderId,
          ),
      )
    )
      return errorToast('已有导入任务将写入此名称，请等待完成或选择其他名称。')
    const date = stamp()
    const commit = simulatedCommit(`${repository.id}:${gitForm.ref}:${date}`)
    const rootIsDirectory = gitForm.path.endsWith('/')
    const created = []
    const folders = new Map()
    const common = {
      source: 'git',
      repositoryId: repository.id,
      gitRef: gitForm.ref || repository.defaultBranch,
      commit,
      syncedAt: date,
      updatedAt: date,
    }
    if (rootIsDirectory) {
      const rootId = uid('git-folder')
      created.push({
        id: rootId,
        parentId: folderId,
        kind: 'folder',
        name,
        gitPath: gitForm.path,
        ...common,
      })
      folders.set('', rootId)
    }
    for (const file of chosen) {
      const relative = rootIsDirectory ? file.name.slice(gitForm.path.length) : file.name
      const pieces = relative.split('/')
      let parentId = rootIsDirectory ? folders.get('') : folderId
      if (rootIsDirectory) {
        for (let index = 0; index < pieces.length - 1; index++) {
          const partial = pieces.slice(0, index + 1).join('/')
          if (!folders.has(partial)) {
            const id = uid('git-folder')
            created.push({
              id,
              parentId,
              kind: 'folder',
              name: pieces[index],
              gitPath: `${gitForm.path}${partial}/`,
              ...common,
            })
            folders.set(partial, id)
          }
          parentId = folders.get(partial)
        }
      }
      created.push({
        id: uid('git-doc'),
        parentId,
        kind: 'file',
        name: rootIsDirectory ? pieces.at(-1) : name,
        content: file.content,
        mime: /\.txt$/i.test(file.name) ? 'text/plain' : 'text/markdown',
        gitPath: file.name,
        ...common,
      })
    }
    startTask({
      projectId,
      type: 'documents',
      title: `从 ${repository.name} 导入 ${gitForm.path}`,
      outcome: gitForm.outcome,
      duration: 3500,
      logs: [
        `读取 ${gitForm.ref || repository.defaultBranch} 的指定路径`,
        gitForm.outcome === 'failed'
          ? '模拟远端访问失败，未写入任何资料。'
          : `已固定提交 ${commit}，准备 ${created.filter((item) => item.kind === 'file').length} 个只读文件。`,
      ],
      effects: created.map((value) => ({
        op: 'append',
        path: ['projects', projectId, 'documents'],
        value,
      })),
    })
    audit({ projectId, action: '发起 Git 资料导入', object: `${repository.name}/${gitForm.path}` })
    setGitForm(null)
  }
  function syncGit() {
    const repository = project.repositories.find((item) => item.id === syncDocument.repositoryId)
    if (!repository) return errorToast('原仓库连接已被删除，请重新配置并导入。')
    if (repository.enabled === false) return errorToast('原仓库连接已停用，请先启用。')
    const ids = descendantIds(documents, syncDocument.id)
    const date = stamp()
    const commit = simulatedCommit(`${repository.id}:${date}`)
    const source = demoSourceFiles(projectId)
    const updates = documents
      .filter(
        (item) => ids.has(item.id) && item.source === 'git' && item.repositoryId === repository.id,
      )
      .map((item) => {
        const remote = source.find((file) => file.name === item.gitPath)
        return {
          op: 'patch',
          path: ['projects', projectId, 'documents'],
          id: item.id,
          value: {
            ...(remote ? { content: `${remote.content}\n\n<!-- 演示同步时间：${date} -->\n` } : {}),
            commit,
            updatedAt: date,
            syncedAt: date,
          },
        }
      })
    startTask({
      projectId,
      type: 'documents',
      title: `同步 ${syncDocument.name}`,
      outcome: syncOutcome,
      duration: 3500,
      logs: [
        '读取原导入路径，保留平台文件名和目录位置。',
        syncOutcome === 'failed'
          ? '模拟仓库连接失败，原内容保持不变。'
          : '最新内容将覆盖导入副本，不保存历史版本。',
      ],
      effects: updates,
    })
    audit({ projectId, action: '发起 Git 资料同步', object: syncDocument.name })
    setSyncDocument(null)
  }

  return (
    <div className="wb-page mat-workspace">
      <PageHeader title="研发资料">
        <Button variant="outline" onClick={() => uploadRef.current?.click()}>
          <Upload className="size-4" />
          上传文件
        </Button>
        <Button
          onClick={() =>
            setForm({
              mode: 'new',
              kind: 'file',
              name: '',
              content: '',
              parentId: folderId || 'root',
            })
          }
        >
          <Plus className="size-4" />
          新建文档
        </Button>
        <MoreMenu label="资料更多操作" outline>
          <DropdownMenuItem
            onSelect={() =>
              setForm({ mode: 'new', kind: 'folder', name: '', parentId: folderId || 'root' })
            }
          >
            <FolderPlus />
            新建文件夹
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              setGitForm({
                repositoryId: project.repositories.find((item) => item.enabled !== false)?.id || '',
                path: 'README.md',
                name: 'README-Git.md',
                ref: 'main',
                outcome: 'success',
              })
            }
          >
            <GitBranch />从 Git 导入
          </DropdownMenuItem>
        </MoreMenu>
      </PageHeader>
      <Input
        ref={uploadRef}
        type="file"
        className="hidden"
        aria-label="上传研发资料"
        multiple
        accept=".md,.markdown,.txt,.png,.jpg,.jpeg,.gif,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
        onChange={uploadFiles}
      />
      <div className="mat-doc-workspace" data-detail={mobileDetail}>
        <Panel
          className="mat-doc-browser"
          title={
            <div className="mat-doc-path">
              <Button variant="ghost" size="sm" onClick={() => openFolder(null)}>
                全部资料
              </Button>
              {folder && (
                <>
                  <ChevronRight />
                  <Button variant="ghost" size="sm" onClick={() => openFolder(folder.parentId)}>
                    {path.length > 1 ? '… / ' : ''}
                    {folder.name}
                  </Button>
                </>
              )}
            </div>
          }
          actions={
            <div className="relative w-full">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                aria-label="按文件名搜索资料"
                className="pl-9"
                placeholder="按文件名搜索"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          }
        >
          {folderId && !search && (
            <Button
              variant="ghost"
              size="sm"
              className="mb-2"
              onClick={() => openFolder(folder?.parentId || null)}
            >
              <ArrowLeft className="size-3.5" />
              上级文件夹
            </Button>
          )}
          <div className="mat-doc-list">
            {!visible.length ? (
              <Empty>{search ? '没有匹配此文件名的资料。' : '此文件夹为空。'}</Empty>
            ) : (
              visible.map((item) => (
                <div key={item.id} className="mat-doc-item" data-selected={item.id === preview?.id}>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      item.kind === 'folder' ? openFolder(item.id) : openDocument(item)
                    }
                  >
                    {item.kind === 'folder' ? <Folder /> : <FileText />}
                    <span className="mat-doc-item-text">
                      <strong>{item.name}</strong>
                      <small>
                        {item.kind === 'folder'
                          ? `${documents.filter((child) => child.parentId === item.id).length} 项内容`
                          : `${item.source === 'git' ? 'Git · 只读' : '项目文档'} · ${prettyTime(item.updatedAt)}`}
                      </small>
                    </span>
                    {item.kind === 'folder' && <ChevronRight />}
                  </Button>
                  {documentMenu(item)}
                </div>
              ))
            )}
          </div>
        </Panel>
        <Panel
          className="mat-doc-reader"
          title={preview?.name || '文档内容'}
          actions={
            preview && (
              <>
                {preview.source !== 'git' && TEXT_EXTENSIONS.test(preview.name) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setForm({ ...preview, mode: 'edit', parentId: preview.parentId || 'root' })
                    }
                  >
                    编辑文档
                  </Button>
                )}
                {documentMenu(preview)}
              </>
            )
          }
        >
          <Button
            variant="ghost"
            size="sm"
            className="mat-mobile-back"
            onClick={() => {
              setMobileDetail(false)
              navigate(`/p/${projectId}/documents${folderId ? `?folder=${folderId}` : ''}`)
            }}
          >
            <ArrowLeft className="size-4" />
            返回资料列表
          </Button>
          {preview ? (
            <>
              <div className="mat-doc-meta">
                <span>{preview.name.split('.').at(-1).toUpperCase()}</span>
                <span>更新于 {prettyTime(preview.updatedAt)}</span>
                {preview.source === 'git' && <Badge variant="outline">Git 只读</Badge>}
              </div>
              <div className="mat-doc-body">
                <DocumentPreview document={preview} />
              </div>
              {preview.source === 'git' && (
                <div className="mat-doc-origin">
                  <GitBranch className="size-3.5" />
                  <Button
                    variant="link"
                    className="mat-inline-link"
                    disabled={
                      !project.repositories.some((item) => item.id === preview.repositoryId)
                    }
                    onClick={() =>
                      navigate(`/p/${projectId}/repositories?repository=${preview.repositoryId}`)
                    }
                  >
                    {project.repositories.find((item) => item.id === preview.repositoryId)?.name ||
                      '原仓库已删除'}
                    <ArrowUpRight className="size-3" />
                  </Button>
                  <span>{preview.gitPath}</span>
                  <code>{preview.commit?.slice(0, 12)}</code>
                  <CopyButton value={preview.commit} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSyncDocument(preview)
                      setSyncOutcome('success')
                    }}
                  >
                    <RefreshCw className="size-3.5" />
                    手动同步
                  </Button>
                </div>
              )}
              <div className="mat-doc-footer">
                <DownloadDocument document={preview} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/p/${projectId}/chat?document=${preview.id}`)}
                >
                  <MessageSquare className="size-4" />
                  带入 Agent 问答
                  <ArrowRight className="size-3.5" />
                </Button>
              </div>
            </>
          ) : (
            <Empty>
              <FileText className="mx-auto mb-3 size-7" />
              选择文档查看内容，或创建第一份项目资料。
            </Empty>
          )}
        </Panel>
      </div>
      <TaskStrip type={['documents']} />
      <Modal
        open={!!form}
        title={
          form?.mode === 'new'
            ? form.kind === 'folder'
              ? '新建文件夹'
              : '新建文档'
            : form?.mode === 'edit'
              ? '编辑文档'
              : '管理资料'
        }
        onClose={() => setForm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button onClick={saveForm}>保存</Button>
          </>
        }
      >
        {form && (
          <div className="wb-stack">
            <Field label="名称">
              <Input
                aria-label="资料名称"
                value={form.name}
                placeholder={form.kind === 'folder' ? '例如：部署手册' : '例如：接口说明.md'}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Field>
            <Field label="所在文件夹">
              <Picker
                label="所在文件夹"
                value={form.parentId}
                onChange={(value) => setForm({ ...form, parentId: value })}
                options={[
                  { value: 'root', label: '全部资料' },
                  ...documents
                    .filter(
                      (item) =>
                        item.kind === 'folder' &&
                        (!form.id || !descendantIds(documents, form.id).has(item.id)),
                    )
                    .map((item) => ({ value: item.id, label: documentPath(documents, item) })),
                ]}
              />
            </Field>
            {form.kind === 'file' && form.mode !== 'manage' && (
              <Field label="内容">
                <Textarea
                  aria-label="文档内容"
                  rows={14}
                  value={form.content || ''}
                  onChange={(event) => setForm({ ...form, content: event.target.value })}
                />
              </Field>
            )}
            {form.mode === 'edit' && (
              <p className="wb-muted">保存后立即替换当前内容，仅保留最新版本。</p>
            )}
            {form.mode === 'manage' && form.source === 'git' && (
              <p className="wb-muted">名称和位置可调整；内容继续从原 Git 路径手动同步。</p>
            )}
          </div>
        )}
      </Modal>
      <Confirm
        title={deleting?.kind === 'folder' ? '删除文件夹及全部内容' : '删除资料'}
        open={!!deleting}
        onClose={() => setDeleteId(null)}
        danger
        confirmLabel="删除资料"
        onConfirm={() => {
          const ids = descendantIds(documents, deleting.id)
          if (
            state.tasks.some(
              (task) =>
                task.status === 'running' &&
                task.projectId === projectId &&
                task.effects?.some(
                  (effect) =>
                    effect.path?.at(-1) === 'documents' &&
                    (ids.has(effect.id) || ids.has(effect.value?.parentId)),
                ),
            )
          )
            return errorToast('正在进行的 Git 导入或同步任务使用此资料，请先等待完成或停止任务。')
          updateProject((draft) => {
            draft.documents = draft.documents.filter((item) => !ids.has(item.id))
          })
          audit({ projectId, action: '删除资料', object: `${deleting.name}（${ids.size} 项）` })
          if (ids.has(previewId)) openFolder(deleting.parentId)
          setDeleteId(null)
          toast.success('资料已删除')
        }}
      >
        <p>
          将删除「{deleting?.name}」
          {deleting?.kind === 'folder'
            ? `及其 ${descendantIds(documents, deleting.id).size - 1} 个子项`
            : ''}
          ，无法恢复。Git 仓库中的原文件不会改变。
        </p>
      </Confirm>
      <Modal
        title="从 Git 导入资料"
        open={!!gitForm}
        onClose={() => setGitForm(null)}
        footer={
          <>
            <SimulationMenu
              label="Git 导入演示场景"
              value={gitForm?.outcome}
              onChange={(value) => setGitForm({ ...gitForm, outcome: value })}
            />
            <Button variant="ghost" onClick={() => setGitForm(null)}>
              取消
            </Button>
            <Button disabled={!project.repositories.length} onClick={importGit}>
              导入指定路径
            </Button>
          </>
        }
      >
        {gitForm && (
          <div className="wb-stack">
            {!project.repositories.length ? (
              <Empty>先在仓库与源码中添加 Git 仓库。</Empty>
            ) : (
              <>
                <Field label="仓库">
                  <Picker
                    label="导入仓库"
                    value={gitForm.repositoryId}
                    options={project.repositories
                      .filter((item) => item.enabled !== false)
                      .map((item) => ({
                        value: item.id,
                        label: item.name,
                      }))}
                    onChange={(value) => setGitForm({ ...gitForm, repositoryId: value })}
                  />
                </Field>
                <Field label="分支、标签或提交">
                  <Input
                    aria-label="资料 Git 引用"
                    value={gitForm.ref}
                    onChange={(event) => setGitForm({ ...gitForm, ref: event.target.value })}
                  />
                </Field>
                <Field label="文件或目录">
                  <Picker
                    label="Git 导入路径"
                    value={gitForm.path}
                    options={gitPaths.map((value) => ({ value, label: value }))}
                    onChange={(value) =>
                      setGitForm({
                        ...gitForm,
                        path: value,
                        name: value.replace(/\/$/, '').split('/').at(-1),
                      })
                    }
                  />
                </Field>
                <Field label="目标名称">
                  <Input
                    aria-label="Git 资料目标名称"
                    value={gitForm.name}
                    onChange={(event) => setGitForm({ ...gitForm, name: event.target.value })}
                  />
                </Field>

                <p className="wb-muted">
                  文件导入到当前文件夹。导入后只读，后续手动同步覆盖最新内容。
                </p>
              </>
            )}
          </div>
        )}
      </Modal>
      <Modal
        title="同步 Git 资料"
        open={!!syncDocument}
        onClose={() => setSyncDocument(null)}
        footer={
          <>
            <SimulationMenu
              label="资料同步演示场景"
              value={syncOutcome}
              onChange={setSyncOutcome}
            />
            <Button variant="ghost" onClick={() => setSyncDocument(null)}>
              取消
            </Button>
            <Button onClick={syncGit}>同步最新内容</Button>
          </>
        }
      >
        {syncDocument && (
          <div className="wb-stack">
            <p>
              从 <code>{syncDocument.gitPath}</code> 同步「{syncDocument.name}
              」。当前内容将被替换，名称及所在文件夹保持不变。
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}

function FileTreePreview({ artifact }) {
  const [directory, setDirectory] = useState('')
  const [selected, setSelected] = useState(artifact.files?.[0]?.name || '')
  useEffect(() => {
    setDirectory('')
    setSelected(artifact.files?.[0]?.name || '')
  }, [artifact.id])
  const files = artifact.files || []
  const entries = new Map()
  for (const file of files) {
    if (!file.name.startsWith(directory)) continue
    const remainder = file.name.slice(directory.length)
    const part = remainder.split('/')[0]
    entries.set(part, { name: part, path: `${directory}${part}`, folder: remainder.includes('/') })
  }
  const selectedFile = files.find((file) => file.name === selected)
  return (
    <div className="wb-grid wb-source-preview mat-file-preview">
      <div className="wb-stack min-w-0 mat-file-browser">
        <div className="wb-row">
          <Button
            size="sm"
            variant="ghost"
            disabled={!directory}
            onClick={() => setDirectory(directory.replace(/[^/]+\/$/, ''))}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <code className="break-all text-xs">/{directory}</code>
        </div>
        {[...entries.values()]
          .sort((a, b) =>
            a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1,
          )
          .map((entry) => (
            <Button
              key={entry.path}
              variant={entry.path === selected ? 'secondary' : 'ghost'}
              className="justify-start truncate"
              onClick={() =>
                entry.folder ? setDirectory(`${entry.path}/`) : setSelected(entry.path)
              }
            >
              {entry.folder ? (
                <Folder className="size-4 shrink-0" />
              ) : (
                <File className="size-4 shrink-0" />
              )}
              <span className="truncate">{entry.name}</span>
            </Button>
          ))}
        {!entries.size && <Empty>没有文件</Empty>}
      </div>
      <div className="min-w-0">
        {selectedFile ? (
          <>
            <div className="wb-row mb-3 justify-between">
              <code className="break-all text-xs">{selectedFile.name}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  download(
                    selectedFile.name.split('/').at(-1),
                    selectedFile.content,
                    'text/plain;charset=utf-8',
                  )
                }
              >
                下载文件
              </Button>
            </div>
            <pre className="wb-code max-h-[55vh] overflow-auto text-xs">{selectedFile.content}</pre>
          </>
        ) : (
          <Empty>选择一个文件预览。</Empty>
        )}
      </div>
    </div>
  )
}

function RepositoryPage() {
  const { state, project, projectId, route, navigate, updateProject, startTask, audit } =
    useWorkbench()
  const [form, setForm] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [fetchForm, setFetchForm] = useState(null)
  const [repositoryId, setRepositoryId] = useState(
    queryValue(route, 'repository') || project.repositories[0]?.id,
  )
  const [verifyOutcome, setVerifyOutcome] = useState('success')
  const latest = project.artifacts.filter((item) => item.type === 'source' && !item.deleted)
  const repository =
    project.repositories.find((item) => item.id === repositoryId) || project.repositories[0]
  const snapshots = latest.filter((item) => item.repositoryId === repository?.id)
  useEffect(() => {
    const id = queryValue(route, 'repository')
    if (id) setRepositoryId(id)
  }, [route])
  function selectRepository(id) {
    setRepositoryId(id)
    navigate(`/p/${projectId}/repositories?repository=${id}`)
  }
  function repositoryMenu(item) {
    return (
      <MoreMenu label={`${item.name} 仓库操作`}>
        <DropdownMenuItem onSelect={() => setForm({ ...item })}>编辑仓库配置</DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            updateProject((draft) => {
              draft.repositories.find((entry) => entry.id === item.id).enabled =
                item.enabled === false
            })
            audit({
              projectId,
              action: item.enabled === false ? '启用仓库' : '停用仓库',
              object: item.name,
            })
          }}
        >
          {item.enabled === false ? '启用仓库' : '停用仓库'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(item)}>
          删除仓库连接
        </DropdownMenuItem>
      </MoreMenu>
    )
  }
  function verifyRepository(item) {
    if (state.tasks.some((task) => task.repositoryId === item.id && task.status === 'running'))
      return toast.info('此仓库有正在进行的任务')
    startTask({
      projectId,
      repositoryId: item.id,
      type: 'source',
      title: `验证仓库 · ${item.name}`,
      duration: 2500,
      outcome: verifyOutcome,
      logs: [
        `读取仓库配置快照 ${item.url}`,
        verifyOutcome === 'failed'
          ? '模拟访问失败，请检查连接配置。'
          : '模拟凭据验证成功，可读取 Git 引用。',
      ],
      effects: [
        {
          op: 'patch',
          path: ['projects', projectId, 'repositories'],
          id: item.id,
          ifMatch: { url: item.url, token: item.token },
          value: { connectionStatus: 'connected', verifiedAt: stamp() },
        },
      ],
      failureEffects: [
        {
          op: 'patch',
          path: ['projects', projectId, 'repositories'],
          id: item.id,
          ifMatch: { url: item.url, token: item.token },
          value: { connectionStatus: 'failed', verifiedAt: stamp() },
        },
      ],
    })
  }

  function saveRepository() {
    const name = form.name.trim()
    if (!name) return errorToast('请填写仓库名称。')
    if (!/^(https?:\/\/[^/\s]+\/\S+|ssh:\/\/\S+|git@[^:\s]+:\S+)$/.test(form.url.trim()))
      return errorToast('请填写有效的 HTTP(S) 或 SSH Git 仓库地址。')
    if (project.repositories.some((item) => item.id !== form.id && item.name === name))
      return errorToast('项目内已有同名仓库。')
    if (form.private && !form.token.trim())
      return errorToast('私有仓库需要演示访问令牌或 SSH 私钥。请勿填写真实凭据。')
    const value = {
      ...form,
      id: form.id || uid('repo'),
      name,
      url: form.url.trim(),
      defaultBranch: form.defaultBranch.trim() || 'main',
      enabled: form.enabled !== false,
      connectionStatus: 'untested',
    }
    updateProject((draft) => {
      if (form.id)
        Object.assign(
          draft.repositories.find((item) => item.id === form.id),
          value,
        )
      else draft.repositories.push(value)
    })
    audit({ projectId, action: form.id ? '修改仓库配置' : '新增仓库配置', object: name })
    setForm(null)
    selectRepository(value.id)
    toast.success('仓库配置已保存，后续操作立即使用')
  }
  function fetchSource() {
    const repository = project.repositories.find((item) => item.id === fetchForm.repositoryId)
    if (!repository) return errorToast('仓库已被删除。')
    if (repository.enabled === false) return errorToast('此仓库已停用，请先启用。')
    const ref = fetchForm.ref.trim()
    if (!ref) return errorToast('请填写要获取的分支、标签或提交。')
    if (fetchForm.refType === 'commit' && !/^[a-f0-9]{7,40}$/i.test(ref))
      return errorToast('提交号应为 7 至 40 位十六进制字符。')
    const artifactId = uid('source')
    const commit =
      fetchForm.refType === 'commit' && ref.length === 40
        ? ref
        : simulatedCommit(`${repository.id}:${ref}:${stamp()}`)
    const value = {
      id: artifactId,
      name: `${repository.name} · ${ref}`,
      type: 'source',
      status: 'processing',
      repositoryId: repository.id,
      repositoryName: repository.name,
      repositoryUrl: repository.url,
      refType: fetchForm.refType,
      ref,
      commit,
      files: [],
      createdAt: stamp(),
    }
    updateProject((draft) => draft.artifacts.unshift(value))
    const taskId = startTask({
      projectId,
      repositoryId: repository.id,
      type: 'source',
      title: `获取 ${repository.name} / ${ref}`,
      artifactIds: [artifactId],
      duration: 4500,
      outcome: fetchForm.outcome,
      logs: [
        `使用任务启动时的仓库配置访问 ${repository.name}`,
        `解析 ${fetchForm.refType}：${ref}`,
        fetchForm.outcome === 'failed'
          ? '模拟 Git 凭据失效或远端不可达，请检查配置后重新获取。'
          : `已固定完整提交 ${commit}`,
      ],
      effects: [
        {
          op: 'patch',
          path: ['projects', projectId, 'artifacts'],
          id: artifactId,
          value: { status: 'ready', files: demoSourceFiles(projectId) },
        },
        {
          op: 'patch',
          path: ['projects', projectId, 'repositories'],
          id: repository.id,
          ifMatch: { url: repository.url, token: repository.token },
          value: { connectionStatus: 'connected', verifiedAt: stamp() },
        },
      ],
      failureEffects: [
        {
          op: 'patch',
          path: ['projects', projectId, 'artifacts'],
          id: artifactId,
          value: { status: 'failed', error: '模拟远端访问失败。请检查仓库配置并重新获取。' },
        },
        {
          op: 'patch',
          path: ['projects', projectId, 'repositories'],
          id: repository.id,
          ifMatch: { url: repository.url, token: repository.token },
          value: { connectionStatus: 'failed', verifiedAt: stamp() },
        },
      ],
    })
    updateProject((draft) => {
      draft.artifacts.find((item) => item.id === artifactId).taskId = taskId
    })
    audit({ projectId, action: '获取 Git 源码', object: `${repository.name} / ${ref}` })
    setFetchForm(null)
    navigate(`/p/${projectId}/artifacts?artifact=${artifactId}`)
  }
  return (
    <div className="wb-page mat-workspace">
      <PageHeader title="仓库与源码">
        <Button variant="outline" onClick={() => navigate(`/p/${projectId}/artifacts`)}>
          <Box className="size-4" />
          查看处理产物
        </Button>
        <Button
          onClick={() =>
            setForm({
              name: '',
              url: '',
              provider: 'GitHub',
              private: false,
              token: '',
              username: '',
              defaultBranch: 'main',
              enabled: true,
            })
          }
        >
          <Plus className="size-4" />
          添加仓库
        </Button>
      </PageHeader>
      {!repository ? (
        <Panel title="Git 仓库">
          <Empty>还没有 Git 仓库。添加仓库后选择分支、标签或提交获取源码。</Empty>
        </Panel>
      ) : (
        <div className="mat-repository-workspace">
          <Panel className="mat-repository-list" title="项目仓库">
            {project.repositories.map((item) => (
              <div
                key={item.id}
                className="mat-repository-row"
                data-selected={repository.id === item.id}
              >
                <Button variant="ghost" onClick={() => selectRepository(item.id)}>
                  <GitBranch className="size-4 shrink-0" />
                  <span className="min-w-0">
                    <strong>{item.name}</strong>
                    <small>
                      {item.provider} · {item.private ? '私有' : '公开'}
                      {item.enabled === false ? ' · 已停用' : ''}
                    </small>
                  </span>
                  <ChevronRight className="size-3 shrink-0" />
                </Button>
                {repositoryMenu(item)}
              </div>
            ))}
          </Panel>
          <Panel
            title={
              <div className="wb-row">
                <GitBranch className="size-4" />
                {repository.name}
              </div>
            }
            actions={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={repository.enabled === false}
                  onClick={() => verifyRepository(repository)}
                >
                  <RefreshCw className="size-3.5" />
                  验证连接
                </Button>
                <Button
                  size="sm"
                  disabled={repository.enabled === false}
                  onClick={() =>
                    setFetchForm({
                      repositoryId: repository.id,
                      refType: 'branch',
                      ref: repository.defaultBranch || 'main',
                      outcome: 'success',
                    })
                  }
                >
                  获取源码
                  <ArrowRight className="size-3.5" />
                </Button>
                {repositoryMenu(repository)}
              </>
            }
          >
            <div className="mat-repository-origin">
              <code>{repository.url}</code>
              {repository.enabled === false ? (
                <Badge variant="outline">已停用</Badge>
              ) : (
                <Status value={repository.connectionStatus || 'untested'} />
              )}
              <SimulationMenu
                value={verifyOutcome}
                onChange={setVerifyOutcome}
                label="仓库验证演示场景"
              />
            </div>
            <div className="mat-repository-stats">
              <span>
                默认分支 <strong>{repository.defaultBranch}</strong>
              </span>
              <span>
                源码快照 <strong>{snapshots.length}</strong>
              </span>
              {repository.verifiedAt && <span>最近验证 {prettyTime(repository.verifiedAt)}</span>}
            </div>
            <h3 className="mb-3 text-xs font-semibold">固定提交快照</h3>
            {snapshots.length ? (
              snapshots.map((artifact) => (
                <div key={artifact.id} className="mat-snapshot-row">
                  <div>
                    <strong>
                      {artifact.refType === 'tag'
                        ? '标签'
                        : artifact.refType === 'commit'
                          ? '提交'
                          : '分支'}{' '}
                      · {artifact.ref || artifact.name}
                    </strong>
                    <div className="wb-row">
                      <code title={artifact.commit}>{artifact.commit?.slice(0, 12)}</code>
                      <CopyButton value={artifact.commit} />
                      <small>{prettyTime(artifact.createdAt)}</small>
                    </div>
                  </div>
                  <Status value={artifact.status} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/p/${projectId}/artifacts?artifact=${artifact.id}`)}
                  >
                    查看产物
                    <ArrowUpRight className="size-3" />
                  </Button>
                </div>
              ))
            ) : (
              <Empty>尚未获取源码。选择一个 Git 引用以创建固定提交快照。</Empty>
            )}
          </Panel>
        </div>
      )}
      <TaskStrip type={['source']} />
      <Modal
        title={form?.id ? '编辑仓库' : '添加仓库'}
        open={!!form}
        onClose={() => setForm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)}>
              取消
            </Button>
            <Button onClick={saveRepository}>保存仓库</Button>
          </>
        }
      >
        {form && (
          <div className="wb-stack">
            <Field label="仓库名称">
              <Input
                aria-label="仓库名称"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Field>
            <Field label="Git 托管方">
              <Picker
                label="Git 托管方"
                value={form.provider}
                onChange={(value) => setForm({ ...form, provider: value })}
                options={['GitHub', 'Gitee', '自建 Git'].map((value) => ({ value, label: value }))}
              />
            </Field>
            <Field label="仓库地址">
              <Input
                aria-label="仓库地址"
                placeholder="https://git.example.invalid/team/repository.git"
                value={form.url}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
              />
            </Field>
            <Field label="默认分支">
              <Input
                aria-label="默认分支"
                value={form.defaultBranch}
                onChange={(event) => setForm({ ...form, defaultBranch: event.target.value })}
              />
            </Field>
            <Field label="私有仓库">
              <Switch
                aria-label="私有仓库"
                checked={form.private}
                onCheckedChange={(value) => setForm({ ...form, private: value })}
              />
            </Field>
            {form.private && (
              <>
                <Field label="用户名">
                  <Input
                    aria-label="仓库用户名"
                    autoComplete="off"
                    value={form.username}
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
                  />
                </Field>
                <Field
                  label="演示令牌或 SSH 私钥"
                  hint="仅填写虚构凭据；交互原型不会访问远端仓库。"
                >
                  <Input
                    aria-label="仓库演示凭据"
                    autoComplete="off"
                    type="password"
                    value={form.token}
                    onChange={(event) => setForm({ ...form, token: event.target.value })}
                  />
                </Field>
              </>
            )}
          </div>
        )}
      </Modal>
      <Confirm
        title="删除仓库连接"
        open={!!deleting}
        onClose={() => setDeleting(null)}
        danger
        confirmLabel="删除连接"
        onConfirm={() => {
          updateProject((draft) => {
            draft.repositories = draft.repositories.filter((item) => item.id !== deleting.id)
          })
          audit({ projectId, action: '删除仓库连接', object: deleting.name })
          setDeleting(null)
          toast.success('仓库连接已删除')
        }}
      >
        <p>
          删除「{deleting?.name}
          」的项目配置。已获取的源码产物与已导入文档保留，文档将无法继续从此连接同步。
        </p>
      </Confirm>
      <Modal
        title="获取 Git 源码"
        open={!!fetchForm}
        onClose={() => setFetchForm(null)}
        footer={
          <>
            <SimulationMenu
              label="源码获取演示场景"
              value={fetchForm?.outcome}
              onChange={(value) => setFetchForm({ ...fetchForm, outcome: value })}
            />
            <Button variant="ghost" onClick={() => setFetchForm(null)}>
              取消
            </Button>
            <Button onClick={fetchSource}>获取并固定提交</Button>
          </>
        }
      >
        {fetchForm && (
          <div className="wb-stack">
            <Field label="来源类型">
              <Picker
                label="源码引用类型"
                options={REFERENCE_OPTIONS}
                value={fetchForm.refType}
                onChange={(value) =>
                  setFetchForm({
                    ...fetchForm,
                    refType: value,
                    ref: value === 'branch' ? 'main' : value === 'tag' ? 'v1.2.0' : '38e20cf',
                  })
                }
              />
            </Field>
            <Field label="分支、标签或提交号">
              <Input
                aria-label="源码引用"
                value={fetchForm.ref}
                onChange={(event) => setFetchForm({ ...fetchForm, ref: event.target.value })}
              />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  )
}

function ArtifactPreview({ artifact, onClose }) {
  const { project, projectId, navigate } = useWorkbench()
  const source = project.artifacts.find((item) => item.id === artifact?.sourceId)
  return (
    <Modal
      title={artifact?.name || '产物预览'}
      open={!!artifact}
      onClose={onClose}
      footer={
        artifact && (
          <>
            <Button
              variant="outline"
              disabled={artifact.deleted || artifact.status !== 'ready'}
              onClick={() => downloadArtifact(artifact)}
            >
              <ArrowDownToLine className="size-4" />
              下载产物
            </Button>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </>
        )
      }
    >
      {artifact && (
        <div className="wb-stack">
          <div className="wb-row">
            <Badge variant="outline">{TYPE_NAMES[artifact.type] || '文件'}</Badge>
            <Status value={artifact.deleted ? 'deleted' : artifact.status} />
            <span className="wb-muted">{prettyTime(artifact.createdAt)}</span>
          </div>
          {artifact.commit && (
            <div className="wb-row">
              <code className="break-all text-xs">{artifact.commit}</code>
              <CopyButton value={artifact.commit} />
            </div>
          )}
          {source && (
            <div className="wb-row text-xs">
              <span className="wb-muted">来源产物</span>
              <Button
                variant="link"
                className="mat-inline-link"
                onClick={() => {
                  onClose()
                  navigate(`/p/${projectId}/artifacts?artifact=${source.id}`)
                }}
              >
                {source.name}
                {source.deleted ? '（已删除）' : ''}
                <ArrowUpRight className="size-3" />
              </Button>
            </div>
          )}
          {artifact.deleted ? (
            <Empty>产物已删除，历史记录保留；文件不能再下载。</Empty>
          ) : artifact.status === 'ready' ? (
            artifact.dataUrl ? (
              <DocumentPreview document={artifact} />
            ) : artifact.files?.length ? (
              <FileTreePreview artifact={artifact} />
            ) : (
              <pre className="wb-code">
                {artifact.content || '此产物由 Agent 生成。使用下载按钮获取原文件。'}
              </pre>
            )
          ) : (
            <Empty>{artifact.error || '任务处理中，文件将在完成后可用。'}</Empty>
          )}
        </div>
      )}
    </Modal>
  )
}

function ArtifactLineage({ selected, artifacts, onSelect, projectId, navigate }) {
  const { project } = useWorkbench()
  if (!selected) return null
  const chain = []
  const seen = new Set()
  let cursor = selected
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.unshift(cursor)
    cursor = artifacts.find((item) => item.id === cursor.sourceId)
  }
  let next = selected
  while (chain.length < 4) {
    const child = artifacts.find(
      (item) =>
        item.sourceId === next.id && !item.deleted && item.type !== 'report' && !seen.has(item.id),
    )
    if (!child) break
    chain.push(child)
    seen.add(child.id)
    next = child
  }
  const origin = chain[0]
  return (
    <div className="mat-lineage" aria-label="产物来源关系">
      {origin.repositoryId && (
        <>
          <Button
            variant="ghost"
            className="mat-lineage-step"
            disabled={!project.repositories.some((item) => item.id === origin.repositoryId)}
            onClick={() =>
              navigate(`/p/${projectId}/repositories?repository=${origin.repositoryId}`)
            }
          >
            <span className="mat-lineage-icon">
              <GitBranch />
            </span>
            <span>
              <strong>Git 提交</strong>
              <small>{origin.ref || origin.commit?.slice(0, 8) || origin.repositoryName}</small>
            </span>
          </Button>
          <ArrowRight className="mat-lineage-arrow" />
        </>
      )}
      {chain.map((item, index) => {
        const Icon = artifactIcon(item.type)
        return (
          <div key={item.id} className="contents">
            {index > 0 && <ArrowRight className="mat-lineage-arrow" />}
            <Button
              variant="ghost"
              className={`mat-lineage-step ${selected.id === item.id ? 'is-selected' : ''}`}
              onClick={() => onSelect(item.id)}
            >
              <span className="mat-lineage-icon">
                <Icon />
              </span>
              <span>
                <strong>{TYPE_NAMES[item.type] || '文件'}</strong>
                <small>{item.deleted ? '已删除' : item.name}</small>
              </span>
            </Button>
          </div>
        )
      })}
    </div>
  )
}

function ArtifactInspector({
  artifact,
  artifacts,
  onSelect,
  onPreview,
  onProcess,
  onDelete,
  onBack,
}) {
  const { state, project, projectId, navigate, canViewAgent } = useWorkbench()
  if (!artifact)
    return (
      <Panel className="mat-artifact-inspector" title="产物详情">
        <Empty>选择产物查看来源和可用操作。</Empty>
      </Panel>
    )
  const Icon = artifactIcon(artifact.type)
  const source = artifacts.find((item) => item.id === artifact.sourceId)
  const task =
    state.tasks.find(
      (item) => item.id === artifact.taskId && canViewAgent(item.agentId, projectId),
    ) ||
    state.tasks.find(
      (item) =>
        item.projectId === projectId &&
        canViewAgent(item.agentId, projectId) &&
        item.effects?.some(
          (effect) =>
            effect.path?.at(-1) === 'artifacts' &&
            (effect.id === artifact.id || effect.value?.id === artifact.id),
        ),
    )
  const report = artifacts.find(
    (item) => item.type === 'report' && item.sourceId === artifact.id && !item.deleted,
  )
  const usable = !artifact.deleted && artifact.status === 'ready'
  const sourceLike = sourceTypes.includes(artifact.type)
  const conversation = state.conversations.find(
    (item) => item.id === artifact.conversationId && canViewAgent(item.agentId, projectId),
  )
  return (
    <Panel
      className="mat-artifact-inspector"
      title={
        <div className="mat-inspector-title">
          <Icon />
          <strong>{artifact.name}</strong>
        </div>
      }
      actions={
        <MoreMenu label={`${artifact.name} 更多操作`}>
          <DropdownMenuItem disabled={!usable} onSelect={() => downloadArtifact(artifact)}>
            <ArrowDownToLine />
            下载产物
          </DropdownMenuItem>
          {sourceLike && (
            <>
              <DropdownMenuItem disabled={!usable} onSelect={() => onProcess(artifact, 'strip')}>
                去除 Git 元数据
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!usable} onSelect={() => onProcess(artifact, 'sanitize')}>
                脱敏并生成报告
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!usable} onSelect={() => onProcess(artifact, 'zip')}>
                生成 ZIP
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={artifact.deleted}
            className="text-destructive"
            onSelect={() => onDelete(artifact.id)}
          >
            删除产物
          </DropdownMenuItem>
        </MoreMenu>
      }
    >
      <Button variant="ghost" size="sm" className="mat-mobile-back" onClick={onBack}>
        <ArrowLeft className="size-4" />
        返回产物列表
      </Button>
      <Status value={artifact.deleted ? 'deleted' : artifact.status} />
      <dl className="mat-inspector-data">
        <dt>来源</dt>
        <dd>
          {source ? (
            <Button variant="link" className="mat-inline-link" onClick={() => onSelect(source.id)}>
              {source.name}
              {source.deleted ? '（已删除）' : ''}
              <ArrowUpRight className="size-3" />
            </Button>
          ) : conversation ? (
            <Button
              variant="link"
              className="mat-inline-link"
              onClick={() => navigate(`/p/${projectId}/chat?conversation=${conversation.id}`)}
            >
              Agent 会话
              <ArrowUpRight className="size-3" />
            </Button>
          ) : (
            artifact.repositoryName || '独立文件'
          )}
        </dd>
        {artifact.ref && (
          <>
            <dt>引用</dt>
            <dd>
              {artifact.refType === 'tag'
                ? '标签'
                : artifact.refType === 'commit'
                  ? '提交'
                  : '分支'}{' '}
              · {artifact.ref}
            </dd>
          </>
        )}
        {artifact.commit && (
          <>
            <dt>提交</dt>
            <dd>
              <div className="wb-row">
                <code title={artifact.commit}>{artifact.commit.slice(0, 12)}</code>
                <CopyButton value={artifact.commit} />
              </div>
            </dd>
          </>
        )}
        {artifact.type === 'sanitized' && (
          <>
            <dt>处理规则</dt>
            <dd>
              内置凭据规则
              {artifact.ruleCount !== undefined ? ` + ${artifact.ruleCount} 项替换` : ''}
            </dd>
          </>
        )}
        <dt>内容</dt>
        <dd>
          {artifact.deleted
            ? '文件已删除'
            : artifact.status === 'ready'
              ? `${artifact.files?.length || 1} 个文件`
              : '等待处理结果'}
        </dd>
        <dt>生成时间</dt>
        <dd>{prettyTime(artifact.createdAt)}</dd>
        <dt>创建任务</dt>
        <dd>
          {task ? (
            <Button
              variant="link"
              className="mat-inline-link"
              onClick={() => navigate(`/p/${projectId}/tasks?task=${task.id}`)}
            >
              {task.title}
              <ArrowUpRight className="size-3" />
            </Button>
          ) : (
            '示例产物'
          )}
        </dd>
      </dl>
      {task?.status === 'running' && (
        <Progress value={task.progress} aria-label="所选产物处理进度" />
      )}
      {artifact.error && !artifact.deleted && (
        <p role="alert" className="wb-danger text-xs">
          {artifact.error}
        </p>
      )}
      {artifact.deleted ? (
        <p className="wb-muted text-xs">文件已删除；历史来源记录保留，不能再次下载。</p>
      ) : (
        <div className="mat-inspector-section">
          <h3>使用此产物</h3>
          <div className="mat-inspector-actions">
            <Button
              size="sm"
              disabled={!usable}
              onClick={() =>
                artifact.type === 'zip'
                  ? downloadArtifact(artifact)
                  : navigate(`/p/${projectId}/chat?artifact=${artifact.id}`)
              }
            >
              {artifact.type === 'zip' ? (
                <ArrowDownToLine className="size-3.5" />
              ) : (
                <MessageSquare className="size-3.5" />
              )}
              {artifact.type === 'zip' ? '下载 ZIP' : 'Agent 问答'}
            </Button>
            {sourceLike && (
              <Button
                variant="outline"
                size="sm"
                disabled={!usable}
                onClick={() => navigate(`/p/${projectId}/services?artifact=${artifact.id}`)}
              >
                <Rocket className="size-3.5" />
                用于发布
              </Button>
            )}
          </div>
          <div className="mat-inspector-secondary">
            <Button
              variant="ghost"
              size="sm"
              disabled={!usable}
              onClick={() => onPreview(artifact.id)}
            >
              <FileText className="size-3.5" />
              查看内容
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!usable}
              onClick={() => downloadArtifact(artifact)}
            >
              <ArrowDownToLine className="size-3.5" />
              下载
            </Button>
            {sourceLike && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={!usable}>
                    继续处理
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onProcess(artifact, 'strip')}>
                    去除 Git 元数据
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onProcess(artifact, 'sanitize')}>
                    脱敏并生成报告
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onProcess(artifact, 'zip')}>
                    生成 ZIP
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}
      {(report || artifact.repositoryId || conversation) && (
        <div className="mat-inspector-section mat-related">
          {report && (
            <Button variant="link" className="mat-inline-link" onClick={() => onSelect(report.id)}>
              查看处理报告
              <ArrowUpRight className="size-3" />
            </Button>
          )}
          {artifact.repositoryId && (
            <Button
              variant="link"
              className="mat-inline-link"
              disabled={!project.repositories.some((item) => item.id === artifact.repositoryId)}
              onClick={() =>
                navigate(`/p/${projectId}/repositories?repository=${artifact.repositoryId}`)
              }
            >
              查看来源仓库
              <ArrowUpRight className="size-3" />
            </Button>
          )}
          {conversation && (
            <Button
              variant="link"
              className="mat-inline-link"
              onClick={() => navigate(`/p/${projectId}/chat?conversation=${conversation.id}`)}
            >
              返回来源会话
              <ArrowUpRight className="size-3" />
            </Button>
          )}
        </div>
      )}
    </Panel>
  )
}

function ArtifactsPage() {
  const { state, project, projectId, route, navigate, updateProject, startTask, audit } =
    useWorkbench()
  const [type, setType] = useState('all')
  const [search, setSearch] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  const [previewId, setPreviewId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [processForm, setProcessForm] = useState(null)
  const [rules, setRules] = useState(null)
  const [selectedId, setSelectedId] = useState(queryValue(route, 'artifact') || '')
  const [mobileDetail, setMobileDetail] = useState(Boolean(queryValue(route, 'artifact')))
  const artifacts = project.artifacts || []
  const visible = artifacts.filter(
    (item) =>
      (showDeleted || !item.deleted) &&
      (type === 'all' || item.type === type) &&
      item.name.toLowerCase().includes(search.toLowerCase()),
  )
  const preview = artifacts.find((item) => item.id === previewId)
  const selected = artifacts.find((item) => item.id === selectedId) || visible[0] || artifacts[0]
  const deleting = artifacts.find((item) => item.id === deletingId)
  const blocking = deleting ? artifactBlockReason(deleting, state, project) : ''
  const processingSource = artifacts.find((item) => item.id === processForm?.sourceId)
  useEffect(() => {
    const requested = queryValue(route, 'artifact')
    if (requested) setSelectedId(requested)
    setMobileDetail(Boolean(requested))
  }, [route])
  function selectArtifact(id) {
    setSelectedId(id)
    setMobileDetail(true)
    navigate(`/p/${projectId}/artifacts?artifact=${encodeURIComponent(id)}`)
  }
  function openProcess(source, operation = 'sanitize') {
    setProcessForm({
      sourceId: source.id,
      operation,
      name: `${source.name} · ${operation === 'strip' ? '去 Git' : operation === 'zip' ? 'ZIP' : '脱敏'}`,
      outcome: 'success',
    })
  }
  function processSource() {
    if (!processingSource || processingSource.deleted || processingSource.status !== 'ready')
      return errorToast('所选来源已不可用，请重新选择。')
    const name = processForm.name.trim()
    if (!name) return errorToast('请填写输出产物名称。')
    const operation = processForm.operation
    const outputId = uid(operation)
    const outputType =
      operation === 'strip' ? 'stripped' : operation === 'sanitize' ? 'sanitized' : 'zip'
    const createdAt = stamp()
    let files = processingSource.files.map((file) => ({ ...file }))
    let findings = []
    if (operation === 'strip') files = stripGitFiles(files)
    if (operation === 'sanitize') ({ files, findings } = sanitizeFiles(files, project.rules))
    const output = {
      id: outputId,
      name,
      type: outputType,
      status: 'processing',
      files: [],
      sourceId: processingSource.id,
      repositoryId: processingSource.repositoryId,
      repositoryName: processingSource.repositoryName,
      refType: processingSource.refType,
      ref: processingSource.ref,
      commit: processingSource.commit,
      operation,
      ruleCount: operation === 'sanitize' ? project.rules.length : undefined,
      createdAt,
    }
    updateProject((draft) => draft.artifacts.unshift(output))
    const effects = [
      {
        op: 'patch',
        path: ['projects', projectId, 'artifacts'],
        id: outputId,
        value: { status: 'ready', files },
      },
    ]
    if (operation === 'sanitize') {
      const report = `# 脱敏处理报告\n\n- 输入产物：${processingSource.name}\n- 输入 ID：${processingSource.id}\n- 固定提交：${processingSource.commit || '无'}\n- 输出产物：${name}\n- 处理时间：${createdAt}\n- 文件数：${files.length}\n- 命中记录：${findings.length}\n\n## 规则命中\n\n${findings.length ? findings.map((item) => `- ${item.file}${item.line ? `:${item.line}` : ''} · ${item.rule}${item.count ? `（${item.count} 处）` : ''}`).join('\n') : '未命中当前规则。'}\n\n报告不保存原始密钥。匹配仅覆盖已配置规则；使用前请检查文件内容。\n`
      effects.push({
        op: 'append',
        path: ['projects', projectId, 'artifacts'],
        value: {
          id: uid('report'),
          name: `${name} · 处理报告.md`,
          type: 'report',
          status: 'ready',
          files: [{ name: '脱敏处理报告.md', content: report }],
          content: report,
          sourceId: outputId,
          commit: processingSource.commit,
          createdAt,
        },
      })
    }
    const taskId = startTask({
      projectId,
      type: 'artifacts',
      title: `${operation === 'strip' ? '去除 Git 元数据' : operation === 'sanitize' ? '脱敏源码' : '压缩 ZIP'}：${processingSource.name}`,
      artifactIds: [processingSource.id, outputId],
      outcome: processForm.outcome,
      duration: 4500,
      logs: [
        `输入产物 ${processingSource.id}；不会覆盖输入。`,
        operation === 'strip'
          ? `删除 ${processingSource.files.length - files.length} 个 .git 元数据文件；保留 .gitignore、.gitattributes 与 CI 配置。`
          : operation === 'sanitize'
            ? `使用启动时规则快照；匹配 ${findings.length} 条记录，报告不包含原始密钥。`
            : `将 ${files.length} 个文件写入可解压 ZIP。`,
        processForm.outcome === 'failed'
          ? '模拟磁盘空间不足，输出失败。输入产物保持可用。'
          : '处理结果将在任务完成后保存。',
      ],
      effects,
      failureEffects: [
        {
          op: 'patch',
          path: ['projects', projectId, 'artifacts'],
          id: outputId,
          value: { status: 'failed', error: '模拟磁盘空间不足，请释放空间后重新处理。' },
        },
      ],
    })
    updateProject((draft) => {
      const item = draft.artifacts.find((entry) => entry.id === outputId)
      if (item) item.taskId = taskId
    })
    audit({
      projectId,
      action:
        operation === 'strip'
          ? '去除 Git 元数据'
          : operation === 'sanitize'
            ? '源码脱敏'
            : '源码压缩',
      object: `${processingSource.name} → ${name}`,
    })
    setProcessForm(null)
    selectArtifact(outputId)
  }
  return (
    <div className="wb-page mat-workspace mat-artifacts-page" data-detail={mobileDetail}>
      <PageHeader title="源码与产物">
        <Button variant="outline" onClick={() => navigate(`/p/${projectId}/repositories`)}>
          <GitBranch className="size-4" />
          查看仓库
        </Button>
        <Button
          onClick={() => {
            const source =
              selected &&
              !selected.deleted &&
              selected.status === 'ready' &&
              sourceTypes.includes(selected.type)
                ? selected
                : artifacts.find(
                    (item) =>
                      !item.deleted && item.status === 'ready' && sourceTypes.includes(item.type),
                  )
            if (!source) return errorToast('请先从 Git 获取一份源码。')
            openProcess(source)
          }}
        >
          <Box className="size-4" />
          生成产物
        </Button>
        <MoreMenu label="产物更多操作" outline>
          <DropdownMenuItem onSelect={() => setRules(project.rules.map((item) => ({ ...item })))}>
            <ShieldCheck />
            脱敏规则
          </DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={showDeleted} onCheckedChange={setShowDeleted}>
            显示已删除产物
          </DropdownMenuCheckboxItem>
        </MoreMenu>
      </PageHeader>
      {selected && (
        <>
          <div className="mat-context">
            <span>
              <Folder />
              {selected.repositoryName || project.name}
            </span>
            {selected.ref && (
              <span>
                <GitBranch />
                {selected.ref}
              </span>
            )}
            {selected.commit && (
              <div className="mat-context-commit">
                <code title={selected.commit}>{selected.commit.slice(0, 12)}</code>
                <CopyButton value={selected.commit} />
              </div>
            )}
            <span>{TYPE_NAMES[selected.type] || '研发文件'}</span>
          </div>
          <ArtifactLineage
            selected={selected}
            artifacts={artifacts}
            onSelect={selectArtifact}
            projectId={projectId}
            navigate={navigate}
          />
        </>
      )}
      <div className="mat-artifact-workspace" data-detail={mobileDetail}>
        <div className="mat-artifact-main">
          <Panel
            title="处理产物"
            className="mat-artifact-table"
            actions={
              <div className="mat-artifact-filter">
                <Input
                  aria-label="搜索产物名称"
                  placeholder="搜索产物名称"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Picker
                  label="产物类型"
                  value={type}
                  onChange={setType}
                  options={[
                    { value: 'all', label: '全部类型' },
                    ...Object.entries(TYPE_NAMES).map(([value, label]) => ({ value, label })),
                  ]}
                />
              </div>
            }
          >
            {!visible.length ? (
              <Empty>
                没有符合条件的产物。
                <div className="mt-3">
                  <Button
                    variant="outline"
                    onClick={() => navigate(`/p/${projectId}/repositories`)}
                  >
                    从 Git 获取源码
                    <ArrowRight className="size-3.5" />
                  </Button>
                </div>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead className="mat-type-column">类型</TableHead>
                    <TableHead className="mat-usage-column">用途</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="mat-preview-column">操作</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((artifact) => {
                    const Icon = artifactIcon(artifact.type)
                    const usable = !artifact.deleted && artifact.status === 'ready'
                    return (
                      <TableRow key={artifact.id} data-selected={selected?.id === artifact.id}>
                        <TableCell>
                          <div className="mat-artifact-name">
                            <Icon />
                            <div className="min-w-0">
                              <Button variant="link" onClick={() => selectArtifact(artifact.id)}>
                                <span>{artifact.name}</span>
                                <ArrowUpRight className="size-3 shrink-0" />
                              </Button>
                              <small>{TYPE_NAMES[artifact.type]}</small>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="mat-type-column">
                          {TYPE_NAMES[artifact.type] || '文件'}
                        </TableCell>
                        <TableCell className="mat-usage-column">
                          {artifactUsage(artifact.type)}
                        </TableCell>
                        <TableCell>
                          <Status value={artifact.deleted ? 'deleted' : artifact.status} />
                        </TableCell>
                        <TableCell className="mat-preview-column">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!usable}
                            onClick={() =>
                              artifact.type === 'zip'
                                ? downloadArtifact(artifact)
                                : selectArtifact(artifact.id)
                            }
                          >
                            {artifact.type === 'zip' ? '下载' : '查看'}
                          </Button>
                        </TableCell>
                        <TableCell>
                          <MoreMenu label={`${artifact.name} 操作菜单`}>
                            <DropdownMenuItem onSelect={() => selectArtifact(artifact.id)}>
                              查看详情
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!usable}
                              onSelect={() => setPreviewId(artifact.id)}
                            >
                              查看文件内容
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!usable}
                              onSelect={() => downloadArtifact(artifact)}
                            >
                              下载产物
                            </DropdownMenuItem>
                            {sourceTypes.includes(artifact.type) && (
                              <DropdownMenuItem
                                disabled={!usable}
                                onSelect={() => openProcess(artifact)}
                              >
                                继续处理
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={artifact.deleted}
                              className="text-destructive"
                              onSelect={() => setDeletingId(artifact.id)}
                            >
                              删除产物
                            </DropdownMenuItem>
                          </MoreMenu>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </Panel>
          <Panel
            title="研发资料"
            actions={
              <Button
                variant="link"
                size="sm"
                className="mat-inline-link"
                onClick={() => navigate(`/p/${projectId}/documents`)}
              >
                全部资料
                <ArrowUpRight className="size-3.5" />
              </Button>
            }
          >
            <div className="mat-document-shortcuts">
              {project.documents
                .filter((item) => item.kind === 'file')
                .slice(0, 3)
                .map((item) => (
                  <div className="mat-document-shortcut" key={item.id}>
                    <FileText />
                    <Button
                      variant="link"
                      size="sm"
                      className="mat-inline-link"
                      onClick={() => navigate(`/p/${projectId}/documents?document=${item.id}`)}
                    >
                      {item.name}
                      <ArrowUpRight className="size-3" />
                    </Button>
                    <small>
                      {item.name.split('.').at(-1).toUpperCase()} · {prettyTime(item.updatedAt)}
                    </small>
                  </div>
                ))}
              {!project.documents.some((item) => item.kind === 'file') && (
                <Empty>还没有项目文档。</Empty>
              )}
            </div>
          </Panel>
        </div>
        <ArtifactInspector
          artifact={selected}
          artifacts={artifacts}
          onSelect={selectArtifact}
          onPreview={setPreviewId}
          onProcess={openProcess}
          onDelete={setDeletingId}
          onBack={() => {
            setMobileDetail(false)
            navigate(`/p/${projectId}/artifacts`)
          }}
        />
      </div>
      <TaskStrip type={['source', 'artifacts']} />
      <ArtifactPreview artifact={preview} onClose={() => setPreviewId(null)} />
      <Modal
        title="处理源码"
        open={!!processForm}
        onClose={() => setProcessForm(null)}
        footer={
          <>
            <SimulationMenu
              label="源码处理演示场景"
              value={processForm?.outcome}
              onChange={(value) => setProcessForm({ ...processForm, outcome: value })}
            />
            <Button variant="ghost" onClick={() => setProcessForm(null)}>
              取消
            </Button>
            <Button onClick={processSource}>生成独立产物</Button>
          </>
        }
      >
        {processForm && (
          <div className="wb-stack">
            <Field label="输入源码">
              <Picker
                label="输入源码产物"
                value={processForm.sourceId}
                options={artifacts
                  .filter(
                    (item) =>
                      !item.deleted &&
                      item.status === 'ready' &&
                      ['source', 'stripped', 'sanitized'].includes(item.type),
                  )
                  .map((item) => ({ value: item.id, label: item.name }))}
                onChange={(value) => setProcessForm({ ...processForm, sourceId: value })}
              />
            </Field>
            <Field label="处理方式">
              <Picker
                label="源码处理方式"
                value={processForm.operation}
                options={[
                  { value: 'strip', label: '去除 Git 元数据' },
                  { value: 'sanitize', label: '脱敏并生成报告' },
                  { value: 'zip', label: '压缩为 ZIP' },
                ]}
                onChange={(value) =>
                  setProcessForm({
                    ...processForm,
                    operation: value,
                    name: `${processingSource?.name} · ${value === 'strip' ? '去 Git' : value === 'sanitize' ? '脱敏' : 'ZIP'}`,
                  })
                }
              />
            </Field>
            <Field label="输出名称">
              <Input
                aria-label="输出产物名称"
                value={processForm.name}
                onChange={(event) => setProcessForm({ ...processForm, name: event.target.value })}
              />
            </Field>

            <p className="wb-muted">
              {processForm.operation === 'strip'
                ? '仅移除路径中的 .git 元数据。保留 .gitignore、.gitattributes 和 CI 配置。'
                : processForm.operation === 'sanitize'
                  ? '使用内置密钥规则和项目自定义替换；单独生成处理报告。'
                  : '包含输入产物的全部文件，下载结果为真实 ZIP。'}{' '}
              输入产物保持不变。
            </p>
          </div>
        )}
      </Modal>
      <Modal
        title="脱敏规则"
        open={!!rules}
        onClose={() => setRules(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRules(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (rules.some((item) => !item.find))
                  return errorToast('自定义替换的查找内容不能为空。')
                updateProject((draft) => {
                  draft.rules = rules.map((item) => ({ ...item }))
                })
                audit({ projectId, action: '修改脱敏规则', object: `${rules.length} 条自定义规则` })
                setRules(null)
                toast.success('规则已保存，后续处理立即使用')
              }}
            >
              保存规则
            </Button>
          </>
        }
      >
        {rules && (
          <div className="wb-stack">
            <Panel title="内置规则">
              <ul className="list-disc space-y-2 pl-5 text-sm">
                <li>配置中的 password、secret、token、API key 等常见密钥。</li>
                <li>RSA、EC、OpenSSH 私钥块。</li>
                <li>常见 GitHub 与云访问凭据格式。</li>
              </ul>
            </Panel>
            {rules.map((rule, index) => (
              <div key={rule.id} className="wb-stack rounded-lg border p-3">
                <div className="wb-row justify-between">
                  <span className="text-sm font-medium">自定义替换 {index + 1}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRules(rules.filter((item) => item.id !== rule.id))}
                  >
                    移除
                  </Button>
                </div>
                <Field label="查找内容">
                  <Input
                    aria-label={`规则 ${index + 1} 查找内容`}
                    value={rule.find}
                    onChange={(event) =>
                      setRules(
                        rules.map((item) =>
                          item.id === rule.id ? { ...item, find: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="替换为">
                  <Input
                    aria-label={`规则 ${index + 1} 替换内容`}
                    value={rule.replace}
                    onChange={(event) =>
                      setRules(
                        rules.map((item) =>
                          item.id === rule.id ? { ...item, replace: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </Field>
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() =>
                setRules([...rules, { id: uid('rule'), find: '', replace: '[REDACTED]' }])
              }
            >
              <Plus className="size-4" />
              添加替换规则
            </Button>
            <p className="wb-muted">自定义规则按字面精确匹配。规则保存后仅影响之后发起的任务。</p>
          </div>
        )}
      </Modal>
      <Modal
        title="删除产物"
        open={!!deleting}
        onClose={() => setDeletingId(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeletingId(null)}>
              关闭
            </Button>
            <Button
              variant="destructive"
              disabled={!!blocking}
              onClick={() => {
                const current = project.artifacts.find((item) => item.id === deleting.id)
                const reason = artifactBlockReason(current, state, project)
                if (reason) return errorToast(reason)
                updateProject((draft) => {
                  const artifact = draft.artifacts.find((item) => item.id === current.id)
                  artifact.deleted = true
                  artifact.deletedAt = stamp()
                  artifact.files = []
                  delete artifact.content
                  delete artifact.dataUrl
                })
                audit({ projectId, action: '删除产物', object: current.name })
                setDeletingId(null)
                toast.success('产物已删除，历史引用显示为已删除')
              }}
            >
              删除文件
            </Button>
          </>
        }
      >
        {deleting && (
          <div className="wb-stack">
            <p>
              删除「{deleting.name}
              」的文件。已完成的任务与历史会话保留引用，并显示“已删除”，不能再次下载。
            </p>
            {blocking && (
              <p role="alert" className="wb-danger">
                {blocking}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

export function MaterialsPage({ tab = 'documents' }) {
  if (tab === 'repositories' || tab === 'repository') return <RepositoryPage />
  if (tab === 'artifacts') return <ArtifactsPage />
  return <DocumentsPage />
}
