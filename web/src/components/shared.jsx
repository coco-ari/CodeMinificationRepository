import { useId, useRef, useState } from 'react'
import { LoaderCircle, Inbox, Info, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
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
import { statusNames, useConsole } from '@/lib/console'

export function Action({ children, onClick, variant = 'outline', className, ...props }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
          setError('')
          try {
            await onClick?.()
          } catch (e) {
            if (e.name !== 'AbortError') setError(e.message)
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy && <LoaderCircle className="animate-spin" />}
        {children}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive basis-full">
          {error}
        </p>
      )}
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
    <Card className="col-span-full border-dashed shadow-none">
      <CardContent className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="mb-1 rounded-xl border bg-muted/50 p-3">
          <Inbox className="size-6 text-muted-foreground" />
        </div>
        <h2 className="font-semibold">{title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
        {action && (
          <Button className="mt-2" onClick={action}>
            {label}
            <ArrowUpRight />
          </Button>
        )}
      </CardContent>
    </Card>
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
      <dd className="break-words text-sm font-medium">{children ?? '—'}</dd>
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
  ...props
}) {
  const unique = useId()
  id ||= `deploy-${name || unique}`
  const inputProps = { id, name, ...props, ...(value !== undefined ? { value } : {}), onChange }
  return (
    <div className={cn('min-w-0 space-y-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      {choices ? (
        <NativeSelect {...inputProps} className="w-full">
          {choices.map(([key, text]) => (
            <NativeSelectOption key={key} value={key}>
              {text}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : multiline ? (
        <Textarea {...inputProps} />
      ) : (
        <Input {...inputProps} />
      )}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
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
  const returnFocus = useRef(document.activeElement)
  const inline = useConsole()?.formLayout === 'page' && id !== 'credential-dialog'
  const form = (
    <form
      id={formId}
      className="min-w-0 space-y-5"
      onSubmit={async (event) => {
        event.preventDefault()
        if (submitting.current || !onSubmit) return
        submitting.current = true
        setBusy(true)
        setError('')
        try {
          const form = event.currentTarget
          await onSubmit(Object.fromEntries(new FormData(form)), form)
        } catch (e) {
          if (e.name !== 'AbortError') setError(e.message)
        } finally {
          submitting.current = false
          setBusy(false)
        }
      }}
    >
      {children}
      {error && (
        <p className="form-error text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {footer || (
        <div className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
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
            <h1 id="page-title" className="text-xl font-semibold">
              {title}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          </div>
          <Button variant="outline" data-slot="dialog-close" onClick={onClose}>
            返回
          </Button>
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
        if (!open && !busy) onClose()
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
