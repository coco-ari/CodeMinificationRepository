import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { resolveFollowGlideTarget } from './vendor/openchamber/follow-scroll'
import {
  isFollowReleaseKey,
  isMiddleButtonPan,
  nestedScrollable,
  nestedScrollableConsumesWheelUp,
  onRowExpand,
} from './vendor/openchamber/timeline-scroll-intent'

const END_TOLERANCE = 2
const EASING_MS = 70
const isEditable = (target) =>
  target instanceof Element && Boolean(target.closest('input,textarea,[contenteditable="true"]'))

/**
 * Follow actual DOM growth, without treating a resize or our own scroll write
 * as a reader gesture. One animation reads the newest end each frame: streamed
 * chunks never queue individual smooth-scroll animations behind one another.
 */
export function useChatScroll({
  conversationId,
  contentVersion,
  scrollerRef,
  contentRef,
  composerRef,
}) {
  const [following, setFollowing] = useState(true)
  const controller = useRef(null)
  const positions = useRef(new Map())
  const stopFollowing = useCallback(() => controller.current?.stop(), [])
  const scrollToLatest = useCallback(() => controller.current?.latest(), [])
  const onScroll = useCallback(() => controller.current?.onScroll(), [])

  useLayoutEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    const memory = positions.current.get(conversationId)
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const originalAnchor = node.style.overflowAnchor
    const originalBehavior = node.style.scrollBehavior
    node.style.overflowAnchor = 'none'
    node.style.scrollBehavior = 'auto'
    let active = true
    let follow = memory?.following ?? true
    let frame = null
    let lastFrameTime = 0
    let lastWrittenTop = null
    let lastTop = node.scrollTop
    let lastEnd = Math.max(0, node.scrollHeight - node.clientHeight)
    let touchY = null
    let touchTarget = null
    let bottomGestureFrame = null

    const end = () => Math.max(0, node.scrollHeight - node.clientHeight)
    const remember = () => {
      positions.current.set(conversationId, { top: lastTop, following: follow })
      // Reading positions are small but a long-lived workbench can open many chats.
      if (positions.current.size > 100)
        positions.current.delete(positions.current.keys().next().value)
    }
    const cancelFrame = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      lastFrameTime = 0
    }
    const setFollow = (value) => {
      if (follow === value) return
      follow = value
      setFollowing(value)
      remember()
    }
    const writeTop = (value) => {
      node.scrollTop = value
      lastWrittenTop = node.scrollTop
      lastTop = node.scrollTop
      lastEnd = end()
      remember()
    }
    const tick = (now) => {
      frame = null
      if (!active || !follow) return
      const maximum = end()
      const target = resolveFollowGlideTarget(maximum, node.scrollTop)
      if (target === null) {
        if (node.scrollTop !== maximum) writeTop(maximum)
        lastFrameTime = 0
        return
      }
      if (motion.matches) {
        writeTop(target)
        lastFrameTime = 0
        return
      }
      // Jump only the off-screen distance, then make a short visible glide.
      // This also bounds catch-up time after returning from a hidden tab.
      if (target - node.scrollTop > node.clientHeight) writeTop(target - node.clientHeight)
      const dt = lastFrameTime ? Math.min(48, now - lastFrameTime) : 16
      lastFrameTime = now
      const distance = target - node.scrollTop
      writeTop(node.scrollTop + Math.max(1, distance * (1 - Math.exp(-dt / EASING_MS))))
      if (target - node.scrollTop > 1) frame = requestAnimationFrame(tick)
      else {
        writeTop(target)
        lastFrameTime = 0
      }
    }
    const schedule = () => {
      if (active && follow && frame === null) frame = requestAnimationFrame(tick)
    }
    const stop = () => {
      cancelFrame()
      lastWrittenTop = null
      lastTop = node.scrollTop
      lastEnd = end()
      setFollow(false)
      remember()
    }
    const latest = () => {
      setFollow(true)
      schedule()
    }
    const handleScroll = () => {
      const top = node.scrollTop
      const maximum = end()
      const ownWrite = lastWrittenTop !== null && Math.abs(top - lastWrittenTop) <= 1
      // Content/viewport contraction can clamp scrollTop before ResizeObserver.
      // That is a layout consequence, not an upward scrollbar gesture.
      const clamped = maximum !== lastEnd && Math.abs(top - Math.min(lastTop, maximum)) <= 1
      if (!ownWrite && !clamped && Math.abs(top - lastTop) > 0.5) {
        // OpenChamber useChatTimelineScroll releases follow on real input,
        // never merely because a scroll event moved upward. When live work
        // settles, React moves the answer out of the collapsed activity; the
        // browser can temporarily clamp this node to zero before Markdown
        // restores its height. That layout write is not a reader gesture.
        // Wheel/touch/key/scrollbar/row-expand handlers own explicit opt-out.
        if (maximum - top <= END_TOLERANCE) latest()
      }
      lastTop = top
      lastEnd = maximum
      remember()
    }
    const resumeIfAtEnd = () => {
      if (bottomGestureFrame !== null) cancelAnimationFrame(bottomGestureFrame)
      bottomGestureFrame = requestAnimationFrame(() => {
        bottomGestureFrame = null
        if (active && end() - node.scrollTop <= END_TOLERANCE) latest()
      })
    }
    const wheel = (event) => {
      if (event.ctrlKey) return // A trackpad pinch zoom is not a reading gesture.
      if (event.deltaY < 0 && !nestedScrollableConsumesWheelUp(node, event.target)) stop()
      if (event.deltaY > 0 && !nestedScrollable(node, event.target)) resumeIfAtEnd()
    }
    const key = (event) => {
      if (isEditable(event.target)) return
      if (isFollowReleaseKey(event) && !nestedScrollableConsumesWheelUp(node, event.target)) stop()
      if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) resumeIfAtEnd()
    }
    const touchStart = (event) => {
      touchY = event.touches[0]?.clientY ?? null
      touchTarget = event.target
    }
    const touchMove = (event) => {
      const y = event.touches[0]?.clientY
      if (touchY !== null && y !== undefined) {
        const delta = y - touchY
        if (delta > 2 && !nestedScrollableConsumesWheelUp(node, touchTarget)) stop()
        if (delta < -2 && !nestedScrollable(node, touchTarget)) resumeIfAtEnd()
        touchY = y
      }
    }
    const pointer = (event) => {
      if (isMiddleButtonPan(node, event)) stop()
      const rect = node.getBoundingClientRect()
      if (
        event.target === node &&
        event.clientX >= rect.right - Math.max(12, node.offsetWidth - node.clientWidth)
      ) {
        stop() // Includes overlay scrollbar thumbs on macOS.
      }
    }
    const resize = new ResizeObserver(() => {
      if (follow) schedule()
      else {
        // Composer expansion changes the viewport, not the reader's chosen top.
        lastTop = node.scrollTop
        lastEnd = end()
        remember()
      }
    })
    resize.observe(node)
    if (contentRef.current) resize.observe(contentRef.current)
    if (composerRef.current) resize.observe(composerRef.current)
    const removeExpand = onRowExpand(node, stop)
    node.addEventListener('wheel', wheel, { passive: true })
    node.addEventListener('keydown', key)
    node.addEventListener('touchstart', touchStart, { passive: true })
    node.addEventListener('touchmove', touchMove, { passive: true })
    node.addEventListener('pointerdown', pointer)
    motion.addEventListener('change', schedule)
    controller.current = { stop, latest, onScroll: handleScroll, schedule }
    setFollowing(follow)
    // Restoration is immediate; opening a chat must not animate through history.
    writeTop(follow ? end() : Math.min(memory?.top ?? 0, end()))

    return () => {
      active = false
      remember()
      cancelFrame()
      if (bottomGestureFrame !== null) cancelAnimationFrame(bottomGestureFrame)
      resize.disconnect()
      removeExpand()
      node.removeEventListener('wheel', wheel)
      node.removeEventListener('keydown', key)
      node.removeEventListener('touchstart', touchStart)
      node.removeEventListener('touchmove', touchMove)
      node.removeEventListener('pointerdown', pointer)
      motion.removeEventListener('change', schedule)
      node.style.overflowAnchor = originalAnchor
      node.style.scrollBehavior = originalBehavior
      controller.current = null
    }
  }, [conversationId, scrollerRef, contentRef, composerRef])

  useLayoutEffect(() => {
    controller.current?.schedule()
  }, [conversationId, contentVersion])

  return { following, stopFollowing, scrollToLatest, onScroll }
}
