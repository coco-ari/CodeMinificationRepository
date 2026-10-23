import { useEffect, type RefObject } from 'react'
import { fileScrollViewports } from '~/components/files/fileSurfaceChrome'
import { readSelection, saveSelection } from './workspaceViewState'

/** 资源身份由调用方确定；异步原生预览装配后恢复，用户新滚动优先。 */
export function useWorkspaceFileScroll(
  root: RefObject<HTMLElement | null>,
  key: string,
  renderScope: string | null | undefined,
) {
  useEffect(() => {
    const element = root.current
    if (!element) return
    let saved: Array<{ top: number; left: number }> = []
    try {
      const parsed: unknown = JSON.parse(readSelection(key) ?? '[]')
      saved = Array.isArray(parsed)
        ? parsed.filter(
            (entry) =>
              entry &&
              typeof entry.top === 'number' &&
              Number.isFinite(entry.top) &&
              entry.top >= 0 &&
              typeof entry.left === 'number' &&
              Number.isFinite(entry.left) &&
              entry.left >= 0,
          )
        : []
    } catch {
      /* 无效的历史位置不影响当前浏览。 */
    }
    const restoredVertical = new WeakSet<HTMLElement>()
    const restoredHorizontal = new WeakSet<HTMLElement>()
    const observed = new WeakSet<Element>()
    let interrupted = false
    const viewports = () => fileScrollViewports(element)
    const restore = () => {
      if (interrupted) return
      viewports().forEach((viewport, index) => {
        // 原生代码预览异步绘制并调整高度，需等可滚动范围就绪后再恢复。
        for (const target of [viewport, viewport.firstElementChild]) {
          if (target && !observed.has(target)) {
            observed.add(target)
            resizeObserver.observe(target)
          }
        }
        const position = saved[index]
        if (!position) return
        // 窗口尺寸或换行变化后，分别钳制两轴；内容继续绘制时仍可恢复原位置。
        if (!restoredVertical.has(viewport)) {
          const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
          viewport.scrollTop = Math.min(position.top, maxTop)
          if (position.top <= maxTop) restoredVertical.add(viewport)
        }
        if (!restoredHorizontal.has(viewport)) {
          const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
          viewport.scrollLeft = Math.min(position.left, maxLeft)
          if (position.left <= maxLeft) restoredHorizontal.add(viewport)
        }
      })
    }
    const remember = () => {
      if (!interrupted && saved.length > viewports().length) return
      if (
        interrupted ||
        viewports().every(
          (viewport, index) =>
            !saved[index] || (restoredVertical.has(viewport) && restoredHorizontal.has(viewport)),
        )
      )
        saveSelection(
          key,
          JSON.stringify(
            viewports().map((viewport) => ({ top: viewport.scrollTop, left: viewport.scrollLeft })),
          ),
        )
    }
    const interact = () => {
      interrupted = true
    }
    const resizeObserver = new ResizeObserver(restore)
    const observer = new MutationObserver(restore)
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    element.addEventListener('scroll', remember, true)
    element.addEventListener('wheel', interact, { passive: true })
    element.addEventListener('pointerdown', interact, { passive: true })
    element.addEventListener('keydown', interact)
    restore()
    return () => {
      observer.disconnect()
      resizeObserver.disconnect()
      element.removeEventListener('scroll', remember, true)
      element.removeEventListener('wheel', interact)
      element.removeEventListener('pointerdown', interact)
      element.removeEventListener('keydown', interact)
    }
  }, [root, key, renderScope])
}
