// @effect-diagnostics nodeBuiltinImport:off
import { test, expect } from 'vite-plus/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLegacySnapshot } from '../../../../../../agent-demo/migrations/legacy-snapshot.mjs'
import { importLegacyToT3 } from './legacyImport.ts'
import { importLegacySnapshot } from '../../../../../../agent-demo/migrations/t3-import-data.mjs'
import { assertNativeRolloutPaths } from '../../../../../../agent-demo/migrations/t3-native-paths.mjs'
async function fixture(withNative = false, quiesced = true, mutate?: (db: DatabaseSync) => void) {
  const root = await mkdtemp(join(tmpdir(), 't3-import-test-')),
    source = join(root, 'source')
  await mkdir(source)
  const db = new DatabaseSync(join(source, 'demo.sqlite'))
  db.exec(
    `CREATE TABLE conversations(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE events(seq INTEGER PRIMARY KEY,cid TEXT,body TEXT);CREATE TABLE files(id TEXT PRIMARY KEY,cid TEXT,owner TEXT,published INTEGER,name TEXT,mime TEXT,data BLOB);CREATE TABLE drafts(key TEXT PRIMARY KEY,body TEXT);CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER);CREATE TABLE requests(key TEXT PRIMARY KEY,fingerprint TEXT,body TEXT);CREATE TABLE conversation_preferences(uid TEXT,cid TEXT,pinned INTEGER,archived INTEGER);`,
  )
  const at = '2026-10-21T01:00:00.000Z'
  const c = {
    id: 'c-original',
    title: '迁移验收',
    projectId: 'p-autoops',
    environmentId: 'env-test',
    agentId: 'a-project',
    ownerId: 'u-admin',
    visibility: 'project',
    mode: 'live',
    createdAt: at,
    updatedAt: at,
    status: 'idle',
    activeTurnId: null,
    runtimeContextRevision: 0,
    runtimeSession: { threadId: 'native-real-id', revision: 0 },
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: '读取附件',
        turnId: 't1',
        createdAt: at,
        status: 'accepted',
        attachments: [{ id: 'file1' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '已读取，检查通过。',
        turnId: 't1',
        createdAt: at,
        status: 'completed',
        attachments: [],
      },
    ],
    turns: [
      {
        id: 't1',
        inputMessageId: 'm1',
        assistantMessageId: 'm2',
        startedAt: at,
        completedAt: at,
        status: 'completed',
        runnerThreadId: 'native-real-id',
        timeline: [
          {
            id: 'tl1',
            type: 'reasoning',
            text: '正在核对资料',
            createdAt: at,
            status: 'completed',
          },
          { id: 'tl2', type: 'tool', stepId: 's1', createdAt: at },
          { id: 'tl3', type: 'text', text: '已读取，检查通过。', createdAt: at },
        ],
        steps: [
          {
            id: 's1',
            name: '读取附件',
            input: { id: 'file1' },
            output: '附件正文',
            status: 'completed',
          },
        ],
      },
    ],
    queue: [{ id: 'q1', text: '稍后生成报告', createdAt: at, attachments: [] }],
    artifacts: [],
  }
  db.prepare('INSERT INTO conversations VALUES(?,?)').run(c.id, JSON.stringify(c))
  db.prepare('INSERT INTO events VALUES(?,?,?)').run(1, c.id, '{}')
  db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)').run(
    'file1',
    c.id,
    'u-admin',
    1,
    '说明.txt',
    'text/plain',
    Buffer.from('附件正文'),
  )
  db.prepare('INSERT INTO drafts VALUES(?,?)').run(
    'u-admin/' + c.id,
    JSON.stringify({ text: '个人草稿', attachmentIds: ['file1'] }),
  )
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(
    'secret-session',
    'u-admin',
    'csrf',
    1792544410000,
  )
  db.prepare('INSERT INTO requests VALUES(?,?,?)').run('receipt', 'old', '{}')
  db.prepare('INSERT INTO conversation_preferences VALUES(?,?,?,?)').run('u-admin', c.id, 1, 0)
  mutate?.(db)
  db.close()
  const nativeDirectories: string[] = []
  let restoredCodexHome: string | undefined
  if (withNative) {
    const bridge = join(root, 'bridge')
    restoredCodexHome = join(root, 'codex')
    await mkdir(bridge)
    await mkdir(join(restoredCodexHome, 'sessions'), { recursive: true })
    await writeFile(
      join(bridge, 'sessions.json'),
      JSON.stringify({
        version: 1,
        entries: [[c.id, { initialized: true, revision: 0, threadId: 'native-real-id' }]],
      }),
    )
    await writeFile(
      join(restoredCodexHome, 'sessions/rollout.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'native-real-id' } }) + '\n',
    )
    const nativeState = new DatabaseSync(join(restoredCodexHome, 'state_5.sqlite'))
    nativeState.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT);CREATE TABLE rollout_migration_skipped_rollouts(rollout_path TEXT PRIMARY KEY)')
    nativeState.prepare('INSERT INTO threads VALUES(?,?,?)').run('native-real-id',join(restoredCodexHome,'sessions/rollout.jsonl'),'/business/workspace')
    nativeState.close()
    nativeDirectories.push(bridge, restoredCodexHome)
  }
  const snapshot = join(root, 'snapshot'),
    target = join(root, 'result')
  await createLegacySnapshot({
    sourceDb: join(source, 'demo.sqlite'),
    destination: snapshot,
    nativeDirectories,
    quiesced,
  })
  return { root, snapshot, target, restoredCodexHome }
}
test('canonical import keeps timeline/files/drafts, holds queue and creates zero provider effects', async () => {
  const f = await fixture()
  try {
    const report = await importLegacyToT3({
      snapshot: f.snapshot,
      target: f.target,
      model: 'grok-4.6',
    })
    expect(report.verifiedContinuations).toBe(0)
    expect(report.compatibilityReadOnly).toHaveLength(1)
    expect(report.nativeProviderStarted).toBe(false)
    expect(report.heldQueuedRuns).toBe(1)
    const db = new DatabaseSync(join(f.target, 't3/userdata/statev2.sqlite'), { readOnly: true })
    try {
      const runs = db
        .prepare('SELECT payload_json FROM orchestration_v2_projection_runs ORDER BY ordinal')
        .all()
        .map((r) => JSON.parse(String(r.payload_json)))
      expect(runs).toHaveLength(2)
      expect(runs[1].queueHeld).toBe(true)
      expect(runs[1].status).toBe('queued')
      expect(db.prepare('SELECT count(*) AS n FROM orchestration_v2_effect_outbox').get()?.n).toBe(
        0,
      )
      expect(
        db.prepare('SELECT count(*) AS n FROM orchestration_v2_projection_provider_threads').get()
          ?.n,
      ).toBe(0)
      const items = db
        .prepare('SELECT payload_json FROM orchestration_v2_projection_turn_items ORDER BY ordinal')
        .all()
        .map((r) => JSON.parse(String(r.payload_json)))
      expect(items.map((x) => x.type)).toEqual([
        'user_message',
        'reasoning',
        'dynamic_tool',
        'assistant_message',
        'user_message',
      ])
      expect(items[2].output).toBe('附件正文')
      expect(items[3].text).toBe('已读取，检查通过。')
      expect(items[4].inputIntent).toBe('queued_turn')
    } finally {
      db.close()
    }
    const acl = new DatabaseSync(join(f.target, 't3-autoops.sqlite'), { readOnly: true })
    try {
      expect(
        acl.prepare('SELECT compatibility_read_only FROM t3_thread_bindings').get()
          ?.compatibility_read_only,
      ).toBe(1)
      const draft = JSON.parse(
        String(
          acl.prepare("SELECT body_json FROM t3_legacy_import_records WHERE kind='draft'").get()
            ?.body_json,
        ),
      )
      expect(draft.text).toBe('个人草稿')
      expect(draft.attachmentIds[0]).not.toBe('file1')
      expect(
        acl
          .prepare('SELECT count(*) AS n FROM t3_attachment_access WHERE thread_id=?')
          .get('c-original')?.n,
      ).toBe(1)
    } finally {
      acl.close()
    }
    const host = new DatabaseSync(join(f.target, 'demo.sqlite'), { readOnly: true })
    expect(host.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0)
    host.close()
    expect((await stat(join(f.target, 't3-autoops.sqlite'))).mode & 0o777).toBe(0o600)
    await expect(
      importLegacyToT3({ snapshot: f.snapshot, target: f.target, model: 'grok-4.6' }),
    ).rejects.toThrow('已存在')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}, 30000)
test('only complete native proof creates a real not_loaded provider reference', async () => {
  const f = await fixture(true)
  try {
    const report = await importLegacyToT3({
      snapshot: f.snapshot,
      target: f.target,
      model: 'grok-4.6',
      restoredCodexHome: f.restoredCodexHome!,
    })
    expect(report.verifiedContinuations).toBe(1)
    const db = new DatabaseSync(join(f.target, 't3/userdata/statev2.sqlite'), { readOnly: true })
    const p = JSON.parse(
      String(
        db.prepare('SELECT payload_json FROM orchestration_v2_projection_provider_threads').get()
          ?.payload_json,
      ),
    )
    expect(p.nativeThreadRef.nativeId).toBe('native-real-id')
    expect(p.status).toBe('not_loaded')
    expect(p.providerSessionId).toBe(null)
    db.close()
    const nativeState = new DatabaseSync(join(f.target,'t3/codex-home/state_5.sqlite'),{readOnly:true})
    expect(nativeState.prepare('SELECT rollout_path FROM threads').get()?.rollout_path).toBe(join(f.target,'t3/codex-home/sessions/rollout.jsonl'))
    nativeState.close()
    expect(assertNativeRolloutPaths(join(f.target,'t3/codex-home')).checked).toBe(1)
    expect(
      await readFile(join(f.target, 't3/codex-home/sessions/rollout.jsonl'), 'utf8'),
    ).toContain('native-real-id')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}, 30000)
test('quiesce and native hash failures never publish target', async () => {
  const f = await fixture(false, false)
  try {
    await expect(
      importLegacyToT3({ snapshot: f.snapshot, target: f.target, model: 'grok-4.6' }),
    ).rejects.toThrow('quiesced')
    await expect(stat(f.target)).rejects.toThrow()
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
  const g = await fixture(true)
  try {
    await writeFile(join(g.restoredCodexHome!, 'extra'), 'different')
    await expect(
      importLegacyToT3({
        snapshot: g.snapshot,
        target: g.target,
        model: 'grok-4.6',
        restoredCodexHome: g.restoredCodexHome!,
      }),
    ).rejects.toThrow('完整文件清单')
    await expect(stat(g.target)).rejects.toThrow()
  } finally {
    await rm(g.root, { recursive: true, force: true })
  }
})

test('historical questions and report IDs use native types and actual run links', async () => {
  const f = await fixture(false, true, (db) => {
    const c = JSON.parse(String(db.prepare('SELECT body FROM conversations').get()?.body))
    c.turns[0].timeline.splice(2, 0, {
      id: 'q-history',
      type: 'question',
      createdAt: c.createdAt,
      question: {
        id: 'q-real',
        prompt: '检查哪个环境？',
        options: ['测试', '生产'],
        status: 'answered',
        answer: '测试',
      },
    })
    c.artifacts.push({
      id: 'report-old',
      turnId: 't1',
      name: '发布报告.md',
      mime: 'text/markdown',
      createdAt: c.createdAt,
    })
    c.turns[0].timeline.at(-1).text += ' [报告](/api/agent-demo/files/report-old)'
    db.prepare('UPDATE conversations SET body=?').run(JSON.stringify(c))
    db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)').run(
      'report-old',
      c.id,
      'u-admin',
      1,
      '发布报告.md',
      'text/markdown',
      Buffer.from('# 发布报告\n检查通过'),
    )
  })
  try {
    await importLegacyToT3({ snapshot: f.snapshot, target: f.target, model: 'grok-4.6' })
    const db = new DatabaseSync(join(f.target, 't3/userdata/statev2.sqlite'), { readOnly: true })
    const items = db
      .prepare('SELECT payload_json FROM orchestration_v2_projection_turn_items ORDER BY ordinal')
      .all()
      .map((r) => JSON.parse(String(r.payload_json)))
    const question = items.find((i) => i.type === 'user_input_request')
    expect(question.questionAnswer.answers['q-real']).toBe('测试')
    expect(question.status).toBe('completed')
    expect(items.find((i) => i.type === 'assistant_message').text).toContain(
      '/api/agent-demo/t3/autoops/files/report-',
    )
    const runId = String(
      db
        .prepare('SELECT run_id FROM orchestration_v2_projection_runs ORDER BY ordinal LIMIT 1')
        .get()?.run_id,
    )
    db.close()
    const reports = new DatabaseSync(join(f.target, 't3-business.sqlite'), { readOnly: true })
    const report = reports.prepare('SELECT * FROM business_artifacts').get()
    expect(report?.run_id).toBe(runId)
    expect(report?.created_at).toBe('2026-10-21T01:00:00.000Z')
    expect(Buffer.from(report?.data as Uint8Array).toString()).toContain('检查通过')
    reports.close()
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}, 30000)
test('mismatched context revision cannot manufacture native continuation', async () => {
  const f = await fixture(true, true, (db) => {
    const c = JSON.parse(String(db.prepare('SELECT body FROM conversations').get()?.body))
    c.runtimeContextRevision = 1
    db.prepare('UPDATE conversations SET body=?').run(JSON.stringify(c))
  })
  try {
    const report = await importLegacyToT3({
      snapshot: f.snapshot,
      target: f.target,
      model: 'grok-4.6',
      restoredCodexHome: f.restoredCodexHome!,
    })
    expect(report.verifiedContinuations).toBe(0)
    expect(report.compatibilityReadOnly[0]?.reason).toContain('版本')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}, 30000)
test('cross-thread attachment references reject and remove the unpublished stage', async () => {
  const f = await fixture(false, true, (db) => {
    const c = JSON.parse(String(db.prepare('SELECT body FROM conversations').get()?.body))
    const other = { ...c, id: 'c-other', messages: [], turns: [], queue: [], artifacts: [] }
    db.prepare('INSERT INTO conversations VALUES(?,?)').run(other.id, JSON.stringify(other))
    db.prepare('UPDATE files SET cid=?').run(other.id)
  })
  try {
    await expect(
      importLegacyToT3({ snapshot: f.snapshot, target: f.target, model: 'grok-4.6' }),
    ).rejects.toThrow('跨会话')
    await expect(stat(f.target)).rejects.toThrow()
    expect((await readdir(f.root)).some((n) => n.includes('.partial-'))).toBe(false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
test('native writer failure leaves source intact and no partially published directory', async () => {
  const f = await fixture()
  try {
    const before = await readFile(join(f.snapshot, 'manifest.json'))
    await expect(
      importLegacySnapshot(
        { snapshot: f.snapshot, target: f.target, model: 'grok-4.6' },
        {
          attachment: (x) => ({
            attachment: {
              type: 'file',
              id: 'attachment',
              name: x.name,
              mimeType: x.mime,
              sizeBytes: x.size,
            },
            relativePath: 'attachment.txt',
          }),
          providerThreadId: (id) => id,
          runId: (id, n) => id + n,
          write: async () => {
            throw new Error('injected native write failure')
          },
        },
      ),
    ).rejects.toThrow('injected native write failure')
    expect(await readFile(join(f.snapshot, 'manifest.json'))).toEqual(before)
    await expect(stat(f.target)).rejects.toThrow()
    expect((await readdir(f.root)).some((n) => n.includes('.partial-'))).toBe(false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
test('existing source lineage is mapped to the original canonical run without copying execution', async () => {
  const f = await fixture(false, true, (db) => {
    const c = JSON.parse(String(db.prepare('SELECT body FROM conversations').get()?.body))
    const fork = {
      ...c,
      id: 'c-fork',
      visibility: 'private',
      messages: [],
      turns: [],
      queue: [],
      artifacts: [],
      branchedFrom: { conversationId: c.id, messageId: 'm2' },
    }
    db.prepare('INSERT INTO conversations VALUES(?,?)').run(fork.id, JSON.stringify(fork))
  })
  try {
    await importLegacyToT3({ snapshot: f.snapshot, target: f.target, model: 'grok-4.6' })
    const db = new DatabaseSync(join(f.target, 't3/userdata/statev2.sqlite'), { readOnly: true })
    const fork = JSON.parse(
      String(
        db
          .prepare('SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?')
          .get('c-fork')?.payload_json,
      ),
    )
    const originalRun = db
      .prepare(
        'SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=? ORDER BY ordinal LIMIT 1',
      )
      .get('c-original')?.run_id
    expect(fork.lineage).toEqual({
      parentThreadId: 'c-original',
      relationshipToParent: 'fork',
      rootThreadId: 'c-original',
    })
    expect(fork.forkedFrom).toEqual({ type: 'run', threadId: 'c-original', runId: originalRun })
    expect(db.prepare('SELECT COUNT(*) AS n FROM orchestration_v2_effect_outbox').get()?.n).toBe(0)
    db.close()
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}, 30000)

test('full runner snapshot restores only the verified nested codex-home subtree', async () => {
  const f = await fixture(true)
  try {
    const runner = join(f.root, 'runner')
    await mkdir(runner)
    await cp(join(f.root, 'bridge/sessions.json'), join(runner, 'sessions.json'))
    await cp(f.restoredCodexHome!, join(runner, 'codex-home'), { recursive: true })
    const snapshot = join(f.root, 'runner-snapshot')
    await createLegacySnapshot({ sourceDb: join(f.root, 'source/demo.sqlite'), destination: snapshot, nativeDirectories: [runner], quiesced: true })
    const report = await importLegacyToT3({ snapshot, target: f.target, model: 'grok-4.6', restoredCodexHome: join(runner, 'codex-home') })
    expect(report.verifiedContinuations).toBe(1)
    expect(await readFile(join(f.target, 't3/codex-home/sessions/rollout.jsonl'), 'utf8')).toContain('native-real-id')
    await expect(stat(join(f.target, 't3/codex-home/codex-home'))).rejects.toThrow()
    await expect(stat(join(f.target, 't3/codex-home/sessions.json'))).rejects.toThrow()
  } finally { await rm(f.root, { recursive: true, force: true }) }
}, 30000)
