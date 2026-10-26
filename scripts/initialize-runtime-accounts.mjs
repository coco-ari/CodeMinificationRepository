import { resolve, join } from 'node:path'
import { createRuntimeAccounts } from '../agent-demo/t3-adapters/accounts/index.ts'
import { users } from '../agent-demo/fixtures.mjs'

// 一次性初始化只读标准输入，不从 argv、固定密码或日志取得秘密。
let accounts
try {
  const directory = process.env.DATA_DIR
  if (!directory?.trim()) throw new Error('请显式指定 DATA_DIR')
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--adopt-existing')) throw new Error('初始化参数无效')
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.byteLength
    if (size > 16384) throw new Error('初始化正文超过限制')
    chunks.push(chunk)
  }
  let input
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new Error('初始化正文必须是有效JSON') }
  if (args[0] === '--adopt-existing') {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.password !== 'string' || !input.password || input.password.length > 128)
      throw new Error('接管仅接受原登录密码配置')
    accounts = createRuntimeAccounts({ databasePath: join(resolve(directory), 'demo.sqlite'), legacyUsers: users, legacyPassword: input.password, requireExistingInstallation: true })
    accounts.assertInitialized()
    const current = accounts.users()
    console.log(JSON.stringify({ initialized: true, adoptedExisting: true, count: current.length, userIds: current.map(user => user.id) }))
  } else {
    accounts = createRuntimeAccounts({ databasePath: join(resolve(directory), 'demo.sqlite') })
    const created = await accounts.initialize(input)
    console.log(JSON.stringify({ initialized: true, count: 1, userIds: [created.id] }))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '账号初始化未完成')
  process.exitCode = 1
} finally { await accounts?.close() }
