import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { registerGuard, navigateSafely } from '@/lib/navigation-guard'
import { Choice } from './selection'
import {
  Field as FieldRoot,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
} from '@/components/ui/field'
import {
  Empty as EmptyRoot,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty'
import { LoaderCircle, Inbox, Info, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { statusNames, useConsole, date } from '@/lib/console'

export function Action({ children, onClick, variant = 'outline', className, ...props }) {
  const [busy, setBusy] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant={variant}
        className={className}
        {...props}
        disabled={busy || props.disabled}
        onClick={async () => {
          if (busy) return
          setBusy(true)
          try {
            await onClick?.()
          } catch (e) {
            if (e.name !== 'AbortError') toast.error(e.message)
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy && <LoaderCircle className="animate-spin" />}
        {children}
      </Button>
    </>
  )
}
export function Status({ value, children }) {
  const positive = ['ready', 'succeeded', 'success', 'online', 'healthy'].includes(value)
  const negative = ['failed', 'interrupted', 'unhealthy'].includes(value)
  const pending = ['queued', 'preparing', 'running', 'syncing', 'rolled_back'].includes(value)
  return (
    <Badge
      variant="outline"
      className={cn(
        'badge gap-1.5 whitespace-nowrap font-normal',
        positive && 'border-emerald-200 bg-emerald-50 text-emerald-700',
        negative && 'border-red-200 bg-red-50 text-red-700',
        pending && 'border-amber-200 bg-amber-50 text-amber-700',
      )}
    >
      <span className={cn('size-1.5 rounded-full bg-current', pending && 'animate-pulse')} />
      {children || statusNames[value] || value}
    </Badge>
  )
}
export function RepositoryStatus({ repo }) {
  const connected = ['ready', 'empty'].includes(repo.connectionStatus)
  const value = !repo.enabled ? 'disabled' : connected ? 'ready' : repo.connectionStatus || 'idle'
  const label = !repo.enabled
    ? '已停用'
    : connected
      ? '已连接'
      : repo.connectionStatus === 'failed'
        ? '连接失败'
        : '待验证'
  const description = !repo.enabled
    ? '仓库已停用，启用后可刷新连接状态。'
    : repo.connectionStatus === 'empty'
      ? '已成功连接远端，仓库暂无提交。'
      : connected
        ? `最近验证：${date(repo.branchInfo?.refreshedAt)}；可在代码仓库中刷新。`
        : repo.connectionStatus === 'failed'
          ? repo.connectionError || '请检查仓库地址、访问凭证和网络后重试。'
          : '尚未验证当前仓库配置，请在代码仓库中刷新。'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex shrink-0" data-repository-status={value}>
          <Status value={value}>{label}</Status>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 break-words">{description}</TooltipContent>
    </Tooltip>
  )
}
export function ServerStatus({ server }) {
  const value = server.revoked
    ? 'disabled'
    : server.online
      ? 'online'
      : server.registeredAt
        ? 'unhealthy'
        : 'disabled'
  const label = server.revoked
    ? '已撤销'
    : server.online
      ? '在线'
      : server.registeredAt
        ? '失联'
        : '等待接入'
  return <Status value={value}>{label}</Status>
}
export function TargetStatus({ target, server }) {
  const state = target.observation?.state || target.observation?.status
  const health = target.observation?.health || target.observation?.healthStatus
  const running = ['running', 'published'].includes(state)
  if (!server?.online || server?.revoked)
    return (
      <div className="space-y-1">
        <Status value="disabled">状态待确认</Status>
        <p className="text-xs text-muted-foreground">
          服务器{server?.revoked ? '已撤销' : '未在线'}
        </p>
        <p className="text-xs text-muted-foreground">
          最近采集：{date(target.lastObservedAt || server?.lastSeenAt)}
        </p>
      </div>
    )
  return (
    <div className="flex flex-wrap gap-1.5">
      <Status value={running ? 'healthy' : state ? 'unhealthy' : 'disabled'}>
        {running
          ? state === 'published'
            ? '已发布'
            : '运行中'
          : ['exited', 'stopped'].includes(state)
            ? '已停止'
            : ['missing', 'unpublished'].includes(state)
              ? '未运行'
              : '待上报'}
      </Status>
      <Status
        value={health === 'healthy' ? 'healthy' : health === 'unhealthy' ? 'unhealthy' : 'disabled'}
      >
        {health === 'healthy' ? '健康' : health === 'unhealthy' ? '健康异常' : '健康待确认'}
      </Status>
    </div>
  )
}

export function Notice({ children, error = false, className }) {
  return (
    <Alert variant={error ? 'destructive' : 'default'} className={cn('bg-muted/35', className)}>
      <Info className="size-4" />
      <AlertDescription className="break-words">{children}</AlertDescription>
    </Alert>
  )
}
export function Empty({ title, description, action, label }) {
  return (
    <EmptyRoot className="col-span-full">
      <EmptyHeader>
        <div className="mb-1 rounded-xl border bg-muted/50 p-3">
          <Inbox className="size-6 text-muted-foreground" />
        </div>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && (
        <Button className="mt-2" onClick={action}>
          {label}
          <ArrowUpRight />
        </Button>
      )}
    </EmptyRoot>
  )
}
export function Stats({ items }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-4">
      {items.map(([label, value, hint]) => (
        <Card key={label} className="py-0 shadow-none">
          <CardContent className="p-3 sm:p-5">
            <p className="min-h-8 text-xs text-muted-foreground sm:min-h-0 sm:text-sm">{label}</p>
            <p className="my-1 text-2xl font-semibold tracking-tight tabular-nums sm:my-2 sm:text-3xl">
              {value}
            </p>
            <p className="hidden text-xs text-muted-foreground sm:block">{hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
export function Detail({ label, children }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm leading-relaxed">{children ?? '—'}</dd>
    </div>
  )
}
export function Field({
  name,
  label,
  hint,
  choices,
  multiline,
  id,
  className,
  value,
  onChange,
  searchable,
  ...props
}) {
  const unique = useId()
  const [invalid, setInvalid] = useState('')
  id ||= `deploy-${name || unique}`
  const inputProps = {
    id,
    name,
    ...props,
    ...(value !== undefined ? { value } : {}),
    'aria-invalid': !!invalid || undefined,
    'aria-describedby': invalid ? `${id}-error` : hint ? `${id}-hint` : undefined,
    onInvalid: (event) => setInvalid(event.currentTarget.validationMessage || `请检查${label}`),
    onChange: (event) => {
      setInvalid('')
      onChange?.(event)
    },
  }
  return (
    <FieldRoot className={className}>
      <FieldLabel htmlFor={id}>
        {label}
        {props.required && (
          <span className="text-muted-foreground" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </FieldLabel>
      {choices ? (
        <Choice
          {...inputProps}
          aria-label={label}
          searchable={
            searchable ?? /serverId|serviceId|sourceProjectId|credentialId/.test(name || '')
          }
          options={choices.map(([key, text]) => ({ value: key, label: text }))}
          onValueChange={(next) => {
            setInvalid('')
            onChange?.({ target: { value: next } })
          }}
        />
      ) : multiline ? (
        <Textarea {...inputProps} />
      ) : (
        <Input {...inputProps} />
      )}
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
      {invalid && <FieldError id={`${id}-error`}>{invalid}</FieldError>}
    </FieldRoot>
  )
}
export function FormDialog({
  title,
  description,
  children,
  onClose,
  onSubmit,
  submitLabel = '保存',
  wide = false,
  id,
  formId,
  footer,
  className,
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const submitting = useRef(false)
  const dirty = useRef(false)
  const guardId = useId()
  useEffect(() => registerGuard(guardId, () => dirty.current && !submitting.current), [guardId])
  const close = () => navigateSafely(onClose)
  const returnFocus = useRef(document.activeElement)
  const context = useConsole()
  const layout = context?.formLayout
  const inline = ['page', 'embedded'].includes(layout) && id !== 'credential-dialog'
  const Heading = layout === 'embedded' ? 'h2' : 'h1'
  const form = (
    <form
      id={formId}
      className="min-w-0 space-y-5"
      onInput={() => {
        dirty.current = true
      }}
      onChange={() => {
        dirty.current = true
      }}
      onInvalidCapture={(event) => {
        const content = event.target.closest('[data-slot="advanced-content"]')
        if (content?.dataset.state === 'closed')
          content.parentElement.querySelector('button[data-state="closed"]')?.click()
        setError('请检查标记的字段。')
      }}
      onSubmit={async (event) => {
        event.preventDefault()
        if (submitting.current || !onSubmit) return
        const missing = event.currentTarget.querySelector(
          '[data-required-choice=""]:not(:disabled)',
        )
        if (missing) {
          missing.focus()
          setError(`请选择${missing.getAttribute('aria-label') || '必填项'}`)
          return
        }
        submitting.current = true
        setBusy(true)
        setError('')
        try {
          const form = event.currentTarget
          await onSubmit(Object.fromEntries(new FormData(form)), form)
          dirty.current = false
        } catch (e) {
          if (e.name !== 'AbortError') setError(e.message)
        } finally {
          submitting.current = false
          setBusy(false)
        }
      }}
    >
      <FieldGroup>{children}</FieldGroup>
      {error && <FieldError className="form-error">{error}</FieldError>}
      {footer || (
        <div className="flex justify-end gap-2 border-t pt-4">
          {layout === 'embedded' ? (
            context.previousStep && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={context.previousStep}
              >
                上一步
              </Button>
            )
          ) : (
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              取消
            </Button>
          )}
          <Button type="submit" disabled={busy}>
            {busy && <LoaderCircle className="animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      )}
    </form>
  )
  if (inline)
    return (
      <section
        id={id}
        className="deploy-dialog inline-editor view-enter space-y-6"
        data-state="open"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <Heading
              id={layout === 'embedded' ? undefined : 'page-title'}
              className={
                layout === 'embedded' ? 'text-base font-semibold' : 'text-xl font-semibold'
              }
            >
              {layout === 'embedded' ? context.formStepTitle : title}
            </Heading>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          </div>
          {layout !== 'embedded' && (
            <Button variant="outline" data-slot="dialog-close" onClick={close}>
              返回
            </Button>
          )}
        </div>
        <Card>
          <CardContent>{form}</CardContent>
        </Card>
      </section>
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <DialogContent
        id={id}
        className={cn(
          'deploy-dialog max-h-[90dvh] overflow-y-auto',
          wide ? 'sm:max-w-4xl' : 'sm:max-w-lg',
          className,
        )}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.current?.isConnected) returnFocus.current.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description || '配置当前项目的交付资源。'}</DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  )
}
