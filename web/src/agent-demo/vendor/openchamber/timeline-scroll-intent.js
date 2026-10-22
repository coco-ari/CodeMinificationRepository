// Adapted from OpenChamber, MIT License.
// Copyright (c) 2025 Bohdan Triapitsyn.
// Source: openchamber/openchamber@6491f51dbcf05d1e3f7f823049f5f097c96c234b
// packages/ui/src/components/chat/lib/scroll/timelineScrollIntent.ts
// Adaptation: also recognize existing overflow containers without requiring
// OpenChamber's data attribute. No OpenCode or application store dependency.

export const isFollowReleaseKey = (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return false
  if (event.key === ' ') return event.shiftKey
  return event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home'
}

export const nestedScrollable = (root, target) => {
  let node = target instanceof Element ? target : null
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
      const overflow = getComputedStyle(node).overflowY
      if (node.hasAttribute('data-scrollable') || /^(auto|scroll)$/.test(overflow)) return node
    }
    node = node.parentElement
  }
  return null
}

export const nestedScrollableConsumesWheelUp = (root, target) => {
  const nested = nestedScrollable(root, target)
  return nested !== null && nested.scrollTop > 0
}

export const isMiddleButtonPan = (root, event) =>
  event.button === 1 && nestedScrollable(root, event.target) === null

const ROW_EXPAND_EVENT = 'autoops:chat-row-expand'

export const dispatchRowExpand = (row) =>
  row?.dispatchEvent(new CustomEvent(ROW_EXPAND_EVENT, { bubbles: true }))

export const onRowExpand = (container, listener) => {
  container.addEventListener(ROW_EXPAND_EVENT, listener)
  return () => container.removeEventListener(ROW_EXPAND_EVENT, listener)
}
