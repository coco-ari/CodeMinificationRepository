// OpenChamber, MIT License. Copyright (c) 2025 Bohdan Triapitsyn.
// Source: openchamber/openchamber@6491f51dbcf05d1e3f7f823049f5f097c96c234b
// packages/ui/src/components/chat/lib/scroll/holdAnchor.ts
// Adaptation: AutoOps scroller selector; TypeScript types removed.
// Full license: public/third-party/agent-demo-streaming-NOTICES.txt.

export const CHAT_SCROLLER_SELECTOR = '.workbench-demo-messages'
const READER_INPUT_EVENTS = ['touchstart', 'pointerdown', 'keydown']

export const holdAnchor = (scroller, element, top) => {
  const align = () => {
    if (!element.isConnected) return
    const delta = element.getBoundingClientRect().top - top
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
  }
  const resizeObserver = new ResizeObserver(align)
  let frame = null
  const stop = () => {
    resizeObserver.disconnect()
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    for (const type of READER_INPUT_EVENTS) scroller.removeEventListener(type, stop)
  }
  align()
  resizeObserver.observe(element.closest('[data-turn-id]') ?? element)
  for (const type of READER_INPUT_EVENTS) scroller.addEventListener(type, stop, { passive: true })
  frame = requestAnimationFrame(() => {
    align()
    frame = requestAnimationFrame(() => {
      align()
      stop()
    })
  })
  return stop
}
