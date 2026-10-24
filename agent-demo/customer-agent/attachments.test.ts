import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CustomerAttachmentCache } from './attachments.ts'
import { CustomerAgentStore } from './store.ts'
import { CustomerAgentExecutor } from './executor.ts'
import type { CustomerAgentCommand } from '../../vendor/t3code/packages/contracts/src/autoopsRemote.ts'

const bytes = Buffer.from('客户附件正文 843901')
const attachment = {
  type: 'file' as const,
  id: 'file-one',
  name: '../../资料.txt',
  mimeType: 'text/plain',
  sizeBytes: bytes.length,
}
const command: CustomerAgentCommand = {
  type: 'command',
  method: 'startTurn',
  commandId: 'command',
  sessionId: 'session',
  target: { registeredWorkspaceId: 'workspace', workspaceBindingRevision: 1, runtimeId: 'codex' },
  input: { message: { attachments: [attachment] } },
  attachments: [
    {
      id: attachment.id,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ],
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'customer-attachment-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('附件自动缓存、校验且只交给目标会话；文件名不能指定落盘路径', async (t) => {
  const root = fixture(t)
  let downloads = 0
  const cache = new CustomerAttachmentCache(join(root, 'cache'), async function* () {
    downloads++
    yield bytes
  })
  await cache.prepare(command, new AbortController().signal, () => {})
  const path = cache.resolve('session', attachment)!
  assert.ok(path.startsWith(join(root, 'cache')))
  assert.deepEqual(readFileSync(path), bytes)
  assert.equal(cache.resolve('other', attachment), null)
  assert.equal(cache.resolve('session', { ...attachment, name: '其他.txt' }), null)
  await cache.prepare(command, new AbortController().signal, () => {})
  assert.equal(downloads, 1)
})

for (const [label, data] of [
  ['截断', bytes.subarray(1)],
  ['超长', Buffer.concat([bytes, bytes])],
  ['损坏', Buffer.alloc(bytes.length)],
] as const) {
  test(`拒绝${label}附件并清理未完成文件`, async (t) => {
    const root = fixture(t),
      directory = join(root, 'cache')
    const cache = new CustomerAttachmentCache(directory, async function* () {
      yield data
    })
    await assert.rejects(
      cache.prepare(command, new AbortController().signal, () => {}),
      { code: 'attachment_transfer_failed' },
    )
    assert.equal(cache.resolve('session', attachment), null)
    assert.deepEqual(readdirSync(directory), [])
  })
}
test('清单、取消、撤销、符号链接和缓存容量不能绕过', async (t) => {
  const root = fixture(t)
  let calls = 0
  const cache = new CustomerAttachmentCache(join(root, 'cache'), async function* () {
    calls++
    yield bytes
  })
  await assert.rejects(
    cache.prepare({ ...command, attachments: [] }, new AbortController().signal, () => {}),
  )
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(cache.prepare(command, abort.signal, () => {}))
  await assert.rejects(
    cache.prepare(command, new AbortController().signal, () => {
      throw new Error('撤权')
    }),
  )
  assert.equal(calls, 0)
  mkdirSync(join(root, 'outside'))
  symlinkSync(join(root, 'outside'), join(root, 'alias'), 'dir')
  await assert.rejects(
    new CustomerAttachmentCache(join(root, 'alias'), async function* () {
      yield bytes
    }).prepare(command, new AbortController().signal, () => {}),
  )
  await assert.rejects(
    new CustomerAttachmentCache(
      join(root, 'small'),
      async function* () {
        yield bytes
      },
      1,
    ).prepare(command, new AbortController().signal, () => {}),
    { code: 'attachment_cache_full' },
  )
})

test('附件失败不会启动 Codex；重复请求返回原失败，成功后原生输入可读取本机文件', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'customer-executor-'))
  mkdirSync(join(root, 'project'))
  const store = new CustomerAgentStore(join(root, 'state'))
  const workspace = store.register(join(root, 'project'), 'project', '隔离项目')
  let started = 0,
    broken = true
  const executor = new CustomerAgentExecutor({
    store,
    deviceId: 'device',
    notify: () => {},
    downloadAttachment: async function* () {
      yield broken ? bytes.subarray(1) : bytes
    },
    runnerFactory: async (options) => ({
      processGeneration: 'epoch',
      catalog: async () => ({ models: [], skills: [] }),
      close: async () => {},
      dispatch: async (method) => {
        if (method === 'startTurn') {
          started++
          assert.deepEqual(readFileSync(options.resolveAttachmentPath!(attachment)!), bytes)
        }
        return null
      },
    }),
  })
  t.after(async () => {
    await executor.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  await executor.execute({
    ...command,
    target: workspace,
    method: 'openSession',
    commandId: 'open',
    input: {},
    attachments: [],
  })
  const start = {
    ...command,
    target: workspace,
    input: { runId: 'run', attemptId: 'attempt', message: { attachments: [attachment] } },
  }
  assert.equal((await executor.execute(start)).state, 'failed')
  assert.equal(store.session('session')?.state, 'idle')
  broken = false
  assert.equal((await executor.execute(start)).state, 'failed')
  assert.equal(started, 0)
  assert.equal((await executor.execute({ ...start, commandId: 'retry' })).state, 'completed')
  assert.equal(started, 1)
})
