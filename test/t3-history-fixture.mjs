// Synthetic scale fixture, never a claim about real model turns. The official
// offline importer writes canonical native T3 rows; the browser reads the server.
import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createLegacySnapshot } from '../agent-demo/migrations/legacy-snapshot.mjs'
const destination = resolve(process.argv[2] || `.test-artifacts/t3-history-${Date.now()}`)
const rounds = Number(process.env.T3_HISTORY_ROUNDS || 1000)
const toolBytes = Number(process.env.T3_HISTORY_TOOL_BYTES || 16384)
if (!Number.isInteger(rounds) || rounds < 1000 || rounds > 5000)
  throw new Error('Fixture needs 1000–5000 rounds')
await mkdir(destination, { recursive: false })
const source = join(destination, 'source')
await mkdir(source)
const db = new DatabaseSync(join(source, 'synthetic.sqlite'))
db.exec(
  'CREATE TABLE conversations(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE events(seq INTEGER PRIMARY KEY,cid TEXT,body TEXT);CREATE TABLE files(id TEXT PRIMARY KEY,cid TEXT,owner TEXT,published INTEGER,name TEXT,mime TEXT,data BLOB);CREATE TABLE drafts(key TEXT PRIMARY KEY,body TEXT);CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER);CREATE TABLE requests(key TEXT PRIMARY KEY,fingerprint TEXT,body TEXT);CREATE TABLE conversation_preferences(uid TEXT,cid TEXT,pinned INTEGER,archived INTEGER);',
)
const threadId = 'synthetic-history-1000',
  at = (n) => new Date(Date.UTC(2026, 9, 20, 0, 0, n)).toISOString()
const conversation = {
  id: threadId,
  title: '合成性能验收：1000轮大工具历史（非模型测试）',
  projectId: 'p-autoops',
  environmentId: 'env-test',
  agentId: 'a-project',
  ownerId: 'u-admin',
  visibility: 'private',
  mode: 'live',
  createdAt: at(0),
  updatedAt: at(rounds * 3),
  status: 'idle',
  activeTurnId: null,
  messages: [],
  turns: [],
  queue: [],
  artifacts: [],
}
for (let n = 0; n < rounds; n++) {
  const turn = `synthetic-turn-${n}`,
    user = `synthetic-user-${n}`,
    assistant = `synthetic-assistant-${n}`,
    step = `synthetic-tool-${n}`
  const content = `原生记忆标记-SYNTHETIC-1000 第${n + 1}轮合成性能数据；请读取固定环境资料编号${n + 1}。`
  const answer = `## 合成记录 ${n + 1}\n\n这是离线生成的界面性能样本，没有调用模型。\n\n- 已检查条目：${n + 1}\n- 大工具结果保存在原生工具折叠项。\n\n|项目|结果|\n|---|---|\n|记录|${n + 1}|\n|检查|样本|`
  conversation.messages.push(
    {
      id: user,
      role: 'user',
      content,
      turnId: turn,
      createdAt: at(n * 3),
      status: 'accepted',
      attachments: [],
    },
    {
      id: assistant,
      role: 'assistant',
      content: answer,
      turnId: turn,
      createdAt: at(n * 3 + 2),
      status: 'completed',
      attachments: [],
    },
  )
  conversation.turns.push({
    id: turn,
    inputMessageId: user,
    assistantMessageId: assistant,
    startedAt: at(n * 3),
    completedAt: at(n * 3 + 2),
    status: 'completed',
    timeline: [
      { id: `${turn}-tool`, type: 'tool', stepId: step, createdAt: at(n * 3 + 1) },
      { id: `${turn}-text`, type: 'text', text: answer, createdAt: at(n * 3 + 2) },
    ],
    steps: [
      {
        id: step,
        name: '读取项目资料',
        input: { synthetic: true, record: n + 1 },
        output: JSON.stringify({ synthetic: true, record: n + 1, data: 'x'.repeat(toolBytes) }),
        status: 'completed',
      },
    ],
  })
}
db.prepare('INSERT INTO conversations VALUES(?,?)').run(threadId, JSON.stringify(conversation))
db.prepare('INSERT INTO events VALUES(?,?,?)').run(1, threadId, '{}')
db.close()
const snapshot = join(destination, 'snapshot')
await createLegacySnapshot({
  sourceDb: join(source, 'synthetic.sqlite'),
  destination: snapshot,
  quiesced: true,
})
const report = {
  synthetic: true,
  modelCalls: 0,
  threadId,
  rounds,
  toolOutputBytesPerRound: toolBytes,
  totalToolOutputBytes: rounds * toolBytes,
  snapshot,
}
await writeFile(join(destination, 'fixture.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
