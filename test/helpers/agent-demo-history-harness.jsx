import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '../../web/src/components/ui/button'
import { useHistoryWindow } from '../../web/src/agent-demo/use-history-window'
import { useChatScroll } from '../../web/src/agent-demo/use-chat-scroll'

const makeTurns = (prefix, from, count) =>
  Array.from({ length: count }, (_, offset) => {
    const turn = from + offset
    return Array.from({ length: 5 }, (_, part) => ({
      id: `${prefix}-${turn}-${part}`,
      turnId: `${prefix}-${turn}`,
      sourceMessageId: part === 3 ? `${prefix}-${turn}-1` : undefined,
      role: part % 2 ? 'assistant' : 'user',
      text: `第 ${turn} 轮 · ${part}：${part === 2 ? '本轮引导' : part === 4 ? '澄清回答' : '正文'}。`,
    }))
  }).flat()

function Harness() {
  const [conversationId, setConversationId] = useState('a')
  const [rows, setRows] = useState(() => makeTurns('a', 0, 90))
  const scrollerRef = useRef(null)
  const contentRef = useRef(null)
  const composerRef = useRef(null)
  const scroll = useChatScroll({
    conversationId,
    contentVersion: rows,
    scrollerRef,
    contentRef,
    composerRef,
  })
  const history = useHistoryWindow({ rows, conversationId, scrollerRef })
  useEffect(() => {
    window.historyHarness = {
      state: () => ({
        conversationId,
        total: history.totalTurnCount,
        hidden: history.hiddenTurnCount,
        ids: history.visibleRows.map((row) => row.id),
        following: scroll.following,
      }),
      earlier: history.loadEarlier,
      reveal: history.revealRow,
      append: () =>
        setRows((old) => [
          ...old,
          ...makeTurns(conversationId, new Set(old.map((row) => row.turnId)).size, 1),
        ]),
      extend: () =>
        setRows((old) =>
          old.map((row, index) =>
            index === old.length - 1 ? { ...row, text: row.text + '新文本。'.repeat(100) } : row,
          ),
        ),
      switch: (id, count = 80) => {
        setConversationId(id)
        setRows(makeTurns(id, 0, count))
      },
      replace: (count) => setRows(makeTurns(conversationId, 0, count)),
      latest: scroll.scrollToLatest,
    }
  })
  return (
    <>
      <Button data-testid="earlier" disabled={!history.hasEarlier} onClick={history.loadEarlier}>
        加载更早的 {history.hiddenTurnCount} 轮
      </Button>
      <div
        data-testid="scroller"
        ref={scrollerRef}
        onScroll={scroll.onScroll}
        style={{
          overflowY: 'auto',
          height: 400,
          width: 480,
          border: '1px solid',
          overflowAnchor: 'none',
        }}
      >
        <div ref={contentRef}>
          {history.visibleRows.map((row) => (
            <article
              key={row.id}
              data-message-id={row.id}
              data-turn-id={row.turnId}
              style={{
                minHeight: 50,
                padding: 8,
                boxSizing: 'border-box',
                borderBottom: '1px solid #ccc',
              }}
            >
              <p>{row.text}</p>
            </article>
          ))}
        </div>
      </div>
      <div ref={composerRef}>
        <Button onClick={scroll.scrollToLatest}>回到最新</Button>
      </div>
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
)
