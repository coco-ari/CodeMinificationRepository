import path from 'node:path'
import { requireCondition } from './errors.ts'

export function readConfig(env: NodeJS.ProcessEnv) {
  const directory = path.resolve(env.AUTOOPS_DATA_DIR ?? 'data/autoops')
  const host = env.AUTOOPS_HOST ?? '127.0.0.1'
  const port = Number(env.AUTOOPS_PORT ?? 28900)
  requireCondition(
    Number.isInteger(port) && port >= 1 && port <= 65535,
    'INVALID_INPUT',
    'AUTOOPS_PORT 无效',
  )
  const publicOrigin = env.AUTOOPS_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`
  let url: URL
  try {
    url = new URL(publicOrigin)
  } catch {
    throw new Error('AUTOOPS_PUBLIC_ORIGIN 无效')
  }
  requireCondition(
    ['http:', 'https:'].includes(url.protocol) &&
      url.origin === publicOrigin &&
      !url.username &&
      !url.password,
    'INVALID_INPUT',
    '公共来源必须为不含路径的 HTTP/S 来源',
  )
  requireCondition(
    url.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'INVALID_INPUT',
    '非本机访问必须配置 HTTPS 来源',
  )
  return { directory, host, port, publicOrigin, secureCookie: url.protocol === 'https:' }
}
