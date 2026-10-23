import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AutoOpsAccessError } from './access.mjs'

// Personal organization is deliberately outside the native run/event database.
// Mutation rules follow T3 fe27e8e Orchestrator.dispatchThreadMutation. Shared
// runs, queues, approvals, messages, errors and timestamps are never rewritten.
const types = new Set(['thread.archive','thread.unarchive','thread.settle','thread.auto-settle',
  'thread.unsettle','thread.snooze','thread.unsnooze','thread.auto-settle.set','thread.pin',
  'thread.unpin','thread.pin.reorder','thread.active.reorder','thread.visit','thread.mark-unread'])
const timeFields = new Set(['archivedAt','settledAt','unsettledAt','snoozedUntil','snoozedAt',
  'lastSnoozeWakeAt','pinnedAt','autoSettleDisabledAt','lastVisitedAt'])
const defaults = Object.freeze({ archivedAt:null, settledOverride:null, settledAt:null, unsettledAt:null,
  snoozedUntil:null, snoozedAt:null, lastSnoozeWakeAt:null, pinnedAt:null, autoSettleDisabledAt:null,
  pinOrderKey:null, activeOrderKey:null, lastVisitedAt:null })
const fail = (code, message) => { throw new AutoOpsAccessError(409, code, message) }
const id = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/u.test(value))
    throw new AutoOpsAccessError(400, 'INVALID_PREFERENCE_ID', `${label}无效`)
  return value
}
const millis = (value) => typeof value === 'number' ? value : typeof value?.epochMilliseconds === 'number'
  ? value.epochMilliseconds : typeof value?.epochMillis === 'number' ? value.epochMillis : value instanceof Date ? value.getTime() : Date.parse(value)
const timestamp = (value, label) => {
  const result = millis(value)
  if (!Number.isFinite(result)) throw new AutoOpsAccessError(400, 'INVALID_PREFERENCE_TIME', `${label}无效`)
  return new Date(result).toISOString()
}
const stable = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  : Array.isArray(value) ? value.map(stable) : value
export const isPersonalPreferenceCommand = (command) => types.has(command?.type)

export function initializePreferencesSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS t3_user_thread_preferences (
    principal_id TEXT NOT NULL, thread_id TEXT NOT NULL, revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(principal_id, thread_id));
    CREATE TABLE IF NOT EXISTS t3_user_preference_revisions (principal_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS t3_user_preference_commands (
      principal_id TEXT NOT NULL, command_id TEXT NOT NULL, digest TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(principal_id, command_id));`)
}

export function createPreferences({ db, now = Date.now, decodeTimestamp = (value) => value }) {
  initializePreferencesSchema(db)
  const listeners = new Map(), wakeTimers = new Map()
  let decode = decodeTimestamp
  const get = (principalId, threadId) => {
    const row = db.prepare('SELECT * FROM t3_user_thread_preferences WHERE principal_id=? AND thread_id=?').get(principalId, threadId)
    return row ? { ...row, value: JSON.parse(row.value_json) } : undefined
  }
  const emit = (change) => {
    for (const listener of listeners.get(change.principalId) ?? []) listener(change)
  }
  const write = (principalId, threadId, value) => {
    db.prepare('INSERT INTO t3_user_preference_revisions VALUES(?,1) ON CONFLICT(principal_id) DO UPDATE SET revision=revision+1').run(principalId)
    const { revision } = db.prepare('SELECT revision FROM t3_user_preference_revisions WHERE principal_id=?').get(principalId)
    const at = new Date(now()).toISOString()
    db.prepare('INSERT INTO t3_user_thread_preferences VALUES(?,?,?,?,?) ON CONFLICT(principal_id,thread_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,value_json=excluded.value_json').run(principalId, threadId, revision, at, JSON.stringify(value))
    return { principalId, threadId, revision }
  }
  const scheduleWake = (principalId, threadId, until) => {
    const key = JSON.stringify([principalId, threadId]); clearTimeout(wakeTimers.get(key)); wakeTimers.delete(key)
    if (!until) return
    const delay = Math.min(2 ** 31 - 1, Math.max(0, millis(until) - now()))
    const timer = setTimeout(() => {
      const row = get(principalId, threadId)
      if (!row || row.value.snoozedUntil !== until) return
      if (millis(until) > now()) { scheduleWake(principalId, threadId, until); return }
      db.exec('BEGIN IMMEDIATE')
      let change
      try { change = write(principalId, threadId, { ...row.value, snoozedUntil:null, snoozedAt:null, lastSnoozeWakeAt:until }); db.exec('COMMIT') }
      catch (error) { db.exec('ROLLBACK'); scheduleWake(principalId, threadId, until); return }
      wakeTimers.delete(key); emit(change)
    }, delay)
    timer.unref?.(); wakeTimers.set(key, timer)
  }
  const overlayThread = (principalId, thread) => {
    if (!thread) return thread
    const saved = get(id(principalId, '用户'), id(thread.id, '会话'))
    const personal = { ...defaults, ...saved?.value }
    // Match T3's effective snooze: a pending request or a later failure wakes it.
    if (personal.snoozedUntil && (millis(personal.snoozedUntil) <= now() || thread.pendingRuntimeRequest != null ||
      (thread.status === 'failed' && (!personal.snoozedAt || millis(thread.latestRunCompletedAt) > millis(personal.snoozedAt))))) {
      personal.lastSnoozeWakeAt = millis(personal.snoozedUntil) <= now() ? personal.snoozedUntil : new Date(now()).toISOString()
      personal.snoozedUntil = null; personal.snoozedAt = null
    }
    // New authored work makes a previously completed personal thread active again.
    if (personal.settledAt && millis(thread.latestUserAuthoredMessageAt ?? thread.latestUserMessageAt) > millis(personal.settledAt)) {
      personal.settledOverride = null; personal.settledAt = null; personal.unsettledAt = null
    }
    const mapped = Object.fromEntries(Object.entries(personal).map(([key, value]) => [key, timeFields.has(key) && value !== null ? decode(value) : value]))
    return { ...thread, ...mapped }
  }
  const overlayProjection = (principalId, projection) => {
    if (!projection?.thread) return projection
    const latestRun = projection.runs?.at(-1)
    const latestAuthored = projection.messages?.filter((message) => message.role === 'user' && !message.notification && !message.delegatedCompletion).at(-1)
    const thread = overlayThread(principalId, { ...projection.thread,
      ...(latestRun ? { latestRunCompletedAt:latestRun.completedAt, status:latestRun.status } : {}),
      ...(latestAuthored ? { latestUserAuthoredMessageAt:latestAuthored.createdAt } : {}),
      pendingRuntimeRequest:projection.runtimeRequests?.find((request) => request.status === 'pending') ?? null })
    return { ...projection, thread: { ...projection.thread, ...Object.fromEntries(Object.keys(defaults).map((key) => [key, thread[key]])) } }
  }
  const overlayShell = (principalId, snapshot, { location = 'active' } = {}) => {
    const all = new Map([...(snapshot.threads ?? []), ...(snapshot.archivedThreads ?? [])].map((thread) => [thread.id, overlayThread(principalId, thread)]))
    const active = [], archived = []
    for (const thread of all.values()) (thread.archivedAt === null ? active : archived).push(thread)
    if (location === 'archive') { const { archivedThreads: _old, ...rest } = snapshot; return { ...rest, threads:archived } }
    return { ...snapshot, threads:active, archivedThreads:location === 'all' ? archived : [] }
  }
  const applyCommand = (principalId, command, { thread, nativeSequence } = {}) => {
    if (!isPersonalPreferenceCommand(command)) return { handled:false }
    id(principalId, '用户'); id(command.commandId, '命令'); id(command.threadId, '会话')
    if (!Number.isSafeInteger(nativeSequence) || nativeSequence < 0) throw new AutoOpsAccessError(500, 'MISSING_NATIVE_SEQUENCE', '个人偏好回执缺少原生事件水位')
    if (!thread || thread.id !== command.threadId || thread.deletedAt != null) fail('THREAD_NOT_FOUND', '会话不存在')
    const digest = createHash('sha256').update(JSON.stringify(stable(command))).digest('hex')
    db.exec('BEGIN IMMEDIATE')
    let result, value, change
    try {
      const previous = db.prepare('SELECT * FROM t3_user_preference_commands WHERE principal_id=? AND command_id=?').get(principalId, command.commandId)
      if (previous) {
        if (previous.digest !== digest) fail('PREFERENCE_COMMAND_CONFLICT', '同一命令标识不能用于不同操作')
        result = JSON.parse(previous.result_json); db.exec('COMMIT'); return result
      }
      const row = get(principalId, command.threadId)
      value = { ...defaults, ...row?.value }
      const effective = overlayThread(principalId, thread)
      for (const key of Object.keys(defaults)) value[key] = timeFields.has(key) && effective[key] !== null ? timestamp(effective[key], key) : effective[key]
      const at = new Date(now()).toISOString()
      const blocking = thread.pendingRuntimeRequest?.blocking !== false && thread.pendingRuntimeRequest != null
      if (value.archivedAt && !['thread.unarchive','thread.visit','thread.mark-unread'].includes(command.type)) fail('THREAD_ARCHIVED', '会话已归档，请先恢复')
      if (command.type === 'thread.unarchive' && !value.archivedAt) fail('THREAD_NOT_ARCHIVED', '会话尚未归档')
      if (command.type === 'thread.pin.reorder' && !value.pinnedAt) fail('THREAD_NOT_PINNED', '会话未置顶，不能调整置顶排序')
      if (command.type === 'thread.active.reorder' && (value.pinnedAt || value.settledOverride === 'settled')) fail('THREAD_NOT_ACTIVE', '此会话不在活跃列表')
      switch (command.type) {
        case 'thread.archive': value.archivedAt = value.archivedAt ?? at; break
        case 'thread.unarchive': value.archivedAt = null; break
        case 'thread.auto-settle':
          if (value.settledOverride !== null || value.autoSettleDisabledAt !== null || value.pinnedAt !== null ||
            millis(thread.updatedAt) > millis(command.snapshotAt)) fail('STALE_AUTO_SETTLEMENT', '会话或个人状态已改变，取消自动完成')
          // fall through: same native guards and resulting organization fields.
        case 'thread.settle':
          if (blocking || thread.hasQueuedUserRun || thread.activityRunStatus || thread.activeRunId || ['preparing','starting','running','waiting','queued'].includes(thread.status)) fail('THREAD_BUSY', '会话仍在执行、排队或等待回应，暂不能标记完成')
          value = { ...value, settledOverride:'settled', settledAt:value.settledOverride === 'settled' && value.settledAt && !value.pinnedAt ? value.settledAt : command.settledAt ? timestamp(command.settledAt, '完成时间') : at,
            unsettledAt:null, pinnedAt:null, pinOrderKey:null, activeOrderKey:null, snoozedUntil:null, snoozedAt:null }; break
        case 'thread.unsettle': value = { ...value, settledOverride:'active', settledAt:null, unsettledAt:value.settledOverride === 'active' ? value.unsettledAt : at }; break
        case 'thread.snooze': {
          const until = timestamp(command.snoozedUntil, '唤回时间')
          if (millis(until) <= now()) fail('INVALID_SNOOZE_TIME', '唤回时间必须在未来')
          if (thread.pendingRuntimeRequest || thread.hasQueuedUserRun || thread.status === 'queued') fail('THREAD_NEEDS_ATTENTION', '会话正在等待回应或仍有排队输入，暂不能隐藏')
          value = { ...value, snoozedUntil:until, snoozedAt:at }; break
        }
        case 'thread.unsnooze': value = { ...value, snoozedUntil:null, snoozedAt:null, lastSnoozeWakeAt:value.snoozedUntil ? at : value.lastSnoozeWakeAt }; break
        case 'thread.auto-settle.set':
          if (typeof command.enabled !== 'boolean') fail('INVALID_AUTO_SETTLE', '自动完成设置无效')
          value.autoSettleDisabledAt = command.enabled ? null : value.autoSettleDisabledAt ?? at; break
        case 'thread.pin': value = { ...value, pinnedAt:value.pinnedAt ?? at,
          pinOrderKey:!value.pinnedAt && command.orderKey !== undefined ? id(command.orderKey, '排序值') : value.pinOrderKey,
          settledOverride:value.settledOverride === 'settled' ? 'active' : value.settledOverride,
          settledAt:value.settledOverride === 'settled' ? null : value.settledAt,
          lastSnoozeWakeAt:value.snoozedUntil ? at : value.lastSnoozeWakeAt, snoozedUntil:null, snoozedAt:null }; break
        case 'thread.unpin': value.pinnedAt = null; value.pinOrderKey = null; break
        case 'thread.pin.reorder': value.pinOrderKey = id(command.orderKey, '排序值'); break
        case 'thread.active.reorder': value.activeOrderKey = id(command.orderKey, '排序值'); break
        case 'thread.visit': {
          const visitedAt = timestamp(command.visitedAt, '阅读时间')
          if (!value.lastVisitedAt || millis(visitedAt) > millis(value.lastVisitedAt)) value.lastVisitedAt = visitedAt
          break
        }
        case 'thread.mark-unread':
          if (!Number.isFinite(millis(thread.latestRunCompletedAt))) fail('NO_COMPLETED_RUN', '会话尚无已完成的回复')
          value.lastVisitedAt = new Date(millis(thread.latestRunCompletedAt) - 1).toISOString(); break
      }
      change = write(principalId, command.threadId, value)
      result = { handled:true, sequence:nativeSequence, revision:change.revision, threadId:command.threadId }
      db.prepare('INSERT INTO t3_user_preference_commands VALUES(?,?,?,?,?)').run(principalId, command.commandId, digest, JSON.stringify(result), at)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    scheduleWake(principalId, command.threadId, value.snoozedUntil); emit(change)
    return result
  }
  try {
    for (const row of db.prepare('SELECT principal_id,thread_id,value_json FROM t3_user_thread_preferences').all()) scheduleWake(row.principal_id, row.thread_id, JSON.parse(row.value_json).snoozedUntil)
  } catch (error) { for (const timer of wakeTimers.values()) clearTimeout(timer); wakeTimers.clear(); throw error }
  return { applyCommand, overlayThread, overlayProjection, overlayShell,
    setTimestampDecoder(decoder) { decode = decoder },
    subscribe(principalId, listener) { id(principalId, '用户'); let targets = listeners.get(principalId); if (!targets) listeners.set(principalId, targets = new Set()); targets.add(listener); return () => { targets.delete(listener); if (!targets.size) listeners.delete(principalId) } },
    revision(principalId) { return db.prepare('SELECT revision FROM t3_user_preference_revisions WHERE principal_id=?').get(principalId)?.revision ?? 0 },
    dispose() { for (const timer of wakeTimers.values()) clearTimeout(timer); wakeTimers.clear(); listeners.clear() },
  }
}
let configured, configuredDb, configuredClosed = false
export function closeConfiguredPreferences() {
  if (configuredClosed) return
  configuredClosed = true
  try { configured?.dispose() } finally { configuredDb?.close() }
}
export function configuredPreferences(decodeTimestamp) {
  if (configuredClosed) throw Object.assign(new Error('个人偏好服务已关闭'), {status:503, code:'AUTOOPS_STOPPING'})
  if (process.env.AUTOOPS_T3_DATA_DIR === undefined) return undefined
  if (!process.env.AUTOOPS_T3_DATA_DIR.trim()) throw new Error('AUTOOPS_T3_DATA_DIR must not be empty')
  if (!configured) {
    const directory = resolve(process.env.AUTOOPS_T3_DATA_DIR); mkdirSync(directory, { recursive:true, mode:0o700 })
    const db = new DatabaseSync(join(directory, 't3-autoops.sqlite'))
    try { db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'); configured = createPreferences({ db }); configuredDb = db }
    catch (error) { db.close(); throw error }
  }
  if (decodeTimestamp) configured.setTimestampDecoder(decodeTimestamp)
  return configured
}
