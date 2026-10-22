// Adapted from OpenChamber, MIT License. Copyright (c) 2025 Bohdan Triapitsyn.
// Source: openchamber/openchamber@6491f51dbcf05d1e3f7f823049f5f097c96c234b
// packages/ui/src/components/chat/components/LiveTurnActivity.tsx
// packages/ui/src/components/chat/components/LiveActivityCollapse.tsx
// packages/ui/src/components/chat/message/MessageBody.tsx: final-answer divider
// Adaptations: local Part/step protocol, per-user-interruption segments, existing
// shadcn Button/lucide icons, and the AutoOps transcript's scroller selector.
// No OpenCode SDK, rendered-page tools, subagents, or diff summaries are invented.
// Full license: public/third-party/agent-demo-streaming-NOTICES.txt.
import {
  Component,
  createRef,
  Fragment,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { animate } from 'motion'
import { ChevronDown, ChevronRight, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CHAT_SCROLLER_SELECTOR, holdAnchor } from './vendor/openchamber/hold-anchor'
import { useActivityRowGlide } from './vendor/openchamber/use-activity-row-glide'
import { dispatchRowExpand } from './vendor/openchamber/timeline-scroll-intent'
import { projectTurnActivity } from './turn-activity-model'
import './turn-activity.css'

const contentBelowFoldOutOfView = (element) => {
  const scroller = element.closest(CHAT_SCROLLER_SELECTOR)
  const anchor = element.nextElementSibling
  if (!scroller || !anchor) return null
  const header = element
    .closest('[data-turn-id]')
    ?.querySelector(':scope > [data-turn-sticky-header]')
  const readingTop =
    scroller.getBoundingClientRect().top + (header?.getBoundingClientRect().height ?? 0)
  return element.getBoundingClientRect().bottom <= readingTop + 1 ? { scroller, anchor } : null
}

// OpenChamber keeps the visible message identity + viewport offset while its
// virtual list replaces rows (messageViewportAnchor.ts / holdAnchor.ts). Our
// transcript renders native DOM rows, and a final text Part moves out of the
// activity fold. Capture BEFORE that React mutation: a layout effect is too
// late because removing the old Markdown can already clamp scrollTop to zero.
// Only this protocol-specific Part move needs an adapter; the two-frame hold
// and its user-input cancellation remain the upstream holdAnchor mechanism.
class ActivityAnswerAnchor extends Component {
  root = createRef()
  release = null

  getSnapshotBeforeUpdate(previous) {
    this.props.transitionSnapshot.current = null
    const id = this.props.finalPartId
    if (!id || id === previous.finalPartId) return null
    const element = [...(this.root.current?.querySelectorAll('[data-part-id]') ?? [])].find(
      (node) => node.dataset.partId === id,
    )
    const scroller = element?.closest(CHAT_SCROLLER_SELECTOR)
    if (!element || !scroller) return null
    const rect = element.getBoundingClientRect()
    const viewport = scroller.getBoundingClientRect()
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) return null
    const snapshot = {
      id,
      scroller,
      top: rect.top,
      activityAboveViewport: rect.top <= viewport.top + 1,
    }
    this.props.transitionSnapshot.current = snapshot
    return snapshot
  }

  componentDidUpdate(_previous, _state, snapshot) {
    if (!snapshot) return
    this.release?.()
    const element = [...(this.root.current?.querySelectorAll('[data-part-id]') ?? [])].find(
      (node) => node.dataset.partId === snapshot.id,
    )
    if (element) this.release = holdAnchor(snapshot.scroller, element, snapshot.top)
  }

  componentWillUnmount() {
    this.release?.()
  }

  render() {
    const {
      finalPartId: _finalPartId,
      transitionSnapshot: _transitionSnapshot,
      children,
      ...props
    } = this.props
    return (
      <div {...props} ref={this.root}>
        {children}
      </div>
    )
  }
}

export function LiveActivityCollapse({
  expanded,
  children,
  id,
  animateOnMount = false,
  transitionSnapshot,
}) {
  const ref = useRef(null)
  const previousExpanded = useRef(expanded || animateOnMount)
  const [retained, setRetained] = useState(expanded || animateOnMount)
  const mounted = expanded || retained

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const settle = () => {
      element.style.height = expanded ? 'auto' : '0px'
      element.style.overflow = expanded ? 'visible' : 'hidden'
      setRetained(expanded)
    }
    if (previousExpanded.current === expanded) {
      settle()
      return
    }
    previousExpanded.current = expanded
    if (expanded) setRetained(true)
    // The final Part was inside this fold before the commit. Its old top is
    // the bottom of the remaining work; use that pre-mutation geometry when
    // native DOM replacement has temporarily clamped the viewport. This is
    // the same upstream rule: work entirely above the reader closes at once.
    if (!expanded && transitionSnapshot?.current?.activityAboveViewport) {
      settle()
      return
    }
    const outOfView = expanded ? null : contentBelowFoldOutOfView(element)
    if (outOfView) {
      const top = outOfView.anchor.getBoundingClientRect().top
      settle()
      return holdAnchor(outOfView.scroller, outOfView.anchor, top)
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settle()
      return
    }
    element.style.height = expanded ? '0px' : `${element.scrollHeight}px`
    element.style.overflow = 'hidden'
    const animation = animate(
      element,
      { height: expanded ? 'auto' : '0px' },
      { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
    )
    let cancelled = false
    const finish = () => {
      if (!cancelled) settle()
    }
    void animation.finished.then(finish, finish)
    return () => {
      cancelled = true
      animation.stop()
    }
  }, [expanded])

  return (
    <div
      ref={ref}
      id={id}
      aria-hidden={!expanded}
      inert={!expanded}
      data-live-activity-content="true"
      style={{
        height: mounted ? 'auto' : 0,
        overflow: mounted ? 'visible' : 'hidden',
        overflowAnchor: 'none',
      }}
    >
      {mounted ? children : null}
    </div>
  )
}

export function TurnActivity({
  parts = [],
  turn,
  messageId,
  finalSegment = true,
  hasLaterAssistant = false,
  showReasoning = true,
  renderPart,
  onRead,
}) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const rowsRef = useRef(null)
  const transitionSnapshot = useRef(null)
  const model = useMemo(
    () =>
      projectTurnActivity({
        parts,
        turn,
        finalSegment,
        hasLaterAssistant,
        showReasoning,
        expanded,
      }),
    [parts, turn, finalSegment, hasLaterAssistant, showReasoning, expanded],
  )
  useActivityRowGlide(rowsRef, model.hiddenRows, !model.settled && !expanded)
  useLayoutEffect(() => {
    const reveal = (event) => {
      if (event.detail?.messageId !== messageId) return
      setExpanded(true)
    }
    window.addEventListener('workbench-demo-reveal-activity', reveal)
    return () => window.removeEventListener('workbench-demo-reveal-activity', reveal)
  }, [messageId])

  if (!model.hasActivity)
    return parts.map((part) => <Fragment key={part.id}>{renderPart(part)}</Fragment>)

  const isExpanded = !model.settled || expanded
  return (
    <ActivityAnswerAnchor
      finalPartId={model.finalPart?.id}
      transitionSnapshot={transitionSnapshot}
      className="workbench-demo-turn-activity"
      data-live-turn-activity={turn?.id}
      data-activity-message-id={messageId}
      data-activity-settled={model.settled}
      data-activity-hidden-rows={model.hiddenRows}
    >
      <Button
        variant="ghost"
        size="sm"
        className="workbench-demo-activity-toggle"
        onClick={(event) => {
          if (!expanded) {
            dispatchRowExpand(event.currentTarget)
            onRead?.()
          }
          setExpanded((value) => !value)
        }}
        aria-expanded={expanded}
        aria-controls={contentId}
      >
        <Layers size={14} />
        <span className="workbench-demo-activity-title">活动</span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {!model.settled && model.hiddenRows > 0 ? (
          <span className="workbench-demo-activity-more">还有 {model.hiddenRows} 项</span>
        ) : null}
      </Button>
      <LiveActivityCollapse
        expanded={isExpanded}
        id={contentId}
        transitionSnapshot={transitionSnapshot}
      >
        <div ref={rowsRef}>
          {model.shownParts.map((part) => (
            <Fragment key={part.id}>{renderPart(part)}</Fragment>
          ))}
        </div>
      </LiveActivityCollapse>
      {model.finalPart ? (
        <div className="workbench-demo-activity-answer" data-activity-final-answer>
          <div className="workbench-demo-activity-divider" aria-hidden="true" />
          {renderPart(model.finalPart)}
        </div>
      ) : null}
    </ActivityAnswerAnchor>
  )
}
