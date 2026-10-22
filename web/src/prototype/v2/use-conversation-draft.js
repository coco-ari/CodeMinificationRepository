import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { fileDataUrl } from './agent-files'

const MAX_FILES = 6
const MAX_BYTES = 2 * 1024 * 1024
const SUPPORTED_FILES =
  /\.(md|markdown|txt|csv|json|pdf|doc|docx|xls|xlsx|ppt|pptx|png|jpg|jpeg|gif|webp)$/i
const TEXT_FILES = /\.(md|markdown|txt|csv|json)$/i
const IMAGE_FILES = /\.(png|jpg|jpeg|gif|webp)$/i
const EMPTY = Object.freeze({ input: '', attachments: [], loadingFiles: false, notice: 0 })
const DRAFT_PREFIX = 'wb:v2:conversation-draft:'
const drafts = new Map()
const discardedKeys = new Set()

const totalSize = (files) => files.reduce((total, file) => total + (Number(file.size) || 0), 0)
const isImage = (file) => file.type?.startsWith('image/') || IMAGE_FILES.test(file.name)

function publish(entry, changes) {
  entry.snapshot = { ...entry.snapshot, ...changes }
  entry.listeners.forEach((listener) => listener())
}

function report(entry, message, storageFailure = false) {
  if (storageFailure && entry.reportedStorageFailure) return
  if (storageFailure) entry.reportedStorageFailure = true
  entry.errors.push(message)
  publish(entry, { notice: entry.snapshot.notice + 1 })
}

function persist(entry) {
  clearTimeout(entry.saveTimer)
  entry.saveTimer = null
  if (entry.discarded || !entry.dirty) return
  try {
    const { input, attachments } = entry.snapshot
    if (!input && !attachments.length) window.localStorage.removeItem(entry.key)
    else
      window.localStorage.setItem(
        entry.key,
        JSON.stringify({ version: 1, scope: entry.scope, input, attachments }),
      )
    entry.dirty = false
  } catch {
    // 浏览器配额不足或禁止存储时继续保留内存草稿，每个会话只提示一次。
    report(entry, '草稿暂时无法保存到浏览器，当前页面内仍保留；刷新前请先复制重要内容。', true)
  }
}

function save(entry, immediately = false) {
  if (entry.discarded) return
  entry.dirty = true
  clearTimeout(entry.saveTimer)
  if (immediately) persist(entry)
  else entry.saveTimer = setTimeout(() => persist(entry), 200)
}

function getEntry(key, scope) {
  if (!key) return null
  if (drafts.has(key)) return drafts.get(key)
  const entry = {
    key,
    scope,
    snapshot: { ...EMPTY, attachments: [] },
    listeners: new Set(),
    errors: [],
    reportedStorageFailure: false,
    saveTimer: null,
    dirty: false,
    discarded: false,
    uploadGeneration: 0,
  }
  drafts.set(key, entry)
  try {
    // 清理失败也不在当前页面重新展示已删除的草稿；失败状态由清理调用方提示。
    const saved = discardedKeys.has(key) ? null : window.localStorage.getItem(key)
    if (saved) {
      const parsed = JSON.parse(saved)
      // 只读取当前账号、项目和会话的准确键，不扫描或回退到其他账号的草稿。
      if (parsed.version !== 1 || JSON.stringify(parsed.scope) !== JSON.stringify(scope))
        throw new Error('草稿归属不匹配')
      const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : []
      if (
        typeof parsed.input !== 'string' ||
        attachments.length > MAX_FILES ||
        totalSize(attachments) > MAX_BYTES ||
        attachments.some(
          (file) =>
            !file ||
            typeof file.id !== 'string' ||
            typeof file.name !== 'string' ||
            !Number.isFinite(file.size) ||
            file.size < 0 ||
            typeof file.mime !== 'string' ||
            typeof file.dataUrl !== 'string',
        )
      )
        throw new Error('草稿格式无效')
      entry.snapshot = { ...entry.snapshot, input: parsed.input, attachments }
    }
  } catch {
    report(entry, '本会话的浏览器草稿未能恢复；新输入仍会保留在当前页面。', true)
  }
  return entry
}

function removeDrafts(matches) {
  const keys = new Set()
  const removedEntries = []
  let success = true
  for (const [key, entry] of drafts) {
    if (!matches(entry.scope)) continue
    keys.add(key)
    clearTimeout(entry.saveTimer)
    entry.saveTimer = null
    entry.dirty = false
    entry.discarded = true
    entry.uploadGeneration += 1
    entry.errors.length = 0
    removedEntries.push(entry)
    drafts.delete(key)
  }
  try {
    // 只枚举本 hook 的命名空间；删除共享会话时需要同时清理各账号的草稿。
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(DRAFT_PREFIX)) continue
      let scope = null
      try {
        scope = JSON.parse(key.slice(DRAFT_PREFIX.length))
      } catch {
        // 全量重置也清理命名空间中无法解析的遗留键。
      }
      if (matches(scope)) keys.add(key)
    }
  } catch {
    success = false
  }
  for (const key of keys) {
    discardedKeys.add(key)
    try {
      window.localStorage.removeItem(key)
    } catch {
      success = false
    }
  }
  for (const entry of removedEntries)
    publish(entry, { input: '', attachments: [], loadingFiles: false })
  return success
}

// 返回 false 表示浏览器持久化清理未完成，调用方必须提示而非声称全部删除。
export function discardConversationDrafts({ projectId, conversationId }) {
  if (!projectId || !conversationId) return false
  return removeDrafts(
    (scope) => Array.isArray(scope) && scope[1] === projectId && scope[2] === conversationId,
  )
}

export function resetConversationDrafts() {
  return removeDrafts(() => true)
}

/**
 * 交互原型的本地草稿，不代表服务端存储或账号间的数据安全边界。
 * 上传归属在发起时固定；切换会话不会将异步结果写进另一个输入框。
 */
export function useConversationDraft({ userId, projectId, conversationId, agent, onError }) {
  const scope = [userId, projectId, conversationId]
  const key =
    userId && projectId && conversationId ? `${DRAFT_PREFIX}${JSON.stringify(scope)}` : null
  const entry = getEntry(key, scope)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const subscribe = useCallback(
    (listener) => {
      if (!entry) return () => {}
      entry.listeners.add(listener)
      return () => entry.listeners.delete(listener)
    },
    [entry],
  )
  const getSnapshot = useCallback(() => entry?.snapshot || EMPTY, [entry])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY)

  useEffect(() => {
    if (!entry || !onErrorRef.current) return
    const errors = entry.errors.splice(0)
    errors.forEach((message) => onErrorRef.current(message))
  }, [entry, snapshot.notice, onError])

  useEffect(() => {
    if (!entry) return
    const flush = () => persist(entry)
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flushWhenHidden)
      flush()
    }
  }, [entry])

  const setInput = useCallback(
    (value) => {
      if (!entry || entry.discarded) return
      const next = typeof value === 'function' ? value(entry.snapshot.input) : value
      if (next === entry.snapshot.input) return
      publish(entry, { input: String(next ?? '') })
      // 合并连续键入，避免每个字符都同步序列化附件；切换、后台与刷新时立即落盘。
      save(entry)
    },
    [entry],
  )
  const setAttachments = useCallback(
    (value) => {
      if (!entry || entry.discarded) return
      const next = typeof value === 'function' ? value(entry.snapshot.attachments) : value
      if (!Array.isArray(next)) return
      if (next.length > MAX_FILES || totalSize(next) > MAX_BYTES) {
        report(entry, '每轮最多附加 6 个文件，附件总计限 2 MiB。')
        return
      }
      publish(entry, { attachments: [...next] })
      save(entry, true)
    },
    [entry],
  )
  const clearDraft = useCallback(() => {
    if (!entry || entry.discarded) return
    // 明确清空后，使尚在读取的旧文件失效，防止发送后附件重新出现。
    entry.uploadGeneration += 1
    publish(entry, { input: '', attachments: [], loadingFiles: false })
    save(entry, true)
  }, [entry])

  const attachFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || [])
      if (!entry || entry.discarded || !files.length || !agent) return false
      if (entry.snapshot.loadingFiles) {
        report(entry, '本会话仍在读取附件，请完成后再添加。')
        return false
      }
      if (files.length + entry.snapshot.attachments.length > MAX_FILES) {
        report(entry, '一次最多附加 6 个文件')
        return false
      }
      if (files.some((file) => !SUPPORTED_FILES.test(file.name))) {
        report(entry, '支持图片、Markdown、文本、PDF 和 Office 文档')
        return false
      }
      if (
        files.some((file) => (isImage(file) ? !agent.supportsImages : !agent.supportsDocuments))
      ) {
        report(entry, '此 Agent 未声明支持该附件类型')
        return false
      }
      if (totalSize(files) + totalSize(entry.snapshot.attachments) > MAX_BYTES) {
        report(entry, '本地原型每轮附件总计限 2 MiB，以保证浏览器持久保存')
        return false
      }
      const generation = ++entry.uploadGeneration
      publish(entry, { loadingFiles: true })
      try {
        const loaded = await Promise.all(
          files.map(async (file) => ({
            id: `attachment-${crypto.randomUUID().slice(0, 8)}`,
            name: file.name,
            size: file.size,
            mime:
              file.type ||
              (isImage(file)
                ? `image/${file.name.split('.').pop().toLowerCase().replace('jpg', 'jpeg')}`
                : 'application/octet-stream'),
            dataUrl: await fileDataUrl(file),
            content: TEXT_FILES.test(file.name) ? await file.text() : undefined,
          })),
        )
        if (generation !== entry.uploadGeneration) return false
        const attachments = [...entry.snapshot.attachments, ...loaded]
        // 读取期间可能从队列恢复附件，完成时再检查会话总量。
        if (attachments.length > MAX_FILES || totalSize(attachments) > MAX_BYTES) {
          report(entry, '本会话附件已变化，加入后会超过 6 个文件或 2 MiB，请重新选择。')
          return false
        }
        publish(entry, { attachments })
        save(entry, true)
        return true
      } catch {
        if (generation === entry.uploadGeneration) report(entry, '附件读取失败，请重新选择')
        return false
      } finally {
        if (generation === entry.uploadGeneration) publish(entry, { loadingFiles: false })
      }
    },
    [entry, agent],
  )

  return {
    input: snapshot.input,
    setInput,
    attachments: snapshot.attachments,
    setAttachments,
    loadingFiles: snapshot.loadingFiles,
    attachFiles,
    clearDraft,
  }
}
