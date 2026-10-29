import { useState, type ReactNode } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Switch } from '~/components/ui/switch'

/** 编辑留在当前工作台；导航确认也在页面内完成，不再叠加编辑弹窗。 */
export function AssistantEditorPage({
  title,
  value,
  busy,
  pending,
  disabled,
  saveLabel,
  onSave,
  onClose,
  children,
}: {
  title: string
  value: unknown
  busy: boolean
  pending: boolean
  disabled: boolean
  saveLabel: string
  onSave(): void
  onClose(): void
  children: ReactNode
}) {
  const [initial] = useState(() => JSON.stringify(value))
  const [leaving, setLeaving] = useState(false)
  const dirty = JSON.stringify(value) !== initial
  // 结果未知已有持久原请求，允许退出后从列表核对，不能把草稿提示变成第二道阻塞。
  const protect = busy || (dirty && !pending)
  const blocker = useBlocker({
    shouldBlockFn: () => protect,
    enableBeforeUnload: protect,
    withResolver: true,
  })
  const close = () => {
    if (busy) return
    if (dirty && !pending) setLeaving(true)
    else onClose()
  }
  return (
    <form
      aria-label={title}
      className="min-w-0 space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-background py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="返回助手列表"
            disabled={busy}
            onClick={close}
          >
            <ArrowLeftIcon />
          </Button>
          <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={disabled} aria-busy={busy}>
            {busy ? '正在保存…' : saveLabel}
          </Button>
        </div>
        {leaving || blocker.status === 'blocked' ? (
          <Alert variant="info" className="basis-full">
            <AlertDescription>
              <p>{busy ? '正在保存，请等待本次操作完成。' : '有尚未保存的修改。'}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLeaving(false)
                    blocker.reset?.()
                  }}
                >
                  继续编辑
                </Button>
                {!busy ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (blocker.status === 'blocked') blocker.proceed()
                      else onClose()
                    }}
                  >
                    放弃修改
                  </Button>
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      {children}
    </form>
  )
}

export function AssistantEnabledControl({
  name,
  enabled,
  busy,
  disabled,
  onFocus,
  onChange,
}: {
  name: string
  enabled: boolean
  busy: boolean
  disabled: boolean
  onFocus(button: HTMLButtonElement): void
  onChange(enabled: boolean): void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="w-12 text-xs text-muted-foreground" aria-hidden>
        {busy ? '保存中' : enabled ? '已启用' : '已停用'}
      </span>
      <Switch
        aria-label={`启用助手 ${name}`}
        checked={enabled}
        disabled={disabled}
        aria-busy={busy}
        onFocus={(event) => onFocus(event.currentTarget as HTMLButtonElement)}
        onCheckedChange={onChange}
      />
    </div>
  )
}
