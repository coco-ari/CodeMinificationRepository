// Adapted from OpenChamber (MIT), Copyright (c) 2025 Bohdan Triapitsyn.
// Commit 6491f51dbcf05d1e3f7f823049f5f097c96c234b:
//   composer/ui/ComposerActionButtons.tsx: busy/idle send and independent stop.
//   QueuedMessagesStrip.tsx: single preview, collapsible multiple queued items.
//   FormDock.tsx: stable request identity and draft retained until accepted.
// Clarification success/failure ownership also follows Hermes WebUI (MIT),
// Copyright (c) 2025 Hermes Web UI Contributors, commit
// 3aa21f63387939dcff37baa141ad59a0e1e1147f, static/messages.js respondClarify.
// Full notices: /third-party/agent-demo-streaming-NOTICES.txt
// Adaptation: shadcn/Radix controls, API callbacks instead of OpenCode stores,
// user-scoped preferences, no frontend queue dispatcher or automatic focus.

import { memo, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Send,
  Square,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { shouldSubmitEnter } from './vendor/openchamber/keyboard-policy'

const preferenceKey = (userId) =>
  `autoops:agent-demo:follow-up:${encodeURIComponent(userId || 'anonymous')}`
const readBehavior = (userId) => {
  try {
    return localStorage.getItem(preferenceKey(userId)) === 'steer' ? 'steer' : 'queue'
  } catch {
    return 'queue'
  }
}

export function resolveComposerDelivery({
  running,
  behavior,
  canSteer = true,
  hasAttachments = false,
}) {
  if (!running) return { primaryDelivery: 'send', alternateDelivery: null }
  const steerAvailable = canSteer && !hasAttachments
  const primaryDelivery = behavior === 'steer' && steerAvailable ? 'steer' : 'queue'
  return {
    primaryDelivery,
    alternateDelivery: steerAvailable ? (primaryDelivery === 'steer' ? 'queue' : 'steer') : null,
  }
}

export function useComposerControls({
  userId,
  running,
  canSend,
  canSteer = true,
  hasAttachments = false,
  onSend,
}) {
  const [preference, setPreference] = useState(() => ({ userId, behavior: readBehavior(userId) }))
  const composition = useRef({ active: false, endedAt: -Infinity })
  const behavior = preference.userId === userId ? preference.behavior : readBehavior(userId)
  const setBehavior = (value) => {
    if (!['steer', 'queue'].includes(value)) return
    setPreference({ userId, behavior: value })
    try {
      localStorage.setItem(preferenceKey(userId), value)
    } catch {
      /* Keep the preference in memory when storage is unavailable. */
    }
  }
  useEffect(() => {
    const refresh = (event) => {
      if (event.key === preferenceKey(userId))
        setPreference({ userId, behavior: readBehavior(userId) })
    }
    window.addEventListener('storage', refresh)
    return () => window.removeEventListener('storage', refresh)
  }, [userId])
  const delivery = resolveComposerDelivery({ running, behavior, canSteer, hasAttachments })
  const onKeyDown = (event) => {
    if (
      event.key !== 'Enter' ||
      event.nativeEvent?.isComposing ||
      event.isComposing ||
      event.keyCode === 229 ||
      composition.current.active ||
      performance.now() - composition.current.endedAt < 60
    )
      return
    if (
      !shouldSubmitEnter({
        isMobile: window.matchMedia('(max-width: 767px)').matches,
        isDesktopExpanded: false,
        enterToSend: true,
        enterToSendConfigured: false,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      })
    )
      return
    event.preventDefault()
    if (!canSend || event.repeat) return
    const action =
      (event.ctrlKey || event.metaKey) && delivery.alternateDelivery
        ? delivery.alternateDelivery
        : delivery.primaryDelivery
    void onSend(action)
  }
  return {
    behavior,
    setBehavior,
    ...delivery,
    onKeyDown,
    onCompositionStart: () => {
      composition.current.active = true
    },
    onCompositionEnd: () => {
      composition.current.active = false
      composition.current.endedAt = performance.now()
    },
  }
}

export const ComposerActions = memo(function ComposerActions({
  running,
  stopping = false,
  hasContent,
  canSend,
  canSteer = true,
  hasAttachments = false,
  sending = false,
  behavior = 'queue',
  setBehavior,
  onSend,
  onStop,
  canContinue = false,
  onContinue,
  continueBusy = false,
}) {
  const { primaryDelivery } = resolveComposerDelivery({
    running,
    behavior,
    canSteer,
    hasAttachments,
  })
  const steerAvailable = canSteer && !hasAttachments
  const label =
    primaryDelivery === 'steer' ? '引导本轮' : primaryDelivery === 'queue' ? '排队' : '发送'
  const unavailableReason = hasAttachments ? '附件会排队到下一轮' : '当前运行器不支持同轮引导'
  return (
    <div className="workbench-demo-composer-actions flex items-center gap-2">
      {!running && canContinue && onContinue && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-10"
          aria-label="继续此轮"
          disabled={continueBusy}
          onClick={onContinue}
        >
          {continueBusy ? (
            <LoaderCircle size={14} className="workbench-demo-spin" />
          ) : (
            <Play size={14} />
          )}
          继续
        </Button>
      )}
      {(!running || hasContent) && (
        <div className="workbench-demo-followup-action flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            className="min-h-10"
            aria-label={
              primaryDelivery === 'steer'
                ? '引导当前执行'
                : primaryDelivery === 'queue'
                  ? '排队到下一轮'
                  : '发送'
            }
            disabled={!canSend || stopping || sending}
            onClick={() => onSend(primaryDelivery)}
          >
            {sending ? (
              <LoaderCircle size={15} className="workbench-demo-spin" />
            ) : primaryDelivery === 'queue' ? (
              <Clock3 size={15} />
            ) : (
              <Send size={15} />
            )}
            {sending ? '提交中' : label}
          </Button>
          {running && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="min-h-10 min-w-10"
                  aria-label="选择运行中发送方式"
                  disabled={stopping || sending}
                >
                  <ChevronDown size={15} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="workbench-demo-followup-menu">
                <DropdownMenuRadioGroup value={primaryDelivery} onValueChange={setBehavior}>
                  <DropdownMenuRadioItem
                    value="steer"
                    disabled={!steerAvailable}
                    className="min-h-10"
                  >
                    引导当前执行
                    {!steerAvailable && (
                      <span className="text-xs text-muted-foreground">（{unavailableReason}）</span>
                    )}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="queue" className="min-h-10">
                    排队到下一轮
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {running && (
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          className="min-h-10 min-w-10"
          aria-label="停止生成"
          title="停止生成并暂停队列"
          disabled={stopping}
          onClick={onStop}
        >
          {stopping ? (
            <LoaderCircle size={15} className="workbench-demo-spin" />
          ) : (
            <Square size={14} />
          )}
        </Button>
      )}
    </div>
  )
})

export const QueueStrip = memo(function QueueStrip({
  items = [],
  paused = false,
  busy = false,
  connected = true,
  running = false,
  onEdit,
  onRemove,
  onMove,
  onPause,
  onResume,
  onSend,
}) {
  const [expanded, setExpanded] = useState(false)
  if (!items.length) return null
  const disabled = busy || !connected
  const multiple = items.length > 1
  return (
    <Collapsible
      open={!multiple || expanded}
      onOpenChange={setExpanded}
      className="workbench-demo-queue workbench-demo-queue-strip"
    >
      <div className="workbench-demo-queue-heading flex flex-wrap items-center justify-between gap-1">
        {multiple ? (
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-10"
              aria-label={expanded ? '收起下一轮队列' : '展开下一轮队列'}
            >
              <ChevronDown size={14} className={expanded ? '' : 'is-closed'} />
              下一轮队列 · {items.length}
              {paused ? ' · 已暂停' : ''}
            </Button>
          </CollapsibleTrigger>
        ) : (
          <span className="flex min-h-10 items-center gap-2 px-2 text-sm">
            <Clock3 size={14} />
            下一轮队列{paused ? ' · 已暂停' : ''}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-h-10"
          disabled={disabled}
          onClick={paused ? onResume : onPause}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? '恢复队列' : '暂停队列'}
        </Button>
      </div>
      <CollapsibleContent>
        <div className="workbench-demo-queue-items">
          {items.map((item, index) => (
            <div
              key={item.id}
              data-queue-id={item.id}
              className="workbench-demo-queue-item flex flex-wrap items-center gap-1"
            >
              <div className="workbench-demo-queue-text min-w-0 flex-1 basis-40 px-2">
                <p className="truncate" title={item.text}>
                  {item.text?.split('\n')[0] || '分析附件'}
                </p>
                {item.attachments?.length > 0 && <small>{item.attachments.length} 个附件</small>}
              </div>
              <div className="workbench-demo-queue-actions flex flex-wrap items-center">
                {multiple && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="min-h-10! min-w-10!"
                      aria-label={`上移排队消息 ${item.id}`}
                      disabled={disabled || index === 0}
                      onClick={() => onMove(item.id, -1)}
                    >
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="min-h-10! min-w-10!"
                      aria-label={`下移排队消息 ${item.id}`}
                      disabled={disabled || index === items.length - 1}
                      onClick={() => onMove(item.id, 1)}
                    >
                      <ArrowDown size={14} />
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="min-h-10! min-w-10!"
                  aria-label={`编辑排队消息 ${item.id}`}
                  disabled={disabled}
                  onClick={() => onEdit(item)}
                >
                  <Pencil size={14} />
                </Button>
                {!running && onSend && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="min-h-10! min-w-10!"
                    aria-label={`立即发送排队消息 ${item.id}`}
                    disabled={disabled}
                    onClick={() => onSend(item)}
                  >
                    <Send size={14} />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="min-h-10! min-w-10!"
                  aria-label={`移除排队消息 ${item.id}`}
                  disabled={disabled}
                  onClick={() => onRemove(item)}
                >
                  <X size={14} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

const questionDraftKey = (userId, conversationId, questionId) =>
  `autoops:agent-demo:clarification:${[userId, conversationId, questionId].map((value) => encodeURIComponent(value || '')).join(':')}`
const readQuestionDraft = (key) => {
  try {
    return sessionStorage.getItem(key) || ''
  } catch {
    return ''
  }
}
const saveQuestionDraft = (key, answer) => {
  try {
    if (answer) sessionStorage.setItem(key, answer)
    else sessionStorage.removeItem(key)
  } catch {
    /* Editing remains available when browser storage is full or disabled. */
  }
}

export function ClarificationDock(props) {
  const { question, userId, conversationId } = props
  if (!question || (question.status && question.status !== 'pending')) return null
  const identity = questionDraftKey(userId, conversationId, question.id)
  return <ClarificationRequest key={identity} {...props} identity={identity} />
}

function ClarificationRequest({
  identity,
  question,
  busy = false,
  disabled = false,
  onAnswer,
  onRead,
}) {
  const [answer, setAnswer] = useState(() => readQuestionDraft(identity))
  const [submitting, setSubmitting] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const composing = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const update = (text) => {
    setAnswer(text)
    saveQuestionDraft(identity, text)
    setError('')
  }
  const submit = async () => {
    if (inFlight.current || busy || disabled || accepted || !answer.trim()) return
    inFlight.current = true
    setSubmitting(true)
    setError('')
    const submitted = answer.trim()
    try {
      const result = await onAnswer(submitted, question)
      if (!result) throw new Error('提交未确认，请重试。回答已保留。')
      // A late answer for A can never erase a newly rendered question B.
      saveQuestionDraft(identity, '')
      if (mounted.current) setAccepted(true)
    } catch (failure) {
      if (mounted.current) setError(failure?.message || '提交失败，请重试。回答已保留。')
    } finally {
      inFlight.current = false
      if (mounted.current) setSubmitting(false)
    }
  }
  const locked = busy || disabled || submitting || accepted
  return (
    <section
      className="workbench-demo-question workbench-demo-clarification-dock"
      data-question-id={question.id}
      aria-labelledby={`clarification-title-${question.id}`}
    >
      <div className="workbench-demo-question-heading">
        <CircleAlert size={17} />
        <strong id={`clarification-title-${question.id}`}>需要你补充</strong>
      </div>
      <p>{question.prompt}</p>
      <div className="workbench-demo-question-options flex flex-wrap gap-2">
        {(question.options || []).map((option) => {
          const label = typeof option === 'string' ? option : option.label || option.value
          return (
            <Button
              key={label}
              type="button"
              variant={answer === label ? 'default' : 'outline'}
              className="min-h-10"
              disabled={locked}
              aria-pressed={answer === label}
              onClick={() => {
                onRead?.()
                update(label)
              }}
            >
              {label}
            </Button>
          )
        })}
      </div>
      <Textarea
        aria-label="澄清回答"
        placeholder="也可以输入自己的回答…"
        value={answer}
        disabled={locked}
        rows={2}
        className="text-base"
        onFocus={onRead}
        onChange={(event) => update(event.target.value)}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.ctrlKey || event.metaKey) &&
            !composing.current &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      {error && (
        <p role="alert" className="workbench-demo-inline-error">
          {error}
        </p>
      )}
      <div className="workbench-demo-clarification-actions flex items-center gap-2">
        <Button
          type="button"
          className="min-h-10"
          disabled={locked || !answer.trim()}
          onClick={() => void submit()}
        >
          {submitting ? (
            <LoaderCircle size={14} className="workbench-demo-spin" />
          ) : accepted ? (
            <Check size={14} />
          ) : null}
          {submitting ? '正在提交…' : accepted ? '已提交，等待继续' : '提交并继续'}
        </Button>
      </div>
    </section>
  )
}
