import { useId, useState, type ComponentProps, type ReactNode } from 'react'
import { PackageIcon } from 'lucide-react'
import { Alert } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Spinner } from '~/components/ui/spinner'
import type {
  WorkspaceDeploymentSourceInput,
  ProjectRepositoryConnection,
} from '../workspaceAuthoring'
import type { WorkspaceBuildContext } from '../workspaces'
import {
  DeploymentSourceFields,
  initialDeploymentSource,
  updateDeploymentSource,
  validDeploymentSourceDirectories,
} from './DeploymentSourceFields'

type SourceSelection = WorkspaceDeploymentSourceInput['sources'][number]

/** 部署来源在提交时固定；此处覆盖不修改工作区的日常跟踪配置。 */
export function DeploymentSourcesDialog({
  projectId,
  onAccessDenied,
  open,
  onOpenChange,
  finalFocus,
  sources,
  disabled,
  error,
  submissionNotice,
  pendingRequest = false,
  canRetryPending = false,
  onGenerate,
}: {
  projectId?: string | undefined
  onAccessDenied?: ((cause: unknown) => void) | undefined
  open: boolean
  onOpenChange: (value: boolean) => void
  finalFocus: ComponentProps<typeof DialogPopup>['finalFocus']
  sources: ProjectRepositoryConnection[]
  disabled: boolean
  error: string | null
  submissionNotice: ReactNode
  pendingRequest?: boolean
  canRetryPending?: boolean
  onGenerate: (sources: SourceSelection[], contexts: WorkspaceBuildContext[]) => Promise<boolean>
}) {
  const id = useId()
  const [selection, setSelection] = useState<Record<string, SourceSelection>>({})
  const [contexts, setContexts] = useState<WorkspaceBuildContext[]>([])
  const [wasOpen, setWasOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open && !pendingRequest) {
      setSelection(
        Object.fromEntries(
          sources.map((source, index) => [
            source.id,
            initialDeploymentSource(source, index, sources.length),
          ]),
        ),
      )
      setContexts([
        {
          service: 'frontend',
          root: sources.length === 1 ? 'repository' : '.',
          workingDirectory: '.',
        },
      ])
      setLocalError(null)
    }
  }
  const unavailable = disabled || pending || (pendingRequest && canRetryPending)
  const selectSource = (source: ProjectRepositoryConnection, checked: boolean) =>
    setSelection((current) => {
      const next = { ...current }
      if (checked)
        next[source.id] = initialDeploymentSource(
          source,
          sources.findIndex((item) => item.id === source.id),
          sources.length,
        )
      else delete next[source.id]
      return next
    })
  const updateSource = (sourceId: string, change: Partial<SourceSelection>) =>
    setSelection((current) => ({
      ...current,
      [sourceId]: updateDeploymentSource(current[sourceId]!, change),
    }))
  const updateContext = (
    service: WorkspaceBuildContext['service'],
    field: 'root' | 'workingDirectory',
    value: string,
  ) =>
    setContexts((current) =>
      current.map((context) =>
        context.service === service ? { ...context, [field]: value } : context,
      ),
    )
  const submit = async () => {
    if (unavailable) return
    const chosen = Object.values(selection)
    if (!chosen.length || !contexts.length) {
      setLocalError('请选择至少一个源码仓库和打包内容。')
      return
    }
    if (chosen.some((source) => source.refKind !== 'default' && !source.ref?.trim())) {
      setLocalError('请填写所选分支、标签或完整提交 SHA。')
      return
    }
    if (chosen.some((source) => !validDeploymentSourceDirectories(source))) {
      setLocalError('请填写有效的部署挂载目录和仓库子目录。')
      return
    }
    setPending(true)
    setLocalError(null)
    try {
      if (await onGenerate(chosen, contexts)) onOpenChange(false)
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : '提交未完成，请核对原请求。')
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value)
      }}
    >
      <DialogPopup className="sm:max-w-2xl" finalFocus={finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
            )
              event.preventDefault()
          }}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>生成部署包</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <DeploymentSourceFields
              projectId={projectId}
              onAccessDenied={onAccessDenied}
              sources={sources}
              selection={selection}
              disabled={unavailable}
              onSelect={selectSource}
              onUpdate={updateSource}
            />
            <fieldset className="min-w-0 space-y-3" disabled={unavailable}>
              <legend className="mb-2 text-sm font-medium">打包内容</legend>
              {(['frontend', 'backend'] as const).map((service) => {
                const context = contexts.find((entry) => entry.service === service)
                const label = service === 'frontend' ? '前端' : '后端'
                return (
                  <div key={service} className="space-y-2">
                    <Label>
                      <Checkbox
                        checked={!!context}
                        disabled={unavailable}
                        onCheckedChange={(checked) =>
                          setContexts((current) =>
                            checked
                              ? [
                                  ...current,
                                  {
                                    service,
                                    root:
                                      (sources.length === 1
                                        ? selection[sources[0]!.id]?.mountPath
                                        : undefined) ?? '.',
                                    workingDirectory: '.',
                                  },
                                ]
                              : current.filter((entry) => entry.service !== service),
                          )
                        }
                      />
                      {label}源码包
                    </Label>
                    {context ? (
                      <div className="grid min-w-0 gap-2 pl-6 sm:grid-cols-2">
                        <div className="min-w-0 space-y-1">
                          <Label htmlFor={`${id}-${service}-root`}>构建上下文</Label>
                          <Input
                            id={`${id}-${service}-root`}
                            value={context.root}
                            disabled={unavailable}
                            onChange={(event) => updateContext(service, 'root', event.target.value)}
                          />
                        </div>
                        <div className="min-w-0 space-y-1">
                          <Label htmlFor={`${id}-${service}-cwd`}>包内构建目录</Label>
                          <Input
                            id={`${id}-${service}-cwd`}
                            value={context.workingDirectory}
                            disabled={unavailable}
                            onChange={(event) =>
                              updateContext(service, 'workingDirectory', event.target.value)
                            }
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </fieldset>
            <p className="text-xs text-muted-foreground">
              提交后固定各仓库的实际 SHA。“.”
              表示根目录，构建上下文应包含共享依赖与锁文件。上传的产品、运维等资料不进入部署包。
            </p>
            {submissionNotice}
            {pendingRequest && !canRetryPending ? (
              <p className="text-xs text-muted-foreground">
                原请求结果尚未确认。页面未保存完整来源，请重新填写原仓库引用与构建上下文，再核对并重试原请求。
              </p>
            ) : null}
            {(localError ?? error) ? <Alert variant="error">{localError ?? error}</Alert> : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={unavailable || !Object.keys(selection).length || !contexts.length}
            >
              {pending ? <Spinner size="sm" /> : <PackageIcon />}
              {pending ? '正在提交…' : pendingRequest ? '核对并重试原请求' : '生成部署包'}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
