import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLegacySnapshot, verifyLegacySnapshot } from '../agent-demo/migrations/legacy-snapshot.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'autoops-t3-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  await mkdir(source)
  const sourceDb = join(source, 'demo.sqlite')
  const db = new DatabaseSync(sourceDb)
  t.after(() => db.close())
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE conversations(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE events(seq INTEGER PRIMARY KEY,cid TEXT,body TEXT);
    CREATE TABLE files(id TEXT PRIMARY KEY,cid TEXT,owner TEXT,published INTEGER,name TEXT,mime TEXT,data BLOB);
    CREATE TABLE drafts(key TEXT PRIMARY KEY,body TEXT);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER);
    CREATE TABLE requests(key TEXT PRIMARY KEY,fingerprint TEXT,body TEXT);
    CREATE TABLE conversation_preferences(uid TEXT,cid TEXT,pinned INTEGER,archived INTEGER);`)
  db.prepare('INSERT INTO conversations VALUES(?,?)').run('conversation-1', JSON.stringify({ id: 'conversation-1', ownerId: 'u-admin', projectId: 'p-autoops', turns: [{ id: 'turn-1', nativeThreadId: 'native-1', text: '用户原文' }] }))
  for (let seq = 1; seq <= 250; seq++) db.prepare('INSERT INTO events VALUES(?,?,?)').run(seq, 'conversation-1', JSON.stringify({ seq, text: `事件 ${seq}`, conversation: { revision: seq } }))
  db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)').run('../untrusted-id', 'conversation-1', 'u-admin', 0, '原始附件.pdf', 'application/pdf', Buffer.from([0, 1, 2, 255]))
  db.prepare('INSERT INTO drafts VALUES(?,?)').run('u-admin:conversation-1', JSON.stringify({ text: '未发送草稿', attachmentIds: ['../untrusted-id'] }))
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('sensitive-session', 'u-admin', 'csrf-secret', Date.now() + 100000)
  db.prepare('INSERT INTO requests VALUES(?,?,?)').run('old-command', 'fingerprint', JSON.stringify({ response: 'old receipt' }))
  db.prepare('INSERT INTO conversation_preferences VALUES(?,?,?,?)').run('u-admin', 'conversation-1', 1, 0)
  return { root, sourceDb, destination: join(root, 'snapshot'), db }
}

test('活动 WAL 数据库一致捕获，保留历史、附件和草稿且不修改源库', async (t) => {
  const f = await fixture(t)
  const manifest = await createLegacySnapshot(f)
  assert.equal(manifest.eventWatermark, 250)
  assert.equal(manifest.cutoverEligible, false)
  assert.equal(manifest.tables.events, 250)
  assert.equal(manifest.tables.files, 1)
  assert.equal(manifest.tables.sessions, undefined)
  assert.equal(manifest.tables.requests, undefined)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 250)
  const rows = (await readFile(join(f.destination, 'tables/events.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(JSON.parse(rows.at(-1).body).conversation.revision, 250)
  const file = JSON.parse((await readFile(join(f.destination, 'tables/files.ndjson'), 'utf8')).trim())
  assert.equal(file.id, '../untrusted-id')
  assert.match(file.contentFile, /^files\/[a-f0-9]{64}\.bin$/)
  assert.deepEqual(await readFile(join(f.destination, file.contentFile)), Buffer.from([0, 1, 2, 255]))
  assert.match(await readFile(join(f.destination, 'tables/drafts.ndjson'), 'utf8'), /未发送草稿/)
  const copy = new DatabaseSync(join(f.destination, 'demo.sqlite'), { readOnly: true })
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1)
  copy.close()
  await verifyLegacySnapshot(f.destination)
})

test('原生会话状态和应用水位共同保存，备份私有且清单可校验', async (t) => {
  const f = await fixture(t)
  const native = join(f.root, 'native-source')
  await mkdir(join(native, 'sessions'), { recursive: true })
  await writeFile(join(native, 'sessions/thread.jsonl'), '{"id":"native-1"}\n')
  await writeFile(join(native, 'provider-private'), 'synthetic-test-value')
  const manifest = await createLegacySnapshot({ ...f, nativeDirectories: [native], quiesced: true })
  assert.equal(manifest.cutoverEligible, true)
  assert.equal(manifest.native.length, 1)
  assert.equal((await stat(join(f.destination, 'native/0/provider-private'))).mode & 0o777, 0o600)
  assert.equal((await stat(f.destination)).mode & 0o777, 0o700)
  await verifyLegacySnapshot(f.destination)
})

test('校验发现附件损坏，拒绝覆盖既有恢复包', async (t) => {
  const f = await fixture(t)
  const manifest = await createLegacySnapshot(f)
  await assert.rejects(createLegacySnapshot(f), /已存在/)
  const file = manifest.files.find((x) => x.path.startsWith('files/'))
  await writeFile(join(f.destination, file.path), 'changed')
  await assert.rejects(verifyLegacySnapshot(f.destination), /校验失败/)
})

test('拒绝越过原生目录的符号链接，拒绝把备份放进源目录', async (t) => {
  const f = await fixture(t)
  await assert.rejects(createLegacySnapshot({ ...f, destination: join(f.root, 'source/nested') }), /源数据库目录之外/)
  const native = join(f.root, 'native-links')
  await mkdir(native)
  await symlink(f.sourceDb, join(native, 'outside.sqlite'))
  await assert.rejects(createLegacySnapshot({ ...f, nativeDirectories: [native] }), /符号链接/)
})

test('拒绝清单外文件和被替换的清单链接', async (t) => {
  const f = await fixture(t)
  await createLegacySnapshot(f)
  await writeFile(join(f.destination, 'unexpected'), 'extra')
  await assert.rejects(verifyLegacySnapshot(f.destination), /清单不一致/)
  await rm(join(f.destination, 'unexpected'))
  await rm(join(f.destination, 'manifest.json'))
  await symlink(f.sourceDb, join(f.destination, 'manifest.json'))
  await assert.rejects(verifyLegacySnapshot(f.destination), /普通目录和文件/)
})
