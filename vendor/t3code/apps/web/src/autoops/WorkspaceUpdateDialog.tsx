import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from 'react'
import { SettingsGroup } from '~/components/settings/SettingsGroup'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { Alert, AlertDescription } from '~/components/ui/alert'
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
import { AutoOpsRequestError, isAutoOpsAccessError } from './apiClient'
import { readAutoOpsHost, subscribeAutoOpsHost } from './hostSnapshot'
import {
  loadWorkspaceUpdates,
  prepareWorkspaceUpdate,
  readPendingWorkspaceUpdate,
  recoverWorkspaceUpdate,
  submitWorkspaceUpdate,
  type PendingWorkspaceUpdate,
  type WorkspaceUpdateOverview,
  type WorkspaceUpdateScope,
  type WorkspaceUpdateWriteResult,
} from './workspaceUpdates'

type Props = {
  projectId: string
  scope: WorkspaceUpdateScope
  open: boolean
  onOpenChange(open: boolean): void
  finalFocus: ComponentProps<typeof DialogPopup>['finalFocus']
  onChanged(): void
  onAccessDenied(cause: unknown): void
}
const failure = (cause: unknown) =>
  cause instanceof Error ? cause.message : '更新设置读取失败，请重试。'
const outcomes = {
  completed: '更新完成',
  pending_review: '等待人工复核',
  failed: '更新失败',
  rejected: '更新未被接受',
}
function displayTime(value: string | null | undefined, timezone: string) {
  if (!value) return '未安排'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value))
  } catch {
    return value
  }
}
export function WorkspaceUpdateDialog(props: Props) {
  const host = useSyncExternalStore(subscribeAutoOpsHost, readAutoOpsHost, readAutoOpsHost)
  const project = host?.projects.find((value) => value.id === props.projectId)
  const allowed =
    project?.capabilities?.['workspace.manage'] === true &&
    (props.scope === 'internal' || project.capabilities?.['workspace.external.publish'] === true)
  return (
    <WorkspaceUpdateEditor
      key={`${host?.principal.id}:${props.projectId}:${props.scope}:${allowed}`}
      {...props}
      allowed={allowed}
    />
  )
}
function WorkspaceUpdateEditor({
  projectId,
  scope,
  open,
  onOpenChange,
  finalFocus,
  onChanged,
  onAccessDenied,
  allowed,
}: Props & { allowed: boolean }) {
  const formId = useId(),
    intervalId = useId(),
    timezoneId = useId(),
    enableId = useId(),
    confirmId = useId(),
    errorId = useId()
  const [overview, setOverview] = useState<WorkspaceUpdateOverview | null>(null)
  const [enabled, setEnabled] = useState(false),
    [interval, setInterval] = useState('60'),
    [timezone, setTimezone] = useState('Asia/Shanghai')
  const [confirmed, setConfirmed] = useState(false),
    [activity, setActivity] = useState<'saving' | 'checking' | null>(null),
    [denied, setDenied] = useState(!allowed)
  const busy = activity !== null
  const [error, setError] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0)
  const [conflict, setConflict] = useState(false)
  const [pending, setPending] = useState<PendingWorkspaceUpdate | null>(null),
    [missing, setMissing] = useState(false),
    [invalidPending, setInvalidPending] = useState(false)
  const alive = useRef(true),
    request = useRef<AbortController | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      request.current?.abort()
    }
  }, [])
  const unavailable = (cause: unknown) => {
    setDenied(true)
    setOverview(null)
    setError(failure(cause))
    onAccessDenied(cause)
  }
  const accepted = (value: WorkspaceUpdateWriteResult) => {
    setPending(null)
    setMissing(false)
    if ('saved' in value) {
      unavailable(
        new AutoOpsRequestError(
          '设置已保存，当前管理权限已失效。',
          'WORKSPACE_UPDATE_ACCESS_CHANGED',
          403,
        ),
      )
      return
    }
    setActivity(null)
    onChanged()
    onOpenChange(false)
  }
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setOverview(null)
    setConfirmed(false)
    setError(null)
    setDenied(!allowed)
    if (!allowed) {
      setError('当前账号无权配置此范围的资料更新。')
      return
    }
    let saved: PendingWorkspaceUpdate | null
    try {
      saved = readPendingWorkspaceUpdate(projectId, scope)
      setPending(saved)
      setInvalidPending(false)
    } catch (cause) {
      setInvalidPending(true)
      setError(failure(cause))
      return
    }
    void loadWorkspaceUpdates(projectId, controller.signal)
      .then(async (next) => {
        if (controller.signal.aborted) return
        setOverview(next)
        const current = next[scope]
        setEnabled(current?.enabled ?? false)
        setInterval(String(current?.intervalMinutes ?? 60))
        setTimezone(current?.timezone ?? 'Asia/Shanghai')
        if (!saved) return
        const restored = await recoverWorkspaceUpdate(saved, controller.signal)
        if (controller.signal.aborted) return
        if (restored.status === 'completed') accepted(restored.result)
        else {
          setMissing(true)
          setError('尚未找到原设置收据。可按原请求重试，不能另建新请求。')
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        if (isAutoOpsAccessError(cause)) unavailable(cause)
        else setError(failure(cause))
      })
    return () => controller.abort()
    // 每次重开或明确重试才读取；草稿编辑不触发后台请求。
  }, [open, projectId, scope, allowed, attempt])
  const run = async (saved: PendingWorkspaceUpdate, checkOnly: boolean) => {
    if (busy || denied) return
    const controller = new AbortController()
    request.current = controller
    setActivity(checkOnly ? 'checking' : 'saving')
    setError(null)
    try {
      if (checkOnly) {
        const restored = await recoverWorkspaceUpdate(saved, controller.signal)
        if (!alive.current || controller.signal.aborted) return
        if (restored.status === 'completed') accepted(restored.result)
        else {
          setMissing(true)
          setError('尚未找到原设置收据。可按原请求重试，不能另建新请求。')
        }
      } else {
        const result = await submitWorkspaceUpdate(saved, controller.signal)
        if (alive.current && !controller.signal.aborted) accepted(result)
      }
    } catch (cause) {
      if (!alive.current || controller.signal.aborted) return
      if (isAutoOpsAccessError(cause)) unavailable(cause)
      else setError(failure(cause))
      try {
        setPending(readPendingWorkspaceUpdate(projectId, scope))
      } catch {
        setInvalidPending(true)
      }
      if (cause instanceof AutoOpsRequestError && cause.status === 409 && !cause.uncertain) {
        setConflict(true)
        setAttempt((value) => value + 1)
      }
    } finally {
      if (alive.current && !controller.signal.aborted) setActivity(null)
    }
  }
  const save = () => {
    if (!overview || busy || denied || pending || invalidPending) return
    try {
      setConflict(false)
      const minutes = Number(interval)
      if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 43_200)
        throw new Error('更新间隔须为 5 至 43200 分钟。')
      new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format()
      if (enabled && !confirmed) throw new Error('请确认本次更新使用的当前来源。')
      const saved = prepareWorkspaceUpdate(projectId, scope, overview[scope]?.revision ?? 0, {
        enabled,
        intervalMinutes: minutes,
        timezone,
        sourceIds: overview.sources.map((value) => value.id),
      })
      setPending(saved)
      setMissing(false)
      void run(saved, false)
    } catch (cause) {
      setError(cause instanceof RangeError ? '请选择有效的 IANA 时区。' : failure(cause))
    }
  }
  const disabled = busy || !!pending || invalidPending || denied || !overview
  const current = overview?.[scope]
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value)
      }}
    >
      <DialogPopup finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{scope === 'internal' ? '内部' : '外部'}更新设置</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            aria-describedby={error ? errorId : undefined}
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
              )
                event.preventDefault()
            }}
          >
            {error ? (
              <Alert id={errorId} variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {conflict ? (
              <Alert variant="warning">
                <AlertDescription>设置已由其他管理员修改，请核对当前值后再保存。</AlertDescription>
              </Alert>
            ) : null}
            {!overview && !error ? (
              <p role="status">
                <Spinner size="sm" /> 正在读取更新设置
              </p>
            ) : null}
            {!overview && !denied && !invalidPending ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setAttempt((value) => value + 1)}
              >
                重试读取
              </Button>
            ) : null}
            {overview ? (
              <>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={enableId}
                    checked={enabled}
                    disabled={disabled}
                    onCheckedChange={(value) => {
                      setEnabled(value === true)
                      setConfirmed(false)
                    }}
                  />
                  <Label htmlFor={enableId}>启用定期更新</Label>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={intervalId}>更新间隔（分钟）</Label>
                  <Input
                    id={intervalId}
                    type="number"
                    min={5}
                    max={43200}
                    step={1}
                    required
                    value={interval}
                    disabled={disabled}
                    onChange={(event) => setInterval(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={timezoneId}>时区</Label>
                  <Input
                    id={timezoneId}
                    required
                    maxLength={80}
                    value={timezone}
                    disabled={disabled}
                    placeholder="Asia/Shanghai"
                    onChange={(event) => setTimezone(event.target.value)}
                  />
                </div>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">更新来源</legend>
                  <ul className="space-y-1 text-sm">
                    {overview.sources.map((source) => (
                      <li key={source.id} className="break-all">
                        {source.name}
                      </li>
                    ))}
                    <li>当前上传资料</li>
                  </ul>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id={confirmId}
                      checked={confirmed}
                      disabled={disabled || !enabled}
                      onCheckedChange={(value) => setConfirmed(value === true)}
                    />
                    <Label htmlFor={confirmId}>确认使用当前全部来源</Label>
                  </div>
                </fieldset>
                {scope === 'external' ? (
                  <p className="text-sm text-muted-foreground">
                    从当前内部资料按内置规则生成；待复核文件仍须人工确认。
                  </p>
                ) : null}
                <SettingsSection title="更新状态">
                  <SettingsGroup>
                    <SettingsRow
                      title="下次更新"
                      description={displayTime(current?.nextRunAt, current?.timezone ?? timezone)}
                    />
                    <SettingsRow
                      title="最近结果"
                      description={
                        current?.currentRun
                          ? (current.currentRun.error?.message ?? '更新处理中')
                          : current?.lastRun?.outcome
                            ? outcomes[current.lastRun.outcome]
                            : '尚未执行'
                      }
                    />
                    {current?.pausedReason ? (
                      <SettingsRow title="已暂停" description={current.pausedReason.message} />
                    ) : null}
                  </SettingsGroup>
                </SettingsSection>
              </>
            ) : null}
            {activity ? (
              <p role="status" className="flex items-center gap-2 text-sm">
                <Spinner size="sm" />
                {activity === 'saving' ? '正在保存更新设置' : '正在核对原请求'}
              </p>
            ) : pending ? (
              <p role="status" className="text-sm text-muted-foreground">
                正在保留原请求：{pending.input.requestId}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
          {pending && !denied ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void run(pending, true)}
              >
                核对原请求
              </Button>
              {missing ? (
                <Button type="button" disabled={busy} onClick={() => void run(pending, false)}>
                  按原请求重试
                </Button>
              ) : null}
            </>
          ) : (
            <Button type="submit" form={formId} disabled={disabled || (enabled && !confirmed)}>
              {busy ? <Spinner size="sm" /> : null}保存
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
