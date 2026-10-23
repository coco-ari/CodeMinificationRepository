import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { createAutoOps } from './app.ts'
import { readConfig } from './platform/config.ts'

const config = readConfig(process.env)
await mkdir(config.directory, { recursive: true, mode: 0o700 })
const runtime = createAutoOps({
  databaseFile: path.join(config.directory, 'autoops.sqlite'),
  publicOrigin: config.publicOrigin,
  secureCookie: config.secureCookie,
  log: (event) => console.error(JSON.stringify(event)),
})
const server = serve({ fetch: runtime.app.fetch, hostname: config.host, port: config.port }, () =>
  console.log(JSON.stringify({ event: 'autoops.ready', origin: config.publicOrigin })),
)
let closing = false
const close = () => {
  if (closing) return
  closing = true
  server.close(() => {
    runtime.close()
  })
  if ('closeIdleConnections' in server) server.closeIdleConnections()
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
server.on('error', () => {
  console.error(JSON.stringify({ event: 'autoops.listen.failed' }))
  runtime.close()
  process.exitCode = 1
})
