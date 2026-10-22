import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 隔离微基准：不加载生产服务，也不读取任何业务数据库或凭据。
// 两条路径都使用 WAL + FULL 和相同事务，不把逻辑参数字节等同实际磁盘写入。
const output = path.resolve(
  process.env.BENCH_OUTPUT || '.test-artifacts/agent-demo-api/emit-microbench.json',
)
const temporary = mkdtempSync(path.join(os.tmpdir(), 'autoops-emit-microbench-'))
const rounds = 100
const warmup = 10
const timestamp = '2026-10-21T00:00:00.000Z'
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
  return {
    count: sorted.length,
    min: sorted[0],
    p50: quantile(0.5),
    p95: quantile(0.95),
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  }
}
const sha = (value) => createHash('sha256').update(value).digest('hex')
const bytes = (value) => Buffer.byteLength(value, 'utf8')
const existsSize = (file) => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function fixture(turnCount, documentRepeats) {
  const content = '授权项目设计资料：固定项目与环境，允许只读资料查询，报告保留来源。\n'
  const conversation = {
    id: 'isolated-benchmark-conversation',
    title: '长会话隔离微基准',
    projectId: 'benchmark-project',
    agentId: 'benchmark-agent',
    environmentId: 'benchmark-environment',
    visibility: 'private',
    ownerId: 'benchmark-user',
    mode: 'scenario',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
    eventSeq: 0,
    status: 'idle',
    activeTurnId: null,
    queuePaused: false,
    messages: [],
    turns: [],
    queue: [],
    artifacts: [],
  }
  for (let index = 0; index < turnCount; index++) {
    const turnId = `turn-${index}`
    conversation.messages.push(
      {
        id: `user-${index}`,
        turnId,
        role: 'user',
        kind: 'prompt',
        content: `第${index}轮：检查项目资料和环境资源，并整理报告。`,
        status: 'accepted',
        createdAt: timestamp,
        attachments: [],
      },
      {
        id: `assistant-${index}`,
        turnId,
        role: 'assistant',
        kind: 'answer',
        content:
          '# 只读检查结果\n\n| 服务 | CPU | 内存 |\n| --- | --- | --- |\n| api | 23% | 54% |\n| database | 18% | 61% |\n\n```text\nservice: healthy\n```\n\n' +
          content.repeat(4),
        status: 'completed',
        createdAt: timestamp,
        attachments: [],
      },
    )
    conversation.turns.push({
      id: turnId,
      status: 'completed',
      inputMessageId: `user-${index}`,
      assistantMessageId: `assistant-${index}`,
      startedAt: timestamp,
      completedAt: timestamp,
      scenario: { kind: 'normal', stepDelayMs: 50 },
      context: {
        project: { id: 'benchmark-project', name: '测试项目' },
        environment: { id: 'benchmark-environment', name: '测试环境' },
        documents: [
          { id: 'doc-design', name: '设计.md', content: content.repeat(documentRepeats) },
          { id: 'doc-guide', name: '手册.md', content: content.repeat(documentRepeats) },
        ],
        resources: [{ id: 'api', name: 'API 服务', type: 'service' }],
        resourceSnapshot: {
          source: 'fixture',
          observedAt: timestamp,
          services: [
            { id: 'api', name: 'api', status: 'healthy', cpuPercent: 23, memoryPercent: 54 },
            { id: 'db', name: 'database', status: 'healthy', cpuPercent: 18, memoryPercent: 61 },
          ],
        },
      },
      steps: [
        {
          id: `read-${index}`,
          name: '读取项目资料',
          status: 'completed',
          input: { documentIds: ['doc-design', 'doc-guide'] },
          output: [{ name: '设计.md', content: content.repeat(documentRepeats) }],
          startedAt: timestamp,
          completedAt: timestamp,
        },
        {
          id: `query-${index}`,
          name: '查询环境快照',
          status: 'completed',
          input: { environmentId: 'benchmark-environment' },
          output: { source: 'fixture', status: 'healthy' },
          startedAt: timestamp,
          completedAt: timestamp,
        },
      ],
      question: null,
      guidance: [{ id: `steer-${index}`, text: '只分析，不执行变更', status: 'accepted' }],
    })
  }
  return conversation
}

function database(name) {
  const file = path.join(temporary, `${name}.sqlite`)
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE conversations(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,cid TEXT,body TEXT NOT NULL);`)
  return { file, db }
}

function measuredWrite(db, conversation, variant) {
  const totals = { encode: 0, clone: 0, sql: 0, commit: 0 }
  const strings = []
  const encode = (value) => {
    const from = performance.now()
    const encoded = JSON.stringify(value)
    totals.encode += performance.now() - from
    strings.push(encoded)
    return encoded
  }
  const sql = (action) => {
    const from = performance.now()
    const result = action()
    totals.sql += performance.now() - from
    return result
  }
  const started = performance.now()
  db.exec('BEGIN')
  try {
    const event = {
      type: 'conversation.updated',
      conversationId: conversation.id,
      turnId: conversation.activeTurnId,
      payload: { conversation },
      at: timestamp,
    }
    const initial = variant === 'before' ? encode(event) : '{}'
    const row = sql(() =>
      db.prepare('INSERT INTO events(cid,body) VALUES(?,?)').run(conversation.id, initial),
    )
    event.seq = Number(row.lastInsertRowid)
    conversation.eventSeq = event.seq
    if (variant === 'before') {
      const from = performance.now()
      event.payload.conversation = structuredClone(conversation)
      totals.clone += performance.now() - from
    } else {
      event.payload.conversation = conversation
    }
    const finalEvent = encode(event)
    sql(() => db.prepare('UPDATE events SET body=? WHERE seq=?').run(finalEvent, event.seq))
    const finalConversation = encode(conversation)
    sql(() =>
      db
        .prepare('INSERT OR REPLACE INTO conversations VALUES(?,?)')
        .run(conversation.id, finalConversation),
    )
    const commitStarted = performance.now()
    db.exec('COMMIT')
    totals.commit = performance.now() - commitStarted
    totals.total = performance.now() - started
    // 字节统计放在计时之后，避免额外 UTF-8 扫描改变被测生产路径。
    return {
      ...totals,
      serializedBytes: strings.reduce((sum, value) => sum + bytes(value), 0),
      sqlTextBytes: bytes(initial) + bytes(finalEvent) + bytes(finalConversation),
      eventBytes: bytes(finalEvent),
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const report = {
  startedAt: new Date().toISOString(),
  scriptSha256: sha(readFileSync(new URL(import.meta.url))),
  environment: {
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    nodeVersion: process.version,
    cpuModel: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBeforeBytes: os.freemem(),
    loadAverageBefore: os.loadavg(),
  },
  roundsPerVariant: rounds,
  warmupPairs: warmup,
  ordering: '每轮交替 before→after / after→before；两条路径用独立新建数据库',
  scenarios: [],
  boundaries: [
    '仅测 conversation.updated 的同步 emit+save 路径，不包含 HTTP、SSE、读取、权限校验和并发请求。',
    '固定会话大小，追加事件日志；没有复用生产数据、配置、凭据或生产服务进程。',
    'SQL 文本字节是逻辑参数量；事务内页写可能合并，不能把字节差直接称为物理磁盘写入下降。',
    '数据库/WAL文件大小是保留空间，不是累计I/O；p95受checkpoint、系统调度与宿主机负载影响。',
    '微基准成本下降不能证明600秒soak或API p95已达标，必须另跑完整验收。',
  ],
}
const handles = []
try {
  for (const settings of [
    { name: 'long-64-turns', turns: 64, repeats: 8 },
    { name: 'long-128-turns', turns: 128, repeats: 20 },
  ]) {
    const sample = fixture(settings.turns, settings.repeats)
    const paths = Object.fromEntries(
      ['before', 'after'].map((variant) => [variant, database(`${settings.name}-${variant}`)]),
    )
    handles.push(...Object.values(paths).map((item) => item.db))
    const states = { before: structuredClone(sample), after: structuredClone(sample) }
    const measurements = { before: [], after: [] }
    for (let iteration = -warmup; iteration < rounds; iteration++) {
      for (const variant of Math.abs(iteration) % 2 ? ['after', 'before'] : ['before', 'after']) {
        states[variant].revision++
        const measured = measuredWrite(paths[variant].db, states[variant], variant)
        if (iteration >= 0) measurements[variant].push(measured)
      }
    }
    const summary = {}
    const finalStates = {}
    for (const variant of ['before', 'after']) {
      const { db, file } = paths[variant]
      const rows = db.prepare('SELECT seq,cid,body FROM events ORDER BY seq').all()
      assert.equal(rows.length, rounds + warmup)
      rows.forEach((row, index) => {
        const event = JSON.parse(row.body)
        assert.equal(Number(row.seq), index + 1)
        assert.equal(event.seq, index + 1)
        assert.equal(event.payload.conversation.eventSeq, index + 1)
        assert.equal(event.payload.conversation.turns.length, settings.turns)
      })
      const saved = db.prepare('SELECT body FROM conversations').get().body
      finalStates[variant] = { conversation: saved, event: rows.at(-1).body }
      const data = measurements[variant]
      summary[variant] = {
        timingsMs: Object.fromEntries(
          ['total', 'encode', 'clone', 'sql', 'commit'].map((field) => [
            field,
            stats(data.map((sample) => sample[field])),
          ]),
        ),
        bytesPerWrite: {
          serialized: stats(data.map((sample) => sample.serializedBytes)),
          sqlTextParameters: stats(data.map((sample) => sample.sqlTextBytes)),
          persistedEvent: stats(data.map((sample) => sample.eventBytes)),
        },
        sqlite: {
          version: db.prepare('SELECT sqlite_version() AS value').get().value,
          synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
          journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
          walAutocheckpoint: db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint,
          pageCount: db.prepare('PRAGMA page_count').get().page_count,
          databaseFileBytes: existsSize(file),
          walFileBytes: existsSize(`${file}-wal`),
        },
        samples: data,
      }
    }
    assert.deepEqual(finalStates.before, finalStates.after)
    const before = summary.before.timingsMs.total
    const after = summary.after.timingsMs.total
    report.scenarios.push({
      ...settings,
      conversationUtf8Bytes: bytes(JSON.stringify(sample)),
      finalConversationSha256: sha(finalStates.after.conversation),
      finalEventSha256: sha(finalStates.after.event),
      consistency: '所有事件连续seq与快照eventSeq一致，两条路径最终事件/会话正文逐字一致',
      reductionPercent: {
        totalP50: ((before.p50 - after.p50) / before.p50) * 100,
        totalP95: ((before.p95 - after.p95) / before.p95) * 100,
        meanLogicalSqlBytes:
          ((summary.before.bytesPerWrite.sqlTextParameters.mean -
            summary.after.bytesPerWrite.sqlTextParameters.mean) /
            summary.before.bytesPerWrite.sqlTextParameters.mean) *
          100,
      },
      variants: summary,
    })
  }
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack
  process.exitCode = 1
} finally {
  for (const db of handles) db.close()
  report.finishedAt = new Date().toISOString()
  report.environment.freeMemoryAfterBytes = os.freemem()
  report.environment.loadAverageAfter = os.loadavg()
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2))
  rmSync(temporary, { recursive: true, force: true })
  console.log(
    JSON.stringify({
      passed: report.passed,
      output,
      scenarios: report.scenarios.map(
        ({ name, conversationUtf8Bytes, reductionPercent, variants }) => ({
          name,
          conversationUtf8Bytes,
          reductionPercent,
          before: variants.before.timingsMs.total,
          after: variants.after.timingsMs.total,
        }),
      ),
    }),
  )
}
