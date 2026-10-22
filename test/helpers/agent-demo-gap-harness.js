import React, { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useDemo } from '../../web/src/agent-demo/use-demo'

// Real useDemo hook with controlled browser transport boundaries. No server
// state is fabricated inside the hook, and no model/backend is invoked.
const requests = []
const sources = []
const timers = []
const originalTimeout = window.setTimeout.bind(window)
window.setTimeout = (callback, delay, ...args) => {
  if (delay === 30 || delay === 1000) timers.push({ delay, at: performance.now() })
  return originalTimeout(callback, delay, ...args)
}
const conversation = ({
  seq = 1,
  revision = seq,
  text = 'A',
  reasoning = '',
  usage = null,
} = {}) => ({
  id: 'conversation-gap',
  eventSeq: seq,
  revision,
  status: 'running',
  activeTurnId: 'turn-gap',
  messages: [{ id: 'assistant-gap', role: 'assistant', turnId: 'turn-gap', content: text }],
  turns: [
    {
      id: 'turn-gap',
      status: 'running',
      usage,
      timeline: [
        { id: 'text-gap', type: 'text', text },
        ...(reasoning ? [{ id: 'reasoning-gap', type: 'reasoning', text: reasoning }] : []),
      ],
    },
  ],
  queue: [],
  artifacts: [],
})
const originalFetch = window.fetch.bind(window)
window.fetch = async (url, options = {}) => {
  if (url === '/api/agent-demo/bootstrap')
    return Response.json({
      user: { id: 'gap-user' },
      csrf: 'fixture-csrf',
      eventCursor: 1,
      projects: [],
      agents: [],
      conversations: [conversation()],
    })
  if (url === '/api/agent-demo/conversations/conversation-gap')
    return new Promise((resolve, reject) => {
      const request = {
        index: requests.length,
        at: performance.now(),
        settled: false,
        resolve,
        reject,
      }
      requests.push(request)
      options.signal?.addEventListener(
        'abort',
        () => {
          request.settled = true
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    })
  return originalFetch(url, options)
}
window.EventSource = class ControlledEventSource extends EventTarget {
  constructor(url) {
    super()
    this.url = url
    this.closed = false
    sources.push(this)
    queueMicrotask(() => {
      if (!this.closed) {
        this.onopen?.()
        this.dispatchEvent(new MessageEvent('ready', { data: JSON.stringify({ type: 'ready' }) }))
      }
    })
  }
  close() {
    this.closed = true
  }
  send(event) {
    if (!this.closed)
      this.dispatchEvent(
        new MessageEvent(event.type, {
          data: JSON.stringify(event),
          lastEventId: String(event.seq || ''),
        }),
      )
  }
}

let current
function Harness() {
  const demo = useDemo()
  useLayoutEffect(() => {
    current = demo
  })
  return React.createElement(
    'pre',
    { id: 'state' },
    JSON.stringify({
      connection: demo.connection,
      conversation: demo.conversations['conversation-gap'],
    }),
  )
}
const root = createRoot(document.getElementById('root'))
root.render(React.createElement(Harness))
window.gapHarness = {
  snapshot: () => JSON.parse(JSON.stringify(current?.conversations['conversation-gap'] ?? null)),
  ready: () => current?.connection === 'connected',
  requests: () => requests.map(({ index, at, settled }) => ({ index, at, settled })),
  timers: () => [...timers],
  send: (event) =>
    sources.at(-1).send({ conversationId: 'conversation-gap', turnId: 'turn-gap', ...event }),
  resolve: (index, snapshot) => {
    requests[index].settled = true
    requests[index].resolve(Response.json({ conversation: conversation(snapshot) }))
  },
  fail: (index) => {
    requests[index].settled = true
    requests[index].resolve(
      Response.json({ error: 'Controlled recovery failure' }, { status: 500 }),
    )
  },
  remove: () => current.remove('conversation-gap'),
  unmount: () => root.unmount(),
}
