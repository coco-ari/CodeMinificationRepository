import { readAutoOpsHost } from './hostSnapshot'

export class AutoOpsRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | undefined,
    readonly uncertain = false,
  ) {
    super(message)
    this.name = 'AutoOpsRequestError'
  }
}

export function autoOpsApiUrl(path: string): string {
  const host = readAutoOpsHost()
  if (!host) throw new AutoOpsRequestError('项目工作台未连接。', 'HOST_UNAVAILABLE', undefined)
  const url = new URL(`${host.gatewayBasePath}${path}`, host.httpBaseUrl)
  if (!path.startsWith('/autoops/') ||
      !url.pathname.startsWith(`${host.gatewayBasePath}/autoops/`) ||
      url.origin !== new URL(host.httpBaseUrl).origin) {
    throw new AutoOpsRequestError('业务请求地址无效。', 'INVALID_REQUEST_PATH', undefined)
  }
  return `${url.pathname}${url.search}`
}

function errorDetails(value: unknown): { message?: string; code?: string } {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const nested = record.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown> : record
  const message = typeof nested.message === 'string' ? nested.message
    : typeof record.error === 'string' ? record.error : undefined
  return { ...(message ? { message } : {}),
    ...(typeof nested.code === 'string' ? { code: nested.code } : {}) }
}

/** 仅适配现有业务 JSON 协议，复用原生 fetch；重试与任务状态由所属模块决定。 */
export async function autoOpsRequest<T>(path: string, options: {
  label: string
  body?: object
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<T> {
  const url = autoOpsApiUrl(path)
  const host = readAutoOpsHost()!
  const mutation = options.body !== undefined
  const timeoutMs = options.timeoutMs ?? (mutation ? 120_000 : 30_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new AutoOpsRequestError('业务请求时限无效。', 'INVALID_REQUEST_TIMEOUT', undefined)
  }
  options.signal?.throwIfAborted()
  const body = mutation ? JSON.stringify(options.body) : undefined
  const deadline = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  const timer = setTimeout(() => deadline.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: mutation ? 'POST' : 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/json',
          ...(mutation ? { 'Content-Type': 'application/json', 'X-Demo-CSRF': host.csrfToken } : {}),
        },
        ...(body === undefined ? {} : { body }),
      })
    } catch (cause) {
      if (options.signal?.aborted) throw cause
      throw new AutoOpsRequestError(
        mutation ? `${options.label}提交结果尚未确认，请刷新核对后再操作。`
          : `${options.label}${deadline.signal.aborted ? '读取超时' : '暂时无法连接'}，请重试。`,
        deadline.signal.aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED', undefined, mutation,
      )
    }
    const result: unknown = await response.json().catch(() => null)
    // 网络或解析实现可能忽略取消，仍需在返回业务数据前拒绝迟到结果。
    options.signal?.throwIfAborted()
    if (deadline.signal.aborted) {
      throw new AutoOpsRequestError(
        mutation ? `${options.label}提交结果尚未确认，请刷新核对后再操作。` : `${options.label}读取超时，请重试。`,
        'REQUEST_TIMEOUT', response.status, mutation,
      )
    }
    const current = readAutoOpsHost()
    if (current?.principal.id !== host.principal.id || current.csrfToken !== host.csrfToken) {
      throw new DOMException('登录上下文已经改变', 'AbortError')
    }
    if (!response.ok || result === null || typeof result !== 'object') {
      const details = errorDetails(result)
      const uncertain = mutation && (response.status >= 500 || response.status === 408 || response.ok)
      throw new AutoOpsRequestError(
        details.message ?? (uncertain ? `${options.label}提交结果尚未确认，请刷新核对后再操作。`
          : `${options.label}请求未完成（${response.status}），请重试。`),
        details.code ?? (response.ok ? 'INVALID_RESPONSE' : 'REQUEST_FAILED'), response.status, uncertain,
      )
    }
    return result as T
  } finally {
    clearTimeout(timer)
  }
}

export const isAutoOpsAccessError = (error: unknown) => error instanceof AutoOpsRequestError &&
  (error.status === 401 || error.status === 403 || error.status === 404)
