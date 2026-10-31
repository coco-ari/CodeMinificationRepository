import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHostBootstrap } from '../web/src/agent-demo/t3/bootstrap.ts'

const sessionPath = '/api/agent-demo/t3/api/auth/session'
const bootstrapPath = '/api/agent-demo/t3/autoops/bootstrap'

test('先完成原生会话初始化，再读取真实项目范围', async (context) => {
  let releaseSession
  const ready = new Promise(resolve => { releaseSession = resolve })
  const payload = { projects: [{ id: 'isolated-project' }] }
  const calls = []
  const controller = new AbortController()
  context.mock.method(globalThis, 'fetch', async (path, options) => {
    calls.push(path)
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.signal, controller.signal)
    if (path === sessionPath) { await ready; return Response.json({}) }
    assert.equal(path, bootstrapPath)
    return Response.json(payload)
  })
  const result = loadHostBootstrap(controller.signal)
  assert.deepEqual(calls, [sessionPath])
  releaseSession()
  assert.deepEqual(await result, payload)
  assert.deepEqual(calls, [sessionPath, bootstrapPath])
})

for (const status of [401, 503]) {
  test(`原生会话返回 ${status} 时不继续读取业务范围`, async (context) => {
    const fetch = context.mock.method(globalThis, 'fetch', async () => new Response(null, { status }))
    const result = loadHostBootstrap(new AbortController().signal)
    if (status === 401) assert.equal(await result, null)
    else await assert.rejects(result, /无法初始化对话登录状态/)
    assert.equal(fetch.mock.callCount(), 1)
  })
}

for (const status of [401, 500]) {
  test(`业务范围返回 ${status} 时不伪造空项目或成功`, async (context) => {
    let count = 0
    context.mock.method(globalThis, 'fetch', async () => ++count === 1 ? Response.json({}) : new Response(null, { status }))
    const result = loadHostBootstrap(new AbortController().signal)
    if (status === 401) assert.equal(await result, null)
    else await assert.rejects(result, /无法读取项目范围/)
  })
}

test('初始化期间取消，不再发起业务范围请求', async (context) => {
  let releaseSession
  const ready = new Promise(resolve => { releaseSession = resolve })
  const fetch = context.mock.method(globalThis, 'fetch', async () => { await ready; return Response.json({}) })
  const controller = new AbortController()
  const result = loadHostBootstrap(controller.signal)
  controller.abort()
  releaseSession()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 1)
})
