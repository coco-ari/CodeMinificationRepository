import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, rename, rm, writeFile, readdir, chmod } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { verifyLegacySnapshot } from './legacy-snapshot.mjs'
import { rebaseNativeRolloutPaths } from './t3-native-paths.mjs'
import { initializeAutoOpsAccessSchema } from '../t3-adapters/access.mjs'
import { initializePreferencesSchema } from '../t3-adapters/preferences.mjs'
import { createBusinessArtifactStore } from '../t3-adapters/business-tools.mjs'
import { projects, agents, users } from '../fixtures.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const key = (kind, ...parts) => `legacy-${kind}-${digest(JSON.stringify(parts))}`
const date = (value, fallback) => {
  const n = Date.parse(value)
  if (Number.isFinite(n)) return new Date(n).toISOString()
  if (fallback) return fallback
  throw new Error('旧会话缺少有效时间，拒绝编造历史时间')
}
const terminal = (value) => ['completed', 'interrupted', 'failed', 'cancelled'].includes(value)
const normalizedStatus = (value) => (terminal(value) ? value : 'interrupted')
const safeInside = (base, path) => {
  const r = relative(base, path)
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)
}
async function* rows(snapshot, table, manifest) {
  if (!manifest.tables[table]) return
  const stream = createReadStream(join(snapshot, 'tables', `${table}.ndjson`))
  const input = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of input) if (line.trim()) yield JSON.parse(line)
  } finally {
    input.close()
    stream.destroy()
  }
}
async function secureTree(path) {
  await chmod(path, 0o700)
  for (const ent of await readdir(path, { withFileTypes: true })) {
    const child = join(path, ent.name)
    if (ent.isSymbolicLink()) throw new Error('原生状态不允许符号链接')
    if (ent.isDirectory()) await secureTree(child)
    else if (ent.isFile()) await chmod(child, 0o600)
    else throw new Error('原生状态包含不支持文件')
  }
}
async function shaFile(path) {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk)
  return h.digest('hex')
}
async function regularFiles(root, dir = root) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) throw new Error('原生状态不允许符号链接')
    if (e.isDirectory()) out.push(...(await regularFiles(root, p)))
    else if (e.isFile()) out.push(relative(root, p).split(sep).join('/'))
    else throw new Error('原生状态包含不支持文件')
  }
  return out.sort()
}

/** Evidence only: never invent a provider ID, create a rollout or start a provider. */
async function nativeEvidence(snapshot, manifest, restoredCodexHome) {
  const sessions = new Map(),
    rollouts = new Map()
  let restoredIndex = null
  for (const file of manifest.files) {
    if (!file.path.startsWith('native/')) continue
    if (file.path.endsWith('/sessions.json')) {
      const data = JSON.parse(await readFile(join(snapshot, file.path), 'utf8'))
      if (data.version === 1 && Array.isArray(data.entries))
        for (const [id, entry] of data.entries) {
          if (sessions.has(id)) sessions.set(id, null)
          else sessions.set(id, entry)
        }
    }
    if (file.path.endsWith('.jsonl')) {
      const stream = createReadStream(join(snapshot, file.path))
      const input = createInterface({ input: stream, crlfDelay: Infinity })
      let meta
      try {
        for await (const line of input) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event.type === 'session_meta') meta = event.payload
          break
        }
      } finally {
        input.close()
        stream.destroy()
      }
      if (typeof meta?.id === 'string') {
        if (rollouts.has(meta.id)) rollouts.set(meta.id, null)
        else
          rollouts.set(meta.id, { ...file, nativeRoot: file.path.split(/\/(?:sessions|archived_sessions)\//)[0] })
      }
    }
  }
  if (restoredCodexHome) {
    const home = resolve(restoredCodexHome)
    const actual = await regularFiles(home)
    // Match the actual CODEX_HOME subtree when the snapshot includes its runner parent.
    const candidateHomes = new Set(manifest.native.map(entry => entry.path))
    for (const rollout of rollouts.values()) if (rollout) candidateHomes.add(rollout.nativeRoot)
    for (const path of candidateHomes) {
      const entry = { path }
      const expected = manifest.files
        .filter((f) => f.path.startsWith(entry.path + '/'))
        .map((f) => ({ ...f, local: f.path.slice(entry.path.length + 1) }))
        .sort((a, b) => a.local.localeCompare(b.local))
      if (expected.length !== actual.length || !expected.every((f) => actual.includes(f.local)))
        continue
      let match = true
      for (const f of expected)
        if ((await shaFile(join(home, f.local))) !== f.sha256) {
          match = false
          break
        }
      if (match) {
        if (restoredIndex) throw new Error('原生恢复目录对应多个来源，拒绝含糊绑定')
        restoredIndex = entry.path
      }
    }
    if (!restoredIndex) throw new Error('restoredCodexHome 与快照原生目录的完整文件清单/哈希不一致')
  }
  return { sessions, rollouts, restoredIndex }
}
function checkNative(c, evidence) {
  const session = evidence.sessions.get(c.id),
    ref = c.runtimeSession,
    rollout = ref?.threadId ? evidence.rollouts.get(ref.threadId) : null
  if (c.mode !== 'live' || c.activeTurnId || (c.turns || []).some((t) => !terminal(t.status)))
    return { verified: false, reason: '旧会话不是已终止的真实运行' }
  if (
    !ref?.threadId ||
    ref.pending ||
    !Number.isSafeInteger(ref.revision) ||
    ref.revision !== (c.runtimeContextRevision || 0)
  )
    return { verified: false, reason: '应用原生会话/上下文版本依据缺失或不一致' }
  if (
    !session ||
    session.initialized !== true ||
    session.threadId !== ref.threadId ||
    session.revision !== ref.revision ||
    session.deletionPending
  )
    return { verified: false, reason: '运行器 sessions.json 没有匹配的已初始化绑定' }
  if (!rollout || rollout.nativeRoot !== evidence.restoredIndex)
    return { verified: false, reason: '真实 rollout 或完整恢复目录校验未通过' }
  const last = (c.turns || []).at(-1)
  if (!last || last.runnerThreadId !== ref.threadId)
    return { verified: false, reason: '最后一轮没有匹配的原生线程凭据' }
  return {
    verified: true,
    nativeThreadId: ref.threadId,
    rolloutSha256: rollout.sha256,
    revision: ref.revision,
  }
}

/** Staging is the transaction boundary across independent databases and files. */
export async function importLegacySnapshot(options, nativeWriter) {
  const snapshot = resolve(options.snapshot),
    target = resolve(options.target)
  if (snapshot === target || safeInside(snapshot, target) || safeInside(target, snapshot))
    throw new Error('新数据目录与恢复包不能互相包含')
  const manifest = await verifyLegacySnapshot(snapshot)
  if (manifest.quiesced !== true) throw new Error('只有停写后的 quiesced 快照可以导入')
  if (typeof options.model !== 'string' || !options.model.trim())
    throw new Error('必须明确固定模型')
  try {
    await lstat(target)
    throw new Error('新数据目录已存在，拒绝覆盖')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const sourceHash = digest(await readFile(join(snapshot, 'manifest.json')))
  const evidence = await nativeEvidence(snapshot, manifest, options.restoredCodexHome)
  const conversations = []
  for await (const row of rows(snapshot, 'conversations', manifest)) {
    const c = JSON.parse(row.body)
    if (c.id !== row.id) throw new Error('会话ID与表键不一致')
    conversations.push(c)
  }
  const nativeIds = new Set()
  const mappings = new Map()
  for (const c of conversations) {
    const proof = checkNative(c, evidence)
    if (proof.verified) {
      if (nativeIds.has(proof.nativeThreadId))
        throw new Error('多个旧会话绑定同一原生线程，拒绝迁移')
      nativeIds.add(proof.nativeThreadId)
    }
    mappings.set(c.id, { threadId: c.id, ...proof })
  }
  const stage = `${target}.partial-${randomUUID()}`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await mkdir(stage, { mode: 0o700 })
  let acl, artifacts, nativePathRebase
  try {
    await cp(join(snapshot, 'demo.sqlite'), join(stage, 'demo.sqlite'), {
      errorOnExist: true,
      force: false,
    })
    await chmod(join(stage, 'demo.sqlite'), 0o600)
    const host = new DatabaseSync(join(stage, 'demo.sqlite'))
    try {
      for (const t of ['sessions', 'requests'])
        if (host.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
          host.exec(`DELETE FROM ${t}`)
    } finally {
      host.close()
    }
    await mkdir(join(stage, 't3/userdata/attachments'), { recursive: true, mode: 0o700 })
    for (const project of projects) await mkdir(join(stage, 't3/workspaces', project.id), {recursive:true,mode:0o700})
    if (evidence.restoredIndex) {
      await cp(join(snapshot, evidence.restoredIndex), join(stage, 't3/codex-home'), {
        recursive: true,
        errorOnExist: true,
        force: false,
      })
      await secureTree(join(stage, 't3/codex-home'))
      nativePathRebase = await rebaseNativeRolloutPaths({homeDirectory:join(stage,'t3/codex-home'), finalHomeDirectory:join(target,'t3/codex-home'), quiesced:true})
    }
    acl = new DatabaseSync(join(stage, 't3-autoops.sqlite'))
    initializeAutoOpsAccessSchema(acl)
    initializePreferencesSchema(acl)
    acl.exec(`CREATE TABLE t3_legacy_import_records(kind TEXT NOT NULL,legacy_id TEXT NOT NULL,thread_id TEXT,owner_id TEXT,body_json TEXT NOT NULL,PRIMARY KEY(kind,legacy_id));
    CREATE TABLE t3_legacy_id_map(kind TEXT NOT NULL,legacy_id TEXT NOT NULL,native_id TEXT NOT NULL,PRIMARY KEY(kind,legacy_id,native_id));`)
    const record = (kind, legacyId, threadId, ownerId, body) =>
      acl
        .prepare('INSERT INTO t3_legacy_import_records VALUES(?,?,?,?,?)')
        .run(kind, legacyId, threadId, ownerId, JSON.stringify(body))
    const mapId = (kind, legacyId, nativeId) =>
      acl
        .prepare('INSERT OR IGNORE INTO t3_legacy_id_map VALUES(?,?,?)')
        .run(kind, legacyId, nativeId)
    const bindings = new Map(),
      files = new Map(),
      reportUrls = new Map(),
      reportDates = []
    artifacts = createBusinessArtifactStore(stage)
    for (const c of conversations) {
      const project = projects.find((p) => p.id === c.projectId),
        agent = agents.find((a) => a.id === c.agentId),
        owner = users.find((u) => u.id === c.ownerId)
      if (
        !project ||
        !agent?.projectIds.includes(project.id) ||
        !owner ||
        !project.memberIds.includes(owner.id) ||
        !project.environments.some((e) => e.id === c.environmentId) ||
        !['private', 'project'].includes(c.visibility)
      )
        throw new Error(`旧会话 ${c.id} 的项目/环境/Agent/属主边界无效`)
      const createdAt = date(c.createdAt),
        mapping = mappings.get(c.id),
        binding = {
          threadId: c.id,
          projectId: c.projectId,
          environmentId: c.environmentId,
          agentId: c.agentId,
          ownerId: c.ownerId,
          visibility: c.visibility,
          createdAt,
        }
      bindings.set(c.id, binding)
      record('conversation', c.id, c.id, c.ownerId, c)
      mapId('thread', c.id, c.id)
      acl
        .prepare(
          'INSERT INTO t3_thread_bindings(thread_id,project_id,environment_id,agent_id,owner_id,visibility,created_at,compatibility_read_only,continuation_verified,native_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          c.id,
          c.projectId,
          c.environmentId,
          c.agentId,
          c.ownerId,
          c.visibility,
          createdAt,
          Number(!mapping.verified),
          Number(mapping.verified),
          mapping.nativeThreadId || null,
        )
    }
    for await (const row of rows(snapshot, 'files', manifest)) {
      const binding = bindings.get(row.cid)
      if (!binding) throw new Error('附件对应的旧会话不存在')
      const owner = users.find((u) => u.id === row.owner),
        project = projects.find((p) => p.id === binding.projectId)
      if (
        !owner ||
        !project.memberIds.includes(owner.id) ||
        (binding.visibility === 'private' && owner.id !== binding.ownerId)
      )
        throw new Error('附件属主不属于会话权限范围')
      const source = resolve(snapshot, row.contentFile)
      if (!safeInside(snapshot, source)) throw new Error('附件路径越界')
      const bytes = await readFile(source)
      if (digest(bytes) !== row.contentSha256) throw new Error('附件独立哈希不一致')
      const metadata = nativeWriter.attachment({
        threadId: row.cid,
        stableKey: `legacy:${row.id}:${row.contentSha256}`,
        name: row.name,
        mime: row.mime,
        size: bytes.length,
      })
      files.set(row.id, { row, bytes, metadata })
      mapId('attachment', row.id, metadata.attachment.id)
      await writeFile(join(stage, 't3/userdata/attachments', metadata.relativePath), bytes, {
        flag: 'wx',
        mode: 0o600,
      })
      const c = conversations.find((c) => c.id === row.cid)
      const published =
        Boolean(row.published) &&
        ((c.messages || []).some((m) => (m.attachments || []).some((a) => a.id === row.id)) ||
          (c.queue || []).some((q) => (q.attachments || []).some((a) => a.id === row.id)))
      acl
        .prepare(
          'INSERT INTO t3_attachment_access(attachment_id,owner_id,thread_id,created_at,metadata_json) VALUES(?,?,?,?,?)',
        )
        .run(
          metadata.attachment.id,
          row.owner,
          published ? row.cid : null,
          binding.createdAt,
          JSON.stringify(metadata.attachment),
        )
      const artifact = (c.artifacts || []).find((a) => a.id === row.id)
      if (artifact) {
        const report = artifacts.create({
          binding,
          runId: (() => {
            const index = (c.turns || []).findIndex((t) => t.id === artifact.turnId)
            if (index < 0) throw new Error('报告缺少真实历史轮次')
            return nativeWriter.runId(c.id, index + 1)
          })(),
          name: row.name,
          mime: row.mime,
          bytes,
        })
        reportUrls.set(`/api/agent-demo/files/${row.id}`, report.sourceUrl)
        mapId('report', row.id, report.id)
        reportDates.push({ id: report.id, at: date(artifact.createdAt, binding.createdAt) })
        record('report', row.id, c.id, c.ownerId, {
          ...artifact,
          id: report.id,
          legacyId: row.id,
          sourceUrl: report.sourceUrl,
        })
      }
    }
    const rewriteText = (text) => {
      let value = String(text || '')
      for (const [from, to] of reportUrls) value = value.replaceAll(from, to)
      return value
    }
    const attachments = (threadId, items, ownerId) =>
      (items || []).map((a) => {
        const file = files.get(a.id)
        if (!file) throw new Error('消息或草稿引用不存在的附件')
        if (
          file.row.cid !== threadId ||
          (!file.row.published && ownerId && file.row.owner !== ownerId)
        )
          throw new Error('附件跨会话或草稿属主引用无效')
        return file.metadata.attachment
      })
    const lineageFor = (c, seen = new Set()) => {
      if (seen.has(c.id)) throw new Error('旧分支关系存在循环')
      seen.add(c.id)
      if (!c.branchedFrom)
        return {
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: c.id },
          forkedFrom: null,
        }
      const parent = conversations.find((p) => p.id === c.branchedFrom.conversationId)
      // Deleted sources cannot become fabricated references; the original record is retained.
      if (!parent)
        return {
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: c.id },
          forkedFrom: null,
        }
      if (
        parent.projectId !== c.projectId ||
        parent.environmentId !== c.environmentId ||
        parent.agentId !== c.agentId ||
        (parent.visibility === 'private' && parent.ownerId !== c.ownerId)
      )
        throw new Error('旧分支来源越过权限边界')
      const message = (parent.messages || []).find((m) => m.id === c.branchedFrom.messageId),
        index = (parent.turns || []).findIndex(
          (t) =>
            t.id === message?.turnId ||
            t.assistantMessageId === c.branchedFrom.messageId ||
            t.inputMessageId === c.branchedFrom.messageId,
        )
      return {
        lineage: {
          parentThreadId: parent.id,
          relationshipToParent: 'fork',
          rootThreadId: lineageFor(parent, seen).lineage.rootThreadId,
        },
        forkedFrom:
          index < 0
            ? null
            : { type: 'run', threadId: parent.id, runId: nativeWriter.runId(parent.id, index + 1) },
      }
    }
    const threads = []
    for (const c of conversations) {
      const createdAt = date(c.createdAt),
        updatedAt = date(c.updatedAt, createdAt),
        proof = mappings.get(c.id),
        providerThreadId = proof.verified
          ? nativeWriter.providerThreadId(proof.nativeThreadId)
          : null
      const thread = {
        createdBy: 'system',
        creationSource: 'server',
        id: c.id,
        projectId: c.projectId,
        title: c.title || '导入会话',
        providerInstanceId: 'codex',
        modelSelection: { instanceId: 'codex', model: options.model },
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThreadId,
        historyOrigin: 'v1_import',
        ...lineageFor(c),
        createdAt,
        updatedAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      }
      const events = []
      let ordinal = 0
      const event = (type, payload, at = updatedAt) =>
        events.push({
          id: key('event', c.id, type, payload.id, events.length),
          type,
          threadId: c.id,
          occurredAt: at,
          payload,
        })
      event('thread.created', thread, createdAt)
      if (proof.verified)
        event('provider-thread.updated', {
          id: providerThreadId,
          driver: 'codex',
          providerInstanceId: 'codex',
          providerSessionId: null,
          appThreadId: c.id,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: 'codex',
            nativeId: proof.nativeThreadId,
            strength: 'strong',
            fingerprint: proof.rolloutSha256,
          },
          nativeConversationHeadRef: null,
          status: 'not_loaded',
          firstRunOrdinal: (c.turns || []).length ? 1 : null,
          lastRunOrdinal: (c.turns || []).length || null,
          handoffIds: [],
          forkedFrom: null,
          createdAt,
          updatedAt,
        })
      const seenMessages = new Set(),
        runs = new Map()
      const item = (type, payload, runId, at, status = 'completed', legacyId) => {
        const id = key('item', c.id, legacyId || ordinal, type)
        event(
          'turn-item.updated',
          {
            id,
            threadId: c.id,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal++,
            status,
            title: null,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            type,
            ...payload,
          },
          at,
        )
        if (legacyId) mapId('item', legacyId, id)
      }
      const message = (m, runId, legacyId = m.id) => {
        if (seenMessages.has(m.id)) return
        seenMessages.add(m.id)
        const id = key('message', c.id, m.id),
          at = date(m.createdAt, createdAt),
          text = rewriteText(m.content),
          files = attachments(c.id, m.attachments)
        event(
          'message.updated',
          {
            createdBy: m.role === 'user' ? 'user' : 'agent',
            creationSource: 'server',
            id,
            threadId: c.id,
            runId,
            nodeId: null,
            role: m.role,
            text,
            attachments: files,
            streaming: false,
            createdAt: at,
            updatedAt: date(m.updatedAt, at),
          },
          at,
        )
        mapId('message', legacyId, id)
        item(
          m.role === 'user' ? 'user_message' : 'assistant_message',
          {
            messageId: id,
            text,
            ...(m.role === 'user'
              ? {
                  createdBy: 'user',
                  creationSource: 'server',
                  inputIntent:
                    m.kind === 'guidance'
                      ? 'steer'
                      : m.kind === 'queued'
                        ? 'queued_turn'
                        : 'turn_start',
                  attachments: files,
                }
              : { streaming: false, attachments: files }),
          },
          runId,
          at,
          normalizedStatus(m.status === 'accepted' ? 'completed' : m.status),
          m.id,
        )
        return id
      }
      for (const [index, t] of (c.turns || []).entries()) {
        const runId = nativeWriter.runId(c.id, index + 1),
          input = (c.messages || []).find((m) => m.id === t.inputMessageId)
        if (!input) throw new Error(`旧轮次 ${t.id} 缺少用户输入`)
        const inputId = message(input, runId),
          at = date(t.startedAt, createdAt),
          status = normalizedStatus(t.status)
        const run = {
          id: runId,
          threadId: c.id,
          ordinal: index + 1,
          providerInstanceId: 'codex',
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: inputId,
          rootNodeId: null,
          activeAttemptId: null,
          status,
          requestedAt: at,
          startedAt: at,
          completedAt: date(t.completedAt, date(t.lastActivityAt, updatedAt)),
          checkpointId: null,
          contextHandoffId: null,
        }
        runs.set(t.id, runId)
        event('run.updated', run, run.completedAt)
        mapId('run', t.id, runId)
        for (const entry of t.timeline || []) {
          const entryAt = date(entry.createdAt, at)
          if (entry.type === 'user') {
            const m = (c.messages || []).find((m) => m.id === entry.messageId)
            if (m) message(m, runId)
          } else if (entry.type === 'text' && typeof entry.text === 'string')
            message(
              {
                id: entry.id,
                role: 'assistant',
                content: entry.text,
                createdAt: entryAt,
                updatedAt: entry.updatedAt,
                status,
              },
              runId,
              t.assistantMessageId || entry.id,
            )
          else if (entry.type === 'reasoning')
            item(
              'reasoning',
              { text: String(entry.text || ''), streaming: false },
              runId,
              entryAt,
              normalizedStatus(entry.status || status),
              entry.id,
            )
          else if (entry.type === 'tool') {
            const step = (t.steps || []).find((s) => s.id === entry.stepId)
            if (step)
              item(
                'dynamic_tool',
                {
                  title: step.name || '历史工具调用',
                  toolName: step.toolName || step.name || null,
                  input: step.input ?? null,
                  output: step.output ?? null,
                },
                runId,
                entryAt,
                normalizedStatus(step.status),
                entry.id,
              )
          } else if (entry.type === 'question') {
            const q = entry.question
            if (!q?.id || !q.prompt) throw new Error('历史提问缺少真实问题内容')
            const requestId = key('request', c.id, q.id),
              question = {
                id: q.id,
                header: '历史提问',
                question: q.prompt,
                options: (q.options || []).map((option) =>
                  typeof option === 'string' ? { label: option, description: option } : option,
                ),
                allowCustomAnswer: true,
              }
            item(
              'user_input_request',
              {
                requestId,
                questions: [question],
                ...(typeof q.answer === 'string'
                  ? {
                      questionAnswer: {
                        requestId,
                        questionTextById: { [q.id]: q.prompt },
                        answers: { [q.id]: q.answer },
                        attachmentsByQuestionId: {},
                      },
                    }
                  : {}),
              },
              runId,
              entryAt,
              q.status === 'answered' ? 'completed' : 'interrupted',
              entry.id,
            )
            mapId('request', q.id, requestId)
          }
        }
        const answer = (c.messages || []).find((m) => m.id === t.assistantMessageId)
        if (answer) {
          if ((t.timeline || []).some((e) => e.type === 'text')) seenMessages.add(answer.id)
          else message(answer, runId)
        }
      }
      for (const m of c.messages || [])
        if (['user', 'assistant'].includes(m.role)) message(m, runs.get(m.turnId) || null)
      for (const [index, q] of (c.queue || []).entries()) {
        const runId = nativeWriter.runId(c.id, (c.turns || []).length + index + 1),
          at = date(q.createdAt, updatedAt),
          m = {
            id: key('queued-message', c.id, q.id),
            role: 'user',
            kind: 'queued',
            content: q.text,
            attachments: q.attachments,
            createdAt: at,
            status: 'accepted',
          }
        const userMessageId = message(m, runId, q.id)
        event(
          'run.updated',
          {
            id: runId,
            threadId: c.id,
            ordinal: (c.turns || []).length + index + 1,
            providerInstanceId: 'codex',
            modelSelection: thread.modelSelection,
            providerThreadId: null,
            userMessageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: 'queued',
            queuePosition: index + 1,
            queueHeld: true,
            requestedAt: at,
            startedAt: null,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
          at,
        )
        mapId('queued-run', q.id, runId)
        record('held_queue', q.id, c.id, c.ownerId, { ...q, queueHeld: true, runId })
      }
      threads.push({ threadId: c.id, events, proof })
    }
    for await (const row of rows(snapshot, 'conversation_preferences', manifest)) {
      const binding = bindings.get(row.cid)
      if (
        !binding ||
        !users.some((u) => u.id === row.uid) ||
        !projects.find((p) => p.id === binding.projectId).memberIds.includes(row.uid) ||
        (binding.visibility === 'private' && row.uid !== binding.ownerId)
      )
        throw new Error('个人会话偏好引用无效')
      const at = bindings.get(row.cid).createdAt,
        value = { pinnedAt: row.pinned ? at : null, archivedAt: row.archived ? at : null }
      acl
        .prepare('INSERT INTO t3_user_thread_preferences VALUES(?,?,?,?,?)')
        .run(row.uid, row.cid, 1, at, JSON.stringify(value))
      acl.prepare('INSERT OR IGNORE INTO t3_user_preference_revisions VALUES(?,1)').run(row.uid)
    }
    for await (const row of rows(snapshot, 'drafts', manifest)) {
      const draft = JSON.parse(row.body),
        c = conversations.find((c) => row.key.endsWith('/' + c.id) || row.key.endsWith(':' + c.id)),
        owner = users.find((u) => row.key.startsWith(u.id + '/') || row.key.startsWith(u.id + ':'))
      if (
        !c ||
        !owner ||
        !projects.find((p) => p.id === c.projectId).memberIds.includes(owner.id) ||
        (c.visibility === 'private' && owner.id !== c.ownerId)
      )
        throw new Error('旧草稿缺少有效用户/会话归属')
      record('draft', row.key, c.id, owner.id, {
        ...draft,
        attachmentIds: attachments(
          c.id,
          (draft.attachmentIds || []).map((id) => ({ id })),
          owner.id,
        ).map((file) => file.id),
      })
    }
    artifacts.close()
    artifacts = undefined
    const reportDb = new DatabaseSync(join(stage, 't3-business.sqlite'))
    try {
      for (const report of reportDates)
        reportDb
          .prepare('UPDATE business_artifacts SET created_at=? WHERE id=?')
          .run(report.at, report.id)
    } finally {
      reportDb.close()
    }
    acl.close()
    acl = undefined
    await nativeWriter.write({
      dbPath: join(stage, 't3/userdata/statev2.sqlite'),
      targetDirectory: target,
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      model: options.model,
      createdAt: manifest.createdAt,
      threads,
    })
    const report = {
      format: 'autoops-t3-import-v1',
      sourceManifestSha256: sourceHash,
      sourceEventWatermark: manifest.eventWatermark,
      ...(nativePathRebase ? { nativePathRebase } : {}),
      importedAt: new Date().toISOString(),
      threadCount: threads.length,
      verifiedContinuations: [...mappings.values()].filter((v) => v.verified).length,
      compatibilityReadOnly: [...mappings.values()]
        .filter((v) => !v.verified)
        .map((v) => ({ threadId: v.threadId, reason: v.reason })),
      heldQueuedRuns: conversations.reduce((n, c) => n + (c.queue || []).length, 0),
      nativeProviderStarted: false,
    }
    await writeFile(join(stage, 't3-import-report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
    await secureTree(stage)
    // Refuse existing destinations. The stage is private and becomes visible in one rename.
    try {
      await lstat(target)
      throw new Error('目标目录在导入中被创建，拒绝覆盖')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    await rename(stage, target)
    return report
  } catch (error) {
    acl?.close()
    artifacts?.close()
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}
