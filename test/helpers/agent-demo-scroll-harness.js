import React, { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useChatScroll } from '../../web/src/agent-demo/use-chat-scroll'

// Isolated browser fixture: no login, backend, Agent run or fabricated business data.
function ScrollHarness() {
  const [conversationId, setConversationId] = useState('a')
  const [rows, setRows] = useState({ a: 35, b: 20 })
  const [composerHeight, setComposerHeight] = useState(80)
  const scrollerRef = useRef(null)
  const contentRef = useRef(null)
  const composerRef = useRef(null)
  const scroll = useChatScroll({
    conversationId,
    contentVersion: rows[conversationId],
    scrollerRef,
    contentRef,
    composerRef,
  })
  useLayoutEffect(() => {
    window.scrollHarness = {
      add: (count = 1) =>
        setRows((old) => ({ ...old, [conversationId]: old[conversationId] + count })),
      switch: setConversationId,
      composer: setComposerHeight,
      latest: scroll.scrollToLatest,
      hold: scroll.stopFollowing,
      // Markdown may grow after its parent commit without a contentVersion update.
      growDOM: (height = 120) => {
        const row = document.createElement('div')
        row.className = 'async-markdown'
        row.style.height = `${height}px`
        row.textContent = 'Asynchronously rendered text'
        contentRef.current.appendChild(row)
      },
      measure: () => ({
        id: conversationId,
        following: document.querySelector('main').dataset.following === 'true',
        top: scrollerRef.current.scrollTop,
        maximum: scrollerRef.current.scrollHeight - scrollerRef.current.clientHeight,
        height: scrollerRef.current.clientHeight,
      }),
    }
  })
  return React.createElement(
    'main',
    {
      'data-following': scroll.following,
      style: { display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 32px)' },
    },
    React.createElement(
      'div',
      {
        id: 'scroller',
        ref: scrollerRef,
        onScroll: scroll.onScroll,
        tabIndex: 0,
        style: {
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'scroll',
          scrollbarGutter: 'stable',
          border: '1px solid #888',
        },
      },
      React.createElement(
        'div',
        { id: 'content', ref: contentRef },
        ...Array.from({ length: rows[conversationId] }, (_, i) =>
          React.createElement(
            'article',
            {
              key: `${conversationId}-${i}`,
              'data-row': i,
              style: { height: 50, borderBottom: '1px solid #ddd' },
            },
            `${conversationId}: Message ${i + 1}`,
          ),
        ),
        React.createElement(
          'div',
          {
            id: 'nested',
            'data-scrollable': '',
            tabIndex: 0,
            style: { height: 80, overflowY: 'auto', border: '1px solid #444' },
          },
          React.createElement(
            'div',
            { style: { height: 500 } },
            'Tool output with an independent scroll position',
          ),
        ),
      ),
    ),
    React.createElement(
      'div',
      {
        id: 'composer',
        ref: composerRef,
        style: { height: composerHeight, flexShrink: 0, background: '#eee' },
      },
      'Composer',
    ),
  )
}

createRoot(document.getElementById('root')).render(React.createElement(ScrollHarness))
