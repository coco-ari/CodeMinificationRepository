// AutoOps search lifecycle adapter; range painting directly adapted from
// OpenChamber's CSS Highlight implementation (see vendor/openchamber/search-highlight.js).
import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  findTermRanges,
  paintSearchHighlights,
  toHighlightTerms,
} from './vendor/openchamber/search-highlight'

export function ConversationSearch({ rows, rootRef, onRead, showReasoning, onClose, revealRow }) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState(null)
  const input = useRef(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query)
      setSelected(null)
    }, 180)
    return () => clearTimeout(timer)
  }, [query])
  const terms = useMemo(() => toHighlightTerms(debounced), [debounced])
  const hits = useMemo(() => {
    if (!terms.length) return []
    return rows.flatMap((row) => {
      const searchable = row.parts?.filter(
        (part) => part.type === 'text' || (showReasoning && part.type === 'reasoning'),
      ) || [{ text: row.content }]
      const matching = searchable.filter((part) =>
        terms.some((term) => (part.text || '').toLowerCase().includes(term)),
      )
      return matching.length
        ? [
            {
              id: row.id,
              reasoning: matching
                .filter((part) => part.type === 'reasoning')
                .map((part) => part.id),
            },
          ]
        : []
    })
  }, [rows, terms, showReasoning])
  const index = selected ? hits.findIndex((hit) => hit.id === selected) : hits.length - 1
  const current = hits[Math.max(0, index)]
  const pendingJump = useRef(0)
  useEffect(
    () => () => {
      pendingJump.current += 1
    },
    [],
  )
  const jump = async (hit) => {
    const request = ++pendingJump.current
    if (!hit) return
    onRead()
    if (revealRow && !(await revealRow(hit.id))) return
    if (request !== pendingJump.current) return
    // OpenChamber's reveal store exposes the pending request at child mount.
    // Our event adapter must commit the parent before delivering to that child;
    // a single animation frame is not a React commit barrier.
    await Promise.resolve()
    if (request !== pendingJump.current) return
    flushSync(() => {
      window.dispatchEvent(
        new CustomEvent('workbench-demo-reveal-activity', { detail: { messageId: hit.id } }),
      )
    })
    flushSync(() => {
      for (const partId of hit.reasoning)
        window.dispatchEvent(
          new CustomEvent('workbench-demo-reveal-reasoning', { detail: { partId } }),
        )
    })
    requestAnimationFrame(() => {
      if (request !== pendingJump.current) return
      const node = rootRef.current?.querySelector(`[data-message-id="${CSS.escape(hit.id)}"]`)
      node?.scrollIntoView({ block: 'center', behavior: 'instant' })
    })
  }
  useEffect(() => {
    jump(current)
  }, [debounced])
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let frame = 0
    const paint = () => {
      frame = 0
      const node = current && root.querySelector(`[data-message-id="${CSS.escape(current.id)}"]`)
      paintSearchHighlights(findTermRanges(root, terms), node ? findTermRanges(node, terms) : [])
    }
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(paint)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    paint()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      paintSearchHighlights([], [])
    }
  }, [terms, current?.id, rootRef])
  const move = (direction) => {
    if (!hits.length) return
    const next = hits[(Math.max(0, index) + direction + hits.length) % hits.length]
    setSelected(next.id)
    jump(next)
  }
  return (
    <div
      className="workbench-demo-conversation-search"
      role="search"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          move(event.shiftKey ? -1 : 1)
        }
      }}
    >
      <Search size={15} />
      <Input
        ref={input}
        aria-label="搜索当前对话"
        placeholder="搜索当前对话"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <span role="status">{hits.length ? `${Math.max(0, index) + 1}/${hits.length}` : '0'} 条</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="上一条匹配"
        disabled={!hits.length}
        onClick={() => move(-1)}
      >
        <ArrowUp size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="下一条匹配"
        disabled={!hits.length}
        onClick={() => move(1)}
      >
        <ArrowDown size={14} />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="关闭对话搜索" onClick={onClose}>
        <X size={14} />
      </Button>
    </div>
  )
}
