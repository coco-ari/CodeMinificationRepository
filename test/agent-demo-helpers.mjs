import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const baseUrl = (process.env.AGENT_DEMO_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
export const evidenceDir = path.resolve(
  process.env.AGENT_DEMO_EVIDENCE_DIR || '.test-artifacts/agent-demo-api',
)
export const requestId = () => randomUUID()
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const samples = []

export function errorDetails(error) {
  return {
    name: error?.name,
    message: error?.message || String(error),
    stack: error?.stack,
    code: error?.code,
    ...(error?.cause ? { cause: errorDetails(error.cause) } : {}),
    ...(error?.request ? { request: error.request } : {}),
  }
}

export async function until(fn, label, timeout = 8000, interval = 25) {
  const start = performance.now()
  let last
  while (performance.now() - start < timeout) {
    last = await fn()
    if (last) return last
    await sleep(interval)
  }
  throw new Error(`等待超时：${label}；最后结果 ${JSON.stringify(last)}`)
}

export function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1) ?? null,
  }
}

export class Client {
  constructor(username, origin = baseUrl) {
    this.username = username
    this.origin = origin
    this.cookie = ''
    this.csrf = ''
  }

  async raw(method, endpoint, data, options = {}) {
    const started = performance.now()
    const headers = {
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(this.csrf && !options.noCsrf ? { 'X-Demo-CSRF': this.csrf } : {}),
      ...options.headers,
    }
    let response
    try {
      response = await fetch(`${this.origin}/api/agent-demo${endpoint}`, {
        method,
        headers,
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(options.timeout ?? 15000),
        redirect: 'manual',
      })
    } catch (error) {
      error.request = { method, endpoint, origin: this.origin }
      samples.push({
        method,
        endpoint,
        status: 0,
        elapsedMs: Number((performance.now() - started).toFixed(2)),
        error: errorDetails(error),
      })
      throw error
    }
    const body = await response.text()
    const elapsedMs = Number((performance.now() - started).toFixed(2))
    let json
    try {
      json = JSON.parse(body)
    } catch {
      json = null
    }
    samples.push({
      method,
      endpoint: endpoint.replace(/[a-f0-9-]{25,}/g, ':id'),
      status: response.status,
      elapsedMs,
    })
    return { response, status: response.status, body, json, elapsedMs }
  }

  async api(method, endpoint, data, options = {}) {
    const result = await this.raw(method, endpoint, data, options)
    assert.ok(
      result.status >= 200 && result.status < 300,
      `${this.username} ${method} ${endpoint}: ${result.status} ${result.body.slice(0, 300)}`,
    )
    return result.json
  }

  async login() {
    const result = await this.raw('POST', '/login', {
      username: this.username,
      password: process.env.AGENT_DEMO_PASSWORD || 'Demo123!',
    })
    assert.equal(result.status, 200, `${this.username} 登录失败`)
    const setCookie = result.response.headers.get('set-cookie')
    assert.ok(setCookie?.includes('HttpOnly'), '会话 Cookie 必须 HttpOnly')
    assert.match(setCookie, /SameSite=(Lax|Strict)/i, '会话 Cookie 必须限制跨站携带')
    this.cookie = setCookie.split(';')[0]
    this.csrf = result.json.csrf
    this.user = result.json.user
    assert.ok(this.csrf, '登录返回 CSRF')
    this.bootstrap = await this.api('GET', '/bootstrap')
    return this
  }

  async create(overrides = {}) {
    const projectId = overrides.projectId || 'p-autoops'
    const result = await this.api('POST', '/conversations', {
      projectId,
      agentId: 'a-project',
      environmentId: 'env-test',
      visibility: 'private',
      mode: 'scenario',
      title: `验收 ${requestId().slice(0, 8)}`,
      ...overrides,
    })
    assert.ok(result.conversation.id)
    assert.equal(result.conversation.mode, overrides.mode || 'scenario')
    return result.conversation
  }

  async conversation(id) {
    return (await this.api('GET', `/conversations/${id}`)).conversation
  }

  async send(id, text, extra = {}) {
    return this.api('POST', `/conversations/${id}/messages`, {
      requestId: requestId(),
      text,
      attachmentIds: [],
      delivery: 'send',
      scenario: { kind: 'normal', stepDelayMs: 20 },
      ...extra,
    })
  }

  async stop(id, turnId, idempotencyKey = requestId()) {
    return this.api('POST', `/conversations/${id}/stop`, {
      requestId: idempotencyKey,
      expectedTurnId: turnId,
    })
  }

  async finish(id, timeout = 10000) {
    return until(
      async () => {
        const conversation = await this.conversation(id)
        return !conversation.activeTurnId && conversation
      },
      `会话 ${id} 结束`,
      timeout,
    )
  }

  async upload(id, name = '资料.txt', content = '测试项目的只读资料。') {
    return (
      await this.api('POST', `/conversations/${id}/attachments`, {
        name,
        mime: 'text/plain',
        data: Buffer.from(content).toString('base64'),
      })
    ).attachment
  }

  async stream(after = 0, extraHeaders = {}, options = {}) {
    const abort = new AbortController()
    const response = await fetch(
      `${this.origin}/api/agent-demo/events?after=${encodeURIComponent(after)}`,
      { headers: { Cookie: this.cookie, ...extraHeaders }, signal: abort.signal },
    )
    assert.equal(response.status, 200, 'SSE 请求成功')
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/)
    const events = []
    const errors = []
    const transport = { bytes: 0, chunks: 0, openedAt: new Date().toISOString() }
    let closed = false
    let buffer = ''
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    const loop = (async () => {
      try {
        for (;;) {
          if (options.readDelayMs) await sleep(options.readDelayMs)
          const { value, done } = await reader.read()
          if (done) break
          transport.bytes += value.byteLength
          transport.chunks++
          transport.lastChunkAt = new Date().toISOString()
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const lines = block.split('\n')
            const data = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n')
            if (!data) continue
            const payload = JSON.parse(data)
            const id = lines
              .find((line) => line.startsWith('id:'))
              ?.slice(3)
              .trim()
            const event = lines
              .find((line) => line.startsWith('event:'))
              ?.slice(6)
              .trim()
            events.push({ ...payload, sseId: id ? Number(id) : null, sseEvent: event })
            transport.lastEventAt = new Date().toISOString()
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          errors.push(String(error))
          transport.error = errorDetails(error)
        }
      } finally {
        closed = true
        transport.closedAt = new Date().toISOString()
      }
    })()
    return {
      events,
      errors,
      transport,
      get closed() {
        return closed
      },
      async close() {
        abort.abort()
        await loop
        assert.deepEqual(errors, [], 'SSE 无解析或传输异常')
      },
    }
  }
}

export function eventSeq(event) {
  return Number(event.seq ?? event.sseId)
}

export function persistentEvents(events) {
  return events.filter(
    (event) =>
      event.type !== 'ready' &&
      event.sseEvent !== 'ready' &&
      Number.isFinite(eventSeq(event)) &&
      eventSeq(event) > 0,
  )
}

export async function deny(client, method, endpoint, data, allowed = [403, 404]) {
  const result = await client.raw(method, endpoint, data)
  assert.ok(
    allowed.includes(result.status),
    `必须拒绝 ${method} ${endpoint}，实际 ${result.status}`,
  )
  assert.ok(result.json?.error, '拒绝响应应提供明确错误')
  assert.ok(result.json?.code, '拒绝响应应提供错误代码')
  return result
}

export async function writeEvidence(name, report) {
  await mkdir(evidenceDir, { recursive: true })
  const file = path.join(evidenceDir, name)
  await writeFile(file, JSON.stringify(report, null, 2))
  return file
}

export async function isolatedServer() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'autoops-agent-isolated-'))
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [path.join(root, 'agent-demo/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: directory,
      AGENT_BRIDGE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-3000)
  })
  child.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-3000)
  })
  const stop = async () => {
    if (child.exitCode === null) {
      const exit = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      await exit
    }
    await rm(directory, { recursive: true, force: true })
  }
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`临时服务退出：${output}`)
      try {
        return (await fetch(`${origin}/api/agent-demo/health`)).ok
      } catch {
        return false
      }
    }, '临时隔离服务启动')
    return {
      origin,
      stop,
      state: () => ({ exitCode: child.exitCode, signalCode: child.signalCode, output }),
    }
  } catch (error) {
    await stop()
    throw error
  }
}
