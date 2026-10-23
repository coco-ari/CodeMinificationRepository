import { CircleAlertIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Tooltip, TooltipPopup, TooltipTrigger } from '~/components/ui/tooltip'

/** 绑定保持锁定，读取失败仍保留可见且可用键盘操作的恢复入口。 */
export function ScopeReadError({
  label,
  error,
  busy,
  onRetry,
}: {
  label: string
  error: string
  busy?: boolean
  onRetry: () => void
}) {
  return (
    <span role="alert" data-composer-context-control>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={onRetry}
              aria-label={`${label}，重试`}
              className="text-destructive"
            >
              <CircleAlertIcon />
              {busy ? '正在重试…' : label}
            </Button>
          }
        />
        <TooltipPopup>{error}</TooltipPopup>
      </Tooltip>
    </span>
  )
}
