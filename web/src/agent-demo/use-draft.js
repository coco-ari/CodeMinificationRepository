import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

const PREFIX = 'autoops:agent-demo:draft:'
const EMPTY = Object.freeze({
  text: '',
  attachments: [],
  revision: 0,
  dirty: false,
  uploading: 0,
  loading: false,
  error: '',
  conflict: null,
})
const sessions = new Map()

function sessionFor(userId) {
  if (!userId) return null
  if (!sessions.has(userId)) sessions.set(userId, new Map())
  return sessions.get(userId)
}

function entryFor(userId, conversationId) {
  const session = sessionFor(userId)
  if (!session || !conversationId) return null
  if (session.has(conversationId)) return session.get(conversationId)
  const key = `${PREFIX}${JSON.stringify([userId, conversationId])}`
  const entry = {
    key,
    userId,
    conversationId,
    snapshot: { ...EMPTY },
    listeners: new Set(),
    edit: 0,
    generation: 0,
    timer: null,
    saving: false,
    loaded: false,
    deleted: false,
    api: null,
  }
  try {
    const value = JSON.parse(localStorage.getItem(key))
    if (value && typeof value.text === 'string' && Array.isArray(value.attachments))
      entry.snapshot = {
        ...EMPTY,
        text: value.text,
        attachments: value.attachments,
        revision: Number(value.revision || 0),
        dirty: Boolean(value.dirty),
      }
  } catch {}
  session.set(conversationId, entry)
  return entry
}

function publish(entry, patch) {
  if (entry.deleted) return
  entry.snapshot = { ...entry.snapshot, ...patch }
  entry.listeners.forEach((listener) => listener())
}

function persist(entry) {
  if (entry.deleted) return
  try {
    const { text, attachments, revision, dirty } = entry.snapshot
    localStorage.setItem(entry.key, JSON.stringify({ text, attachments, revision, dirty }))
  } catch {
    publish(entry, { error: '浏览器草稿暂时无法保存，服务端同步成功前请保留此页面。' })
  }
}

function normalizeDraft(draft) {
  return {
    text: draft?.text || '',
    attachments:
      draft?.attachments ||
      (draft?.attachmentIds || []).map((id) => ({ id, name: '已上传附件', mime: '', size: 0 })),
    revision: Number(draft?.revision || 0),
  }
}

async function save(entry) {
  clearTimeout(entry.timer)
  if (
    entry.deleted ||
    !entry.loaded ||
    entry.saving ||
    !entry.snapshot.dirty ||
    entry.snapshot.conflict
  )
    return
  entry.saving = true
  const edit = entry.edit
  const value = entry.snapshot
  try {
    const response = await entry.api(
      `/conversations/${encodeURIComponent(entry.conversationId)}/draft`,
      {
        method: 'PUT',
        body: {
          text: value.text,
          attachmentIds: value.attachments.map((file) => file.id),
          revision: value.revision,
        },
      },
    )
    if (entry.deleted) return
    publish(entry, { revision: response.draft.revision, dirty: entry.edit !== edit, error: '' })
    persist(entry)
  } catch (error) {
    if (entry.deleted || error.name === 'AbortError') return
    if (error.status === 409) {
      try {
        const response = await entry.api(
          `/conversations/${encodeURIComponent(entry.conversationId)}/draft`,
        )
        publish(entry, {
          conflict: normalizeDraft(response.draft),
          error: '此草稿已在另一个页面更新。本地输入仍保留，请选择要使用的版本。',
        })
      } catch {
        publish(entry, { error: '草稿同步冲突，当前输入仍保留；连接恢复后可重试。' })
      }
    } else publish(entry, { error: '草稿尚未同步，当前输入已保留在此浏览器。' })
  } finally {
    entry.saving = false
    if (!entry.deleted && entry.snapshot.dirty && !entry.snapshot.error && !entry.snapshot.conflict)
      entry.timer = setTimeout(() => void save(entry), 300)
  }
}

function change(entry, patch) {
  if (!entry || entry.deleted) return
  entry.edit += 1
  publish(entry, { ...patch, dirty: true })
  persist(entry)
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => void save(entry), 450)
}

export function discardDraft(userId, conversationId) {
  const entry = sessions.get(userId)?.get(conversationId)
  if (entry) {
    clearTimeout(entry.timer)
    entry.deleted = true
    entry.generation += 1
    sessions.get(userId).delete(conversationId)
  }
  try {
    localStorage.removeItem(`${PREFIX}${JSON.stringify([userId, conversationId])}`)
  } catch {}
}

export function suspendDrafts(userId) {
  const session = sessions.get(userId)
  if (!session) return
  for (const entry of session.values()) {
    clearTimeout(entry.timer)
    entry.generation += 1
    persist(entry)
    entry.deleted = true
  }
  sessions.delete(userId)
}

async function readBase64(file) {
  const value = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
    reader.readAsDataURL(file)
  })
  return value.slice(value.indexOf(',') + 1)
}

export function useDraft({ userId, conversationId, api }) {
  const entry = useMemo(() => entryFor(userId, conversationId), [userId, conversationId])
  if (entry) entry.api = (path, options = {}) => api(path, { ...options, forUserId: userId })
  const apiRef = useRef(api)
  apiRef.current = api
  const subscribe = useCallback(
    (listener) => {
      if (!entry) return () => {}
      entry.listeners.add(listener)
      return () => entry.listeners.delete(listener)
    },
    [entry],
  )
  const getSnapshot = useCallback(() => entry?.snapshot || EMPTY, [entry])
  const draft = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY)

  useEffect(() => {
    if (!entry || entry.loaded) return
    let cancelled = false
    publish(entry, { loading: true })
    apiRef
      .current(`/conversations/${encodeURIComponent(conversationId)}/draft`)
      .then(({ draft: remote }) => {
        if (cancelled || entry.deleted) return
        const server = normalizeDraft(remote)
        entry.loaded = true
        if (entry.snapshot.dirty) {
          if (server.revision > entry.snapshot.revision) {
            publish(entry, {
              conflict: server,
              error: '另一页面已更新草稿，请选择保留本地输入或使用服务器版本。',
            })
          } else publish(entry, { revision: server.revision })
        } else {
          publish(entry, { ...server, error: '' })
          persist(entry)
        }
        void save(entry)
      })
      .catch((error) => {
        if (!cancelled && !entry.deleted && error.name !== 'AbortError')
          publish(entry, { error: '暂时无法读取服务器草稿，本地输入仍会保留。' })
      })
      .finally(() => {
        if (!cancelled) publish(entry, { loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [entry, conversationId])

  useEffect(() => {
    if (!entry) return
    const flush = () => {
      persist(entry)
      void save(entry)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [entry])

  const setText = (text) => change(entry, { text })
  const removeAttachment = (id) =>
    change(entry, { attachments: entry.snapshot.attachments.filter((file) => file.id !== id) })
  const upload = async (files) => {
    if (!entry || entry.deleted) return
    const selected = Array.from(files || [])
    if (!selected.length) return
    if (selected.some((file) => file.size > 8 * 1024 * 1024))
      throw new Error('单个附件不能超过 8 MiB')
    const generation = entry.generation
    publish(entry, { uploading: entry.snapshot.uploading + selected.length })
    for (const file of selected) {
      try {
        const data = await readBase64(file)
        if (entry.deleted || generation !== entry.generation) break
        const result = await entry.api(
          `/conversations/${encodeURIComponent(entry.conversationId)}/attachments`,
          {
            method: 'POST',
            body: { name: file.name, mime: file.type || 'application/octet-stream', data },
          },
        )
        if (entry.deleted || generation !== entry.generation) break
        change(entry, { attachments: [...entry.snapshot.attachments, result.attachment] })
      } catch (error) {
        if (!entry.deleted) publish(entry, { error: `${file.name}：${error.message}` })
      } finally {
        publish(entry, { uploading: Math.max(0, entry.snapshot.uploading - 1) })
      }
    }
  }
  const snapshot = () =>
    entry
      ? {
          conversationId: entry.conversationId,
          edit: entry.edit,
          text: entry.snapshot.text,
          attachmentIds: entry.snapshot.attachments.map((file) => file.id),
        }
      : null
  const clearSubmitted = (submitted) => {
    const original = sessions.get(userId)?.get(submitted?.conversationId)
    if (original && !original.deleted && original.edit === submitted.edit)
      change(original, { text: '', attachments: [], conflict: null, error: '' })
  }
  const resolveConflict = (keepLocal) => {
    if (!entry?.snapshot.conflict) return
    const server = entry.snapshot.conflict
    if (keepLocal) {
      publish(entry, { revision: server.revision, conflict: null, error: '' })
      void save(entry)
    } else {
      entry.edit += 1
      publish(entry, { ...server, dirty: false, conflict: null, error: '' })
      persist(entry)
    }
  }
  const retry = async () => {
    if (!entry) return
    try {
      const { draft: remote } = await entry.api(
        `/conversations/${encodeURIComponent(entry.conversationId)}/draft`,
      )
      entry.loaded = true
      const server = normalizeDraft(remote)
      if (entry.snapshot.dirty && server.revision > entry.snapshot.revision)
        publish(entry, { conflict: server, error: '服务器草稿已更新，请选择保留的版本。' })
      else {
        publish(
          entry,
          entry.snapshot.dirty
            ? { revision: server.revision, error: '' }
            : { ...server, dirty: false, conflict: null, error: '' },
        )
        persist(entry)
        void save(entry)
      }
    } catch {
      publish(entry, { error: '草稿同步仍未恢复，本地输入已保留。' })
    }
  }
  return {
    ...draft,
    setText,
    removeAttachment,
    upload,
    snapshot,
    clearSubmitted,
    resolveConflict,
    retry,
  }
}
