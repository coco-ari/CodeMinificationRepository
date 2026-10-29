// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- 账号所有者保留原会话标识，密码计算在事务外完成。
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as S from 'effect/Schema'
import * as C from '../../../autoops/contracts/accounts.ts'
import { CreateUser, Login } from '../../../autoops/contracts/index.ts'
import { DirectoryId } from '../../../autoops/contracts/project-directory.ts'
import {
  identitySecrets,
  hashImportedPassword,
} from '../../../autoops/server/modules/identity/index.ts'
import { migration, deletionMigration } from './schema.ts'

type LegacyUser = {
  id: string
  username: string
  name: string
  role: string
  kind?: string
  status?: string
}
type Row = Record<string, string | number | bigint | null | Uint8Array>
export class AccountError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AccountError'
    this.status = status
    this.code = code
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new AccountError(status, code, message)
}
const decode = <T extends S.ConstraintDecoder<unknown>>(schema: T, input: unknown): T['Type'] => {
  try {
    return S.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
  } catch {
    return fail(400, 'ACCOUNT_INPUT_INVALID', '账号字段、格式或长度无效')
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const account = (row: Row): C.RuntimeAccount =>
  decode(C.RuntimeAccount, {
    id: row.id,
    username: row.username,
    name: row.name,
    kind: row.kind,
    platformAdmin: row.platform_admin === 1,
    enabled: row.enabled === 1,
    revision: row.revision,
  })

export function createRuntimeAccounts({
  databasePath,
  legacyUsers = [],
  legacyPassword,
  requireExistingInstallation = false,
  now = Date.now,
}: {
  databasePath: string
  legacyUsers?: readonly LegacyUser[]
  legacyPassword?: string
  requireExistingInstallation?: boolean
  now?: () => number
}) {
  if (requireExistingInstallation) {
    if (!existsSync(databasePath))
      fail(409, 'ACCOUNT_ADOPTION_REQUIRES_EXISTING', '接管仅允许使用已有安装，不能导入到新安装')
    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    try {
      inspection.exec('PRAGMA busy_timeout=5000;')
      const tables = inspection
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name)
      const metadata = tables.includes('runtime_account_metadata')
        ? inspection
            .prepare('SELECT legacy_installation FROM runtime_account_metadata WHERE id=1')
            .get()
        : undefined
      if (
        (metadata && metadata.legacy_installation !== 1) ||
        (!metadata && !tables.includes('sessions') && !tables.includes('conversations'))
      )
        fail(409, 'ACCOUNT_ADOPTION_REQUIRES_EXISTING', '当前目录不是可接管的已有安装')
    } finally {
      inspection.close()
    }
  }
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(databasePath)
  let closed = false,
    stopping = false,
    closing: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const assertOpen = () => {
    if (closed) fail(503, 'ACCOUNT_STOPPING', '账号服务已关闭')
  }
  const assertAccepting = () => {
    assertOpen()
    if (stopping) fail(503, 'ACCOUNT_STOPPING', '账号服务正在停止')
  }
  const rowFor = (id: string) => db.prepare('SELECT * FROM runtime_accounts WHERE id=?').get(id)
  const active = (id: string) => {
    assertOpen()
    const row = rowFor(id)
    if (!row || row.enabled !== 1) fail(401, 'UNAUTHENTICATED', '账号或会话已失效')
    return account(row!)
  }
  const admin = (id: string) => {
    const current = active(id)
    if (!current.platformAdmin || current.kind !== 'internal')
      fail(403, 'ACCOUNT_FORBIDDEN', '账号管理仅限平台管理员')
    return current
  }
  const revision = (id: string, expected: number) => {
    const row = rowFor(id)
    if (!row) return fail(404, 'ACCOUNT_NOT_FOUND', '账号不存在')
    if (db.prepare('SELECT 1 FROM runtime_account_deletions WHERE target_id=?').get(id))
      fail(409, 'ACCOUNT_DELETING', '账号正在删除，请继续原删除')
    if (row.revision !== expected)
      fail(409, 'ACCOUNT_REVISION_CONFLICT', '账号已变化，请刷新后重新确认')
    return row
  }
  const initialized = () => db.prepare('SELECT * FROM runtime_account_metadata WHERE id=1').get()!
  const assertInitialized = () => {
    assertOpen()
    if (initialized().initialized !== 1)
      fail(503, 'ACCOUNT_INITIALIZATION_REQUIRED', '请先通过一次性初始化命令创建平台管理员')
  }
  try {
    db.exec('PRAGMA busy_timeout=5000;')
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    transaction(() => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name)
      const existing = tables.includes('sessions') || tables.includes('conversations')
      if (
        !tables.includes('runtime_account_schema_migrations') &&
        tables.some((name) => String(name).startsWith('runtime_account'))
      )
        fail(503, 'ACCOUNT_SCHEMA_INVALID', '账号升级记录缺失，拒绝覆盖已有账号')
      db.exec(
        'CREATE TABLE IF NOT EXISTS runtime_account_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;',
      )
      const applied = db
        .prepare('SELECT * FROM runtime_account_schema_migrations ORDER BY version')
        .all()
      const migrations = [migration, deletionMigration]
      if (
        applied.some(
          (row) =>
            !migrations.some(
              (value) =>
                value.version === row.version &&
                value.name === row.name &&
                digest(value.sql) === row.checksum,
            ),
        )
      )
        fail(503, 'ACCOUNT_SCHEMA_INVALID', '账号升级版本未知或校验失败')
      for (const change of migrations)
        if (!applied.some((row) => row.version === change.version)) {
          db.exec(change.sql)
          db.prepare('INSERT INTO runtime_account_schema_migrations VALUES(?,?,?)').run(
            change.version,
            change.name,
            digest(change.sql),
          )
          if (change.version === 1)
            db.prepare('INSERT INTO runtime_account_metadata VALUES(1,0,?)').run(Number(existing))
        }
      db.exec(
        'CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL)',
      )
    })
    if (initialized().initialized !== 1 && initialized().legacy_installation === 1) {
      if (
        !legacyUsers.length ||
        typeof legacyPassword !== 'string' ||
        !legacyPassword ||
        legacyPassword.length > 128
      )
        fail(503, 'ACCOUNT_IMPORT_CONFIG_REQUIRED', '已有安装升级需要原账号目录及原登录密码配置')
      const imported = legacyUsers.map((user) => ({
        value: decode(C.RuntimeAccount, {
          id: user.id,
          username: user.username,
          name: user.name,
          kind: user.kind ?? 'internal',
          platformAdmin: user.role === 'admin',
          enabled: user.status === undefined || user.status === 'active',
          revision: 1,
        }),
        passwordHash: hashImportedPassword(legacyPassword!),
      }))
      transaction(() => {
        if (initialized().initialized === 1) return
        if (!imported.some((item) => item.value.enabled && item.value.platformAdmin))
          fail(503, 'ACCOUNT_IMPORT_INVALID', '已有账号目录缺少有效内部平台管理员')
        for (const item of imported) insert(item.value, item.passwordHash)
        db.prepare('UPDATE runtime_account_metadata SET initialized=1 WHERE id=1').run()
      })
    }
  } catch (error) {
    db.close()
    throw error
  }

  function insert(value: C.RuntimeAccount, passwordHash: string) {
    db.prepare('INSERT INTO runtime_accounts VALUES(?,?,?,?,?,?,?,?)').run(
      value.id,
      value.username,
      value.name,
      value.kind,
      Number(value.platformAdmin),
      Number(value.enabled),
      value.revision,
      passwordHash,
    )
  }
  function audit(actor: string, operation: string, target: string, requestId?: string) {
    db.prepare('INSERT INTO runtime_account_audit VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      actor,
      operation,
      target,
      requestId ?? null,
      new Date(now()).toISOString(),
    )
  }
  function fingerprint(operation: C.AccountOperation, target: string, input: unknown) {
    const command = input as { value: Record<string, unknown> }
    const value = Object.fromEntries(
      Object.entries(command.value).filter(
        ([key]) => !['password', 'newPassword', 'currentPassword'].includes(key),
      ),
    )
    return digest(JSON.stringify([operation, target, { ...command, value }]))
  }
  function prior(
    actor: string,
    requestId: string,
    operation: C.AccountOperation,
    target: string,
    input: unknown,
  ): Row | undefined {
    const row = db
      .prepare('SELECT * FROM runtime_account_requests WHERE actor_id=? AND request_id=?')
      .get(actor, requestId)
    if (!row) return undefined
    if (row.fingerprint !== fingerprint(operation, target, input))
      fail(409, 'ACCOUNT_REQUEST_CONFLICT', '原请求已用于其他账号操作或参数')
    return row
  }
  async function priorResult(
    row: Row | undefined,
    input: unknown,
    actor: string,
    operation: C.AccountOperation,
    assertCurrent?: () => void,
  ): Promise<C.RuntimeAccount | C.AccountPasswordResult | undefined> {
    if (!row) return undefined
    const value = (
      input as { value: { password?: string; newPassword?: string; currentPassword?: string } }
    ).value
    const password = operation === 'create' ? value.password : value.newPassword
    // 原请求复用本次已有的 scrypt 证明，不能留下同库密钥即可快速猜测的密码指纹。
    if (
      typeof password !== 'string' ||
      !(await identitySecrets.verify(password, String(row.password_proof)))
    )
      fail(409, 'ACCOUNT_REQUEST_CONFLICT', '原请求已用于其他账号操作或参数')
    if (
      operation === 'changePassword' &&
      (typeof value.currentPassword !== 'string' ||
        !(await identitySecrets.verify(value.currentPassword, String(row.current_password_proof))))
    )
      fail(409, 'ACCOUNT_REQUEST_CONFLICT', '原请求已用于其他账号操作或参数')
    assertCurrent?.()
    if (operation === 'changePassword') active(actor)
    else admin(actor)
    return JSON.parse(String(row.result_json))
  }
  function save(
    actor: string,
    requestId: string,
    operation: C.AccountOperation,
    target: string,
    input: unknown,
    result: C.RuntimeAccount | C.AccountPasswordResult,
    passwordProof = '',
    currentPasswordProof = '',
  ) {
    const resultTarget = operation === 'create' ? (result as C.RuntimeAccount).id : target
    db.prepare('INSERT INTO runtime_account_requests VALUES(?,?,?,?,?,?,?,?,?)').run(
      actor,
      requestId,
      fingerprint(operation, target, input),
      operation,
      resultTarget,
      JSON.stringify(result),
      new Date(now()).toISOString(),
      passwordProof,
      currentPasswordProof,
    )
    audit(actor, operation, resultTarget, requestId)
    return result
  }
  function passwordResult(target: string, nextRevision: number): C.AccountPasswordResult {
    return { userId: target, revision: nextRevision, sessionsRevoked: true, loginPath: '/' }
  }
  function run<T>(work: () => Promise<T>): Promise<T> {
    assertAccepting()
    const value = Promise.resolve().then(work)
    pending.add(value)
    void value.finally(() => pending.delete(value)).catch(() => {})
    return value
  }
  const attempts = new Map<string, { count: number; until: number }>()
  return {
    assertInitialized,
    active,
    get legacyInstallation() {
      assertOpen()
      return initialized().legacy_installation === 1
    },
    users() {
      assertInitialized()
      return db
        .prepare('SELECT * FROM runtime_accounts ORDER BY id')
        .all()
        .map((row) => {
          const user = account(row)
          return {
            id: user.id,
            username: user.username,
            name: user.name,
            kind: user.kind,
            role: user.platformAdmin ? 'admin' : 'member',
            status: user.enabled ? 'active' : 'disabled',
          }
        })
    },
    list(actor: string, after = ''): C.AccountPage {
      admin(actor)
      if (after) decode(DirectoryId, after)
      const items = db
        .prepare('SELECT * FROM runtime_accounts WHERE id>? ORDER BY id LIMIT 100')
        .all(after)
        .map(account)
      return { items, nextCursor: items.length === 100 ? items.at(-1)!.id : null }
    },
    own(actor: string) {
      return { account: active(actor) }
    },
    session(sessionHash: string) {
      assertInitialized()
      const row = db
        .prepare('SELECT * FROM sessions WHERE token=? AND expires>?')
        .get(sessionHash, now())
      if (!row) return fail(401, 'UNAUTHENTICATED', '登录已失效，请重新登录')
      const value = active(String(row.uid))
      return {
        token: String(row.token),
        uid: value.id,
        csrf: String(row.csrf),
        expires: Number(row.expires),
        user: {
          id: value.id,
          username: value.username,
          name: value.name,
          role: value.platformAdmin ? 'admin' : 'member',
          kind: value.kind,
          status: 'active' as const,
        },
      }
    },
    logout(sessionHash: string) {
      assertAccepting()
      db.prepare('DELETE FROM sessions WHERE token=?').run(sessionHash)
    },
    initialize(input: unknown) {
      return run(async () => {
        const value = decode(CreateUser, input)
        if (initialized().initialized === 1 || value.kind !== 'internal' || !value.platformAdmin)
          fail(409, 'ACCOUNT_INITIALIZATION_CONFLICT', '仅空账号库可初始化内部平台管理员')
        const passwordHash = await identitySecrets.password(value.password)
        return transaction(() => {
          assertAccepting()
          if (initialized().initialized === 1)
            fail(409, 'ACCOUNT_INITIALIZATION_CONFLICT', '账号已经初始化')
          const result = {
            id: randomUUID(),
            username: value.username,
            name: value.name,
            kind: value.kind,
            platformAdmin: true,
            enabled: true,
            revision: 1,
          }
          insert(result, passwordHash)
          audit(result.id, 'initialize', result.id)
          db.prepare('UPDATE runtime_account_metadata SET initialized=1 WHERE id=1').run()
          return result
        })
      })
    },
    login(input: unknown) {
      return run(async () => {
        assertInitialized()
        const value = decode(Login, input),
          at = now(),
          key = digest(value.username)
        for (const [entry, limit] of attempts) if (limit.until <= at) attempts.delete(entry)
        const limit = attempts.get(key) ?? { count: 0, until: at + 60000 }
        if (limit.count >= 10 || (!attempts.has(key) && attempts.size >= 1000))
          fail(429, 'ACCOUNT_RATE_LIMITED', '登录尝试过多，请稍后重试')
        limit.count++
        attempts.set(key, limit)
        const original = db
          .prepare('SELECT * FROM runtime_accounts WHERE username=?')
          .get(value.username)
        const valid = await identitySecrets.verify(
          value.password,
          original ? String(original.password_hash) : `${'0'.repeat(32)}:${'0'.repeat(128)}`,
        )
        if (!valid || !original || original.enabled !== 1)
          fail(401, 'BAD_CREDENTIALS', '账号或密码不正确')
        return transaction(() => {
          assertAccepting()
          const current = rowFor(String(original!.id))
          if (
            !current ||
            current.enabled !== 1 ||
            current.password_hash !== original!.password_hash
          )
            fail(401, 'BAD_CREDENTIALS', '账号或密码不正确')
          const token = randomBytes(32).toString('hex'),
            csrf = randomBytes(24).toString('hex'),
            expires = now() + 86400000
          db.prepare('DELETE FROM sessions WHERE expires<=?').run(now())
          db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(
            digest(token),
            current!.id!,
            csrf,
            expires,
          )
          const user = account(current!)
          return {
            token,
            csrf,
            expires,
            user: {
              id: user.id,
              username: user.username,
              name: user.name,
              role: user.platformAdmin ? 'admin' : 'member',
              kind: user.kind,
              status: 'active' as const,
            },
          }
        })
      })
    },
    create(actor: string, input: unknown, assertCurrent?: () => void): Promise<C.RuntimeAccount> {
      return run(async () => {
        admin(actor)
        const command = decode(C.CreateAccountCommand, input)
        if (command.value.kind === 'external' && command.value.platformAdmin)
          fail(400, 'ACCOUNT_INPUT_INVALID', '外部账号不能成为平台管理员')
        const original = await priorResult(
          prior(actor, command.requestId, 'create', '', command),
          command,
          actor,
          'create',
          assertCurrent,
        )
        if (original) return original as C.RuntimeAccount
        const passwordHash = await identitySecrets.password(command.value.password)
        const outcome = transaction(() => {
          assertAccepting()
          assertCurrent?.()
          admin(actor)
          const repeated = prior(actor, command.requestId, 'create', '', command)
          if (repeated) return { receipt: repeated }
          if (
            db
              .prepare('SELECT id FROM runtime_accounts WHERE username=?')
              .get(command.value.username)
          )
            fail(409, 'ACCOUNT_USERNAME_EXISTS', '用户名已存在')
          const value = {
            id: randomUUID(),
            username: command.value.username,
            name: command.value.name,
            kind: command.value.kind,
            platformAdmin: command.value.platformAdmin,
            enabled: true,
            revision: 1,
          }
          insert(value, passwordHash)
          return {
            result: save(
              actor,
              command.requestId,
              'create',
              '',
              command,
              value,
              passwordHash,
            ) as C.RuntimeAccount,
          }
        })
        return outcome.receipt
          ? ((await priorResult(
              outcome.receipt,
              command,
              actor,
              'create',
              assertCurrent,
            )) as C.RuntimeAccount)
          : outcome.result
      })
    },
    remove(
      actor: string,
      target: string,
      input: unknown,
      purge: (target: string) => Promise<void>,
      assertCurrent?: () => void,
    ): Promise<C.AccountDeletionResult> {
      return run(async () => {
        admin(actor)
        decode(DirectoryId, target)
        const command = decode(C.DeleteAccountCommand, input)
        const existing = transaction(() => {
          assertCurrent?.()
          admin(actor)
          const original = prior(actor, command.requestId, 'delete', target, command)
          if (original) return JSON.parse(String(original.result_json)) as C.AccountDeletionResult
          const row = rowFor(target)
          if (!row) return fail(404, 'ACCOUNT_NOT_FOUND', '账号不存在')
          if (row.revision !== command.expectedRevision)
            fail(409, 'ACCOUNT_REVISION_CONFLICT', '账号已变化，请刷新后重新确认')
          if (
            row.platform_admin === 1 &&
            row.enabled === 1 &&
            Number(
              db
                .prepare(
                  'SELECT count(*) AS n FROM runtime_accounts WHERE enabled=1 AND platform_admin=1',
                )
                .get()!.n,
            ) < 2
          )
            fail(409, 'ACCOUNT_LAST_ADMIN', '请先创建另一个有效平台管理员，再删除此账号')
          db.prepare('INSERT OR IGNORE INTO runtime_account_deletions VALUES(?,?,?,?,?)').run(
            target,
            actor,
            command.requestId,
            command.expectedRevision,
            new Date(now()).toISOString(),
          )
          db.prepare('UPDATE runtime_accounts SET enabled=0 WHERE id=?').run(target)
          db.prepare('DELETE FROM sessions WHERE uid=?').run(target)
          return undefined
        })
        if (existing) return existing
        try {
          await purge(target)
        } catch (cause) {
          throw Object.assign(
            new AccountError(
              503,
              'ACCOUNT_DELETE_PENDING',
              '账号已停用，关联清理未完成，请继续删除',
            ),
            { cause },
          )
        }
        return transaction(() => {
          if (actor !== target) {
            assertCurrent?.()
            admin(actor)
          }
          const priorResult = prior(actor, command.requestId, 'delete', target, command)
          if (priorResult) return JSON.parse(String(priorResult.result_json)) as C.AccountDeletionResult
          const result: C.AccountDeletionResult = {
            deleted: true,
            userId: target,
            revision: command.expectedRevision + 1,
          }
          db.prepare("DELETE FROM runtime_account_requests WHERE actor_id=? OR (target_id=? AND operation!='delete')").run(
            target,
            target,
          )
          db.prepare('DELETE FROM runtime_account_audit WHERE actor_id=? OR target_id=?').run(
            target,
            target,
          )
          db.prepare('DELETE FROM sessions WHERE uid=?').run(target)
          db.prepare('DELETE FROM runtime_accounts WHERE id=?').run(target)
          db.prepare('DELETE FROM runtime_account_deletions WHERE target_id=?').run(target)
          if (actor !== target)
            db.prepare('INSERT INTO runtime_account_requests VALUES(?,?,?,?,?,?,?,?,?)').run(
              actor,
              command.requestId,
              fingerprint('delete', target, command),
              'delete',
              target,
              JSON.stringify(result),
              new Date(now()).toISOString(),
              '',
              '',
            )
          return result
        })
      })
    },
    setEnabled(
      actor: string,
      target: string,
      input: unknown,
      assertCurrent?: () => void,
    ): C.RuntimeAccount {
      assertAccepting()
      admin(actor)
      decode(DirectoryId, target)
      const command = decode(C.EnableAccountCommand, input)
      return transaction(() => {
        assertCurrent?.()
        admin(actor)
        const original = prior(actor, command.requestId, 'enable', target, command)
        if (original) return JSON.parse(String(original.result_json)) as C.RuntimeAccount
        const row = revision(target, command.expectedRevision),
          value = account(row)
        if (value.enabled === command.value.enabled)
          return save(
            actor,
            command.requestId,
            'enable',
            target,
            command,
            value,
          ) as C.RuntimeAccount
        if (
          !command.value.enabled &&
          value.enabled &&
          value.platformAdmin &&
          Number(
            db
              .prepare(
                'SELECT count(*) AS n FROM runtime_accounts WHERE enabled=1 AND platform_admin=1',
              )
              .get()!.n,
          ) < 2
        )
          fail(409, 'ACCOUNT_LAST_ADMIN', '不能停用最后一个有效平台管理员')
        const result = { ...value, enabled: command.value.enabled, revision: value.revision + 1 }
        db.prepare('UPDATE runtime_accounts SET enabled=?,revision=? WHERE id=?').run(
          Number(result.enabled),
          result.revision,
          target,
        )
        db.prepare('DELETE FROM sessions WHERE uid=?').run(target)
        return save(actor, command.requestId, 'enable', target, command, result) as C.RuntimeAccount
      })
    },
    resetPassword(
      actor: string,
      target: string,
      input: unknown,
      assertCurrent?: () => void,
    ): Promise<C.AccountPasswordResult> {
      return run(async () => {
        admin(actor)
        decode(DirectoryId, target)
        const command = decode(C.ResetAccountPasswordCommand, input)
        const original = await priorResult(
          prior(actor, command.requestId, 'resetPassword', target, command),
          command,
          actor,
          'resetPassword',
          assertCurrent,
        )
        if (original) return original as C.AccountPasswordResult
        revision(target, command.expectedRevision)
        const passwordHash = await identitySecrets.password(command.value.newPassword)
        const outcome = transaction(() => {
          assertAccepting()
          assertCurrent?.()
          admin(actor)
          const repeated = prior(actor, command.requestId, 'resetPassword', target, command)
          if (repeated) return { receipt: repeated }
          const row = revision(target, command.expectedRevision)
          db.prepare(
            'UPDATE runtime_accounts SET password_hash=?,revision=revision+1 WHERE id=?',
          ).run(passwordHash, target)
          db.prepare('DELETE FROM sessions WHERE uid=?').run(target)
          return {
            result: save(
              actor,
              command.requestId,
              'resetPassword',
              target,
              command,
              passwordResult(target, Number(row.revision) + 1),
              passwordHash,
            ) as C.AccountPasswordResult,
          }
        })
        return outcome.receipt
          ? ((await priorResult(
              outcome.receipt,
              command,
              actor,
              'resetPassword',
              assertCurrent,
            )) as C.AccountPasswordResult)
          : outcome.result
      })
    },
    changePassword(
      actor: string,
      input: unknown,
      assertCurrent?: () => void,
    ): Promise<C.AccountPasswordResult> {
      return run(async () => {
        active(actor)
        const command = decode(C.ChangeAccountPasswordCommand, input)
        const original = await priorResult(
          prior(actor, command.requestId, 'changePassword', actor, command),
          command,
          actor,
          'changePassword',
          assertCurrent,
        )
        if (original) return original as C.AccountPasswordResult
        const previous = revision(actor, command.expectedRevision)
        if (
          !(await identitySecrets.verify(
            command.value.currentPassword,
            String(previous.password_hash),
          ))
        )
          fail(401, 'ACCOUNT_PASSWORD_INVALID', '当前密码无效')
        const passwordHash = await identitySecrets.password(command.value.newPassword)
        const outcome = transaction(() => {
          assertAccepting()
          assertCurrent?.()
          active(actor)
          const repeated = prior(actor, command.requestId, 'changePassword', actor, command)
          if (repeated) return { receipt: repeated }
          revision(actor, command.expectedRevision)
          db.prepare(
            'UPDATE runtime_accounts SET password_hash=?,revision=revision+1 WHERE id=?',
          ).run(passwordHash, actor)
          db.prepare('DELETE FROM sessions WHERE uid=?').run(actor)
          return {
            result: save(
              actor,
              command.requestId,
              'changePassword',
              actor,
              command,
              passwordResult(actor, Number(previous.revision) + 1),
              passwordHash,
              String(previous.password_hash),
            ) as C.AccountPasswordResult,
          }
        })
        return outcome.receipt
          ? ((await priorResult(
              outcome.receipt,
              command,
              actor,
              'changePassword',
              assertCurrent,
            )) as C.AccountPasswordResult)
          : outcome.result
      })
    },
    receipt(actor: string, requestId: string): C.AccountReceipt | null {
      active(actor)
      decode(S.String.check(S.isUUID()), requestId)
      const row = db
        .prepare('SELECT * FROM runtime_account_requests WHERE actor_id=? AND request_id=?')
        .get(actor, requestId)
      if (!row) return null
      if (row.operation !== 'changePassword') admin(actor)
      return {
        state: 'completed',
        requestId,
        operation: row.operation as C.AccountOperation,
        targetId: String(row.target_id),
        result: JSON.parse(String(row.result_json)),
        createdAt: String(row.created_at),
      }
    },
    stopAccepting() {
      stopping = true
    },
    close() {
      stopping = true
      return (closing ||= Promise.allSettled([...pending]).then(() => {
        closed = true
        db.close()
      }))
    },
  }
}
export type RuntimeAccounts = ReturnType<typeof createRuntimeAccounts>
