import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpRight,
  Bot,
  ChevronDown,
  CircleAlert,
  FileText,
  History,
  LoaderCircle,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Pause,
  RotateCcw,
  Search,
  Settings2,
  Play,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Markdown } from './Content'
import { fileUrl, requestId } from './api'
import { useDraft } from './use-draft'
import { useChatScroll } from './use-chat-scroll'
import { useHistoryWindow } from './use-history-window'
import { conversationRows } from './timeline'
import { ToolPart } from './tool-parts'
import { TurnActivity } from './turn-activity'
import { finalAnswerPart } from './turn-activity-model'
import { deriveWorkStatus, WorkStatus, workStatusLabel } from './work-status'
import {
  ComposerActions,
  ClarificationDock,
  QueueStrip,
  useComposerControls,
} from './conversation-controls'
import { ReasoningBlock, useReasoningPreferences } from './reasoning'
import { ConversationSearch } from './conversation-search'
import { downloadConversation } from './conversation-export'
import { MessageActions, useTouchMessageActions } from './message-actions'

export const STATUS = {
  idle: '就绪',
  running: '正在处理',
  waiting: '等待你补充',
  stopping: '正在停止',
  completed: '已完成',
  failed: '未完成',
  interrupted: '已停止',
}
const compactTime = (value) =>
  value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''

function FileChip({ file, onPreview, compact = false }) {
  const notice = file.extraction?.status === 'unavailable' || file.extraction?.status === 'partial'
  return (
    <Button
      variant="outline"
      className={`workbench-demo-file-chip ${compact ? 'is-compact' : ''}`}
      onClick={() => onPreview(file)}
      title={notice ? `${file.name}：${file.extraction.message}` : file.name}
    >
      {notice ? <CircleAlert size={15} /> : <FileText size={15} />}
      <span>{file.name}</span>
      {notice && <span>{file.readable === false ? '正文不可读' : '部分可读'}</span>}
      <ArrowUpRight size={12} />
    </Button>
  )
}

const Message = memo(function Message({
  message,
  turn,
  onPreview,
  onRead,
  onAnswer,
  busy,
  userId,
  conversationId,
  reasoning,
  connected,
  actionsDisabled,
  onEdit,
  onBranch,
  onRetry,
  canRetry,
  hasLaterAssistant,
  touchActions,
}) {
  const assistant = message.role === 'assistant'
  const running = assistant && ['running', 'waiting', 'stopping'].includes(turn?.status)
  const finalSegment = message.finalSegment !== false
  const copyContent = assistant
    ? finalAnswerPart(message.parts || [], turn, finalSegment)?.text || message.content
    : message.content
  // OpenChamber's terminal turn footer: one action row at the final assistant
  // boundary, never on tools, reasoning, live placeholders or pre-steer slices.
  const settled = ['completed', 'interrupted', 'failed'].includes(turn?.status)
  const showActions =
    message.status !== 'sending' &&
    (assistant
      ? finalSegment && settled && Boolean(message.content?.trim())
      : Boolean(message.content?.trim() || message.attachments?.length))
  const livePartId = turn?.timeline?.at(-1)?.id
  return (
    <article
      className={`workbench-demo-message ${assistant ? 'is-assistant' : 'is-user'}`}
      data-message-id={message.id}
      data-turn-id={message.turnId}
      data-status={message.status || turn?.status}
    >
      <div className="workbench-demo-message-heading">
        {assistant ? (
          <span className="workbench-demo-agent-mark">
            <Bot size={15} />
          </span>
        ) : (
          <span className="workbench-demo-person-mark">
            {(message.actorName || '我').slice(-1)}
          </span>
        )}
        <span>{assistant ? '项目助手' : message.actorName || '我'}</span>
        {message.kind === 'steer' && <span className="workbench-demo-message-kind">本轮引导</span>}
        {!assistant && message.kind === 'answer' && (
          <span className="workbench-demo-message-kind">补充回答</span>
        )}
        <time>{compactTime(message.createdAt)}</time>
      </div>
      <div className="workbench-demo-message-body">
        {assistant &&
          !message.parts &&
          (turn?.steps || []).map((step) => (
            <ToolPart key={step.id} step={step} turn={turn} onRead={onRead} onPreview={onPreview} />
          ))}
        {message.parts ? (
          <TurnActivity
            parts={message.parts}
            turn={turn}
            messageId={message.id}
            finalSegment={finalSegment}
            hasLaterAssistant={hasLaterAssistant}
            showReasoning={reasoning?.show}
            onRead={onRead}
            renderPart={(part) => (
              <div
                className="workbench-demo-timeline-part"
                key={part.id}
                data-part-id={part.id}
                data-part-type={part.type}
              >
                {part.type === 'text' && (
                  <Markdown
                    content={part.text}
                    identity={part.id}
                    streaming={running && part.id === livePartId}
                  />
                )}
                {part.type === 'reasoning' && reasoning?.show && (
                  <ReasoningBlock
                    part={part}
                    running={running}
                    expandWhileStreaming={reasoning.expand}
                    onRead={onRead}
                  />
                )}
                {part.type === 'tool' && (
                  <ToolPart
                    step={turn.steps.find((step) => step.id === part.stepId)}
                    turn={turn}
                    onRead={onRead}
                    onPreview={onPreview}
                  />
                )}
                {part.type === 'question' &&
                  (part.question.status === 'pending' && turn.status === 'waiting' ? (
                    <ClarificationDock
                      userId={userId}
                      conversationId={conversationId}
                      question={part.question}
                      busy={busy}
                      disabled={!connected}
                      onRead={onRead}
                      onAnswer={onAnswer}
                    />
                  ) : (
                    <div className="workbench-demo-question-history">
                      <CircleAlert size={14} />
                      <span>{part.question.prompt}</span>
                      <small>{part.question.status === 'answered' ? '已回答' : '已结束'}</small>
                    </div>
                  ))}
              </div>
            )}
          />
        ) : message.content ? (
          <Markdown content={message.content} identity={message.id} streaming={running} />
        ) : null}
        {message.status === 'sending' && (
          <div className="workbench-demo-message-state" role="status">
            <LoaderCircle size={12} className="workbench-demo-spin" /> 正在发送…
          </div>
        )}
        {message.attachments?.length > 0 && (
          <div className="workbench-demo-file-list">
            {message.attachments.map((file) => (
              <FileChip key={file.id} file={file} onPreview={onPreview} />
            ))}
          </div>
        )}
        {assistant && finalSegment && turn?.error && (
          <div className="workbench-demo-inline-error">
            <CircleAlert size={14} />
            {typeof turn.error === 'string' ? turn.error : turn.error.message || '本轮执行未完成'}
          </div>
        )}
        {assistant && finalSegment && ['interrupted', 'failed'].includes(turn?.status) && (
          <div className="workbench-demo-message-state">{STATUS[turn.status]} · 已保留生成内容</div>
        )}
        {showActions && (
          <MessageActions
            assistant={assistant}
            content={copyContent}
            touch={touchActions}
            disabled={actionsDisabled}
            onEdit={!assistant && onEdit ? () => onEdit(message) : undefined}
            onBranch={onBranch ? () => onBranch(message) : undefined}
            onRetry={assistant && canRetry && onRetry ? () => onRetry(turn) : undefined}
            usage={assistant ? turn?.usage : undefined}
          />
        )}
        {assistant && finalSegment && settled && !showActions && canRetry && onRetry && (
          // A runner can fail before producing any text. Keep recovery available
          // without presenting a meaningless fork/copy footer for an empty reply.
          <Button
            variant="ghost"
            size="sm"
            aria-label="重新生成"
            disabled={actionsDisabled}
            onClick={() => onRetry(turn)}
          >
            <RotateCcw size={13} />
            重新生成
          </Button>
        )}
      </div>
    </article>
  )
})

export function Chat({
  conversation,
  project,
  agent,
  user,
  connection,
  api,
  command,
  onPreview,
  onContentLink,
  onOpenHistory,
  onOpenContext,
  onMore,
  onSelectConversation,
  refresh,
  reference,
}) {
  const touchActions = useTouchMessageActions()
  const draft = useDraft({ userId: user.id, conversationId: conversation.id, api })
  const active = conversation.turns.find((turn) => turn.id === conversation.activeTurnId)
  const workStatus = deriveWorkStatus(active)
  const lastTurn = conversation.turns.at(-1)
  const hasActive = Boolean(conversation.activeTurnId)
  const waiting = active?.question?.status === 'pending'
  const [busy, setBusy] = useState({})
  const [errors, setErrors] = useState({})
  const [receipt, setReceipt] = useState(null)
  const [editing, setEditing] = useState(null)
  const [editingMessage, setEditingMessage] = useState(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [reasoning, updateReasoning] = useReasoningPreferences(user.id)
  const [pendingSend, setPendingSend] = useState(null)
  const scroller = useRef(null)
  const column = useRef(null)
  const composer = useRef(null)
  const textarea = useRef(null)
  const picker = useRef(null)
  const attempts = useRef(new Map())
  const pending = useRef(new Set())
  const selectedId = useRef(conversation.id)
  selectedId.current = conversation.id
  const conversationRef = useRef(conversation)
  conversationRef.current = conversation
  const selectRef = useRef(onSelectConversation)
  selectRef.current = onSelectConversation
  const stoppingBusy = Boolean(busy[conversation.id]?.stop)
  const currentBusy = stoppingBusy ? 'stop' : busy[conversation.id]?.control
  const error = errors[conversation.id]
  const connectionReady = connection === 'connected'
  const turnMap = useMemo(
    () => new Map(conversation.turns.map((turn) => [turn.id, turn])),
    [conversation.turns],
  )
  const rowCache = useMemo(() => new Map(), [conversation.id])
  const rows = useMemo(
    () => conversationRows(conversation, rowCache),
    [conversation.messages, conversation.turns],
  )
  const historyWindow = useHistoryWindow({
    rows,
    conversationId: conversation.id,
    scrollerRef: scroller,
  })
  const {
    following,
    stopFollowing,
    scrollToLatest: latest,
    onScroll,
  } = useChatScroll({
    conversationId: conversation.id,
    contentVersion: conversation.revision,
    scrollerRef: scroller,
    contentRef: column,
    composerRef: composer,
  })
  useLayoutEffect(() => {
    setReceipt(null)
    setEditing(null)
    setEditingMessage(null)
    setSearchOpen(false)
    setDragging(false)
    dragDepth.current = 0
  }, [conversation.id])
  useLayoutEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = 'auto'
      textarea.current.style.height = `${Math.min(180, Math.max(68, textarea.current.scrollHeight))}px`
    }
  }, [draft.text, conversation.id])
  useEffect(() => {
    if (reference?.conversationId !== conversation.id) return
    draft.setText(
      `${draft.text}${draft.text.trim() ? '\n\n' : ''}请参考《${reference.name}》中的内容。`,
    )
    textarea.current?.focus()
  }, [reference?.id])

  const perform = useCallback(
    async (key, path, body, method = 'POST', onSuccess) => {
      const id = conversation.id
      const slot = key === 'stop' ? 'stop' : 'control'
      const pendingKey = `${id}:${slot}`
      if (
        pending.current.has(pendingKey) ||
        (slot !== 'stop' &&
          (pending.current.has(`${id}:stop`) || conversation.status === 'stopping'))
      )
        return
      pending.current.add(pendingKey)
      const fingerprint = `${id}:${key}:${JSON.stringify(body || {})}`
      const retryId = attempts.current.get(fingerprint) || requestId()
      attempts.current.set(fingerprint, retryId)
      if (key === 'send')
        setPendingSend({
          id: retryId,
          clientRequestId: retryId,
          conversationId: id,
          role: 'user',
          kind: body.delivery === 'steer' ? 'steer' : 'prompt',
          content: body.text,
          createdAt: new Date().toISOString(),
          status: 'sending',
          actorName: user.name,
          delivery: body.delivery,
        })
      setBusy((old) => ({ ...old, [id]: { ...old[id], [slot]: key } }))
      setErrors((old) => ({ ...old, [id]: '' }))
      try {
        const value = await command(
          `/conversations/${encodeURIComponent(id)}${path}`,
          method === 'POST' ? { ...body, requestId: retryId } : body,
          method,
        )
        attempts.current.delete(fingerprint)
        onSuccess?.(value)
        if (value.receipt && selectedId.current === id)
          setReceipt({ ...value.receipt, delivery: body?.delivery })
        return value
      } catch (failure) {
        if (failure.name === 'AbortError') return
        if (failure.status && failure.status < 500) attempts.current.delete(fingerprint)
        setErrors((old) => ({ ...old, [id]: failure.message }))
        if (failure.status === 409) void refresh(id).catch(() => {})
      } finally {
        if (key === 'send') setPendingSend((old) => (old?.id === retryId ? null : old))
        pending.current.delete(pendingKey)
        setBusy((old) => {
          const next = { ...old[id] }
          delete next[slot]
          return { ...old, [id]: next }
        })
      }
    },
    [conversation.id, conversation.status, command, refresh, user.name],
  )

  const answerQuestion = useCallback(
    (answer, question) => {
      if (
        !active?.question ||
        active.question.status !== 'pending' ||
        (question && question.id !== active.question.id)
      )
        return false
      return perform('answer', `/questions/${encodeURIComponent(active.question.id)}`, {
        answer,
        expectedTurnId: active.id,
      })
    },
    [active?.id, active?.question?.id, active?.question?.status, perform],
  )

  const send = async (delivery) => {
    if (currentBusy || draft.uploading) return
    if (!connectionReady)
      return setErrors((old) => ({ ...old, [conversation.id]: '连接恢复后再发送，输入已保留。' }))
    if (!draft.text.trim() && !draft.attachments.length) return
    const submitted = draft.snapshot()
    latest()
    const value = await perform(
      'send',
      '/messages',
      {
        text: submitted.text,
        attachmentIds: submitted.attachmentIds,
        delivery,
        ...(delivery === 'steer' ? { expectedTurnId: conversation.activeTurnId } : {}),
      },
      'POST',
      () => draft.clearSubmitted(submitted),
    )
    return value
  }
  const upload = async (files) => {
    try {
      await draft.upload(files)
    } catch (failure) {
      setErrors((old) => ({ ...old, [conversation.id]: failure.message }))
    }
  }
  const reorder = (itemId, direction) => {
    const ids = conversation.queue.map((item) => item.id)
    const index = ids.indexOf(itemId)
    const other = index + direction
    if (other < 0 || other >= ids.length) return
    ;[ids[index], ids[other]] = [ids[other], ids[index]]
    void perform('queue', '/queue/reorder', { ids, expectedRevision: conversation.revision })
  }
  const canSend =
    !currentBusy &&
    !draft.uploading &&
    connectionReady &&
    (draft.text.trim() || draft.attachments.length)
  const canSteer = Boolean(agent?.capabilities?.includes('steer'))
  const controls = useComposerControls({
    userId: user.id,
    running: hasActive,
    canSend,
    canSteer,
    hasAttachments: Boolean(draft.attachments.length),
    onSend: send,
  })
  const branch = useCallback(
    async (message, text) => {
      const source = conversationRef.current
      const sourceId = source.id
      const result = await perform('branch', '/branch', {
        messageId: message.sourceMessageId || message.id,
        ...(text !== undefined ? { text } : {}),
        expectedRevision: source.revision,
      })
      if (result?.conversation?.id && selectedId.current === sourceId) {
        setEditingMessage(null)
        selectRef.current(result.conversation.id)
        requestAnimationFrame(() => {
          if (selectedId.current === result.conversation.id)
            textarea.current?.focus({ preventScroll: true })
        })
      }
      return result
    },
    [perform],
  )
  const retry = useCallback(
    (turn) => {
      latest()
      return perform('retry', '/retry', {
        turnId: turn.id,
        expectedRevision: conversationRef.current.revision,
      })
    },
    [perform, latest],
  )
  useEffect(() => {
    const keyboard = (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'f' &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault()
        stopFollowing()
        setSearchOpen(true)
        requestAnimationFrame(() => document.querySelector('[aria-label="搜索当前对话"]')?.focus())
      }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [stopFollowing])
  const environmentName =
    project?.environments.find((environment) => environment.id === conversation.environmentId)
      ?.name || '未指定环境'

  return (
    <section
      className="workbench-demo-chat"
      aria-label="Agent 会话"
      data-conversation-id={conversation.id}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault()
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        void upload(event.dataTransfer.files)
      }}
    >
      <header className="workbench-demo-chat-header">
        <div className="workbench-demo-chat-heading">
          <Button
            className="workbench-demo-show-history"
            variant="ghost"
            size="icon-sm"
            aria-label="打开历史会话"
            onClick={onOpenHistory}
          >
            <History size={18} />
          </Button>
          <div>
            <h1>{conversation.title}</h1>
            <div className="workbench-demo-chat-meta">
              <span>{environmentName}</span>
              <i />
              <span>{conversation.visibility === 'project' ? '项目共享' : '私有会话'}</span>
              <i />
              <span
                className={
                  conversation.mode === 'live'
                    ? 'workbench-demo-mode-live'
                    : 'workbench-demo-mode-scenario'
                }
              >
                {conversation.mode === 'live' ? '真实运行' : '场景演示'}
              </span>
            </div>
          </div>
        </div>
        <div className="workbench-demo-chat-header-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="搜索对话"
            title="搜索对话（Ctrl/Cmd + F）"
            onClick={() => {
              stopFollowing()
              setSearchOpen(!searchOpen)
            }}
          >
            <Search size={17} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="对话显示与导出">
                <Settings2 size={17} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuCheckboxItem
                checked={reasoning.show}
                onCheckedChange={(show) => updateReasoning({ show })}
              >
                显示思考过程
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={reasoning.expand}
                disabled={!reasoning.show}
                onCheckedChange={(expand) => updateReasoning({ expand })}
              >
                思考时自动展开
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  downloadConversation(conversation, { includeReasoning: reasoning.show })
                }
              >
                <ArrowDownToLine size={15} />
                导出对话 Markdown
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            className="workbench-demo-show-context"
            aria-label="打开会话上下文"
            onClick={onOpenContext}
          >
            <PanelRight size={18} />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="会话更多操作" onClick={onMore}>
            <MoreHorizontal size={19} />
          </Button>
        </div>
      </header>
      {searchOpen && (
        <ConversationSearch
          key={conversation.id}
          rows={rows}
          rootRef={scroller}
          showReasoning={reasoning.show}
          onRead={stopFollowing}
          revealRow={historyWindow.revealRow}
          onClose={() => {
            setSearchOpen(false)
            textarea.current?.focus()
          }}
        />
      )}
      {dragging && (
        <div className="workbench-demo-drop-overlay" role="status">
          <Paperclip size={25} />
          松开以添加附件
        </div>
      )}
      {!connectionReady && (
        <div className="workbench-demo-connection" role="status">
          <LoaderCircle size={14} className="workbench-demo-spin" />
          <span>
            {connection === 'connecting'
              ? '正在连接会话…'
              : '连接已中断，正在恢复。已显示内容和输入仍保留。'}
          </span>
        </div>
      )}
      <div
        className="workbench-demo-messages"
        aria-label="会话消息"
        ref={scroller}
        onClick={onContentLink}
        onScroll={onScroll}
      >
        <div className="workbench-demo-message-column" ref={column}>
          {!conversation.messages.length && (
            <div className="workbench-demo-chat-welcome">
              <span className="workbench-demo-welcome-icon">
                <Bot size={28} />
              </span>
              <h2>从一个问题开始</h2>
              <div className="workbench-demo-starters">
                {['总结项目资料中的关键事项', '检查当前环境的运行状态', '整理一份发布准备报告'].map(
                  (prompt) => (
                    <Button
                      key={prompt}
                      variant="outline"
                      onClick={() => {
                        draft.setText(prompt)
                        textarea.current?.focus()
                      }}
                    >
                      {prompt}
                      <ArrowUpRight size={14} />
                    </Button>
                  ),
                )}
              </div>
            </div>
          )}
          {historyWindow.hasEarlier && (
            <div className="workbench-demo-earlier-history">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  stopFollowing()
                  historyWindow.loadEarlier()
                }}
              >
                <History size={14} />
                加载更早消息（{historyWindow.hiddenTurnCount} 轮）
              </Button>
            </div>
          )}
          {historyWindow.visibleRows.map((message, rowIndex) => (
            <Message
              hasLaterAssistant={historyWindow.visibleRows
                .slice(rowIndex + 1)
                .some((row) => row.role === 'assistant' && row.turnId !== message.turnId)}
              key={message.id}
              message={message}
              turn={turnMap.get(message.turnId)}
              onPreview={onPreview}
              onRead={stopFollowing}
              busy={Boolean(currentBusy)}
              onAnswer={answerQuestion}
              userId={user.id}
              conversationId={conversation.id}
              connected={connectionReady}
              reasoning={reasoning}
              touchActions={touchActions}
              actionsDisabled={hasActive || Boolean(currentBusy) || !connectionReady}
              onEdit={setEditingMessage}
              onBranch={branch}
              onRetry={retry}
              canRetry={
                turnMap.get(message.turnId)?.id === lastTurn?.id &&
                ['completed', 'interrupted', 'failed'].includes(lastTurn?.status)
              }
            />
          ))}
          {pendingSend?.conversationId === conversation.id &&
            pendingSend.delivery !== 'queue' &&
            !conversation.messages.some(
              (message) => message.clientRequestId === pendingSend.id,
            ) && (
              <Message
                key={pendingSend.id}
                message={pendingSend}
                onPreview={onPreview}
                onRead={stopFollowing}
              />
            )}
          {waiting && !active.timeline && (
            <ClarificationDock
              key={active.question.id}
              userId={user.id}
              conversationId={conversation.id}
              question={active.question}
              busy={Boolean(currentBusy)}
              disabled={!connectionReady}
              onRead={stopFollowing}
              onAnswer={answerQuestion}
            />
          )}
        </div>
      </div>
      <div className="workbench-demo-composer" ref={composer}>
        {following && connectionReady && workStatus.active && (
          <div className="workbench-demo-live-state" data-phase={active?.phase}>
            <WorkStatus key={active.id} {...workStatus} />
          </div>
        )}
        {!following && conversation.messages.length > 0 && (
          <div className="workbench-demo-back-latest">
            <Button variant="outline" size="sm" onClick={latest} aria-label="回到最新消息">
              {connectionReady && workStatus.active && (
                <span className="workbench-demo-back-status">{workStatusLabel(workStatus)}</span>
              )}
              <ArrowDown size={14} />
              回到最新消息
            </Button>
          </div>
        )}
        <QueueStrip
          items={conversation.queue}
          paused={conversation.queuePaused}
          busy={Boolean(currentBusy)}
          connected={connectionReady}
          running={hasActive || Boolean(waiting)}
          onEdit={(item) => setEditing({ ...item })}
          onRemove={(item) =>
            perform(
              'queue',
              `/queue/${encodeURIComponent(item.id)}`,
              { expectedRevision: conversation.revision },
              'DELETE',
            )
          }
          onMove={reorder}
          onPause={() => perform('queue', '/queue/pause', {})}
          onResume={() => perform('queue', '/queue/resume', {})}
          onSend={(item) =>
            perform('queue', `/queue/${encodeURIComponent(item.id)}/send-now`, {
              expectedRevision: conversation.revision,
            })
          }
        />
        {error && (
          <div role="alert" className="workbench-demo-composer-notice is-error">
            <CircleAlert size={14} />
            <span>{error}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="关闭发送提示"
              onClick={() => setErrors((old) => ({ ...old, [conversation.id]: '' }))}
            >
              <X size={13} />
            </Button>
          </div>
        )}
        {draft.error && (
          <div role="status" className="workbench-demo-composer-notice">
            <CircleAlert size={14} />
            <span>{draft.error}</span>
            {draft.conflict ? (
              <div className="workbench-demo-inline-actions">
                <Button size="sm" variant="outline" onClick={() => draft.resolveConflict(true)}>
                  保留本地
                </Button>
                <Button size="sm" variant="ghost" onClick={() => draft.resolveConflict(false)}>
                  使用服务器草稿
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" onClick={draft.retry}>
                重试同步
              </Button>
            )}
          </div>
        )}
        {draft.attachments.length > 0 && (
          <div className="workbench-demo-pending-files">
            {draft.attachments.map((file) => (
              <div key={file.id} className="workbench-demo-pending-file">
                <Button variant="ghost" size="sm" onClick={() => onPreview(file)}>
                  <FileText size={14} />
                  {file.name}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`移除附件 ${file.name}`}
                  onClick={() => draft.removeAttachment(file.id)}
                >
                  <X size={12} />
                </Button>
              </div>
            ))}
          </div>
        )}
        {draft.attachments
          .filter((file) => ['unavailable', 'partial'].includes(file.extraction?.status))
          .map((file) => (
            <p key={`notice-${file.id}`} role="status" className="text-xs text-muted-foreground">
              {file.name}：{file.extraction.message}
            </p>
          ))}
        <div className="workbench-demo-input-box">
          <Textarea
            ref={textarea}
            rows={2}
            aria-label="输入问题"
            value={draft.text}
            placeholder={
              waiting
                ? '可以补充本轮要求，或将后续问题加入队列…'
                : hasActive
                  ? '补充要求，选择引导本轮或排队…'
                  : '向项目助手提问…'
            }
            onChange={(event) => draft.setText(event.target.value)}
            onCompositionStart={controls.onCompositionStart}
            onCompositionEnd={controls.onCompositionEnd}
            onPaste={(event) => {
              if (event.clipboardData.files.length) {
                event.preventDefault()
                void upload(event.clipboardData.files)
              }
            }}
            onKeyDown={controls.onKeyDown}
          />
          <div className="workbench-demo-input-toolbar">
            <div className="workbench-demo-input-tools">
              <input
                type="file"
                hidden
                ref={picker}
                multiple
                aria-label="选择会话附件"
                onChange={(event) => {
                  const element = event.currentTarget
                  void upload(element.files).finally(() => {
                    element.value = ''
                  })
                }}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="添加附件"
                disabled={Boolean(draft.uploading) || !connectionReady}
                onClick={() => picker.current?.click()}
              >
                <Paperclip size={17} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="workbench-demo-reference-button"
                onClick={onOpenContext}
              >
                <FileText size={15} />
                资料
              </Button>
              {draft.uploading > 0 && (
                <span className="workbench-demo-uploading">
                  <LoaderCircle size={13} className="workbench-demo-spin" />
                  上传中
                </span>
              )}
            </div>
            <ComposerActions
              behavior={controls.behavior}
              setBehavior={controls.setBehavior}
              running={hasActive}
              stopping={stoppingBusy || conversation.status === 'stopping'}
              hasContent={Boolean(draft.text.trim() || draft.attachments.length)}
              canSend={Boolean(canSend)}
              canSteer={canSteer}
              hasAttachments={Boolean(draft.attachments.length)}
              sending={currentBusy === 'send'}
              onSend={send}
              onStop={() => perform('stop', '/stop', { expectedTurnId: conversation.activeTurnId })}
              canContinue={['interrupted', 'failed'].includes(lastTurn?.status)}
              continueBusy={Boolean(currentBusy) || !connectionReady}
              onContinue={() => perform('continue', '/continue', { turnId: lastTurn.id })}
            />
          </div>
        </div>
        <div className="workbench-demo-composer-meta">
          <span>
            {currentBusy === 'send'
              ? '等待服务器确认…'
              : draft.uploading
                ? '附件上传完成后可发送'
                : receipt
                  ? `${receipt.delivery === 'steer' ? '引导' : receipt.delivery === 'queue' ? '排队消息' : '消息'}${receipt.status === 'accepted' || receipt.status === 'queued' ? '已接收' : ` · ${receipt.status}`}`
                  : conversation.mode === 'scenario'
                    ? '场景模式 · 用于验证交互时序'
                    : '只读分析 · 真实运行器'}
          </span>
          <span className="workbench-demo-keyboard-hint">
            Enter {controls.primaryDelivery === 'steer' ? '引导' : hasActive ? '排队' : '发送'} ·
            Shift + Enter 换行
          </span>
          <span className="workbench-demo-mobile-keyboard-hint">Enter 换行</span>
        </div>
      </div>
      <Dialog
        open={Boolean(editingMessage)}
        onOpenChange={(open) => {
          if (!open) setEditingMessage(null)
        }}
      >
        <DialogContent className="workbench-demo-edit-dialog">
          <DialogHeader>
            <DialogTitle>编辑并重新发送</DialogTitle>
            <DialogDescription>
              从这条消息创建新分支，保留原对话。原附件会一起带入。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="编辑消息内容"
            rows={6}
            value={editingMessage?.content || ''}
            onChange={(event) =>
              setEditingMessage((old) => ({ ...old, content: event.target.value }))
            }
          />
          <div className="workbench-demo-dialog-actions">
            <Button variant="ghost" onClick={() => setEditingMessage(null)}>
              取消
            </Button>
            <Button
              disabled={
                hasActive ||
                Boolean(currentBusy) ||
                !connectionReady ||
                (!editingMessage?.content.trim() && !editingMessage?.attachments?.length)
              }
              onClick={() => branch(editingMessage, editingMessage.content)}
            >
              {currentBusy === 'branch' && (
                <LoaderCircle size={14} className="workbench-demo-spin" />
              )}
              创建分支并发送
            </Button>
          </div>
          {error && (
            <p role="alert" className="workbench-demo-inline-error">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent className="workbench-demo-edit-dialog">
          <DialogHeader>
            <DialogTitle>编辑排队消息</DialogTitle>
            <DialogDescription className="sr-only">
              修改尚未开始执行的消息，原附件保持不变。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="排队消息内容"
            rows={5}
            value={editing?.text || ''}
            onChange={(event) => setEditing((old) => ({ ...old, text: event.target.value }))}
          />
          {editing?.attachments?.length > 0 && (
            <p className="workbench-demo-muted">
              附件：{editing.attachments.map((file) => file.name).join('、')}
            </p>
          )}
          <div className="workbench-demo-dialog-actions">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              disabled={
                Boolean(currentBusy) || (!editing?.text.trim() && !editing?.attachments?.length)
              }
              onClick={async () => {
                const result = await perform(
                  'queue',
                  `/queue/${encodeURIComponent(editing.id)}`,
                  { text: editing.text, expectedRevision: conversation.revision },
                  'PATCH',
                )
                if (result) setEditing(null)
              }}
            >
              保存修改
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
