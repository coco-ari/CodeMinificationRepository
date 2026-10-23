import { useId, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowDownToLineIcon,
  ChevronDownIcon,
  GitBranchIcon,
  PackageIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react'
import { Alert } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '~/components/ui/collapsible'
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '~/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Spinner } from '~/components/ui/spinner'
import { formatBytes } from '~/lib/formatBytes'
import { randomUUID } from '~/lib/utils'
import type { WorkspaceBuildContext } from '../../../../../../autoops/contracts/workspaces.ts'
import {
  workspaceFileDownloadUrl,
  type WorkspaceOverview,
  type WorkspaceTask,
  type WorkspaceVersion,
} from './workspaces'

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus?: ComponentProps<typeof DialogPopup>['finalFocus']
  error?: string | null | undefined
  submissionNotice?: ReactNode
}

type RedactionRule = { find: string; replace: string }
type Service = 'frontend' | 'backend'

const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN')
const taskActive = (task: WorkspaceTask) => task.status === 'queued' || task.status === 'running'
const errorLabel = (cause: unknown) =>
  cause instanceof Error ? cause.message : '操作失败，请重试。'

function repositoryUrlError(value: string) {
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol !== 'https:' || parsed.username || parsed.password
      ? '请填写不带账号密码的 HTTPS 仓库地址。'
      : null
  } catch {
    return '请填写有效的 HTTPS 仓库地址。'
  }
}

function preventCompositionSubmit(event: KeyboardEvent<HTMLFormElement>) {
  if (
    event.key === 'Enter' &&
    (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
  ) {
    event.preventDefault()
  }
}

function useWorkspaceSubmit() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const submit = async (action: () => Promise<boolean>, onSuccess?: () => void) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setPending(true)
    setError(null)
    try {
      if (await action()) onSuccess?.()
    } catch (cause) {
      setError(errorLabel(cause))
    }
    submittingRef.current = false
    setPending(false)
  }
  return { pending, error, setError, submit }
}

export function WorkspaceSubmissionNotice({
  label, busy, onCheck, onRetry, retryAvailable,
}: {
  label: string | null
  retryAvailable: boolean
  busy: boolean
  onCheck: () => Promise<boolean>
  onRetry: () => Promise<boolean>
}) {
  if (!label) return null
  return (
    <Alert variant="warning" role="status">
      <div className="flex min-w-0 flex-col gap-2">
        <p>上次{label}的结果尚未确认。先核对任务；重试会继续使用原输入，关闭弹窗不会取消后台任务。</p>
        {!retryAvailable ? <p>刷新后需重新填写原输入并提交，系统会先核对上次任务。</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onCheck()}>
            核对任务
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !retryAvailable} onClick={() => void onRetry()}>
            使用原请求重试
          </Button>
        </div>
      </div>
    </Alert>
  )
}

function OperationError({ error }: { error: string | null | undefined }) {
  return error ? (
    <Alert variant="error" role="alert">
      {error}
    </Alert>
  ) : null
}

function SourceVersionPicker({
  versions,
  value,
  onChange,
  disabled,
}: {
  versions: readonly WorkspaceVersion[]
  value: string
  onChange: (value: string) => void
  disabled: boolean
}) {
  const selected = versions.find((version) => version.id === value)
  return (
    <div className="flex flex-col gap-1.5">
      <Label>来源内部版本</Label>
      <Select
        value={selected?.id ?? ''}
        disabled={disabled || versions.length === 0}
        onValueChange={(next) => {
          if (typeof next === 'string') onChange(next)
        }}
      >
        <SelectTrigger aria-label="来源内部版本">
          <SelectValue>{selected?.name ?? '暂无可用版本'}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {versions.map((version) => (
            <SelectItem key={version.id} value={version.id}>
              {version.name}
              {version.isExample ? ' · 示例项目' : ''}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  )
}

export function WorkspaceImportDialog({
  open,
  onOpenChange,
  finalFocus,
  disabled,
  limits,
  onImport,
  error,
  submissionNotice,
}: DialogProps & {
  disabled: boolean
  limits: WorkspaceOverview['import'] | undefined
  onImport: (url: string, branch: string) => Promise<boolean>
}) {
  const id = useId()
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const operation = useWorkspaceSubmit()
  const unavailable = disabled || operation.pending || limits?.supported !== true
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!operation.pending) onOpenChange(next)
      }}
    >
      <DialogPopup className="sm:max-w-xl" finalFocus={finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onKeyDown={preventCompositionSubmit}
          onSubmit={(event) => {
            event.preventDefault()
            if (unavailable) return
            const validationError = repositoryUrlError(url)
            if (validationError) {
              operation.setError(validationError)
              return
            }
            void operation.submit(
              () => onImport(url.trim(), branch.trim()),
              () => onOpenChange(false),
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>导入仓库</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-repository`}>HTTPS 仓库地址</Label>
              <Input
                id={`${id}-repository`}
                type="url"
                placeholder="https://github.com/组织/项目.git"
                required
                value={url}
                onValueChange={setUrl}
                disabled={unavailable}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-branch`}>分支</Label>
              <Input
                id={`${id}-branch`}
                value={branch}
                onValueChange={setBranch}
                required
                disabled={unavailable}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <p className="text-muted-foreground text-xs">
              支持{limits?.hosts.join('、') || '公开代码托管平台'}的公开 HTTPS Git 仓库。保留目录与
              Git 信息，并固定所选分支的提交。
              {limits
                ? `导入上限 ${formatBytes(limits.maxBytes)}、${limits.maxFiles.toLocaleString('zh-CN')} 个文件。`
                : ''}
            </p>
            {limits?.supported === false ? (
              <Alert variant="warning">当前服务未开放仓库导入。</Alert>
            ) : null}
            {submissionNotice}
            <OperationError error={operation.error ?? error} />
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={operation.pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={unavailable || !url.trim() || !branch.trim()}>
              {operation.pending ? <Spinner size="sm" /> : <GitBranchIcon />}
              {operation.pending ? '正在导入…' : '导入并保存版本'}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function ExternalWorkspaceDialog({
  open,
  onOpenChange,
  finalFocus,
  internalVersions,
  initialSourceId,
  disabled,
  onGenerate,
  error,
  submissionNotice,
}: DialogProps & {
  internalVersions: readonly WorkspaceVersion[]
  initialSourceId?: string | undefined
  disabled: boolean
  onGenerate: (sourceId: string, rules: RedactionRule[]) => Promise<boolean>
}) {
  const [sourceId, setSourceId] = useState(initialSourceId ?? '')
  const [rules, setRules] = useState<Array<RedactionRule & { id: string }>>([])
  const [renderedOpen, setRenderedOpen] = useState(open)
  if (renderedOpen !== open) {
    setRenderedOpen(open)
    if (open) setSourceId(initialSourceId ?? '')
  }
  const source = internalVersions.find((version) => version.id === sourceId) ?? internalVersions[0]
  const operation = useWorkspaceSubmit()
  const unavailable = disabled || operation.pending || !source
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!operation.pending) onOpenChange(next)
      }}
    >
      <DialogPopup className="sm:max-w-xl" finalFocus={finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onKeyDown={preventCompositionSubmit}
          onSubmit={(event) => {
            event.preventDefault()
            if (unavailable || !source) return
            void operation.submit(
              () =>
                onGenerate(
                  source.id,
                  rules.filter((rule) => rule.find).map(({ find, replace }) => ({ find, replace })),
                ),
              () => onOpenChange(false),
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>生成外部版本</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <SourceVersionPicker
              versions={internalVersions}
              value={source?.id ?? ''}
              onChange={setSourceId}
              disabled={disabled || operation.pending}
            />
            <p className="text-muted-foreground text-xs">
              从内部固定版本去除所有 Git
              历史并脱敏，保持目录结构。原始工作区不会被修改；生成后需检查并发布。
            </p>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <Label>额外脱敏规则</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={unavailable || rules.length >= 30}
                  onClick={() =>
                    setRules((previous) => [
                      ...previous,
                      { id: randomUUID(), find: '', replace: '' },
                    ])
                  }
                >
                  <PlusIcon />
                  添加替换
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                平台凭证与私钥规则始终生效。最多添加 30 条文本替换。
              </p>
              {rules.map((rule, index) => (
                <div key={rule.id} className="flex items-start gap-2">
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                    <Input
                      aria-label={`规则 ${index + 1} 原始文本`}
                      placeholder="需要替换的文本"
                      required
                      value={rule.find}
                      disabled={unavailable}
                      onValueChange={(find) =>
                        setRules((previous) =>
                          previous.map((entry) =>
                            entry.id === rule.id ? { ...entry, find } : entry,
                          ),
                        )
                      }
                    />
                    <Input
                      aria-label={`规则 ${index + 1} 替换文本`}
                      placeholder="替换为（可留空）"
                      value={rule.replace}
                      disabled={unavailable}
                      onValueChange={(replace) =>
                        setRules((previous) =>
                          previous.map((entry) =>
                            entry.id === rule.id ? { ...entry, replace } : entry,
                          ),
                        )
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除规则 ${index + 1}`}
                    disabled={unavailable}
                    onClick={() =>
                      setRules((previous) => previous.filter((entry) => entry.id !== rule.id))
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
            </div>
            {submissionNotice}
            <OperationError error={operation.error ?? error} />
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={operation.pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={unavailable}>
              {operation.pending ? <Spinner size="sm" /> : <ShieldCheckIcon />}
              {operation.pending ? '正在提交…' : '生成外部版本'}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function WorkspacePackagesDialog({
  open,
  onOpenChange,
  finalFocus,
  internalVersions,
  initialSourceId,
  disabled,
  onGenerate,
  error,
  submissionNotice,
}: DialogProps & {
  internalVersions: readonly WorkspaceVersion[]
  initialSourceId?: string | undefined
  disabled: boolean
  onGenerate: (sourceId: string, services: Service[], contexts: WorkspaceBuildContext[]) => Promise<boolean>
}) {
  const [sourceId, setSourceId] = useState(initialSourceId ?? '')
  const [frontend, setFrontend] = useState(true)
  const [backend, setBackend] = useState(true)
  const contextId = useId()
  const [contextInputs, setContextInputs] = useState<Record<string, { root: string; workingDirectory: string }>>({})
  const [renderedOpen, setRenderedOpen] = useState(open)
  if (renderedOpen !== open) {
    setRenderedOpen(open)
    if (open) setSourceId(initialSourceId ?? '')
  }
  const source = internalVersions.find((version) => version.id === sourceId) ?? internalVersions[0]
  const contextFor = (service: Service) => {
    const standalone = source?.source.repositories.some((repository) => repository.path === service)
    return contextInputs[`${source?.id}:${service}`] ?? { root: standalone ? service : '.', workingDirectory: '.' }
  }
  const changeContext = (service: Service, field: 'root' | 'workingDirectory', value: string) =>
    setContextInputs((current) => ({ ...current, [`${source?.id}:${service}`]: { ...contextFor(service), [field]: value } }))
  const operation = useWorkspaceSubmit()
  const unavailable = disabled || operation.pending || !source
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!operation.pending) onOpenChange(next)
      }}
    >
      <DialogPopup className="sm:max-w-xl" finalFocus={finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onKeyDown={preventCompositionSubmit}
          onSubmit={(event) => {
            event.preventDefault()
            if (unavailable || !source || (!frontend && !backend)) return
            void operation.submit(
              () =>
                onGenerate(source.id, [
                  ...(frontend ? ['frontend' as const] : []),
                  ...(backend ? ['backend' as const] : []),
                ], (['frontend', 'backend'] as const).filter((service) => service === 'frontend' ? frontend : backend).map((service) => ({ service, ...contextFor(service) }))),
              () => onOpenChange(false),
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>生成部署包</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <SourceVersionPicker
              versions={internalVersions}
              value={source?.id ?? ''}
              onChange={setSourceId}
              disabled={disabled || operation.pending}
            />
            <div className="flex flex-col gap-3">
              <Label>打包内容</Label>
              <Label>
                <Checkbox checked={frontend} disabled={unavailable} onCheckedChange={setFrontend} />
                前端源码包
              </Label>
              <Label>
                <Checkbox checked={backend} disabled={unavailable} onCheckedChange={setBackend} />
                后端源码包
              </Label>
              {(['frontend', 'backend'] as const).filter((service) => service === 'frontend' ? frontend : backend).map((service) => (
                <div key={service} className="grid min-w-0 gap-2 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`${contextId}-${service}-root`}>{service === 'frontend' ? '前端' : '后端'}构建上下文</Label>
                    <Input id={`${contextId}-${service}-root`} value={contextFor(service).root} disabled={unavailable} onChange={(event) => changeContext(service, 'root', event.target.value)} />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`${contextId}-${service}-directory`}>包内构建目录</Label>
                    <Input id={`${contextId}-${service}-directory`} value={contextFor(service).workingDirectory} disabled={unavailable} onChange={(event) => changeContext(service, 'workingDirectory', event.target.value)} />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              “.” 表示根目录。构建上下文应包含共享依赖和锁文件，包内构建目录相对此上下文。排除 Git
              和缓存。下载后传输到对应服务器解压部署。
            </p>
            {submissionNotice}
            <OperationError error={operation.error ?? error} />
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={operation.pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={unavailable || (!frontend && !backend)}>
              {operation.pending ? <Spinner size="sm" /> : <PackageIcon />}
              {operation.pending ? '正在提交…' : '生成部署包'}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function WorkspaceVersionDialog({
  open,
  onOpenChange,
  finalFocus,
  version,
}: Omit<DialogProps, 'error'> & { version: WorkspaceVersion | undefined }) {
  if (!version) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>版本详情</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">版本</dt>
            <dd className="break-words">{version.name}</dd>
            <dt className="text-muted-foreground">类型</dt>
            <dd>
              {version.type === 'internal' ? '内部工作区' : '外部工作区'}
              {version.isExample ? ' · 示例项目' : ''}
            </dd>
            <dt className="text-muted-foreground">状态</dt>
            <dd>
              <Badge
                variant={
                  version.status === 'published'
                    ? 'success'
                    : version.status === 'pending_review'
                      ? 'warning'
                      : 'error'
                }
              >
                {version.status === 'published'
                  ? '可用'
                  : version.status === 'pending_review'
                    ? '待复核'
                    : '失败'}
              </Badge>
            </dd>
            <dt className="text-muted-foreground">文件</dt>
            <dd>
              {version.fileCount.toLocaleString('zh-CN')} 个 · {formatBytes(version.byteLength)}
            </dd>
            <dt className="text-muted-foreground">创建时间</dt>
            <dd>
              <time dateTime={version.createdAt}>{dateLabel(version.createdAt)}</time>
            </dd>
          </dl>
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              <ChevronDownIcon />
              完整版本信息
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <dl className="mt-3 space-y-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">版本标识</dt>
                  <dd className="mt-1 break-all font-mono">{version.id}</dd>
                </div>
                {version.sourceVersionId ? (
                  <div>
                    <dt className="text-muted-foreground">来源内部版本</dt>
                    <dd className="mt-1 break-all font-mono">{version.sourceVersionId}</dd>
                  </div>
                ) : null}
                {version.source.repositories.map((repository) => (
                  <div key={repository.path}>
                    <dt className="break-all text-muted-foreground">
                      {repository.path || '.'} · 提交
                    </dt>
                    <dd className="mt-1 break-all font-mono">{repository.commit}</dd>
                  </div>
                ))}
                <div>
                  <dt className="text-muted-foreground">内容校验 SHA-256</dt>
                  <dd className="mt-1 break-all font-mono">{version.source.contentHash}</dd>
                </div>
              </dl>
            </CollapsiblePanel>
          </Collapsible>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

export function WorkspaceTasksDialog({
  open,
  onOpenChange,
  finalFocus,
  tasks,
  busy,
  onCancel,
  error,
}: DialogProps & {
  tasks: readonly WorkspaceTask[]
  busy: boolean
  onCancel: (id: string) => Promise<boolean>
}) {
  const operation = useWorkspaceSubmit()
  const ordered = [...tasks.filter(taskActive), ...tasks.filter((task) => !taskActive(task))]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>任务记录</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <OperationError error={operation.error ?? error} />
          {ordered.length === 0 ? (
            <Empty size="compact">
              <EmptyHeader>
                <EmptyTitle>暂无任务记录</EmptyTitle>
                <EmptyDescription>
                  导入仓库、生成工作区或部署包后，可在这里查看进度与结果。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="divide-y" aria-live="polite">
              {ordered.map((task) => (
                <div key={task.id} className="flex items-start gap-3 py-3">
                  {taskActive(task) ? (
                    <div className="pt-0.5">
                      <Spinner size="sm" />
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {task.type === 'snapshot' ? '生成内部版本' : task.type === 'import'
                          ? '仓库导入'
                          : task.type === 'external'
                            ? '外部工作区生成'
                            : task.type === 'packages'
                              ? '部署包生成'
                              : '工作区任务'}
                      </span>
                      <Badge
                        size="sm"
                        variant={
                          task.status === 'completed'
                            ? 'success'
                            : task.status === 'failed'
                              ? 'error'
                              : 'secondary'
                        }
                      >
                        {
                          (
                            {
                              queued: '等待中',
                              running: '执行中',
                              completed: '已完成',
                              failed: '失败',
                              interrupted: '已中断',
                            } as const
                          )[task.status]
                        }
                      </Badge>
                    </div>
                    <p
                      className={
                        task.status === 'failed'
                          ? 'mt-1 break-words text-destructive text-xs'
                          : 'mt-1 break-words text-muted-foreground text-xs'
                      }
                    >
                      {task.error ?? task.message}
                    </p>
                    <time
                      className="mt-1 block text-muted-foreground text-xs"
                      dateTime={task.createdAt}
                    >
                      {dateLabel(task.createdAt)}
                    </time>
                  </div>
                  {taskActive(task) ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy || operation.pending}
                      onClick={() => {
                        void operation.submit(() => onCancel(task.id))
                      }}
                    >
                      取消
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

export function WorkspaceReviewDialog({
  open,
  onOpenChange,
  finalFocus,
  projectId,
  version,
  busy,
  onPublish,
  error,
}: DialogProps & {
  projectId: string
  version: WorkspaceVersion | undefined
  busy: boolean
  onPublish: (confirmed: string[], excluded: string[]) => Promise<boolean>
}) {
  const [decisionVersion, setDecisionVersion] = useState(version?.id)
  const [decisions, setDecisions] = useState<Record<string, 'keep' | 'exclude'>>({})
  if (decisionVersion !== version?.id) {
    setDecisionVersion(version?.id)
    setDecisions({})
  }
  const operation = useWorkspaceSubmit()
  if (!version) return null
  const report = version.report
  const pendingFiles = report?.pendingFiles ?? []
  const complete = pendingFiles.every((file) => decisions[file.path])
  const canPublish = version.status === 'pending_review' && Boolean(report) && complete
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!operation.pending) onOpenChange(next)
      }}
    >
      <DialogPopup className="sm:max-w-2xl" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>脱敏复核</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p className="break-words text-sm font-medium">{version.name}</p>
          {report ? (
            <>
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground text-xs">移除 Git 元数据</dt>
                  <dd className="mt-1 tabular-nums">{report.removedGitEntries} 处</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">文本替换</dt>
                  <dd className="mt-1 tabular-nums">{report.replacements} 次</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">排除文件</dt>
                  <dd className="mt-1 tabular-nums">{report.excludedFiles.length} 个</dd>
                </div>
              </dl>
              {report.excludedFiles.length ? (
                <Collapsible>
                  <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                    <ChevronDownIcon />
                    查看排除的文件
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <ul className="mt-2 space-y-1 font-mono text-xs">
                      {report.excludedFiles.map((path) => (
                        <li className="break-all" key={path}>
                          {path}
                        </li>
                      ))}
                    </ul>
                  </CollapsiblePanel>
                </Collapsible>
              ) : null}
              {version.status === 'pending_review' ? (
                <>
                  <Alert variant="warning">
                    发布前需要人工复核。平台无法检查以下文件的全部内容，请下载检查后逐个选择保留；无法确认时请排除。
                  </Alert>
                  <div className="divide-y">
                    {pendingFiles.map((file) => (
                      <div key={file.path} className="flex flex-col gap-2 py-3">
                        <div className="min-w-0">
                          <p className="break-all font-mono text-xs">{file.path}</p>
                          <p className="mt-1 break-words text-muted-foreground text-xs">
                            {file.reason}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            render={
                              <a
                                href={workspaceFileDownloadUrl(projectId, version.id, file.path)}
                                download
                              />
                            }
                          >
                            <ArrowDownToLineIcon />
                            下载检查
                          </Button>
                          <div className="min-w-0 flex-1 sm:max-w-52">
                            <Select
                              value={decisions[file.path] ?? 'pending'}
                              disabled={busy || operation.pending}
                              onValueChange={(next) => {
                                if (next === 'keep' || next === 'exclude')
                                  setDecisions((previous) => ({ ...previous, [file.path]: next }))
                              }}
                            >
                              <SelectTrigger size="sm" aria-label={`复核 ${file.path}`}>
                                <SelectValue>
                                  {decisions[file.path] === 'keep'
                                    ? '已检查，保留'
                                    : decisions[file.path] === 'exclude'
                                      ? '排除文件'
                                      : '请选择处理方式'}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectPopup>
                                <SelectItem value="keep">已检查，保留</SelectItem>
                                <SelectItem value="exclude">排除文件</SelectItem>
                              </SelectPopup>
                            </Select>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-muted-foreground text-xs" aria-live="polite">
                    已处理 {pendingFiles.filter((file) => decisions[file.path]).length} /{' '}
                    {pendingFiles.length} 个待复核文件
                  </p>
                </>
              ) : version.status === 'published' ? (
                <p className="text-muted-foreground text-sm">
                  此版本已通过检查并固定保存，可用于全新的外部工作区对话。
                </p>
              ) : (
                <Alert variant="error">此版本生成失败，不能发布。请在任务记录中查看原因。</Alert>
              )}
            </>
          ) : (
            <Empty size="compact">
              <EmptyHeader>
                <EmptyTitle>暂无脱敏报告</EmptyTitle>
                <EmptyDescription>完成外部工作区生成后，可查看检查结果。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <OperationError error={operation.error ?? error} />
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={operation.pending}
            onClick={() => onOpenChange(false)}
          >
            {version.status === 'pending_review' ? '取消' : '关闭'}
          </Button>
          {version.status === 'pending_review' ? (
            <Button
              disabled={busy || operation.pending || !canPublish}
              onClick={() => {
                if (!canPublish || busy) return
                void operation.submit(
                  () =>
                    onPublish(
                      pendingFiles
                        .filter((file) => decisions[file.path] === 'keep')
                        .map((file) => file.path),
                      pendingFiles
                        .filter((file) => decisions[file.path] === 'exclude')
                        .map((file) => file.path),
                    ),
                  () => onOpenChange(false),
                )
              }}
            >
              {operation.pending ? <Spinner size="sm" /> : <ShieldCheckIcon />}
              {operation.pending ? '正在发布…' : '确认并发布版本'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
