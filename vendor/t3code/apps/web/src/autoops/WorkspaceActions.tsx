import {
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ArrowDownToLineIcon, ChevronDownIcon, GitBranchIcon, PackageIcon } from 'lucide-react'
import { Alert, AlertDescription } from '~/components/ui/alert'
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
import type { WorkspaceBuildContext } from '../../../../../../autoops/contracts/workspaces.ts'
import { type WorkspaceOverview, type WorkspaceTask, type WorkspaceVersion } from './workspaces'

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus?: ComponentProps<typeof DialogPopup>['finalFocus']
  error?: string | null | undefined
  submissionNotice?: ReactNode
}

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
  label,
  busy,
  onCheck,
  onRetry,
  retryAvailable,
  paused = false,
}: {
  label: string | null
  retryAvailable: boolean
  paused?: boolean
  busy: boolean
  onCheck: () => Promise<boolean>
  onRetry: () => Promise<boolean>
}) {
  if (!label) return null
  return (
    <Alert variant="info" role="status">
      <AlertDescription>
        <p>
          {busy ? `正在${label}…` : paused ? '暂时无法获取结果，请重试。' : '正在确认操作结果…'}
        </p>
        {!busy ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void (retryAvailable ? onRetry() : onCheck())}
            >
              重试
            </Button>
          </div>
        ) : null}
      </AlertDescription>
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
  onGenerate: (
    sourceId: string,
    services: Service[],
    contexts: WorkspaceBuildContext[],
  ) => Promise<boolean>
}) {
  const [sourceId, setSourceId] = useState(initialSourceId ?? '')
  const [frontend, setFrontend] = useState(true)
  const [backend, setBackend] = useState(true)
  const contextId = useId()
  const [contextInputs, setContextInputs] = useState<
    Record<string, { root: string; workingDirectory: string }>
  >({})
  const [renderedOpen, setRenderedOpen] = useState(open)
  if (renderedOpen !== open) {
    setRenderedOpen(open)
    if (open) setSourceId(initialSourceId ?? '')
  }
  const source = internalVersions.find((version) => version.id === sourceId) ?? internalVersions[0]
  const contextFor = (service: Service) => {
    const standalone = source?.source.repositories.some((repository) => repository.path === service)
    return (
      contextInputs[`${source?.id}:${service}`] ?? {
        root: standalone ? service : '.',
        workingDirectory: '.',
      }
    )
  }
  const changeContext = (service: Service, field: 'root' | 'workingDirectory', value: string) =>
    setContextInputs((current) => ({
      ...current,
      [`${source?.id}:${service}`]: { ...contextFor(service), [field]: value },
    }))
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
                onGenerate(
                  source.id,
                  [
                    ...(frontend ? ['frontend' as const] : []),
                    ...(backend ? ['backend' as const] : []),
                  ],
                  (['frontend', 'backend'] as const)
                    .filter((service) => (service === 'frontend' ? frontend : backend))
                    .map((service) => ({ service, ...contextFor(service) })),
                ),
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
              {(['frontend', 'backend'] as const)
                .filter((service) => (service === 'frontend' ? frontend : backend))
                .map((service) => (
                  <div key={service} className="grid min-w-0 gap-2 sm:grid-cols-2">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${contextId}-${service}-root`}>
                        {service === 'frontend' ? '前端' : '后端'}构建上下文
                      </Label>
                      <Input
                        id={`${contextId}-${service}-root`}
                        value={contextFor(service).root}
                        disabled={unavailable}
                        onChange={(event) => changeContext(service, 'root', event.target.value)}
                      />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${contextId}-${service}-directory`}>包内构建目录</Label>
                      <Input
                        id={`${contextId}-${service}-directory`}
                        value={contextFor(service).workingDirectory}
                        disabled={unavailable}
                        onChange={(event) =>
                          changeContext(service, 'workingDirectory', event.target.value)
                        }
                      />
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
                  同步源码或更新外部工作区后，可在这里查看进度与结果。
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
                        {task.type === 'sync'
                          ? '同步源码'
                          : task.type === 'snapshot'
                            ? '历史资料快照'
                            : task.type === 'import'
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
