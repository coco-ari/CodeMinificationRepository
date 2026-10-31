import { useRef, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from '~/components/chat/ComposerControl'
import { ComposerContextLabel } from '~/components/ComposerContextLabel'
import { useComposerMenuProps } from '~/components/chat/composerEventScope'
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from '~/components/ui/menu'
import { Tooltip, TooltipTrigger, TooltipPopup } from '~/components/ui/tooltip'
import { readAutoOpsHost } from './hostConfig'

/** 平台范围只决定可见边界；每次运行的输入由服务端捕获。 */
export function availableWorkspaceScopes(
  projectId: string,
): Array<{ value: 'internal' | 'external'; label: string }> {
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  if (project?.capabilities?.['workspace.read'] !== true) return []
  return [
    ...(project.membership?.workspaceAccess === 'external'
      ? []
      : [{ value: 'internal' as const, label: '内部原始 · 当前工作区' }]),
    { value: 'external' as const, label: '外部脱敏 · 当前已发布资料' },
  ]
}

export function ScopeComposerChoice({
  label,
  summary,
  icon: Icon,
  value,
  options,
  locked,
  disabled,
  onChange,
  footer,
  lockReason,
  keepSummaryVisible = false,
  labelWidth = 5,
  size = 'sm',
}: {
  label: string
  summary: string
  icon: LucideIcon
  value: string
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
  locked: boolean
  disabled: boolean
  onChange: (value: string) => void
  footer?: ReactNode
  lockReason?: string | undefined
  keepSummaryVisible?: boolean
  labelWidth?: number
  size?: ComposerControlSize
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const floating = useComposerMenuProps(trigger)
  const content = (
    <>
      <ComposerControlIcon icon={Icon} size={size} />
      <ComposerContextLabel
        reservedWidth={labelWidth}
        compactBehavior={keepSummaryVisible ? 'truncate' : 'hide'}
      >
        <span className="block text-left">{summary}</span>
      </ComposerContextLabel>
    </>
  )
  if (locked)
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              render={<span />}
              size={size}
              tabIndex={0}
              aria-label={label}
              aria-description={summary}
              className="min-w-0 max-w-full cursor-default hover:bg-transparent"
              data-composer-context-control
              data-autoops-scope-locked="true"
            >
              {content}
              <ComposerControlChevron size={size} className="invisible" />
            </ComposerControl>
          }
        />
        <TooltipPopup role="tooltip">
          {summary} · {lockReason ?? '首条消息已接受，切换范围请新建对话。'}
        </TooltipPopup>
      </Tooltip>
    )
  return (
    <Menu modal={false}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              ref={trigger}
              render={<ComposerControl size={size} />}
              aria-label={label}
              aria-description={summary}
              disabled={disabled}
              data-composer-context-control
            >
              {content}
              <ComposerControlChevron size={size} />
            </MenuTrigger>
          }
        />
        <TooltipPopup>{summary}{locked ? ` · ${lockReason ?? '首条消息已接受，切换范围请新建对话。'}` : ''}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="start" {...floating}>
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          <MenuRadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} disabled={locked || option.disabled} closeOnClick>
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">{option.label}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {footer ? (
          <>
            <MenuSeparator />
            {footer}
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  )
}
