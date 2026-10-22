// Adapted from OpenChamber MessageBody.tsx at 6491f51dbcf05d1e3f7f823049f5f097c96c234b
// (MIT; see /third-party/agent-demo-streaming-NOTICES.txt).
// Keep its pointer icon row / assistant fork menu / labelled touch sheet policy.
// AutoOps uses its existing Radix Sheet and server commands, not OpenCode stores.
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, GitBranch, MoreHorizontal, Pencil, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from './api'
import { Usage } from './reasoning'
import './message-actions.css'

const TOUCH_ACTIONS = '(max-width: 767px), (any-pointer: coarse), (hover: none)'

// Subscribe once per chat, not once per historical message. Wide touch devices
// also need the sheet: a viewport-only check would leave them without hover.
export function useTouchMessageActions() {
  const [touch, setTouch] = useState(() => window.matchMedia(TOUCH_ACTIONS).matches)
  useEffect(() => {
    const media = window.matchMedia(TOUCH_ACTIONS)
    const update = () => setTouch(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return touch
}

export function MessageActions({
  assistant,
  content,
  touch,
  disabled,
  onEdit,
  onBranch,
  onRetry,
  usage,
}) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const handingOffFocus = useRef(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  useEffect(() => {
    setMenuOpen(false)
    setSheetOpen(false)
  }, [touch])
  const copy = async () => {
    try {
      await copyText(content)
      setCopied(true)
      setCopyError('')
    } catch {
      setCopyError('复制不可用，请选择正文后复制。')
    }
  }
  const actions = [
    ...(content?.trim()
      ? [
          {
            id: 'copy',
            label: copied ? '已复制' : assistant ? '复制回复' : '复制消息',
            icon: copied ? Check : Copy,
            run: copy,
          },
        ]
      : []),
    ...(onEdit ? [{ id: 'edit', label: '编辑并重发', icon: Pencil, run: onEdit, disabled }] : []),
    ...(onBranch
      ? [{ id: 'branch', label: '从这里分支', icon: GitBranch, run: onBranch, disabled }]
      : []),
    ...(onRetry
      ? [{ id: 'retry', label: '重新生成', icon: RotateCcw, run: onRetry, disabled }]
      : []),
  ]
  if (!actions.length) return null
  return (
    <div
      className="workbench-demo-answer-actions"
      data-action-surface={touch ? 'touch' : 'pointer'}
    >
      {usage && <Usage usage={usage} />}
      {touch ? (
        <Sheet
          open={sheetOpen}
          onOpenChange={(open) => {
            handingOffFocus.current = false
            setSheetOpen(open)
          }}
        >
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="workbench-demo-message-more"
              aria-label="更多消息操作"
            >
              <MoreHorizontal size={14} />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="workbench-demo-message-sheet"
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              if (handingOffFocus.current) event.preventDefault()
            }}
          >
            <SheetHeader>
              <SheetTitle>消息操作</SheetTitle>
            </SheetHeader>
            <div className="workbench-demo-message-sheet-actions">
              {actions.map((action) => (
                <Button
                  key={action.id}
                  variant="ghost"
                  disabled={action.disabled}
                  onClick={() => {
                    // The edit dialog owns focus immediately. Async commands keep
                    // normal focus restoration so a rejected request stays usable.
                    handingOffFocus.current = action.id === 'edit'
                    setSheetOpen(false)
                    action.run()
                  }}
                >
                  <action.icon size={16} />
                  {action.label}
                </Button>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      ) : (
        <TooltipProvider delayDuration={300}>
          <div className="workbench-demo-message-action-icons" data-open={menuOpen || undefined}>
            {actions.map((action) =>
              assistant && action.id === 'branch' ? (
                <DropdownMenu key={action.id} open={menuOpen} onOpenChange={setMenuOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="分支菜单"
                          disabled={disabled}
                        >
                          <GitBranch size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>分支菜单</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem disabled={disabled} onSelect={onBranch}>
                      <GitBranch size={14} />
                      从这里分支
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Tooltip key={action.id}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={
                        action.id === 'copy' ? (assistant ? '复制回复' : '复制消息') : action.label
                      }
                      disabled={action.disabled}
                      onClick={action.run}
                    >
                      <action.icon size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{action.label}</TooltipContent>
                </Tooltip>
              ),
            )}
          </div>
        </TooltipProvider>
      )}
      <span className="sr-only" role="status">
        {copied ? '已复制' : ''}
      </span>
      {copyError && (
        <span className="workbench-demo-inline-error" role="alert">
          {copyError}
        </span>
      )}
    </div>
  )
}
