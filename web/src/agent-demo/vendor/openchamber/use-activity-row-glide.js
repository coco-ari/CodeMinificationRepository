// OpenChamber, MIT License. Copyright (c) 2025 Bohdan Triapitsyn.
// Source: openchamber/openchamber@6491f51dbcf05d1e3f7f823049f5f097c96c234b
// packages/ui/src/components/chat/components/useActivityRowGlide.ts
// TypeScript types removed; animation and measurement algorithm unchanged.
// Full license: public/third-party/agent-demo-streaming-NOTICES.txt.

import { useLayoutEffect, useRef } from 'react'

const GLIDE_MS = 220
const GLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const currentTranslateY = (element) => {
  const { transform } = getComputedStyle(element)
  if (transform === '' || transform === 'none') return 0
  return new DOMMatrixReadOnly(transform).m42
}

export const useActivityRowGlide = (rowsRef, hiddenRows, active) => {
  const previousRef = useRef(null)
  useLayoutEffect(() => {
    const rows = rowsRef.current
    const anchor = rows?.lastElementChild
    if (!rows || !anchor) {
      previousRef.current = null
      return
    }
    const top = anchor.getBoundingClientRect().top - rows.getBoundingClientRect().top
    const previous = previousRef.current
    previousRef.current = { anchor, top, hiddenRows }
    if (!active || !previous || hiddenRows <= previous.hiddenRows || prefersReducedMotion()) return
    if (!previous.anchor.isConnected) return
    const previousAnchorTop =
      previous.anchor.getBoundingClientRect().top - rows.getBoundingClientRect().top
    const delta = previous.top - previousAnchorTop
    if (delta <= 0.5) return
    const from = delta + currentTranslateY(rows)
    for (const animation of rows.getAnimations()) animation.cancel()
    rows.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], {
      duration: GLIDE_MS,
      easing: GLIDE_EASING,
    })
  })
}
