import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ComposerControl, ComposerControlChevron } from '~/components/chat/ComposerControl'
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
}: {
  label: string
  summary: string
  icon: LucideIcon
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  locked: boolean
  disabled: boolean
  onChange: (value: string) => void
  footer?: ReactNode
}) {
  const floating = useComposerMenuProps()
  const content = (
    <>
      <Icon className="size-3 shrink-0" />
      <ComposerContextLabel>{summary}</ComposerContextLabel>
    </>
  )
  if (locked)
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={label}
              aria-description={summary}
              className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
              data-composer-context-control
              data-autoops-scope-locked="true"
            >
              {content}
            </span>
          }
        />
        <TooltipPopup>{summary} · 首条消息已接受，切换范围请新建对话。</TooltipPopup>
      </Tooltip>
    )
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<ComposerControl size="xs" />}
              aria-label={label}
              aria-description={summary}
              disabled={disabled}
              data-composer-context-control
            >
              {content}
              <ComposerControlChevron size="xs" />
            </MenuTrigger>
          }
        />
        <TooltipPopup>{summary}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="start" {...floating}>
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          <MenuRadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                {option.label}
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
