import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  Copy,
  FileArchive,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  MessageSquare,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePrototype } from './context'

const TYPE_LABELS = {
  source: '源码快照',
  sanitized: '脱敏目录',
  zip: 'ZIP 文件',
  report: '处理报告',
}
const TYPE_ICONS = {
  source: FileCode2,
  sanitized: ShieldCheck,
  zip: FileArchive,
  report: FileText,
}
const MATERIAL_TABS = [
  ['overview', '概览'],
  ['documents', '研发资料'],
  ['repository', '仓库与源码'],
  ['resources', '环境资源'],
  ['plugins', '插件配置'],
  ['artifacts', '源码与产物'],
]
const ACTIONS = {
  strip: {
    label: '移除 Git 信息',
    description: '保留工作文件，单独生成不含 .git 目录的文件树。',
    outputType: 'source',
    usage: ['部署', '插件'],
  },
  sanitize: {
    label: '生成脱敏目录',
    description: '在输入副本中替换示例敏感配置，独立保存目录和处理报告。',
    outputType: 'sanitized',
    usage: ['Agent', '插件'],
  },
  zip: {
    label: '生成 ZIP 压缩包',
    description: '将当前文件树打包，生成可实际解压的 ZIP 文件。',
    outputType: 'zip',
    usage: ['下载交付'],
  },
  report: {
    label: '生成处理报告',
    description: '生成输入版本、处理记录与文件清单，便于检查与追溯。',
    outputType: 'report',
    usage: ['追溯'],
  },
}

function filesOf(artifact) {
  if (artifact?.files?.length) return artifact.files
  return [
    {
      name: artifact?.type === 'report' ? 'report.md' : 'README.md',
      content:
        artifact?.content || `# ${artifact?.name || '资料'}\n\n该示例产物还没有可预览的文件内容。`,
    },
  ]
}

function safeFilename(name) {
  return String(name)
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
}

function crc32(bytes) {
  let result = 0xffffffff
  for (const value of bytes) {
    result ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0)
    }
  }
  return (result ^ 0xffffffff) >>> 0
}

// 使用 ZIP 的无压缩模式，确保下载的示例产物可由标准解压工具读取。
export function createArtifactZip(files) {
  const encoder = new TextEncoder()
  const localChunks = []
  const centralChunks = []
  let offset = 0
  let centralSize = 0
  for (const file of files) {
    const name = encoder.encode(safeFilename(file.name) || 'unnamed.txt')
    const data = encoder.encode(String(file.content ?? ''))
    const checksum = crc32(data)
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x0800, true)
    view.setUint16(12, 33, true)
    view.setUint32(14, checksum, true)
    view.setUint32(18, data.length, true)
    view.setUint32(22, data.length, true)
    view.setUint16(26, name.length, true)
    header.set(name, 30)
    localChunks.push(header, data)
    const central = new Uint8Array(46 + name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(14, 33, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, data.length, true)
    centralView.setUint32(24, data.length, true)
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, offset, true)
    central.set(name, 46)
    centralChunks.push(central)
    centralSize += central.length
    offset += header.length + data.length
  }
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, files.length, true)
  endView.setUint16(10, files.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  return new Blob([...localChunks, ...centralChunks, end], {
    type: 'application/zip',
  })
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name.replaceAll('/', '-').replaceAll('\\', '-')
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadArtifact(artifact) {
  if (!artifact) return
  const files = filesOf(artifact)
  if (artifact.type === 'report') {
    saveBlob(
      new Blob([files[0].content], { type: 'text/markdown;charset=utf-8' }),
      artifact.name.endsWith('.md') ? artifact.name : `${artifact.name}.md`,
    )
  } else {
    saveBlob(
      createArtifactZip(files),
      artifact.name.endsWith('.zip') ? artifact.name : `${artifact.name}.zip`,
    )
  }
  toast.success('示例产物已下载')
}

async function copyText(value, message = '已复制') {
  try {
    await navigator.clipboard.writeText(String(value))
    toast.success(message)
  } catch {
    toast.error('浏览器未允许复制，请在预览中选中文字后复制')
  }
}

function versionLabel(value) {
  return String(value || 1).startsWith('v') ? String(value) : `v${value || 1}`
}

function formattedTime(value) {
  if (!value) return '刚刚'
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}:00+08:00`
    : value
  const date = new Date(normalized)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
      }).format(date)
}

export function ArtifactPreview({ artifact, onClose }) {
  const [fileIndex, setFileIndex] = useState(0)
  const [filter, setFilter] = useState('')
  useEffect(() => {
    setFileIndex(0)
    setFilter('')
  }, [artifact?.id])
  const files = artifact ? filesOf(artifact) : []
  const file = files[fileIndex] || files[0]
  return (
    <Dialog open={Boolean(artifact)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[88dvh] flex-col gap-4 overflow-hidden sm:max-w-[1000px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <Folder className="size-5 text-blue-600" />
            {artifact?.name}
          </DialogTitle>
          <DialogDescription>
            {TYPE_LABELS[artifact?.type] || '研发资料'} · {versionLabel(artifact?.version)} ·{' '}
            {files.length} 个示例文件
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 overflow-hidden rounded-xl border bg-background/70 md:grid-cols-[230px_minmax(0,1fr)]">
          <div className="max-h-44 overflow-y-auto border-b p-3 md:max-h-none md:border-r md:border-b-0">
            <Input
              aria-label="搜索产物内文件"
              placeholder="搜索文件…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="mb-3"
            />
            <div className="space-y-1">
              {files.map((entry, index) =>
                entry.name.toLowerCase().includes(filter.toLowerCase()) ? (
                  <Button
                    key={`${entry.name}-${index}`}
                    variant={fileIndex === index ? 'secondary' : 'ghost'}
                    className="h-auto min-h-9 w-full justify-start px-2 py-2 text-left text-xs"
                    onClick={() => setFileIndex(index)}
                  >
                    <FileText className="size-4 shrink-0" />
                    <span className="truncate" title={entry.name}>
                      {entry.name}
                    </span>
                  </Button>
                ) : null,
              )}
              {!files.some((entry) => entry.name.toLowerCase().includes(filter.toLowerCase())) && (
                <p className="px-2 py-4 text-xs text-muted-foreground">没有匹配的文件</p>
              )}
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
              <span className="truncate font-mono text-xs">{file?.name}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyText(file?.content || '', '已复制文件内容')}
              >
                <Copy className="size-3.5" />
                复制
              </Button>
            </div>
            <pre className="min-h-44 flex-1 overflow-auto p-4 text-xs leading-7 md:min-h-80">
              <code>{String(file?.content ?? '')}</code>
            </pre>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button onClick={() => downloadArtifact(artifact)}>
            <ArrowDownToLine className="size-4" />
            下载{artifact?.type === 'report' ? '报告' : '文件包'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GenerationDialog({ open, initialInputId, initialAction, onClose, onCreated }) {
  const { project, updateProject } = usePrototype()
  const candidates = project.artifacts || []
  const [inputId, setInputId] = useState('')
  const [action, setAction] = useState('sanitize')
  const [name, setName] = useState('')
  const [progress, setProgress] = useState(0)
  const [running, setRunning] = useState(false)
  const timer = useRef(null)
  useEffect(() => {
    if (open) {
      setInputId(initialInputId || candidates[0]?.id || '')
      setAction(initialAction || 'sanitize')
      setName('')
      setProgress(0)
      setRunning(false)
    }
  }, [open, initialInputId, initialAction])
  useEffect(() => () => window.clearInterval(timer.current), [])
  const input = candidates.find((item) => item.id === inputId)
  const definition = ACTIONS[action]
  const steps = ['读取输入版本', definition.label, '校验文件内容', '登记独立产物']
  const cancel = () => {
    window.clearInterval(timer.current)
    timer.current = null
    if (running) toast.info('模拟任务已取消，输入产物保持不变')
    setRunning(false)
    onClose()
  }
  const start = () => {
    if (!input) {
      toast.error('请选择输入产物')
      return
    }
    setRunning(true)
    setProgress(3)
    let value = 3
    const frozenInput = { ...input, files: filesOf(input) }
    timer.current = window.setInterval(() => {
      value = Math.min(100, value + 17)
      setProgress(value)
      if (value < 100) return
      window.clearInterval(timer.current)
      timer.current = null
      const createdAt = new Date().toISOString()
      const id = `artifact-${crypto.randomUUID()}`
      const version = input.version || project.configVersion || 1
      const versionName = versionLabel(version)
      const sourceFiles = frozenInput.files.filter(
        (file) => !safeFilename(file.name).split('/').includes('.git'),
      )
      const outputFiles =
        action === 'sanitize'
          ? sourceFiles.map((file) => ({
              ...file,
              content: String(file.content).replace(
                /((?:password|token|api[_-]?key|secret)["']?\s*[:=]\s*["']?)[^\s"',;\n}]+/gi,
                '$1[REDACTED]',
              ),
            }))
          : action === 'strip'
            ? sourceFiles
            : frozenInput.files
      const report = `# ${definition.label} · 处理报告\n\n> 本报告由前端交互原型生成，只处理示例数据。\n\n- 输入产物：${input.name}\n- 输入版本：${versionName}\n- 项目：${project.name}\n- 配置版本：v${project.configVersion || 1}\n- 处理动作：${definition.label}\n- 生成时间：${createdAt}\n- 输出文件：${outputFiles.length} 个\n- 模拟校验：已完成\n\n## 文件清单\n\n${outputFiles.map((file) => `- ${file.name}`).join('\n')}\n\n## 来源\n\n来源产物 ID：${input.id}\n\n原始产物保留，可独立下载或作为后续处理输入。\n${action === 'sanitize' ? '\n## 示例脱敏规则\n\n替换示例文件中的 password、token、api_key、secret 字段。此原型不代表生产环境安全扫描。\n' : ''}`
      const defaultName = {
        strip: `source-no-git-${versionName}`,
        sanitize: `sanitized-${versionName}`,
        zip: `${input.name.replace(/\.zip$/i, '')}-export.zip`,
        report: `processing-report-${versionName}`,
      }[action]
      const artifact = {
        id,
        name: name.trim() || defaultName,
        type: definition.outputType,
        version,
        status: 'ready',
        sourceId: input.id,
        createdAt,
        files: action === 'report' ? [{ name: 'report.md', content: report }] : outputFiles,
        content: action === 'report' ? report : '',
        usage: definition.usage,
        rule:
          action === 'sanitize'
            ? `项目示例脱敏规则 v${project.configVersion || 1}`
            : definition.label,
      }
      const additions = [artifact]
      if (action === 'sanitize') {
        const reportArtifact = {
          ...artifact,
          id: `${id}-report`,
          name: `sanitize-report-${versionName}`,
          type: 'report',
          sourceId: id,
          usage: ['追溯'],
          files: [{ name: 'report.md', content: report }],
          content: report,
        }
        artifact.reportId = reportArtifact.id
        additions.push(reportArtifact)
      }
      updateProject((current) => ({
        ...current,
        artifacts: [...additions, ...(current.artifacts || [])],
        activities: [
          {
            id: crypto.randomUUID(),
            title: `${definition.label}已完成`,
            time: '刚刚',
            type: 'artifact',
          },
          ...(current.activities || []),
        ].slice(0, 30),
      }))
      setRunning(false)
      toast.success(`${definition.label}已完成`, {
        description:
          action === 'sanitize' ? '脱敏目录与处理报告已独立保存' : '新产物已保存，可查看或继续处理',
      })
      onCreated(artifact.id)
    }, 420)
  }
  return (
    <Dialog open={open} onOpenChange={(value) => !value && cancel()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Box className="size-5" />
            生成产物
          </DialogTitle>
          <DialogDescription>每一步单独保存，原始产物始终保留。</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <Label htmlFor="artifact-input">输入产物</Label>
            <Select value={inputId} onValueChange={setInputId} disabled={running}>
              <SelectTrigger id="artifact-input" className="w-full">
                <SelectValue placeholder="选择一个已有产物" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · {TYPE_LABELS[item.type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="artifact-action">处理动作</Label>
            <Select value={action} onValueChange={setAction} disabled={running}>
              <SelectTrigger id="artifact-action" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ACTIONS).map(([key, entry]) => (
                  <SelectItem key={key} value={key}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs leading-5 text-muted-foreground">{definition.description}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="artifact-name">
              产物名称 <span className="font-normal text-muted-foreground">（选填）</span>
            </Label>
            <Input
              id="artifact-name"
              placeholder="留空使用自动命名"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={running}
              maxLength={100}
            />
          </div>
          {running ? (
            <div
              className="space-y-3 rounded-xl border bg-muted/35 p-4"
              role="status"
              aria-live="polite"
            >
              <div className="flex justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  {steps[Math.min(3, Math.floor(progress / 25))]}
                </span>
                <span className="tabular-nums text-muted-foreground">{progress}%</span>
              </div>
              <Progress value={progress} aria-label="产物生成进度" />
              <p className="text-xs text-muted-foreground">
                模拟任务进行中，关闭弹窗或离开页面将取消本次处理。
              </p>
            </div>
          ) : (
            <div className="rounded-xl border bg-muted/35 px-4 py-3 text-xs leading-5 text-muted-foreground">
              输入固定为 {versionLabel(input?.version)}
              。这是前端模拟处理，不会连接仓库或修改源文件。
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            {running ? '取消任务' : '取消'}
          </Button>
          <Button onClick={start} disabled={running || !input}>
            {running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {running ? '处理中…' : '开始生成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ArtifactsPage({ selectedId }) {
  const { project, navigate } = usePrototype()
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [localSelected, setLocalSelected] = useState(selectedId || '')
  const [preview, setPreview] = useState(null)
  const [generation, setGeneration] = useState(null)
  const artifacts = project.artifacts || []
  useEffect(() => setLocalSelected(selectedId || ''), [selectedId, project.id])
  const selected =
    artifacts.find((item) => item.id === localSelected) ||
    artifacts.find((item) => item.type === 'sanitized') ||
    artifacts[0]
  const source = artifacts.find((item) => item.id === selected?.sourceId)
  const sourceConversation = project.conversations.find(
    (item) =>
      item.id === selected?.conversationId ||
      item.messages.some((message) => message.id === selected?.sourceId),
  )
  const sourceSnapshot = artifacts.find((item) => item.type === 'source')
  const report = artifacts.find(
    (item) =>
      item.id === selected?.reportId || (item.type === 'report' && item.sourceId === selected?.id),
  )
  const filtered = useMemo(
    () =>
      artifacts.filter(
        (item) =>
          (type === 'all' || item.type === type) &&
          `${item.name} ${TYPE_LABELS[item.type]} ${(item.usage || []).join(' ')}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [artifacts, search, type],
  )
  const choose = (id) => {
    setLocalSelected(id)
    navigate('materials', 'artifacts', id)
  }
  const selectedFiles = selected ? filesOf(selected) : []
  const SelectedIcon = TYPE_ICONS[selected?.type] || Box
  const lineage = useMemo(() => {
    const chain = []
    const visited = new Set()
    let item = selected
    while (item && !visited.has(item.id)) {
      visited.add(item.id)
      chain.unshift(item)
      item = artifacts.find((entry) => entry.id === item.sourceId)
    }
    let last = selected
    for (let index = 0; index < 2; index += 1) {
      const nextType =
        last?.type === 'source' ? 'sanitized' : last?.type === 'sanitized' ? 'zip' : null
      const next =
        nextType && artifacts.find((entry) => entry.sourceId === last.id && entry.type === nextType)
      if (!next || visited.has(next.id)) break
      chain.push(next)
      visited.add(next.id)
      last = next
    }
    const originalConversation = project.conversations.find(
      (entry) =>
        entry.id === chain[0]?.conversationId ||
        entry.messages.some((message) => message.id === chain[0]?.sourceId),
    )
    return [
      ...(originalConversation
        ? [
            {
              label: 'Agent 对话',
              description: originalConversation.title,
              Icon: MessageSquare,
              conversationId: originalConversation.id,
              item: null,
            },
          ]
        : []),
      ...(/^[a-f0-9]{7,40}$/i.test(chain[0]?.sourceId || '')
        ? [{ label: 'Git 提交', description: '确定的源码版本', Icon: GitBranch, item: null }]
        : []),
      ...chain.map((entry) => ({
        label: TYPE_LABELS[entry.type],
        description: entry.name,
        Icon: TYPE_ICONS[entry.type] || FileText,
        item: entry,
      })),
    ]
  }, [artifacts, selected, project.conversations])
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">源码与产物</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => navigate('materials', 'repository')}>
            <GitBranch className="size-4" />
            查看仓库
          </Button>
          <Button
            onClick={() => setGeneration({ inputId: selected?.id, action: 'sanitize' })}
            disabled={!artifacts.length}
          >
            <Box className="size-4" />
            生成产物
          </Button>
        </div>
      </div>
      <Tabs value="artifacts" onValueChange={(tab) => navigate('materials', tab)}>
        <TabsList
          variant="line"
          className="h-10 w-full justify-start gap-3 overflow-x-auto border-b pb-1"
        >
          {MATERIAL_TABS.map(([id, title]) => (
            <TabsTrigger key={id} value={id} className="shrink-0 px-4 py-2">
              {title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border bg-card/65 px-4 py-3 text-sm">
        <span className="flex items-center gap-2">
          <Folder className="size-4" />
          {project.name}
        </span>
        <span className="flex items-center gap-2 text-muted-foreground">
          <GitBranch className="size-4" />
          {project.config?.branch || 'main'}
        </span>
        <span className="flex items-center gap-2 text-muted-foreground">
          <GitCommitHorizontal className="size-4" />
          <span className="font-mono text-xs">{sourceSnapshot?.commit || '38e20cf'}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="复制源码版本"
            onClick={() => copyText(sourceSnapshot?.commit || '38e20cf', '已复制示例源码版本')}
          >
            <Copy className="size-3" />
          </Button>
        </span>
        <Badge variant="secondary">源码版本 {versionLabel(sourceSnapshot?.version)}</Badge>
      </div>
      <Card className="gap-0 py-4">
        <CardContent className="space-y-3 px-4">
          <div className="flex items-center justify-between gap-2 overflow-x-auto pb-1">
            {lineage.map(({ label, description, Icon, item, conversationId }, index) => (
              <div key={item?.id || conversationId || 'git'} className="contents">
                {index > 0 && (
                  <ArrowRight className="size-4 shrink-0 self-center text-muted-foreground/50" />
                )}
                <Button
                  variant="ghost"
                  className="h-auto shrink-0 justify-start gap-3 p-3 text-left"
                  onClick={() =>
                    conversationId
                      ? navigate('chat', 'session', conversationId)
                      : item
                        ? choose(item.id)
                        : navigate('materials', 'repository')
                  }
                >
                  <span className="relative flex size-11 shrink-0 items-center justify-center rounded-full border bg-background/80">
                    <Icon className="size-5" />
                    {(item || index === 0) && (
                      <CheckCircle2 className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full bg-background text-emerald-600" />
                    )}
                  </span>
                  <span>
                    <span className="block text-sm font-medium">{label}</span>
                    <span
                      className="mt-1 block max-w-32 truncate text-xs font-normal text-muted-foreground"
                      title={description}
                    >
                      {description}
                    </span>
                  </span>
                </Button>
              </div>
            ))}
          </div>
          <p className="text-center text-xs text-muted-foreground">
            来源关系 · 任一步产物都可以单独读取或继续处理
          </p>
        </CardContent>
      </Card>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(310px,1fr)]">
        <div className="min-w-0 space-y-5">
          <Card className="gap-4 py-5">
            <CardHeader className="px-5">
              <CardTitle className="text-base">
                处理产物{' '}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {artifacts.length} 项
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 px-5">
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索产物名称…"
                    aria-label="搜索产物"
                    className="pl-9"
                  />
                </div>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger className="w-32 shrink-0" aria-label="筛选产物类型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部类型</SelectItem>
                    {Object.entries(TYPE_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="overflow-hidden rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/35">
                      <TableHead>名称</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>用途</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((item) => {
                      const Icon = TYPE_ICONS[item.type] || FileText
                      return (
                        <TableRow
                          key={item.id}
                          className={selected?.id === item.id ? 'bg-blue-50/65' : ''}
                        >
                          <TableCell className="max-w-64 py-2">
                            <Button
                              variant="ghost"
                              className="h-auto max-w-full justify-start px-1 py-2 font-normal"
                              onClick={() => choose(item.id)}
                            >
                              <Icon
                                className={`size-4 shrink-0 ${item.type === 'sanitized' ? 'text-blue-600' : 'text-muted-foreground'}`}
                              />
                              <span className="truncate">{item.name}</span>
                            </Button>
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                            {TYPE_LABELS[item.type]}
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                            {(item.usage || []).join(' · ') || '项目资料'}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-3 text-xs"
                              onClick={() => setPreview(item)}
                            >
                              查看
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {filtered.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="h-28 text-center text-sm text-muted-foreground"
                        >
                          {artifacts.length
                            ? '没有匹配的产物，请调整搜索或类型筛选。'
                            : '暂无产物，请先在仓库与源码中同步示例源码。'}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
          <Card className="gap-4 py-5">
            <CardHeader className="px-5">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">研发资料</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={() => navigate('materials', 'documents')}
                >
                  查看全部
                  <ArrowRight className="size-3" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="px-5">
              <div className="divide-y rounded-xl border bg-background/30 px-3">
                {(project.documents || []).slice(0, 3).map((document) => (
                  <div key={document.id} className="flex items-center gap-3 py-2.5">
                    <FileText className="size-4 shrink-0 text-blue-600" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {document.name || document.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {versionLabel(document.version)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-3 text-xs"
                      onClick={() =>
                        setPreview({
                          ...document,
                          name: document.name || document.title,
                          type: 'report',
                          files: [
                            {
                              name: document.name || document.title || 'document.md',
                              content:
                                document.content ||
                                document.body ||
                                '这份资料的正文可以在研发资料页面中编辑。',
                            },
                          ],
                        })
                      }
                    >
                      查看
                    </Button>
                  </div>
                ))}
                {!project.documents?.length && (
                  <p className="py-5 text-sm text-muted-foreground">
                    暂无研发资料，可在资料区添加。
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
        <Card className="gap-0 py-5 xl:sticky xl:top-5">
          {selected ? (
            <>
              <CardHeader className="border-b px-5 pb-5">
                <div className="flex flex-wrap items-center gap-2">
                  <SelectedIcon className="size-5 text-blue-600" />
                  <CardTitle className="min-w-0 flex-1 truncate text-base">
                    {selected.name}
                  </CardTitle>
                </div>
                <Badge
                  variant="secondary"
                  className="mt-2 border-emerald-200 bg-emerald-50 text-emerald-700"
                >
                  <Check className="size-3" />
                  示例内容已校验
                </Badge>
              </CardHeader>
              <CardContent className="space-y-5 px-5 pt-5">
                <dl className="grid grid-cols-[70px_minmax(0,1fr)] items-center gap-x-3 gap-y-4 text-sm">
                  <dt className="text-muted-foreground">来源</dt>
                  <dd>
                    {source ? (
                      <Button
                        variant="link"
                        className="h-auto max-w-full justify-start p-0 text-sm"
                        onClick={() => choose(source.id)}
                      >
                        <span className="truncate">{source.name}</span>
                        <ArrowRight className="size-3" />
                      </Button>
                    ) : sourceConversation ? (
                      <Button
                        variant="link"
                        className="h-auto max-w-full justify-start p-0 text-sm"
                        onClick={() => navigate('chat', 'session', sourceConversation.id)}
                      >
                        <MessageSquare className="size-3.5" />
                        <span className="truncate">Agent 对话</span>
                        <ArrowRight className="size-3" />
                      </Button>
                    ) : /^[a-f0-9]{7,40}$/i.test(selected.sourceId || '') ? (
                      'Git 仓库快照'
                    ) : selected.sourceKind === 'conversation' ? (
                      'Agent 对话（已归档）'
                    ) : (
                      '独立产物'
                    )}
                  </dd>
                  <dt className="text-muted-foreground">版本</dt>
                  <dd>{versionLabel(selected.version)}</dd>
                  <dt className="text-muted-foreground">处理规则</dt>
                  <dd className="leading-6">
                    {selected.rule ||
                      (selected.type === 'sanitized' ? '项目脱敏规则 v3' : '默认处理规则')}
                  </dd>
                  <dt className="text-muted-foreground">内容</dt>
                  <dd>{selectedFiles.length} 个示例文件</dd>
                  <dt className="text-muted-foreground">生成时间</dt>
                  <dd>{formattedTime(selected.createdAt)}</dd>
                </dl>
                <div className="border-t pt-5">
                  <h3 className="mb-3 text-sm font-medium">使用此产物</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPreview(selected)}>
                      <FileText className="size-3.5" />
                      查看内容
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => downloadArtifact(selected)}>
                      <ArrowDownToLine className="size-3.5" />
                      下载产物
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate('chat', 'new', selected.id)}
                    >
                      <MessageSquare className="size-3.5" />
                      带入问答
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGeneration({ inputId: selected.id, action: 'zip' })}
                    >
                      <FileArchive className="size-3.5" />
                      生成 ZIP
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 border-t pt-4">
                  <Button
                    variant="link"
                    className="h-auto p-0 text-xs text-blue-600"
                    onClick={() => setGeneration({ inputId: selected.id, action: 'sanitize' })}
                  >
                    继续处理
                    <ArrowRight className="size-3" />
                  </Button>
                  {report && (
                    <Button
                      variant="link"
                      className="h-auto p-0 text-xs text-blue-600"
                      onClick={() => setPreview(report)}
                    >
                      查看处理报告
                      <ArrowRight className="size-3" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </>
          ) : (
            <CardContent className="py-14 text-center text-sm text-muted-foreground">
              选择产物后查看详情
            </CardContent>
          )}
        </Card>
      </div>
      <ArtifactPreview artifact={preview} onClose={() => setPreview(null)} />
      <GenerationDialog
        open={Boolean(generation)}
        initialInputId={generation?.inputId}
        initialAction={generation?.action}
        onClose={() => setGeneration(null)}
        onCreated={(id) => {
          setGeneration(null)
          choose(id)
        }}
      />
    </div>
  )
}
