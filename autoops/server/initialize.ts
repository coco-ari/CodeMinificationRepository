import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createAutoOps } from './app.ts'
import { readConfig } from './platform/config.ts'

const config = readConfig(process.env)
const input = {
  username: process.env.AUTOOPS_ADMIN_USERNAME,
  name: process.env.AUTOOPS_ADMIN_NAME,
  password: process.env.AUTOOPS_ADMIN_PASSWORD,
  kind: 'internal',
  platformAdmin: true,
}
delete process.env.AUTOOPS_ADMIN_PASSWORD
await mkdir(config.directory, { recursive: true, mode: 0o700 })
const runtime = createAutoOps({
  databaseFile: path.join(config.directory, 'autoops.sqlite'),
  publicOrigin: config.publicOrigin,
  secureCookie: config.secureCookie,
})
try {
  await runtime.identity.initialize(input)
  console.log('平台管理员初始化完成；请清除调用端的初始化密码环境变量。')
} finally {
  runtime.close()
}
