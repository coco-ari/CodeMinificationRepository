import { useCallback, useEffect, useRef, useState } from 'react'
import { API, recordRender, request } from './api'
import { applyTimelineDelta } from './timeline'

const initial = {
  user: null,
  csrf: '',
  projects: [],
  agents: [],
  conversations: {},
  runtime: { liveAvailable: false, name: '', reason: '正在读取运行器状态' },
  booting: true,
  snapshotReady: false,
  connection: 'connecting',
  error: '',
}

function stableItems(next = [], previous = []) {
  const old = new Map(previous.map((item) => [item.id, item]))
  return next.map((item) => {
    const existing = old.get(item.id)
    return existing && JSON.stringify(item) === JSON.stringify(existing) ? existing : item
  })
}

function mergeConversation(current, incoming) {
  if (!incoming?.id) return current
  const old = current[incoming.id]
  const seq = Number(incoming.eventSeq || 0)
  if (
    old &&
    (Number(incoming.revision || 0) < Number(old.revision || 0) ||
      seq < Number(old._appliedSeq || old.eventSeq || 0))
  )
    return current
  return {
    ...current,
    [incoming.id]: {
      ...incoming,
      messages: stableItems(incoming.messages, old?.messages),
      turns: stableItems(incoming.turns, old?.turns),
      queue: stableItems(incoming.queue, old?.queue),
      artifacts: stableItems(incoming.artifacts, old?.artifacts),
      _appliedSeq: seq,
    },
  }
}

export function useDemo() {
  const [state, setState] = useState(initial)
  const current = useRef(state)
  const epoch = useRef(0)
  const cursor = useRef(0)
  const cursorInitialized = useRef(false)
  const requests = useRef(new Map())
  const pendingEvents = useRef([])
  const frame = useRef(0)
  const deleted = useRef(new Set())
  current.current = state

  const mutate = useCallback((recipe) => {
    setState((old) => {
      const next = recipe(old)
      current.current = next
      return next
    })
  }, [])

  const api = useCallback(
    async (path, options = {}) => {
      if (options.forUserId && options.forUserId !== current.current.user?.id)
        throw new DOMException('账号已切换', 'AbortError')
      const generation = epoch.current
      try {
        const value = await request(path, { ...options, csrf: current.current.csrf })
        if (generation !== epoch.current)
          throw new DOMException('账号已切换，请重新操作', 'AbortError')
        return value
      } catch (error) {
        if (error.status === 401 && generation === epoch.current) {
          epoch.current += 1
          cursor.current = 0
          cursorInitialized.current = false
          mutate(() => ({ ...initial, booting: false, connection: 'offline' }))
        }
        throw error
      }
    },
    [mutate],
  )

  const accept = useCallback(
    (conversation) => {
      if (!conversation?.id || deleted.current.has(conversation.id)) return
      mutate((old) => ({
        ...old,
        conversations: mergeConversation(old.conversations, conversation),
      }))
    },
    [mutate],
  )

  const readConversation = useCallback(
    async (id) => {
      if (!id || deleted.current.has(id)) return null
      if (requests.current.has(id)) return requests.current.get(id)
      const task = api(`/conversations/${encodeURIComponent(id)}`)
        .then(({ conversation }) => {
          accept(conversation)
          return conversation
        })
        .finally(() => requests.current.delete(id))
      requests.current.set(id, task)
      return task
    },
    [api, accept],
  )

  const bootstrap = useCallback(async () => {
    try {
      const value = await api('/bootstrap')
      const accountChanged = current.current.user?.id && current.current.user.id !== value.user?.id
      if (accountChanged) {
        epoch.current += 1
        cursor.current = 0
        cursorInitialized.current = false
        requests.current.clear()
        deleted.current.clear()
      }
      if (!cursorInitialized.current) {
        cursor.current = Math.max(0, Number(value.eventCursor) || 0)
        cursorInitialized.current = true
      }
      mutate((old) => {
        let conversations = {}
        for (const item of value.conversations || []) {
          if (deleted.current.has(item.id)) continue
          if (!accountChanged && old.conversations[item.id])
            conversations[item.id] = old.conversations[item.id]
          conversations = mergeConversation(conversations, item)
        }
        return {
          ...old,
          ...value,
          conversations,
          booting: false,
          snapshotReady: true,
          error: '',
        }
      })
    } catch (error) {
      if (error.name === 'AbortError') return
      mutate((old) => ({
        ...old,
        booting: false,
        error: error.status === 401 ? '' : error.message,
      }))
    }
  }, [api, mutate])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    if (!state.user || state.booting || !state.snapshotReady) return
    let stream
    let retry
    let closed = false
    let reconnects = 0
    const missing = new Set()
    const repairing = new Set()
    const requiredSeq = new Map()
    const repairTimers = new Map()

    const repair = (id) => {
      if (deleted.current.has(id)) {
        missing.delete(id)
        requiredSeq.delete(id)
        clearTimeout(repairTimers.get(id))
        repairTimers.delete(id)
        return
      }
      if (closed || repairing.has(id) || repairTimers.has(id) || !missing.has(id)) return
      repairing.add(id)
      let retryDelay = 30
      void readConversation(id)
        .then((conversation) => {
          if (conversation && Number(conversation.eventSeq || 0) >= (requiredSeq.get(id) || 0)) {
            missing.delete(id)
            requiredSeq.delete(id)
          }
        })
        .catch(() => {
          retryDelay = 1000
        })
        .finally(() => {
          repairing.delete(id)
          if (deleted.current.has(id)) {
            missing.delete(id)
            requiredSeq.delete(id)
          }
          if (closed || !missing.has(id)) return
          const timer = setTimeout(() => {
            repairTimers.delete(id)
            repair(id)
          }, retryDelay)
          repairTimers.set(id, timer)
        })
    }

    const drain = () => {
      frame.current = 0
      const batch = pendingEvents.current.splice(0)
      if (!batch.length || closed) return
      mutate((old) => {
        let next = old
        for (const { event } of batch) {
          const seq = Number(event.seq || 0)
          if (event.type === 'runtime.updated') {
            next = { ...next, runtime: event.payload }
            continue
          }
          const id = event.conversationId || event.payload?.conversation?.id
          if (event.type === 'conversation.deleted') {
            deleted.current.add(id)
            missing.delete(id)
            requiredSeq.delete(id)
            const conversations = { ...next.conversations }
            delete conversations[id]
            next = { ...next, conversations }
            continue
          }
          if (deleted.current.has(id)) continue
          if (event.type === 'conversation.updated') {
            next = {
              ...next,
              conversations: mergeConversation(next.conversations, event.payload?.conversation),
            }
            if (seq >= (requiredSeq.get(id) || 0)) {
              missing.delete(id)
              requiredSeq.delete(id)
            }
            continue
          }
          if (!['message.delta', 'reasoning.delta', 'turn.usage.updated'].includes(event.type))
            continue
          const conversation = next.conversations[id]
          if (
            !conversation ||
            (event.type === 'message.delta' &&
              !conversation.messages.some((message) => message.id === event.payload?.messageId))
          ) {
            missing.add(id)
            requiredSeq.set(id, Math.max(requiredSeq.get(id) || 0, seq))
            continue
          }
          if (seq <= Number(conversation._appliedSeq || conversation.eventSeq || 0)) continue
          const turns = applyTimelineDelta(conversation.turns, event)
          if (!turns || missing.has(id)) {
            missing.add(id)
            requiredSeq.set(id, Math.max(requiredSeq.get(id) || 0, seq))
            continue
          }
          next = {
            ...next,
            conversations: {
              ...next.conversations,
              [id]: {
                ...conversation,
                _appliedSeq: seq,
                revision: event.payload.revision ?? Number(conversation.revision || 0) + 1,
                turns,
                messages:
                  event.type !== 'message.delta'
                    ? conversation.messages
                    : conversation.messages.map((message) =>
                        message.id === event.payload.messageId
                          ? { ...message, content: (message.content || '') + event.payload.delta }
                          : message,
                      ),
              },
            },
          }
        }
        return next
      })
      requestAnimationFrame(() => {
        recordRender(batch[0].receivedAt, batch.length)
        for (const id of missing) repair(id)
      })
    }

    const receive = (message, fallbackType) => {
      if (closed || current.current.user?.id !== state.user.id) return
      try {
        const event = JSON.parse(message.data)
        event.type ||= fallbackType
        if (event.type === 'ready') {
          reconnects = 0
          mutate((old) => ({ ...old, connection: 'connected' }))
          return
        }
        const seq = Number(event.seq || message.lastEventId || 0)
        if (seq && seq <= cursor.current) return
        event.seq = seq
        cursor.current = Math.max(cursor.current, seq)
        pendingEvents.current.push({ event, receivedAt: performance.now() })
        if (!frame.current) frame.current = requestAnimationFrame(drain)
      } catch {
        mutate((old) => ({ ...old, error: '收到无法识别的更新，正在重新同步会话。' }))
        void bootstrap()
      }
    }

    const connect = () => {
      if (closed) return
      stream?.close()
      mutate((old) => ({ ...old, connection: reconnects ? 'reconnecting' : 'connecting' }))
      stream = new EventSource(`${API}/events?after=${cursor.current}`)
      stream.onmessage = (message) => receive(message, 'message')
      for (const type of [
        'ready',
        'conversation.updated',
        'message.delta',
        'reasoning.delta',
        'turn.usage.updated',
        'conversation.deleted',
        'runtime.updated',
      ])
        stream.addEventListener(type, (message) => receive(message, type))
      stream.onopen = () => {
        if (closed) return
        if (reconnects) void bootstrap()
      }
      stream.onerror = () => {
        if (closed) return
        stream.close()
        mutate((old) => ({ ...old, connection: 'reconnecting' }))
        reconnects += 1
        if (reconnects === 1) void bootstrap()
        retry = setTimeout(connect, Math.min(8000, 700 * 2 ** Math.min(reconnects - 1, 4)))
      }
    }
    const online = () => {
      clearTimeout(retry)
      connect()
    }
    connect()
    window.addEventListener('online', online)
    return () => {
      closed = true
      stream?.close()
      clearTimeout(retry)
      for (const timer of repairTimers.values()) clearTimeout(timer)
      cancelAnimationFrame(frame.current)
      frame.current = 0
      pendingEvents.current = []
      window.removeEventListener('online', online)
    }
  }, [state.user?.id, state.booting, state.snapshotReady, bootstrap, mutate, readConversation])

  const login = async (username, password) => {
    epoch.current += 1
    cursor.current = 0
    cursorInitialized.current = false
    deleted.current.clear()
    const value = await request('/login', { method: 'POST', body: { username, password } })
    mutate(() => ({ ...initial, ...value, booting: true }))
    await bootstrap()
  }

  const logout = async () => {
    await api('/logout', { method: 'POST', body: {} })
    epoch.current += 1
    cursor.current = 0
    cursorInitialized.current = false
    requests.current.clear()
    deleted.current.clear()
    mutate(() => ({ ...initial, booting: false, connection: 'offline' }))
  }

  const command = useCallback(
    async (path, body, method = 'POST') => {
      const value = await api(path, { method, ...(body !== undefined ? { body } : {}) })
      if (value.conversation) accept(value.conversation)
      return value
    },
    [api, accept],
  )

  const remove = (id) => {
    deleted.current.add(id)
    mutate((old) => {
      const conversations = { ...old.conversations }
      delete conversations[id]
      return { ...old, conversations }
    })
  }

  return { ...state, api, command, bootstrap, readConversation, login, logout, remove }
}
