import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, realpath, rm, lstat, writeFile, readFile, chmod, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { createSharedModelGateway } from './shared-model-gateway.ts'
import type { SharedExecutionScope } from '../../autoops/contracts/shared-execution.ts'

const credential = 'Bearer autoops-fixture-shared-model-token-20261026'
const scope = (): SharedExecutionScope => ({
  grantId: 'issued-grant-one', actorId: 'caller-one', providerId: 'provider-one',
  projectId: 'project-one', sourceProjectId: 'source-project', threadId: 'thread-one', runId: 'run-one',
  assistantId: 'provided-assistant', presetRevision: 1, shareRevision: 1,
  allocation: { kind: 'member', id: 'caller-one', revision: 1 }, capabilityRevision: 'actual-catalog-one',
  profile: { id: 'readonly-profile', revision: 1, digest: 'a'.repeat(64), imageDigest: 'sha256:' + 'b'.repeat(64), policy: 'linux-docker-readonly-v1' },
  target: { kind: 'customer', deviceId: 'device-one', registeredWorkspaceId: 'workspace-one', workspaceBindingRevision: 1, runtimeId: 'codex' },
  model: { instanceId: 'customer-device-one-codex', model: 'actual-model', reasoningEffort: 'high' }, skillIds: [],
})
const body = (model = 'actual-model', effort = 'high') => ({ model, reasoning: { effort }, input: [{ role: 'user', content: '隔离测试内容' }], stream: true })
type Received = { url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }
async function fixture(t: TestContext, options: {
  authorize?: (scope: SharedExecutionScope, signal: AbortSignal) => void | Promise<void>
  respond?: (request: Received, response: ServerResponse) => void
  expectedReasoningEffort?: (scope: SharedExecutionScope) => string | null
  maxBodyBytes?: number; maxResponseBytes?: number; requestTimeoutMs?: number
} = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'shared-model-')))
  const received: Received[] = [], responseChunks: Buffer[] = []
  let current = scope(), revoked = false, secretsRead = 0
  let gateway: Awaited<ReturnType<typeof createSharedModelGateway>> | undefined
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const value = { url: request.url!, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }
    received.push(value)
    if (options.respond) options.respond(value, response)
    else { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"text":"真实流式结果"}\n\n') }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway?.close()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  const address = upstream.address() as { port: number }
  gateway = await createSharedModelGateway({
    socketPath: join(directory, 'model.sock'), scope: () => current,
    authorize: async (value, signal) => {
      if (revoked) throw new Error('共享已撤回')
      await options.authorize?.(value, signal)
    },
    expectedReasoningEffort: options.expectedReasoningEffort ?? (value => value.model.reasoningEffort),
    upstream: { url: `http://127.0.0.1:${address.port}/private-model/v1`, authorization: () => { secretsRead++; return credential } },
    ...(options.maxBodyBytes ? { maxBodyBytes: options.maxBodyBytes } : {}),
    ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  })
  const call = (value: unknown = body(), path = '/v1/responses', headers: Record<string, string> = {}) => new Promise<{ status: number; headers: IncomingMessage['headers']; text: string; bytes: Buffer }>((resolve, reject) => {
    const requestValue = request({ socketPath: join(directory, 'model.sock'), path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)); responseChunks.push(Buffer.from(chunk)) })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, text: Buffer.concat(chunks).toString(), bytes: Buffer.concat(chunks) }))
    })
    requestValue.on('error', reject)
    requestValue.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  })
  return { directory, received, responseChunks, gateway, call, revoke() { revoked = true }, setScope(value: SharedExecutionScope) { current = value }, get secretsRead() { return secretsRead } }
}

test('真实UDS转发固定模型与强度、无远端持久会话，宿主凭据和调用者header不混用', async t => {
  const f = await fixture(t)
  const result = await f.call(body(), undefined, { authorization: 'Bearer container-fictional', cookie: 'other-user', 'x-project': 'forged' })
  assert.equal(result.status, 200)
  assert.match(result.text, /真实流式结果/)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(f.received[0]!.url, '/private-model/v1/responses')
  assert.equal(f.received[0]!.headers.authorization, credential)
  assert.equal(f.received[0]!.headers.cookie, undefined)
  assert.equal(f.received[0]!.headers['x-project'], undefined)
  assert.deepEqual(f.received[0]!.body, { ...body(), store: false, background: false })
  assert.equal((await lstat(join(f.directory, 'model.sock'))).mode & 0o777, 0o600)
})

test('模型、强度、远端会话/文件和托管MCP不能借提供者凭据改变范围', async t => {
  const f = await fixture(t)
  for (const value of [body('other-model'), body(undefined, 'low'), { ...body(), previous_response_id: 'other-response' }, { ...body(), conversation: 'other-conversation' }, { ...body(), store: true }, { ...body(), background: true }, { ...body(), input: [{ type: 'input_file', file_id: 'other-user-file' }] }, { ...body(), tools: [{ type: 'mcp', server_url: 'http://private.invalid' }] }, { ...body(), tools: [{ type: 'web_search' }] }, { ...body(), input: [{ type: 'input_image', image_url: 'http://private.invalid/image' }] }]) {
    assert.equal((await f.call(value)).status, 400)
  }
  assert.equal(f.received.length, 0)
  assert.equal(f.secretsRead, 0)
})

test('真实正文按字节限额，非法编码、无关路由和压缩不能进入上游', async t => {
  const f = await fixture(t, { maxBodyBytes: 512 })
  assert.equal((await f.call(JSON.stringify(body()) + ' '.repeat(512))).status, 400)
  assert.equal((await f.call('{invalid')).status, 400)
  assert.equal((await f.call(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d]))).status, 400)
  assert.equal((await f.call(body(), '/v1/responses?url=http://other.invalid')).status, 400)
  assert.equal((await f.call(body(), undefined, { 'content-encoding': 'gzip' })).status, 400)
  assert.equal(f.received.length, 0)
})

test('同一线程新轮可接受中心重新签发的实际模型，不能换调用者或目标目录', async t => {
  const f = await fixture(t)
  assert.equal((await f.call()).status, 200)
  f.setScope({ ...scope(), grantId: 'issued-next', runId: 'run-two', model: { ...scope().model, model: 'actual-next', reasoningEffort: 'low' } })
  assert.equal((await f.call(body('actual-next', 'low'))).status, 200)
  f.setScope({ ...scope(), actorId: 'other-caller', grantId: 'forged-other' })
  assert.equal((await f.call()).status, 403)
  assert.equal(f.received.length, 2)
})

test('正文准备后撤回共享，拒绝迟到请求且不读取宿主凭据', async t => {
  let checks = 0, f!: Awaited<ReturnType<typeof fixture>>
  f = await fixture(t, { authorize: () => { if (++checks === 2) { f.revoke(); throw new Error('已撤回') } } })
  assert.equal((await f.call()).status, 403)
  assert.equal(f.received.length, 0)
  assert.equal(f.secretsRead, 0)
})

test('实际目录的默认强度必须精确匹配，空预设不能变成平台默认值', async t => {
  const f = await fixture(t, { expectedReasoningEffort: () => 'high' })
  f.setScope({ ...scope(), model: { ...scope().model, reasoningEffort: null } })
  assert.equal((await f.call(body())).status, 200)
  assert.equal((await f.call({ ...body(), reasoning: undefined })).status, 400)
  assert.equal(f.received.length, 1)
})

test('提供者远端提示模板和item引用不能绕过无持久会话范围', async t => {
  const f = await fixture(t)
  const results = []
  for (const input of [
    { ...body(), prompt: { id: 'pmpt-other-project' } },
    { ...body(), input: [{ type: 'item_reference', id: 'msg-other-caller' }] },
  ]) results.push((await f.call(input)).status)
  assert.deepEqual(results, [400, 400])
  assert.equal(f.received.length, 0)
  assert.equal(f.secretsRead, 0)
})

test('省略引用类型、输入中托管工具及强度配置不能绕过本轮合同', async t => {
  const f = await fixture(t)
  const hosted = { type: 'mcp', server_label: 'other', server_url: 'https://remote.invalid/mcp', require_approval: 'never' }
  const values = [
    [{ id: 'msg-other-caller' }],
    [{ type: null, id: 'msg-other-caller' }],
    [{ type: 'additional_tools', role: 'developer', tools: [hosted] }],
    [{ type: 'tool_search_output', call_id: 'local-search', status: 'completed', execution: 'client', tools: [hosted] }],
    [{ type: 'tool_search_output', call_id: 'remote-search', status: 'completed', execution: 'server', tools: [] }],
    [{ type: 'configuration_update', reasoning: { effort: 'low' } }],
    [{ type: 'compaction_trigger' }],
    [{ type: 'future_remote_resource', id: 'other-user-object' }],
  ]
  const results = []
  for (const input of values) results.push((await f.call({ ...body(), input })).status)
  assert.deepEqual(results, values.map(() => 400))
  assert.equal(f.received.length, 0)
  assert.equal(f.secretsRead, 0)
})

test('锁定CLI的内联消息、本机延迟工具和搜索结果保持可用', async t => {
  const f = await fixture(t)
  const tools = [{ type: 'namespace', name: 'local', tools: [
    { type: 'function', name: 'read', parameters: { type: 'object' }, defer_loading: true },
    { type: 'custom', name: 'patch', format: { type: 'text' }, defer_loading: true },
  ] }]
  const input = [
    { type: 'additional_tools', role: 'developer', tools },
    { role: 'user', content: [{ type: 'input_text', text: '读取当前文件' }, { type: 'input_image', image_url: 'data:image/png;base64,aA==' }] },
    { type: 'function_call', name: 'read', call_id: 'call-one', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-one', output: [{ type: 'input_text', text: '本轮文件内容' }] },
    { type: 'tool_search_call', call_id: 'search-one', execution: 'client', arguments: { query: 'local' } },
    { type: 'tool_search_output', call_id: 'search-one', status: 'completed', execution: 'client', tools },
    { type: 'tool_search_output', call_id: 'cancelled-search', status: 'completed', execution: 'client', tools: [] },
    { type: 'reasoning', summary: [], encrypted_content: 'opaque-local-history' },
    { type: 'compaction', encrypted_content: 'opaque-local-compaction' },
  ]
  const result = await f.call({ ...body(), input, tools: [{ type: 'tool_search', execution: 'client' }] })
  assert.equal(result.status, 200)
  assert.deepEqual(f.received[0]!.body.input, input)
  assert.equal((await f.call({ ...body(), input, tools: null })).status, 200)
})

test('锁定CLI完整内联消息的本机id不变成提供者远端引用', async t => {
  const f = await fixture(t)
  const input = ['developer', 'user', 'user', 'user', 'user'].map((role, index) => ({
    type: 'message', id: `fixture-local-message-${index}`, role,
    content: [{ type: 'input_text', text: '本轮虚构的内联资料' }],
  }))
  const result = await f.call({ ...body(), input })
  assert.equal(result.status, 200)
  assert.deepEqual(f.received[0]!.body.input, input.map(({ id: _id, ...message }) => message))
  assert.equal(f.received.length, 1)
  assert.equal(f.secretsRead, 1)
})

test('本机消息id只能附于完整显式内联消息，引用和不完整输入仍在读取凭据前拒绝', async t => {
  const f = await fixture(t)
  const content = [{ type: 'input_text', text: '虚构正文' }]
  const inputs = [
    [{ id: 'remote-message' }],
    [{ id: 'ambiguous-message', role: 'user', content }],
    [{ type: 'message', id: 'remote-message', role: 'user' }],
    [{ type: 'message', id: 'remote-message', role: 'user', content: [] }],
    [{ type: 'message', id: 'remote-message', role: 'user', content: '' }],
    [{ type: 'message', id: { other: 'remote-message' }, role: 'user', content }],
    [{ type: 'message', id: 'x'.repeat(257), role: 'user', content }],
    [{ type: 'message', id: 'bad\nmessage', role: 'user', content }],
    [{ type: 'message', id: 'inline', role: 'user', content, file_id: 'remote-file' }],
    [{ type: 'message', id: 'inline', role: 'user', content: [{ type: 'input_file', file_id: 'remote-file' }] }],
    [{ type: 'message', id: 'inline', role: 'user', content: [{ type: 'input_image', image_url: 'https://private.invalid/file' }] }],
    [{ type: 'item_reference', id: 'remote-message', role: 'user', content }],
  ]
  for (const input of inputs) assert.equal((await f.call({ ...body(), input })).status, 400)
  assert.equal(f.received.length, 0)
  assert.equal(f.secretsRead, 0)
})

test('流式输出中撤回共享，迟到分块不能交付，原请求不重放', { timeout: 3_000 }, async t => {
  const first = Promise.withResolvers<ServerResponse>()
  const checked = Promise.withResolvers<void>()
  let checks = 0
  const f = await fixture(t, {
    authorize: () => { if (++checks >= 5) checked.resolve() },
    respond: (_input, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + '首段结果'.repeat(100) + '\n\n')
      first.resolve(response)
    },
  })
  const outcome = f.call().then(value => value, error => error as Error)
  const upstream = await first.promise
  await checked.promise
  f.revoke()
  upstream.end('data: 不可交付的迟到内容\n\n')
  assert.ok(await outcome instanceof Error)
  assert.ok(!Buffer.concat(f.responseChunks).toString().includes('不可交付'))
  assert.equal(f.received.length, 1)
})

test('并发请求被拒绝，关闭会终止正在等待的上游并完成排空', { timeout: 3_000 }, async t => {
  const accepted = Promise.withResolvers<void>()
  const f = await fixture(t, { respond: () => accepted.resolve() })
  const outcome = f.call().then(value => value, error => error as Error)
  await accepted.promise
  assert.equal((await f.call()).status, 429)
  await f.gateway.close()
  await f.gateway.drain()
  assert.ok(await outcome instanceof Error)
  assert.equal(f.received.length, 1)
  assert.equal(f.secretsRead, 1)
})

test('准入服务无响应时总期限中止请求，不读取凭据且关闭不挂起', { timeout: 3_000 }, async t => {
  const aborted = Promise.withResolvers<void>()
  const f = await fixture(t, {
    requestTimeoutMs: 100,
    authorize: (_scope, signal) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      return new Promise<void>(() => {})
    },
  })
  const outcome = f.call().then(value => value, error => error as Error)
  await aborted.promise
  assert.ok(await outcome instanceof Error)
  await f.gateway.drain()
  assert.equal(f.secretsRead, 0)
  assert.equal(f.received.length, 0)
})

test('上游响应超过字节限额时中断，不交付超限数据', { timeout: 3_000 }, async t => {
  const f = await fixture(t, { maxResponseBytes: 64, respond: (_input, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ text: '超限内容'.repeat(200) }))
  } })
  const outcome = await f.call().then(value => value, error => error as Error)
  assert.ok(outcome instanceof Error)
  assert.equal(Buffer.concat(f.responseChunks).length, 0)
  assert.equal(f.received.length, 1)
})

test('上游重定向和错误正文不透传，不泄露凭据或连接细节', async t => {
  const f = await fixture(t, { respond: (_input, response) => {
    response.writeHead(302, { location: 'http://other.invalid', 'set-cookie': credential })
    response.end(credential)
  } })
  const result = await f.call()
  assert.equal(result.status, 502)
  assert.equal(result.headers.location, undefined)
  assert.equal(result.headers['set-cookie'], undefined)
  assert.ok(!result.text.includes(credential))
  assert.equal(f.received.length, 1)
})

test('成功流跨分块意外回显凭据时精确脱敏，正常流内容保持', async t => {
  const token = credential.replace('Bearer ', '')
  const f = await fixture(t, { respond: (_input, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"text":"' + token.slice(0, 9))
    setImmediate(() => response.end(token.slice(9) + '"}\n\n'))
  } })
  const result = await f.call()
  assert.equal(result.status, 200)
  assert.ok(!result.text.includes(token))
  assert.match(result.text, /已移除运行凭据/)
})

test('gzip和brotli成功正文不能绕过宿主凭据脱敏', async t => {
  let encoding = 'gzip'
  const payload = Buffer.from(JSON.stringify({ token: credential }))
  const f = await fixture(t, { respond: (_input, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding })
    response.end(encoding === 'gzip' ? gzipSync(payload) : brotliCompressSync(payload))
  } })
  const results = []
  for (const format of ['gzip', 'br']) {
    encoding = format
    results.push(await f.call())
  }
  assert.deepEqual(results.map(result => result.status), [502, 502])
  assert.ok(results.every(result => result.headers['content-encoding'] === undefined && !result.text.includes(credential)))
  assert.ok(f.received.every(request => request.headers['accept-encoding'] === 'identity'))
})

test('停止接单和关闭排空不重放请求，原socket之外的文件保持', async t => {
  const f = await fixture(t)
  const marker = join(f.directory, 'keep.txt')
  await writeFile(marker, '原有文件')
  f.gateway.stopAccepting()
  assert.equal((await f.call()).status, 503)
  await f.gateway.drain()
  await f.gateway.close()
  assert.equal(await readFile(marker, 'utf8'), '原有文件')
  await assert.rejects(lstat(join(f.directory, 'model.sock')), { code: 'ENOENT' })
})

test('目录权限不合格或socket位置已有文件时拒绝启动，绝不覆盖', async t => {
  const f = await fixture(t)
  const file = join(f.directory, 'existing.sock')
  await writeFile(file, '原有内容')
  const config = { socketPath: file, scope, authorize() {}, expectedReasoningEffort: () => 'high', upstream: { url: 'http://127.0.0.1:1/v1', authorization: () => credential } }
  await assert.rejects(createSharedModelGateway(config))
  assert.equal(await readFile(file, 'utf8'), '原有内容')
  await chmod(f.directory, 0o755)
  await assert.rejects(createSharedModelGateway({ ...config, socketPath: join(f.directory, 'new.sock') }), /权限无效/)
  await chmod(f.directory, 0o700)
})

test('关闭前socket路径被替换时保留新文件，不越过本实例所有权', async t => {
  const f = await fixture(t)
  const socketPath = join(f.directory, 'model.sock')
  await unlink(socketPath)
  await writeFile(socketPath, '另一个所有者的文件')
  await f.gateway.close()
  assert.equal(await readFile(socketPath, 'utf8'), '另一个所有者的文件')
})

test('本机函数参数的JSON schema字段名不是远端文件句柄，真实内容引用仍拒绝', async t => {
  const f = await fixture(t)
  const tool = { type: 'function', name: 'inspect_local', parameters: { type: 'object', properties: {
    file_id: { type: 'string' }, file_url: { type: 'string' }, container_id: { type: 'string' },
    vector_store_ids: { type: 'array', items: { type: 'string' } }, image_url: { type: 'string' }, audio_url: { type: 'string' },
  } } }
  for (const value of [
    { ...body(), tools: [tool] },
    { ...body(), input: [{ type: 'additional_tools', role: 'developer', tools: [tool] }] },
    { ...body(), input: [{ type: 'tool_search_output', execution: 'client', status: 'completed', call_id: 'local-call', tools: [tool] }] },
  ]) assert.equal((await f.call(value)).status, 200)
  const accepted = f.received.length
  for (const value of [
    { ...body(), input: [{ role: 'user', content: [{ type: 'input_file', file_data: 'data:text/plain;base64,eA==', file_id: 'remote-file' }] }] },
    { ...body(), input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://private.invalid/image' }] }] },
    { ...body(), input: [{ type: 'item_reference', id: 'remote-item' }] },
    { ...body(), input: [{ type: 'message', role: 'user', id: 'remote-message', content: 'inline' }] },
  ]) assert.equal((await f.call(value)).status, 400)
  assert.equal(f.received.length, accepted)
})
