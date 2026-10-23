import * as C from '../../../contracts/index.ts'
import { decode, requireCondition as must } from '../../platform/errors.ts'
import type { AuditWriter, Authorization, Runtime, Transaction } from '../../platform/ports.ts'
import type { IdentityRepository, Secrets } from './domain.ts'

export function createIdentityService(
  repo: IdentityRepository,
  tx: Transaction,
  audit: AuditWriter,
  runtime: Runtime,
  secrets: Secrets,
  auth: Authorization,
) {
  const attempts = new Map<string, { count: number; until: number }>()
  const active = (userId: string) => {
    const account = repo.byId(userId)
    must(account?.user.enabled, 'UNAUTHENTICATED', '账号或会话已失效')
    return account.user
  }
  const admin = (userId: string) => auth.require(userId, 'account.manage')
  const validAccount = (input: unknown) => {
    const value = decode(C.CreateUser, input)
    must(
      value.kind === 'internal' || !value.platformAdmin,
      'INVALID_INPUT',
      '外部账号不能成为平台管理员',
    )
    return value
  }
  const insert = (value: typeof C.CreateUser.Type, passwordHash: string, actorId?: string) => {
    must(!repo.byUsername(value.username), 'CONFLICT', '用户名已存在')
    const user: C.User = {
      id: runtime.id(),
      username: value.username,
      name: value.name,
      kind: value.kind,
      platformAdmin: value.platformAdmin,
      enabled: true,
    }
    repo.insert({ user, passwordHash })
    audit.append(actorId ?? user.id, actorId ? 'account.create' : 'account.initialize', user.id)
    return user
  }
  return {
    active,
    list(userId: string, after = '') {
      admin(userId)
      const items = repo.list(after ? decode(C.Id, after) : '', 100)
      return { items, nextCursor: items.length === 100 ? items.at(-1)!.id : null }
    },
    async initialize(input: unknown) {
      const value = validAccount(input)
      must(
        value.kind === 'internal' && value.platformAdmin && repo.count() === 0,
        'CONFLICT',
        '初始化仅允许在空账号库创建内部管理员',
      )
      const hash = await secrets.password(value.password)
      return tx.run(() => {
        must(repo.count() === 0, 'CONFLICT', '平台已经初始化')
        return insert(value, hash)
      })
    },
    async create(userId: string, input: unknown) {
      admin(userId)
      const value = validAccount(input),
        hash = await secrets.password(value.password)
      return tx.run(() => {
        admin(userId)
        return insert(value, hash, userId)
      })
    },
    async login(input: unknown) {
      const value = decode(C.Login, input),
        now = runtime.now()
      for (const [key, limit] of attempts) if (limit.until <= now) attempts.delete(key)
      const key = secrets.digest(value.username),
        limit = attempts.get(key) ?? { count: 0, until: now + 60_000 }
      must(
        limit.count < 10 && (attempts.has(key) || attempts.size < 1000),
        'RATE_LIMITED',
        '登录尝试过多，请稍后重试',
      )
      limit.count++
      attempts.set(key, limit)
      const account = repo.byUsername(value.username)
      // 不存在的账号也计算相同成本的密码派生，错误不暴露账号存在性。
      const valid = await secrets.verify(
        value.password,
        account?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`,
      )
      must(valid && account?.user.enabled, 'UNAUTHENTICATED', '用户名或密码无效')
      return tx.run(() => {
        const latest = repo.byId(account.user.id)
        must(
          latest?.user.enabled && latest.passwordHash === account.passwordHash,
          'UNAUTHENTICATED',
          '用户名或密码无效',
        )
        const token = secrets.token(),
          csrfToken = secrets.digest('csrf:' + token),
          expiresAt = now + 12 * 60 * 60 * 1000
        repo.deleteExpiredSessions(now)
        repo.saveSession(secrets.digest(token), {
          userId: latest.user.id,
          csrfHash: secrets.digest(csrfToken),
          expiresAt,
        })
        audit.append(latest.user.id, 'session.login', latest.user.id)
        return { token, csrfToken, expiresAt, user: latest.user }
      })
    },
    authenticate(token: string | undefined, csrfToken?: string) {
      must(token && token.length <= 128, 'UNAUTHENTICATED', '请先登录')
      const session = repo.session(secrets.digest(token))
      must(session && session.expiresAt > runtime.now(), 'UNAUTHENTICATED', '账号或会话已失效')
      if (csrfToken !== undefined)
        must(
          secrets.equal(session.csrfHash, secrets.digest(csrfToken)),
          'FORBIDDEN',
          '请求校验失败',
        )
      return active(session.userId)
    },
    sessionInfo(token: string) {
      const user = this.authenticate(token)
      return {
        user,
        csrfToken: secrets.digest('csrf:' + token),
        expiresAt: repo.session(secrets.digest(token))!.expiresAt,
      }
    },
    logout(userId: string, token: string) {
      tx.run(() => {
        active(userId)
        repo.deleteSession(secrets.digest(token))
        audit.append(userId, 'session.logout', userId)
      })
    },
    setEnabled(actorId: string, targetId: string, input: unknown) {
      const { enabled } = decode(C.UpdateAccount, input)
      return tx.run(() => {
        admin(actorId)
        const target = repo.byId(targetId)
        must(target, 'NOT_FOUND', '账号不存在')
        if (target.user.enabled === enabled) return target.user
        must(
          enabled || !target.user.enabled || !target.user.platformAdmin || repo.enabledAdmins() > 1,
          'CONFLICT',
          '不能停用最后一个有效平台管理员',
        )
        repo.setEnabled(targetId, enabled)
        repo.revokeSessions(targetId)
        audit.append(actorId, enabled ? 'account.enable' : 'account.disable', targetId)
        return { ...target.user, enabled }
      })
    },
    async changePassword(actorId: string, input: unknown) {
      active(actorId)
      const value = decode(C.ChangePassword, input),
        account = repo.byId(actorId)
      must(
        account && (await secrets.verify(value.currentPassword, account.passwordHash)),
        'UNAUTHENTICATED',
        '当前密码无效',
      )
      const hash = await secrets.password(value.newPassword)
      tx.run(() => {
        active(actorId)
        must(
          repo.byId(actorId)?.passwordHash === account.passwordHash,
          'CONFLICT',
          '密码已变更，请重新验证',
        )
        repo.setPassword(actorId, hash)
        repo.revokeSessions(actorId)
        audit.append(actorId, 'account.password.change', actorId)
      })
    },
    async resetPassword(actorId: string, targetId: string, input: unknown) {
      admin(actorId)
      const value = decode(C.ResetPassword, input),
        hash = await secrets.password(value.newPassword)
      tx.run(() => {
        admin(actorId)
        must(repo.byId(targetId), 'NOT_FOUND', '账号不存在')
        repo.setPassword(targetId, hash)
        repo.revokeSessions(targetId)
        audit.append(actorId, 'account.password.reset', targetId)
      })
    },
  }
}
export type IdentityService = ReturnType<typeof createIdentityService>
