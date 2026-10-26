// @effect-diagnostics globalTimers:off -- 外部只读驱动以原生取消信号监督SDK连接预算与排空。
import type { EnvironmentMcpDriverContext } from '../index.ts'
import { EnvironmentMcpError } from '../policy.ts'

export const driverFailure = (code: string, message: string, status = 502) =>
  new EnvironmentMcpError(status, code, message)

/** 每次读取独占连接；关闭只取消本驱动已取得的连接，不重连或换目标。 */
export function driverLifetime() {
  let closed = false
  const reads = new Map<AbortController, Promise<unknown>>()
  return {
    async run<T>(
      context: EnvironmentMcpDriverContext,
      operation: (signal: AbortSignal) => Promise<T>,
    ) {
      if (closed) throw driverFailure('ENVIRONMENT_MCP_DRIVER_CLOSED', '环境读取驱动已停止', 503)
      if (context.signal.aborted)
        throw driverFailure('ENVIRONMENT_MCP_READ_INTERRUPTED', '环境读取已中断', 499)
      const controller = new AbortController()
      const abort = () => controller.abort()
      context.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, context.limits.timeoutMs)
      const work = Promise.resolve()
        .then(() => {
          if (controller.signal.aborted)
            throw driverFailure('ENVIRONMENT_MCP_READ_INTERRUPTED', '环境读取已中断', 499)
          return operation(controller.signal)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted)
            throw driverFailure('ENVIRONMENT_MCP_READ_INTERRUPTED', '环境读取已中断或超时', 499)
          if (error instanceof EnvironmentMcpError) throw error
          throw driverFailure(
            'ENVIRONMENT_MCP_CONNECTION_FAILED',
            '环境连接失败，请核对目标、只读凭证与网络后重试',
          )
        })
        .finally(() => {
          clearTimeout(timer)
          context.signal.removeEventListener('abort', abort)
          reads.delete(controller)
        })
      reads.set(controller, work)
      return work
    },
    async close() {
      closed = true
      for (const controller of reads.keys()) controller.abort()
      await Promise.allSettled([...reads.values()])
    },
  }
}

export async function interrupted<T>(signal: AbortSignal, work: Promise<T>, release: () => void) {
  if (signal.aborted) {
    release()
    throw driverFailure('ENVIRONMENT_MCP_READ_INTERRUPTED', '环境读取已中断', 499)
  }
  let abort!: () => void
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => {
          release()
          reject(driverFailure('ENVIRONMENT_MCP_READ_INTERRUPTED', '环境读取已中断或超时', 499))
        }
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
