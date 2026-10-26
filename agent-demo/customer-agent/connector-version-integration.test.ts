import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeWS } from '../../vendor/t3code/apps/server/node_modules/@effect/platform-node-shared/dist/NodeSocket.js'
import { RemoteDeviceHub } from '../../vendor/t3code/apps/server/src/autoops/RemoteDeviceService.ts'
import { decodeCustomerAgentClientFrame } from '../../vendor/t3code/packages/contracts/src/autoopsRemote.ts'
import { createCustomerRegistry } from '../t3-adapters/customer-registry.mjs'
import { createCustomerTransportJournal } from '../t3-adapters/customer-transport.mjs'
import { CustomerAgentStore } from './store.ts'
import { CustomerAgentConnection, CONNECTOR_VERSION } from './connection.ts'

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('真实握手未在期限内完成')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'autoops-connector-version-'))
  const registryDb = new DatabaseSync(':memory:'), transportDb = new DatabaseSync(':memory:')
  const registry = createCustomerRegistry({db:registryDb, enabled:()=>true, requireOwner() {}, requireProjectForUser() {}})
  const paired = registry.consumePairing(registry.createPairing('owner').pairingCode, {label:'版本测试', connectorVersion:'0.1.0'})
  const journal = createCustomerTransportJournal(transportDb)
  const hub = new RemoteDeviceHub({assertAccepting() {}, customerRegistry:registry} as never, journal)
  const errors: string[] = []
  let count = 0, delayFirst = false, releaseFirst: (() => void) | undefined, firstQueued = false
  const server = createServer(), wss = new NodeWS.WebSocketServer({server})
  wss.on('connection', (socket: InstanceType<typeof NodeWS.WebSocket>, request: IncomingMessage) => {
    const ordinal = ++count
    const principal = registry.authenticateToken(request.headers.authorization?.slice(7) ?? '')
    const peer = hub.connect(principal, async frame => {if(socket.readyState === NodeWS.WebSocket.OPEN) socket.send(JSON.stringify(frame))}, ()=>socket.close())
    socket.on('message', (raw: unknown) => {
      void (async () => {
        const frame = decodeCustomerAgentClientFrame(String(raw))
        if (ordinal === 1 && delayFirst) {
          firstQueued = true
          await new Promise<void>(resolve => {releaseFirst = resolve})
        }
        await peer.accept(frame)
      })().catch(error => errors.push(String(error.code ?? 'UNKNOWN')))
    })
    socket.on('close', ()=>peer.disconnect())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as {port:number}).port
  const raw = async (version: string) => {
    const socket = new NodeWS.WebSocket(`ws://127.0.0.1:${port}`, {headers:{authorization:`Bearer ${paired.deviceToken}`}})
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)})
    const hello = {type:'hello',protocolVersion:1,deviceId:paired.device.id,connectorVersion:version,connectorEpoch:`wire-${count}`,workspaces:[],sessions:[]}
    socket.send(JSON.stringify(hello))
    return {socket,hello}
  }
  return {registry, paired, errors, journal, directory, port, raw,
    delay:()=>{delayFirst=true}, queued:()=>firstQueued, release:()=>releaseFirst?.(),
    async close() {
      releaseFirst?.()
      hub.close()
      for(const client of wss.clients)client.terminate()
      await new Promise<void>(resolve=>wss.close(()=>resolve()))
      await new Promise<void>(resolve=>server.close(()=>resolve()))
      registryDb.close();transportDb.close();rmSync(directory,{recursive:true,force:true})
    },
  }
}

test('真实连接程序 HELLO 把旧配对版本更新到当前版本，所有者列表与连接代次一致', async () => {
  const f = await fixture(), store = new CustomerAgentStore(join(f.directory,'state'))
  let ready = false, nativeStarts = 0
  const connection = new CustomerAgentConnection({store,credentials:{deviceId:f.paired.device.id,token:f.paired.deviceToken,baseUrl:`http://127.0.0.1:${f.port}`},
    runnerFactory:async()=>{nativeStarts++;throw new Error('版本握手不能启动模型')},onReady:async()=>{ready=true}})
  try {
    connection.start();await until(()=>ready)
    const device = f.registry.listDevices('owner')[0]!
    assert.equal(CONNECTOR_VERSION,'0.4.2')
    assert.equal(device.connectorVersion,CONNECTOR_VERSION)
    assert.equal(device.connectionEpoch,1)
    assert.equal(device.online,true)
    assert.deepEqual(f.registry.listDevices('other'),[])
    assert.deepEqual(f.errors,[])
    assert.equal(nativeStarts,0)
  } finally {await connection.close();store.close();await f.close()}
})

test('真实 WS 的重复 HELLO 被拒绝，不能改版本或增加代次', async () => {
  const f = await fixture()
  try {
    const {socket,hello} = await f.raw('0.4.0')
    await until(()=>f.registry.listDevices('owner')[0]?.connectorVersion === '0.4.0')
    socket.send(JSON.stringify({...hello,connectorVersion:'0.2.0'}))
    await until(()=>f.errors.length === 1)
    assert.deepEqual(f.errors,['INVALID_HELLO'])
    assert.equal(f.registry.listDevices('owner')[0]?.connectorVersion,'0.4.0')
    assert.equal(f.registry.listDevices('owner')[0]?.connectionEpoch,1)
  } finally {await f.close()}
})

test('真实 WS 已排队的旧 HELLO 在新连接完成后仍被拒绝，不能回退新版本', async () => {
  const f = await fixture()
  try {
    f.delay();await f.raw('0.2.0');await until(f.queued)
    await f.raw('0.4.0')
    await until(()=>f.registry.listDevices('owner')[0]?.connectorVersion === '0.4.0')
    f.release();await until(()=>f.errors.length === 1)
    assert.deepEqual(f.errors,['STALE_CONNECTION'])
    assert.equal(f.registry.listDevices('owner')[0]?.connectorVersion,'0.4.0')
    assert.equal(f.registry.listDevices('owner')[0]?.connectionEpoch,2)
  } finally {await f.close()}
})
