import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'

// Session ownership follows OpenChamber client.ts sendMessage/compactSession at
// 6491f51dbcf05d1e3f7f823049f5f097c96c234b: retain the runner session and send
// incremental turns. Codex App Server 0.159.2 owns history and auto-compaction:
// https://learn.chatgpt.com/docs/app-server (thread/start, thread/resume).
// This adapter stores identities and authorization fingerprints, never a second
// transcript or a home-grown summary. UI history remains owned by the host.
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function sessionAuthorization(run, runnerIdentity) {
  return {
    fixed: digest({
      runnerIdentity,
      projectId: run.context.projectId,
      environmentId: run.context.environmentId,
      documents: run.context.documents,
      // Observations and collection timestamps change every request. They are
      // fresh tool data, not authorization identity. Revoking a resource id is
      // a boundary change; a newer CPU value is not.
      resources: run.context.resources
        .map(({ id, environmentId, type }) => ({ id, environmentId, type }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    }),
    // New files may be admitted. Removing/replacing any previous file isolates
    // the old native context, whose tool results may still contain that file.
    attachments: run.readableAttachments.map(({ id, name, mime, contentDigest }) => [
      id,
      // Host file ids are immutable, including when a current image becomes a
      // historical reference without inline pixels on the following turn.
      digest({ name, mime, contentDigest }),
    ]),
  }
}

export function canReuseAuthorization(previous, next) {
  if (!previous || previous.fixed !== next.fixed) return false
  const current = new Map(next.attachments)
  return previous.attachments.every(([id, fingerprint]) => current.get(id) === fingerprint)
}

export class RuntimeSessions {
  constructor(directory = '') {
    this.directory = directory
    this.entries = new Map()
    this.pending = Promise.resolve()
  }

  async load() {
    if (!this.directory) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    try {
      const parsed = JSON.parse(await readFile(join(this.directory, 'sessions.json'), 'utf8'))
      if (parsed.version !== 1 || !Array.isArray(parsed.entries))
        throw new Error('Invalid sessions')
      this.entries = new Map(parsed.entries)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  select(session, authorization) {
    if (!session) return { mode: 'stateless', entry: null, bootstrap: true }
    const entry = this.entries.get(session.id)
    if (!entry) return { mode: 'created', entry: null, bootstrap: true }
    if (!canReuseAuthorization(entry.authorization, authorization)) {
      // No old transcript is replayed after access revocation. The host must
      // decide separately whether old visible messages remain visible to users.
      return { mode: 'authorization-reset', entry: null, bootstrap: false }
    }
    if (entry.revision !== session.revision)
      return { mode: 'revision-reset', entry: null, bootstrap: true }
    return { mode: 'resumed', entry, bootstrap: entry.initialized === false }
  }

  async bind(session, threadId, authorization, total = null, initialized = true) {
    if (!session) return
    const previous = this.entries.get(session.id)
    this.entries.set(session.id, {
      revision: session.revision,
      threadId,
      authorization,
      total,
      initialized,
      retiredThreadIds: [
        ...new Set([
          ...(previous?.retiredThreadIds || []),
          ...(previous?.threadId && previous.threadId !== threadId ? [previous.threadId] : []),
        ]),
      ],
    })
    await this.save()
  }

  async usage(session, threadId, total) {
    if (!session) return
    const entry = this.entries.get(session.id)
    if (entry?.threadId !== threadId || entry.revision !== session.revision) return
    entry.total = total
    await this.save()
  }

  async remove(id) {
    this.entries.delete(id)
    await this.save()
  }

  async beginDeletion(id) {
    const entry = this.entries.get(id)
    if (!entry) return []
    if (!entry.deletionPending) {
      entry.deletionPending = [...new Set([...(entry.retiredThreadIds || []), entry.threadId])]
      await this.save()
    }
    return [...entry.deletionPending]
  }

  async deletedThread(id, threadId) {
    const entry = this.entries.get(id)
    if (!entry?.deletionPending?.includes(threadId)) return
    entry.deletionPending = entry.deletionPending.filter((pending) => pending !== threadId)
    await this.save()
  }

  save() {
    if (!this.directory) return Promise.resolve()
    // Capture a coherent snapshot and serialize atomic replacements so a slow
    // write for another conversation cannot overwrite a newer binding.
    const text = JSON.stringify({ version: 1, entries: [...this.entries] })
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        const temporary = join(this.directory, `.sessions-${randomUUID()}.tmp`)
        await writeFile(temporary, text, { mode: 0o600 })
        await rename(temporary, join(this.directory, 'sessions.json'))
      })
    return this.pending
  }

  async flush() {
    await this.pending
  }
}
