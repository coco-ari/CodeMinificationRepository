import { Copy, FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkbench } from './store'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
export { Button, Badge, Card, CardContent, CardHeader, CardTitle, toast }
export { Input } from '@/components/ui/input'
export { Textarea } from '@/components/ui/textarea'
export { Label } from '@/components/ui/label'
export { Switch } from '@/components/ui/switch'
export { Checkbox } from '@/components/ui/checkbox'
export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
export { Progress } from '@/components/ui/progress'
export function Picker({ value, onChange, options, label, id, disabled, className }) {
  return (
    <NativeSelect
      id={id}
      aria-label={label}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className}
    >
      {options.map((o) => (
        <NativeSelectOption key={o.value} value={o.value}>
          {o.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
}
export function PageHeader({ title, children }) {
  const { route, project, navigate } = useWorkbench()
  const path = route.split('?')[0].split('/')[3]
  const materialTabs = [
    ['documents', '研发资料'],
    ['repositories', '仓库与源码'],
    ['artifacts', '处理产物'],
    ['resources', '环境与资源'],
  ]
  return (
    <>
      <div className="wb-page-heading">
        <h1>{title}</h1>
        <div className="wb-row">{children}</div>
      </div>
      {project && materialTabs.some(([key]) => key === path) && (
        <Tabs
          value={path}
          onValueChange={(key) => navigate(`/p/${project.id}/${key}`)}
          className="wb-workspace-tabs"
        >
          <TabsList variant="line" aria-label="资料与配置">
            {materialTabs.map(([key, label]) => (
              <TabsTrigger key={key} value={key}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
    </>
  )
}
export function DemoScenarios({ children, label = '演示场景' }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <FlaskConical className="size-3.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-32px)]"
        onClick={(event) => {
          if (event.target.closest('button[data-ui="button"]')) setOpen(false)
        }}
      >
        <div className="wb-stack">{children}</div>
      </PopoverContent>
    </Popover>
  )
}
export function Panel({ title, actions, children, className = '', ...props }) {
  return (
    <Card className={`wb-panel ${className}`} {...props}>
      {(title || actions) && (
        <CardHeader className="wb-panel-header">
          <CardTitle>{title}</CardTitle>
          <div className="wb-row">{actions}</div>
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </Card>
  )
}
export function Field({ label, children, hint }) {
  return (
    <div className="wb-field">
      <label>
        {label}
        {children}
      </label>
      {hint && <p className="wb-muted text-xs">{hint}</p>}
    </div>
  )
}
export function Modal({ title, open, onClose, children, footer, description }) {
  return (
    <Dialog open={Boolean(open)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="wb-modal">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? '' : 'sr-only'}>
            {description || title}
          </DialogDescription>
        </DialogHeader>
        <div className="wb-modal-body">{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}
export function Confirm({
  title,
  open,
  onClose,
  onConfirm,
  children,
  confirmLabel = '确认',
  danger = false,
}) {
  return (
    <Modal
      title={title}
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant={danger ? 'destructive' : 'default'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
const labels = {
  active: '运行中',
  running: '进行中',
  processing: '处理中',
  deleted: '已删除',
  success: '成功',
  ready: '就绪',
  failed: '失败',
  rolledback: '已自动回退',
  unknown: '结果待核查',
  stopped: '已停止',
  online: '在线',
  offline: '离线',
  connected: '已连接',
  untested: '未连接',
  waiting: '等待确认',
  queued: '排队中',
  unassigned: '未分配',
  assigned: '已分配',
}
export function Status({ value }) {
  return (
    <Badge variant="outline" className={`wb-status wb-status-${value}`}>
      <span className="wb-dot" />
      {labels[value] || value}
    </Badge>
  )
}
export function Empty({ children }) {
  return <div className="wb-empty">{children || '暂无数据'}</div>
}
export function CopyButton({ value, label = '复制提交号' }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={() =>
        navigator.clipboard
          .writeText(value)
          .then(() => toast.success('已复制'))
          .catch(() => toast.error('复制失败'))
      }
    >
      <Copy className="size-3.5" />
    </Button>
  )
}
export function download(name, content, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const url =
    typeof content === 'string' && content.startsWith('data:') ? content : URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name.replaceAll('/', '-')
  a.click()
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 1000)
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
export function createZip(files) {
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
export function downloadArtifact(a) {
  if (a.deleted) return toast.error('该产物已删除')
  if (a.dataUrl) return download(a.name, a.dataUrl, a.mime)
  if (a.type === 'zip' || (a.files?.length && ['source', 'sanitized', 'stripped'].includes(a.type)))
    return download(a.name.endsWith('.zip') ? a.name : a.name + '.zip', createZip(a.files))
  return download(
    a.name,
    a.content ?? a.files?.[0]?.content ?? '',
    a.mime || 'text/plain;charset=utf-8',
  )
}
