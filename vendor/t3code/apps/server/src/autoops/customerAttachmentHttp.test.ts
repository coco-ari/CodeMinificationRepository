// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vite-plus/test'
import * as Layer from 'effect/Layer'
import { HttpRouter } from 'effect/http'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { createCustomerTransportJournal } from '../../../../../../agent-demo/t3-adapters/customer-transport.mjs'
import { createAttachmentId } from '../attachmentStore.ts'
import { CustomerAttachmentDelivery } from './CustomerAttachmentDelivery.ts'
import { RemoteDeviceHub, RemoteDeviceService } from './RemoteDeviceService.ts'
import { layer } from './customerAttachmentHttp.ts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
async function fixture() {
  const previous = process.env.AUTOOPS_CUSTOMER_AGENTS
  process.env.AUTOOPS_CUSTOMER_AGENTS = '1'
  cleanup.push(() => {
    if (previous === undefined) delete process.env.AUTOOPS_CUSTOMER_AGENTS
    else process.env.AUTOOPS_CUSTOMER_AGENTS = previous
  })
  const sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(':memory:'),
    transport = new DatabaseSync(':memory:')
  cleanup.push(() => {
    sessions.close()
    bindings.close()
    transport.close()
  })
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  sessions
    .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
    .run(createHash('sha256').update('fixture').digest('hex'), 'u-admin', 'csrf', 60000)
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, now: () => 1000 })
  const owner = access.authenticateCookie('demo_session=fixture'),
    registry = access.customerRegistry
  const paired = registry.consumePairing(registry.createPairing(owner.id).pairingCode, {
    label: '附件测试',
  })
  const device = registry.authenticateToken(paired.deviceToken)
  registry.registerWorkspace(device, {
    registeredWorkspaceId: 'workspace',
    projectId: 'p-autoops',
    label: '测试目录',
    workspaceBindingRevision: 1,
    runtimeId: 'codex',
  })
  const target = {
    kind: 'customer' as const,
    deviceId: device.deviceId,
    registeredWorkspaceId: 'workspace',
    workspaceBindingRevision: 1,
    runtimeId: 'codex' as const,
  }
  const binding = access.bindThread(owner, {
    threadId: 'attachment-thread',
    projectId: 'p-autoops',
    environmentId: 'env-test',
    agentId: 'a-project',
    visibility: 'private',
    executionBinding: target,
  })
  const directory = mkdtempSync(join(tmpdir(), 'customer-delivery-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const id = createAttachmentId(binding.threadId, '.txt')!,
    bytes = Buffer.from('客户附件正文')
  const attachment = {
    type: 'file' as const,
    id,
    name: '资料.txt',
    mimeType: 'text/plain',
    sizeBytes: bytes.length,
  }
  const path = join(directory, `${id}.txt`)
  writeFileSync(path, bytes)
  access.recordThreadAttachment(owner, id, binding.threadId, attachment)
  const journal = createCustomerTransportJournal(transport),
    delivery = new CustomerAttachmentDelivery(access, directory),
    hub = new RemoteDeviceHub(access, journal, delivery)
  cleanup.push(() => hub.close())
  hub.bind(binding, 'session')
  const input = { message: { attachments: [attachment] } },
    manifest = await delivery.prepare(hub.session('session')!, input)
  journal.saveCommand({
    type: 'command',
    commandId: 'command',
    sessionId: 'session',
    target,
    method: 'startTurn',
    input,
    attachments: manifest,
  })
  const app = HttpRouter.toWebHandler(
    layer.pipe(Layer.provideMerge(Layer.succeed(RemoteDeviceService, { hub }))),
    { disableLogger: true },
  )
  cleanup.push(app.dispose)
  const request = (token = paired.deviceToken, commandId = 'command', attachmentId = id) =>
    app.handler(
      new Request(
        `http://localhost/autoops/customer/connector/attachments/${commandId}/${attachmentId}`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    )
  return {
    access,
    owner,
    registry,
    paired,
    device,
    request,
    bytes,
    path,
    delivery,
    hub,
    input,
    manifest,
    journal,
  }
}
it('设备凭据只读取发给本机原命令的附件，浏览器身份和未知附件均被拒绝', async () => {
  const f = await fixture()
  const response = await f.request()
  expect(response.status).toBe(200)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  for (const args of [
    ['fixture'],
    [f.paired.deviceToken, 'missing'],
    [f.paired.deviceToken, 'command', 'missing'],
  ])
    expect((await f.request(...(args as [string, string?, string?]))).status).toBe(403)
  const other = f.registry.consumePairing(f.registry.createPairing(f.owner.id).pairingCode, {
    label: '另一台电脑',
  })
  expect((await f.request(other.deviceToken)).status).toBe(403)
})
it('原命令不能读取同一设备的其他会话附件', async () => {
  const f = await fixture()
  const saved = f.journal.command('command')!.command
  const binding = f.access.getThreadBinding('attachment-thread')!
  f.access.bindThread(f.owner, { ...binding, threadId: 'other-thread' })
  f.hub.bind({ ...binding, threadId: 'other-thread' }, 'other-session')
  f.journal.saveCommand({ ...saved, sessionId: 'other-session', commandId: 'other-command' })
  expect((await f.request(f.paired.deviceToken, 'other-command')).status).toBe(403)
})
it('附件损坏、设备停用和会话删除后不再下发', async () => {
  const f = await fixture()
  writeFileSync(f.path, Buffer.alloc(f.bytes.length))
  expect((await f.request()).status).toBe(403)
  writeFileSync(f.path, f.bytes)
  f.registry.setDeviceStatus(f.owner.id, f.device.deviceId, 'disabled')
  expect((await f.request()).status).toBe(403)
  f.registry.setDeviceStatus(f.owner.id, f.device.deviceId, 'active')
  f.access.markThreadDeleted('attachment-thread')
  expect((await f.request()).status).toBe(403)
})

it('旧连接程序仍可连接，但带附件的新轮次在持久下发前明确拒绝', async () => {
  const f = await fixture()
  const peer = f.hub.connect(
    f.device,
    async () => {},
    () => {},
  )
  await peer.accept({
    type: 'hello',
    deviceId: f.device.deviceId,
    protocolVersion: 1,
    connectorVersion: '0.1.0',
    connectorEpoch: 'fixture-epoch',
    workspaces: [],
    sessions: [],
  })
  await expect(
    f.hub.command('session', 'startTurn', f.input, 'old-connector'),
  ).rejects.toMatchObject({ code: 'CONNECTOR_UPDATE_REQUIRED', outcome: 'not_started' })
})
