import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { CustomerAgentStore } from './store.ts'
import type { RunnerFactory } from './executor.ts'

async function declaredGatewayKey(path: string): Promise<string | undefined> {
  // 此处只读取过滤提示；共享准入继续由原 profile、运行时和授权校验拥有。
  try {
    if (!isAbsolute(path) || /[\x00-\x1f]/.test(path) || await realpath(path) !== path) return
    const maximum = 64 * 1024
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let bytes: Buffer
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > maximum || (stat.mode & 0o022) !== 0) return
      const buffer = Buffer.allocUnsafe(maximum + 1)
      let length = 0
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > maximum) return
      bytes = buffer.subarray(0, length)
    } finally { await handle.close() }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || !('gateway' in value)) return
    const gateway = value.gateway
    if (!gateway || typeof gateway !== 'object' || !('authorizationEnv' in gateway)) return
    const name = gateway.authorizationEnv
    if (typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(name)) return name
  } catch { /* 缺失或损坏的共享配置不能阻断既有自用能力。 */ }
}

export function createCustomerRunnerFactory(store: CustomerAgentStore, runner: RunnerFactory): RunnerFactory {
  const sharedGatewayKeys = new Set<string>()
  return async options => {
    for (const workspace of store.workspaces()) {
      if (!workspace.sharedProfilePath) continue
      const name = await declaredGatewayKey(workspace.sharedProfilePath)
      if (name) sharedGatewayKeys.add(name)
    }
    const environment = { ...(options.environment ?? process.env) }
    // Effect 的 extendEnv 会再次合并宿主环境；显式 undefined 才能在最终进程处移除该键。
    for (const name of sharedGatewayKeys) environment[name] = undefined
    return runner({ ...options, environment })
  }
}
