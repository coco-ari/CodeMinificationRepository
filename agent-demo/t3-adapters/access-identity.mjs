import { createHash, timingSafeEqual } from 'node:crypto'

const hash = (value) => createHash('sha256').update(value).digest('hex')

// 身份只校验账号与会话，项目及资源权限由业务授权门面裁决。
export function createAccessIdentity({ sessionDb, bindingDb, findUser, now, fail, identifier, assertAccepting }) {
  const lookupSession = (sessionHash) => {
    assertAccepting()
    const row = sessionDb.prepare('SELECT token,uid,csrf,expires FROM sessions WHERE token=? AND expires>?').get(sessionHash, now())
    const user = row && findUser(row.uid)
    if (!row || !user || (user.status !== undefined && user.status !== 'active')) fail(401, 'UNAUTHENTICATED', '登录已失效，请重新登录')
    return Object.freeze({ id: user.id, displayName: user.name, role: user.role, sessionHash: row.token, csrf: row.csrf, expiresAt: row.expires })
  }
  const refresh = (principal) => {
    if (!principal || typeof principal.sessionHash !== 'string') fail(401, 'UNAUTHENTICATED', '请先登录')
    const current = lookupSession(principal.sessionHash)
    if (current.id !== principal.id) fail(401, 'UNAUTHENTICATED', '登录身份已改变')
    return current
  }
  return {
    authenticateCookie(cookie = '') {
      const values = String(cookie).split(';').map((item) => item.trim()).filter((item) => item.startsWith('demo_session='))
      if (values.length !== 1 || !values[0].slice(13)) fail(401, 'UNAUTHENTICATED', '请先登录')
      return lookupSession(hash(values[0].slice(13)))
    },
    refresh,
    requireCsrf(principal, presented) {
      const current = refresh(principal)
      if (typeof presented !== 'string' || !timingSafeEqual(Buffer.from(hash(presented)), Buffer.from(hash(current.csrf))))
        fail(403, 'CSRF', '会话校验失败，请刷新后重试')
    },
    recordNativeSession(principal, nativeSessionId) {
      const current = refresh(principal)
      bindingDb.prepare('DELETE FROM t3_native_auth_sessions WHERE expires_at<=?').run(now())
      bindingDb.prepare('INSERT OR REPLACE INTO t3_native_auth_sessions VALUES(?,?,?)').run(
        identifier(nativeSessionId, '原生登录ID'), current.sessionHash, current.expiresAt,
      )
    },
    principalForNativeSession(nativeSessionId) {
      assertAccepting()
      const row = bindingDb.prepare('SELECT * FROM t3_native_auth_sessions WHERE native_session_id=? AND expires_at>?').get(nativeSessionId, now())
      if (!row) fail(401, 'UNAUTHENTICATED', '登录已失效，请重新登录')
      return lookupSession(row.autoops_session_hash)
    },
  }
}

export function initializeAccessIdentitySchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS t3_native_auth_sessions (native_session_id TEXT PRIMARY KEY, autoops_session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)')
}
