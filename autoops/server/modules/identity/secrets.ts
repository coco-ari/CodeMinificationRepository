// @effect-diagnostics nodeBuiltinImport:off -- 统一身份密码边界使用既有 Node scrypt，不能由 Effect 宿主替换派生参数。
import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import type { Secrets } from './domain.ts'
import { requireCondition } from '../../platform/errors.ts'

let deriving = 0
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
// 仅供已有身份的一次性启动导入；正常登录与账号写入仍使用有界异步派生。
export function hashImportedPassword(value: string) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(value, salt, 64, scryptOptions).toString('hex')}`
}
const derive = async (password: string, salt: string) => {
  requireCondition(deriving < 8, 'RATE_LIMITED', '身份验证繁忙，请稍后重试')
  deriving++
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, scryptOptions, (error, key) =>
        error ? reject(error) : resolve(key),
      )
    })
  } finally {
    deriving--
  }
}
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export const secrets: Secrets = {
  async password(value) {
    const salt = randomBytes(16).toString('hex')
    return `${salt}:${(await derive(value, salt)).toString('hex')}`
  },
  async verify(value, encoded) {
    const [salt, key] = encoded.split(':')
    if (!salt || !key || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(key)) return false
    return equal((await derive(value, salt)).toString('hex'), key)
  },
  token: () => randomBytes(32).toString('base64url'),
  digest: (value) => createHash('sha256').update(value).digest('hex'),
  equal,
}
