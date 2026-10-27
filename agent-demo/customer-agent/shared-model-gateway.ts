import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { chmod, lstat, realpath, unlink, mkdtemp, link, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, join } from 'node:path'
import type { Socket } from 'node:net'
import { decodeContract } from '../../autoops/contracts/index.ts'
import { SharedExecutionScope, type SharedExecutionScope as Scope } from '../../autoops/contracts/shared-execution.ts'

export interface SharedModelGatewayOptions {
  socketPath: string
  scope: () => Scope
  authorize: (scope: Scope, signal: AbortSignal) => void | Promise<void>
  /** 只能来自提供者本机配置；容器与模型不能指定上游或取得凭据。 */
  upstream: { url: string; authorization: (signal: AbortSignal) => string | Promise<string> }
  expectedReasoningEffort: (scope: Scope) => string | null
  maxBodyBytes?: number
  maxResponseBytes?: number
  requestTimeoutMs?: number
}

class GatewayError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
const unavailable = () => new GatewayError(403, 'SHARED_MODEL_ADMISSION_DENIED', '共享运行授权不可用，请核对原任务')
const invalid = () => new GatewayError(400, 'SHARED_MODEL_INPUT_INVALID', '共享模型请求不符合当前运行范围')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
const identity = (scope: Scope) => JSON.stringify([
  scope.actorId, scope.providerId, scope.projectId, scope.sourceProjectId, scope.threadId,
  scope.assistantId, scope.target, scope.profile,
])
const frozenScope = (scope: Scope): Scope => {
  const value = structuredClone(decodeContract(SharedExecutionScope, scope))
  const freeze = (entry: unknown) => {
    if (entry && typeof entry === 'object') {
      for (const child of Object.values(entry)) freeze(child)
      Object.freeze(entry)
    }
  }
  freeze(value)
  return value
}
const bounded = (value: number | undefined, fallback: number, maximum: number) => {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
    throw new Error('共享模型通道限额无效')
  return selected
}
function abortable<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener('abort', cancelled); reject(signal.reason) }
    signal.addEventListener('abort', cancelled, { once: true })
    Promise.resolve(value).then(result => {
      signal.removeEventListener('abort', cancelled); resolve(result)
    }, error => { signal.removeEventListener('abort', cancelled); reject(error) })
  })
}

function validateBody(value: unknown, scope: Scope, effort: string | null, compact: boolean) {
  const body = object(value)
  if (body.model !== scope.model.model || (body.background != null && body.background !== false) || body.store === true ||
      body.previous_response_id != null || body.conversation != null || body.prompt != null || 'reasoning_effort' in body)
    throw invalid()
  if (scope.model.reasoningEffort !== null && effort !== scope.model.reasoningEffort) throw unavailable()
  if (!compact && (body.reasoning == null ? null : object(body.reasoning).effort ?? null) !== effort)
    throw invalid()
  // 结构限额适用于整个正文，函数 JSON schema 的字段名本身不代表远端权限。
  const rejectRemoteHandles = (item: Record<string, unknown>) => {
    if (['file_id', 'file_url', 'vector_store_ids', 'container_id'].some(key => key in item)) throw invalid()
  }
  rejectRemoteHandles(body)
  // 共享模型只处理本轮内联输入和本机工具，不能借提供者账号读取其他远端会话或文件。
  const pending: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++nodes > 100_000 || entry.depth > 64) throw invalid()
    if (!entry.value || typeof entry.value !== 'object') continue
    for (const child of Object.values(entry.value))
      pending.push({ value: child, depth: entry.depth + 1 })
  }
  const checkTool = (value: unknown) => {
    const tool = object(value)
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const child of tool.tools) {
        if (!['function', 'custom'].includes(String(object(child).type))) throw invalid()
      }
    } else if (tool.type === 'tool_search' && tool.execution === 'client') {
      return
    } else if (!['function', 'custom'].includes(String(tool.type))) throw invalid()
  }
  const checkTools = (value: unknown) => {
    if (!Array.isArray(value)) throw invalid()
    for (const tool of value) checkTool(tool)
  }
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  const checkContent = (value: unknown, encrypted = false) => {
    if (typeof value === 'string') return
    if (!Array.isArray(value)) throw invalid()
    for (const entry of value) {
      const item = object(entry)
      rejectRemoteHandles(item)
      switch (item.type) {
        case 'input_text': case 'output_text':
          if (typeof item.text !== 'string') throw invalid()
          break
        case 'input_image':
          if (typeof item.image_url !== 'string' || !item.image_url.startsWith('data:image/')) throw invalid()
          break
        case 'input_audio':
          if (typeof item.audio_url !== 'string' || !item.audio_url.startsWith('data:audio/')) throw invalid()
          break
        case 'input_file':
          if (!text(item.file_data)) throw invalid()
          break
        case 'encrypted_content':
          if (!encrypted || !text(item.encrypted_content)) throw invalid()
          break
        default: throw invalid()
      }
    }
  }
  // 只接受锁定 CLI 实际发送的内联项目，不能让可选 type 的远端引用或后续配置改变权限。
  if (typeof body.input !== 'string') {
    if (!Array.isArray(body.input)) throw invalid()
    for (const value of body.input) {
      const item = object(value)
      rejectRemoteHandles(item)
      switch (item.type) {
        case undefined: case 'message':
          if ('id' in item && (item.type !== 'message' || !text(item.id) || item.id.length > 256 || /[\x00-\x1f\x7f]/.test(item.id) ||
              !Array.isArray(item.content) || item.content.length === 0)) throw invalid()
          if (!['user', 'assistant', 'system', 'developer'].includes(String(item.role))) throw invalid()
          checkContent(item.content)
          // 锁定 CLI 为完整内联消息生成本机 id；去除标识后转发正文，不能将其当提供者远端对象引用。
          delete item.id
          break
        case 'agent_message':
          if (!text(item.author) || !text(item.recipient)) throw invalid()
          checkContent(item.content, true)
          break
        case 'additional_tools':
          if (item.role !== 'developer') throw invalid()
          checkTools(item.tools)
          break
        case 'tool_search_call':
          if (item.execution !== 'client' || item.arguments == null) throw invalid()
          break
        case 'tool_search_output':
          if (item.execution !== 'client' || item.status !== 'completed' || !text(item.call_id)) throw invalid()
          checkTools(item.tools)
          break
        case 'function_call': case 'custom_tool_call':
          if (!text(item.call_id) || !text(item.name) || typeof item[item.type === 'function_call' ? 'arguments' : 'input'] !== 'string') throw invalid()
          break
        case 'function_call_output': case 'custom_tool_call_output':
          if (!text(item.call_id) && !text(item.name)) throw invalid()
          checkContent(item.output, true)
          break
        case 'reasoning':
          if (!Array.isArray(item.summary)) throw invalid()
          break
        case 'local_shell_call':
          if (!['in_progress', 'completed', 'incomplete'].includes(String(item.status)) || object(item.action).type !== 'exec') throw invalid()
          break
        case 'compaction': case 'compaction_summary':
          if (!text(item.encrypted_content)) throw invalid()
          break
        case 'context_compaction':
          if (!text(item.encrypted_content)) throw invalid()
          break
        default: throw invalid()
      }
    }
  }
  if (body.tools != null) {
    checkTools(body.tools)
  }
  if (body.tool_choice && typeof body.tool_choice === 'object') checkTool(body.tool_choice)
  // 同步请求省略可选后台字段，避免向不支持该字段的上游注入新参数。
  delete body.background
  return Buffer.from(JSON.stringify({ ...body, store: false }))
}

/** 不缓存上游错误；即使成功流意外回显凭据，也跨分块移除精确凭据字节。 */
function redactor(authorization: string) {
  const patterns = [authorization, authorization.replace(/^Bearer /, '')].map(value => Buffer.from(value))
  const keep = Math.max(...patterns.map(value => value.length)) - 1
  let pending = Buffer.alloc(0)
  return (chunk: Buffer, final = false) => {
    pending = Buffer.concat([pending, chunk])
    const output: Buffer[] = []
    while (pending.length) {
      const found = patterns.map(pattern => ({ pattern, at: pending.indexOf(pattern) }))
        .filter(value => value.at >= 0).sort((a, b) => a.at - b.at)[0]
      if (found) {
        output.push(pending.subarray(0, found.at), Buffer.from('[已移除运行凭据]'))
        pending = pending.subarray(found.at + found.pattern.length)
      } else {
        const length = final ? pending.length : Math.max(0, pending.length - keep)
        if (length) output.push(pending.subarray(0, length))
        pending = pending.subarray(length)
        break
      }
    }
    return Buffer.concat(output)
  }
}

export async function createSharedModelGateway(options: SharedModelGatewayOptions) {
  const socketPath = resolve(options.socketPath), parent = dirname(socketPath)
  if (!isAbsolute(options.socketPath) || await realpath(parent) !== parent)
    throw new Error('共享模型通道必须位于真实私有目录')
  const directory = await lstat(parent)
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      (process.getuid && directory.uid !== process.getuid())) throw new Error('共享模型通道目录权限无效')
  let upstream: URL
  try {
    upstream = new URL(options.upstream.url.endsWith('/') ? options.upstream.url : options.upstream.url + '/')
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash)
      throw new Error()
  } catch { throw new Error('共享模型上游配置无效') }
  const maxBody = bounded(options.maxBodyBytes, 8 * 1024 * 1024, 64 * 1024 * 1024)
  const maxResponse = bounded(options.maxResponseBytes, 32 * 1024 * 1024, 128 * 1024 * 1024)
  const timeout = bounded(options.requestTimeoutMs, 300_000, 600_000)
  const initialIdentity = identity(frozenScope(options.scope()))
  const active = new Set<Promise<void>>(), controllers = new Set<AbortController>(), sockets = new Set<Socket>()
  let accepting = true, closing: Promise<void> | undefined
  const check = async (scope: Scope, signal: AbortSignal) => {
    try {
      const current = frozenScope(options.scope())
      if (identity(current) !== initialIdentity || current.grantId !== scope.grantId) throw unavailable()
      signal.throwIfAborted()
      await abortable(options.authorize(scope, signal), signal)
      signal.throwIfAborted()
      if (options.scope().grantId !== scope.grantId) throw unavailable()
    } catch { throw unavailable() }
  }
  const reply = (response: ServerResponse, error: unknown) => {
    if (response.destroyed) return
    if (response.headersSent) { response.destroy(); return }
    const known = error instanceof GatewayError ? error : new GatewayError(502, 'SHARED_MODEL_UPSTREAM_FAILED', '共享模型通道未完成请求，请核对原任务')
    response.writeHead(known.status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' })
    response.end(JSON.stringify({ error: { code: known.code, message: known.message } }))
  }
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (!accepting) throw new GatewayError(503, 'SHARED_MODEL_STOPPING', '共享运行器正在停止接单')
    if (controllers.size) throw new GatewayError(429, 'SHARED_MODEL_BUSY', '本轮共享模型请求尚未结束')
    if (request.method !== 'POST' || !['/v1/responses', '/v1/responses/compact'].includes(request.url ?? '') ||
        request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json' || request.headers['content-encoding']) throw invalid()
    const scope = frozenScope(options.scope()), controller = new AbortController()
    controllers.add(controller)
    const terminate = () => { request.destroy(); response.destroy() }
    controller.signal.addEventListener('abort', terminate, { once: true })
    const timer = setTimeout(() => controller.abort(), timeout)
    const abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    try {
      await check(scope, controller.signal)
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        controller.signal.throwIfAborted()
        const value = Buffer.from(chunk)
        if (value.length > maxBody - bytes) throw invalid()
        chunks.push(value); bytes += value.length
      }
      let input: unknown
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) }
      catch { throw invalid() }
      const compact = request.url === '/v1/responses/compact'
      const payload = validateBody(input, scope, options.expectedReasoningEffort(scope), compact)
      await check(scope, controller.signal)
      controller.signal.throwIfAborted()
      const authorization = await abortable(options.upstream.authorization(controller.signal), controller.signal)
      if (!/^Bearer [\x21-\x7e]{8,4096}$/.test(authorization)) throw unavailable()
      await check(scope, controller.signal)
      const target = new URL(compact ? 'responses/compact' : 'responses', upstream)
      const forwarded = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: 'POST', signal: controller.signal,
        headers: { authorization, 'content-type': 'application/json', accept: 'text/event-stream, application/json', 'accept-encoding': 'identity', 'content-length': payload.length },
      })
      const result = await new Promise<IncomingMessage>((resolve, reject) => {
        forwarded.once('response', resolve); forwarded.once('error', reject); forwarded.end(payload)
      })
      await check(scope, controller.signal)
      const contentType = result.headers['content-type']?.split(';')[0]?.trim()
      const contentEncoding = result.headers['content-encoding']?.trim().toLowerCase()
      if (!result.statusCode || result.statusCode < 200 || result.statusCode >= 300 ||
          (contentEncoding !== undefined && contentEncoding !== 'identity') ||
          !['text/event-stream', 'application/json'].includes(contentType ?? '')) {
        result.destroy()
        throw new GatewayError(502, 'SHARED_MODEL_UPSTREAM_FAILED', '共享模型服务未返回有效结果，请核对原任务')
      }
      response.writeHead(result.statusCode, { 'content-type': contentType!, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      const clean = redactor(authorization)
      let received = 0
      for await (const value of result) {
        controller.signal.throwIfAborted()
        await check(scope, controller.signal)
        const chunk = Buffer.from(value)
        if (chunk.length > maxResponse - received) throw invalid()
        received += chunk.length
        const output = clean(chunk)
        if (output.length && !response.write(output)) await new Promise<void>((resolve, reject) => {
          const ready = () => { response.off('error', failed); response.off('close', failed); resolve() }
          const failed = () => { response.off('drain', ready); reject(new Error('共享模型连接已关闭')) }
          response.once('drain', ready); response.once('error', failed); response.once('close', failed)
        })
      }
      await check(scope, controller.signal)
      response.end(clean(Buffer.alloc(0), true))
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', terminate)
      controller.abort(); controllers.delete(controller)
      request.off('aborted', abort); response.off('close', abort)
    }
  }
  const server = createServer({ requestTimeout: Math.min(timeout, 30_000), headersTimeout: Math.min(timeout, 10_000), maxHeaderSize: 16 * 1024 }, (request, response) => {
    const work = handle(request, response).catch(error => reply(response, error))
    active.add(work); void work.finally(() => active.delete(work))
  })
  server.maxConnections = 8
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  // Node 关闭时会隐式删除 listen 路径。绑定名放在私有临时目录，公开名用不覆盖的硬链接发布。
  const bindingDirectory = await mkdtemp(join(parent, '.g-'))
  const boundPath = join(bindingDirectory, 's')
  const bindingOwner = await lstat(bindingDirectory)
  const removeBindingDirectory = async () => {
    const current = await lstat(bindingDirectory).catch(() => undefined)
    if (current?.isDirectory() && current.ino === bindingOwner.ino && current.dev === bindingOwner.dev)
      await rmdir(bindingDirectory).catch(error => {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error
      })
  }
  let owned: Awaited<ReturnType<typeof lstat>> | undefined
  const removePublishedSocket = async () => {
    const current = await lstat(socketPath).catch(() => undefined)
    if (owned && current?.isSocket() && current.ino === owned.ino && current.dev === owned.dev) await unlink(socketPath)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(boundPath, () => { server.off('error', reject); resolve() })
    })
    await chmod(boundPath, 0o600)
    owned = await lstat(boundPath)
    await link(boundPath, socketPath)
    await unlink(boundPath)
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await removePublishedSocket()
    await removeBindingDirectory()
    throw error
  }
  return {
    stopAccepting() { accepting = false },
    async drain() { await Promise.allSettled([...active]) },
    close() {
      closing ??= (async () => {
        accepting = false
        for (const controller of controllers) controller.abort()
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        for (const socket of sockets) socket.destroy()
        await Promise.allSettled([...active]); await stopped
        await removePublishedSocket()
        await removeBindingDirectory()
      })()
      return closing
    },
  }
}
