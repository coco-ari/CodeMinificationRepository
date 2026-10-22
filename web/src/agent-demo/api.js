export const API = '/api/agent-demo'

const samples = { requests: [], renders: [] }
if (typeof window !== 'undefined') window.__agentDemoMetrics = samples

export function recordRender(receivedAt, count) {
  samples.renders.push({ duration: performance.now() - receivedAt, count, at: Date.now() })
  if (samples.renders.length > 2000) samples.renders.shift()
}

export async function request(
  path,
  { method = 'GET', body, csrf, signal, timeoutMs = 30000 } = {},
) {
  const startedAt = performance.now()
  let status = 0
  let timedOut = false
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && csrf ? { 'X-Demo-CSRF': csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    status = response.status
    const value = await response.json().catch((error) => {
      if (controller.signal.aborted) throw error
      return {}
    })
    if (!response.ok) {
      const error = new Error(value.error || `请求未完成（${response.status}）`)
      error.status = response.status
      error.code = value.code
      throw error
    }
    return value
  } catch (error) {
    if (timedOut) {
      const failure = new Error('请求等待超时，结果尚未确认，请稍后重试。')
      failure.name = 'TimeoutError'
      failure.code = 'REQUEST_TIMEOUT'
      throw failure
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    samples.requests.push({
      method,
      path: path.split('?')[0],
      status,
      duration: performance.now() - startedAt,
      at: Date.now(),
    })
    if (samples.requests.length > 2000) samples.requests.shift()
  }
}

export function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {}
  }
  const previous = document.activeElement
  const input = document.createElement('textarea')
  input.value = value
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    input.remove()
    previous?.focus?.({ preventScroll: true })
  }
  if (!copied) throw new Error('当前浏览器不允许自动复制，请选择内容后复制。')
}

export function fileUrl(file, inline = false) {
  const value = file?.url || (file?.id ? `${API}/files/${encodeURIComponent(file.id)}` : '')
  if (!value) return ''
  try {
    const url = new URL(value, location.origin)
    if (url.origin !== location.origin || !url.pathname.startsWith(`${API}/files/`)) return ''
    if (inline) url.searchParams.set('inline', '1')
    return url.pathname + url.search
  } catch {
    return ''
  }
}
