// @effect-diagnostics nodeBuiltinImport:off -- 网关与 Worker 装配相同持久账号所有者，不导入业务授权。
import { join, resolve } from 'node:path'
import { users } from '../fixtures.mjs'
import { createRuntimeAccounts, type RuntimeAccounts } from './accounts/index.ts'

let configured: RuntimeAccounts | undefined
let directory: string | undefined
let closed = false
export function configuredRuntimeAccounts(dataDir?: string) {
  if (closed)
    throw Object.assign(new Error('账号服务已关闭'), { status: 503, code: 'ACCOUNT_STOPPING' })
  const selected = dataDir ?? process.env.AUTOOPS_T3_DATA_DIR ?? process.env.DATA_DIR
  if (!selected?.trim())
    throw Object.assign(new Error('账号数据目录不能为空'), {
      status: 500,
      code: 'ACCOUNT_DATA_DIR_INVALID',
    })
  const next = resolve(selected)
  if (directory && directory !== next)
    throw Object.assign(new Error('不能切换正在使用的账号目录'), {
      status: 503,
      code: 'ACCOUNT_DATA_DIR_CHANGED',
    })
  directory = next
  return (configured ||= createRuntimeAccounts({
    databasePath: join(next, 'demo.sqlite'),
    legacyUsers: users,
    ...(process.env.DEMO_PASSWORD === undefined
      ? {}
      : { legacyPassword: process.env.DEMO_PASSWORD }),
  }))
}
export function stopConfiguredRuntimeAccounts() {
  configured?.stopAccepting()
}
export function closeConfiguredRuntimeAccounts() {
  closed = true
  return configured?.close() ?? Promise.resolve()
}
