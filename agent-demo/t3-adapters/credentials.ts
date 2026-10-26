// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- 凭证模块使用独立 Node 运行边界，生命周期由组合根管理。
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { openDatabase } from '../../autoops/server/platform/database.ts'
import { decrypt, encrypt } from '../../src/security.mjs'
import type { WorkspaceCredentialMetadata, WorkspaceCredentialVersionReference } from '../../autoops/contracts/workspace-authoring.ts'

export type CredentialAction = 'credential.manage' | 'credential.use'
export interface GitCredential { username: string; password: string }
export interface ProjectCredentialOptions {
  databasePath: string
  keyPath: string
  initializeKeyIfNew?: boolean
  authorize: (actorId: string, projectId: string, action: CredentialAction) => void | boolean
}
export interface CredentialCreate { requestId: string; name: string; username: string; password: string }
export interface CredentialReplace extends Omit<CredentialCreate, 'name'> { expectedRevision: number; name?: string }
export interface CredentialRevoke { requestId: string; expectedRevision: number }
export class CredentialError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.name = 'CredentialError'; this.status = status; this.code = code }
}
const fail = (status: number, code: string, message: string): never => { throw new CredentialError(status, code, message) }
const text = (value: unknown, label: string, maximum = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) return fail(400, 'CREDENTIAL_INPUT_INVALID', `${label}无效`)
  return value.trim()
}
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail(400, 'CREDENTIAL_REVISION_INVALID', '请提供有效的凭证修订号')
  return Number(value)
}
function secret(input: GitCredential): GitCredential {
  // 保留秘密本身的空格，不能用展示字段的规范化改变有效凭证。
  if (typeof input.username !== 'string' || !input.username || input.username.length > 1000 || /[\x00-\x1f\x7f]/.test(input.username)
    || typeof input.password !== 'string' || !input.password || input.password.length > 16000 || /[\x00-\x1f\x7f]/.test(input.password))
    return fail(400, 'CREDENTIAL_SECRET_INVALID', '请提供有效的用户名与访问令牌或密码')
  return { username: input.username, password: input.password }
}
function protectedKey(options: ProjectCredentialOptions): Buffer {
  const databasePath = resolve(options.databasePath), keyPath = resolve(options.keyPath)
  if (databasePath === keyPath) return fail(500, 'CREDENTIAL_KEY_INVALID', '凭证密钥路径不能与数据库相同')
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  if (!existsSync(keyPath)) {
    if (!options.initializeKeyIfNew || existsSync(databasePath)) return fail(503, 'CREDENTIAL_KEY_MISSING', '凭证密钥不可用，拒绝初始化或替换现有秘密')
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
    try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error }
  }
  let fd: number | undefined
  try {
    const before = lstatSync(keyPath)
    if (!before.isFile() || before.isSymbolicLink()) return fail(503, 'CREDENTIAL_KEY_INVALID', '凭证密钥必须是受保护的普通文件')
    fd = openSync(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = fstatSync(fd)
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size !== 32
      || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))))
      return fail(503, 'CREDENTIAL_KEY_INVALID', '凭证密钥长度、所有者或访问权限无效')
    return readFileSync(fd)
  } finally { if (fd !== undefined) closeSync(fd) }
}
const migration = {
  version: 1, name: '项目凭证与不可变秘密版本', sql: `
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0), current_version INTEGER NOT NULL CHECK(current_version > 0),
      revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX credentials_project ON credentials(project_id,id);
    CREATE TABLE credential_versions (
      credential_id TEXT NOT NULL REFERENCES credentials(id), version INTEGER NOT NULL CHECK(version > 0),
      encrypted_secret TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(credential_id,version)
    ) STRICT;
    CREATE TABLE credential_requests (
      project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id,actor_id,request_id)
    ) STRICT;
    CREATE TABLE credential_audit (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
      credential_id TEXT NOT NULL REFERENCES credentials(id), version INTEGER NOT NULL,
      revision INTEGER NOT NULL, request_id TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE credential_key_check (id INTEGER PRIMARY KEY CHECK(id=1), encrypted_check TEXT NOT NULL) STRICT;
  `,
}
type Row = Record<string, string | number | bigint | null | Uint8Array>
function metadata(row: Row): WorkspaceCredentialMetadata {
  return { id: String(row.id), projectId: String(row.project_id), name: String(row.name), revision: Number(row.revision),
    version: Number(row.current_version), revoked: row.revoked === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

export function createProjectCredentialService(options: ProjectCredentialOptions) {
  if (!options || typeof options.authorize !== 'function') throw new TypeError('凭证服务必须配置授权入口')
  const key = protectedKey(options)
  const databasePath = resolve(options.databasePath)
  // 在 SQLite 打开前原子创建受保护文件，避免短暂生成可被其他系统用户读取的数据库。
  try { const fd = openSync(databasePath, 'wx', 0o600); closeSync(fd) }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) { key.fill(0); throw error } }
  const info = lstatSync(databasePath)
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) {
    key.fill(0); return fail(503, 'CREDENTIAL_DATABASE_INVALID', '凭证数据库必须是受保护的普通文件')
  }
  let storage: ReturnType<typeof openDatabase>
  try { storage = openDatabase(databasePath, [migration]) } catch (error) { key.fill(0); throw error }
  const { db, transaction } = storage
  try {
    transaction.run(() => {
      const existing = db.prepare('SELECT encrypted_check FROM credential_key_check WHERE id=1').get()
      if (existing) {
        try { if (decrypt(String(existing.encrypted_check), key) !== 'autoops-project-credentials-v1') throw new Error() }
        catch { fail(503, 'CREDENTIAL_KEY_MISMATCH', '凭证密钥与当前数据库不匹配') }
      } else {
        if (db.prepare('SELECT 1 FROM credentials LIMIT 1').get()) fail(503, 'CREDENTIAL_KEY_MISMATCH', '凭证密钥校验记录缺失')
        db.prepare('INSERT INTO credential_key_check VALUES(1,?)').run(encrypt('autoops-project-credentials-v1', key))
      }
    })
  } catch (error) { storage.close(); key.fill(0); throw error }
  let accepting = true, closed = false
  const pending = new Set<Promise<unknown>>()
  function authorize(actorId: string, projectId: string, action: CredentialAction) {
    if (!accepting || closed) fail(503, 'CREDENTIAL_SERVICE_STOPPING', '凭证服务正在停止接单')
    text(actorId, '操作人标识'); text(projectId, '项目标识')
    const decision: unknown = options.authorize(actorId, projectId, action)
    if (decision && typeof decision === 'object' && 'then' in decision) {
      void Promise.resolve(decision).catch(() => {})
      fail(503, 'CREDENTIAL_AUTHORIZATION_INVALID', '凭证授权必须同步返回当前裁决')
    }
    if (decision !== undefined && decision !== true) fail(403, 'CREDENTIAL_FORBIDDEN', '没有该项目的凭证操作权限')
  }
  function find(projectId: string, id: string) {
    const row = db.prepare('SELECT * FROM credentials WHERE project_id=? AND id=?').get(projectId, text(id, '凭证标识'))
    if (!row) return fail(404, 'CREDENTIAL_NOT_FOUND', '凭证不存在或不属于当前项目')
    return metadata(row)
  }
  function active(projectId: string, id: string) {
    const record = find(projectId, id)
    if (record.revoked) fail(409, 'CREDENTIAL_REVOKED', '凭证已撤销，请选择可用凭证')
    return record
  }
  function mutation(actorId: string, projectId: string, requestId: string, input: unknown, action: string, operation: () => WorkspaceCredentialMetadata) {
    authorize(actorId, projectId, 'credential.manage')
    text(requestId, '请求标识', 160)
    const fingerprint = createHmac('sha256', key).update(JSON.stringify([action, input])).digest('hex')
    return transaction.run(() => {
      const previous = db.prepare('SELECT fingerprint,result_json FROM credential_requests WHERE project_id=? AND actor_id=? AND request_id=?').get(projectId, actorId, requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fail(409, 'CREDENTIAL_REQUEST_CONFLICT', '该请求标识已用于不同的凭证操作，请核对原结果')
        return JSON.parse(String(previous.result_json)) as WorkspaceCredentialMetadata
      }
      const result = operation()
      db.prepare('INSERT INTO credential_requests VALUES(?,?,?,?,?)').run(projectId, actorId, requestId, fingerprint, JSON.stringify(result))
      // 操作事实与凭证变更同事务，只保存允许字段，绝不保存请求体或秘密。
      db.prepare('INSERT INTO credential_audit VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), projectId, actorId, action, result.id, result.version, result.revision, requestId, result.updatedAt)
      return result
    })
  }
  function saveVersion(record: WorkspaceCredentialMetadata, value: GitCredential) {
    const encrypted = encrypt(JSON.stringify({ projectId: record.projectId, credentialId: record.id, version: record.version, ...value }), key)
    db.prepare('INSERT INTO credential_versions VALUES(?,?,?,?)').run(record.id, record.version, encrypted, record.updatedAt)
  }
  const service = {
    receipt(actorId: string, projectId: string, requestId: string): WorkspaceCredentialMetadata | null {
      authorize(actorId, projectId, 'credential.manage')
      text(requestId, '请求标识', 160)
      const row = db.prepare('SELECT result_json FROM credential_requests WHERE project_id=? AND actor_id=? AND request_id=?').get(projectId, actorId, requestId)
      return row ? JSON.parse(String(row.result_json)) as WorkspaceCredentialMetadata : null
    },
    list(actorId: string, projectId: string): WorkspaceCredentialMetadata[] {
      authorize(actorId, projectId, 'credential.use')
      return db.prepare('SELECT * FROM credentials WHERE project_id=? ORDER BY created_at,id').all(projectId).map(metadata)
    },
    deletionReferences(projectId: string, environmentId?: string) {
      if (environmentId !== undefined) return []
      const count = Number(
        db
          .prepare('SELECT COUNT(*) AS n FROM credentials WHERE project_id=? AND revoked=0')
          .get(projectId)?.n ?? 0,
      )
      return count ? [{ kind: 'project-credentials', count, message: '项目仍有有效凭证' }] : []
    },
    create(actorId: string, projectId: string, input: CredentialCreate): WorkspaceCredentialMetadata {
      const name = text(input.name, '凭证名称'), value = secret(input)
      return mutation(actorId, projectId, input.requestId, { name, ...value }, 'credential.create', () => {
        const time = new Date().toISOString(), id = randomUUID()
        db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?,?,?)').run(id, projectId, name, 1, 1, 0, time, time)
        const record = find(projectId, id); saveVersion(record, value); return record
      })
    },
    replace(actorId: string, projectId: string, id: string, input: CredentialReplace): WorkspaceCredentialMetadata {
      const expected = revision(input.expectedRevision), name = input.name === undefined ? undefined : text(input.name, '凭证名称'), value = secret(input)
      return mutation(actorId, projectId, input.requestId, { id, expected, name, ...value }, 'credential.replace', () => {
        const previous = active(projectId, id)
        if (previous.revision !== expected) return fail(409, 'CREDENTIAL_REVISION_CONFLICT', '凭证已被其他操作修改，请刷新后再试')
        db.prepare('UPDATE credentials SET name=?,revision=revision+1,current_version=current_version+1,updated_at=? WHERE id=?').run(name ?? previous.name, new Date().toISOString(), id)
        const record = find(projectId, id); saveVersion(record, value); return record
      })
    },
    revoke(actorId: string, projectId: string, id: string, input: CredentialRevoke): WorkspaceCredentialMetadata {
      const expected = revision(input.expectedRevision)
      return mutation(actorId, projectId, input.requestId, { id, expected }, 'credential.revoke', () => {
        const previous = active(projectId, id)
        if (previous.revision !== expected) return fail(409, 'CREDENTIAL_REVISION_CONFLICT', '凭证已被其他操作修改，请刷新后再试')
        db.prepare('UPDATE credentials SET revoked=1,revision=revision+1,updated_at=? WHERE id=?').run(new Date().toISOString(), id)
        return find(projectId, id)
      })
    },
    referenceVersion(actorId: string, projectId: string, id: string): WorkspaceCredentialVersionReference {
      authorize(actorId, projectId, 'credential.use')
      const record = active(projectId, id)
      return { projectId, credentialId: record.id, version: record.version }
    },
    withCredential<T>(actorId: string, projectId: string, reference: WorkspaceCredentialVersionReference, operation: (credential: GitCredential) => T | Promise<T>): Promise<T> {
      // 解析与回调启动前重新授权；排空等待已经取密的回调，不能提前关闭状态所有者。
      authorize(actorId, projectId, 'credential.use')
      if (!reference || reference.projectId !== projectId) return Promise.reject(new CredentialError(403, 'CREDENTIAL_SCOPE_MISMATCH', '凭证版本不属于当前项目'))
      active(projectId, reference.credentialId)
      revision(reference.version)
      const row = db.prepare('SELECT encrypted_secret FROM credential_versions WHERE credential_id=? AND version=?').get(reference.credentialId, reference.version)
      if (!row) return Promise.reject(new CredentialError(404, 'CREDENTIAL_VERSION_NOT_FOUND', '固定凭证版本不存在'))
      let value: GitCredential
      try {
        const decoded: unknown = JSON.parse(decrypt(String(row.encrypted_secret), key))
        if (!decoded || typeof decoded !== 'object' || !('projectId' in decoded) || decoded.projectId !== projectId
          || !('credentialId' in decoded) || decoded.credentialId !== reference.credentialId || !('version' in decoded) || decoded.version !== reference.version
          || !('username' in decoded) || typeof decoded.username !== 'string' || !('password' in decoded) || typeof decoded.password !== 'string') throw new Error()
        value = secret({ username: decoded.username, password: decoded.password })
      } catch { return Promise.reject(new CredentialError(503, 'CREDENTIAL_DECRYPT_FAILED', '固定凭证版本暂时无法解密')) }
      let resolveResult!: (value: T | PromiseLike<T>) => void, rejectResult!: (reason: unknown) => void
      const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
      pending.add(result)
      // 回调立即启动，避免授权和实际使用之间插入另一个可撤权的微任务。
      try { resolveResult(operation(value)) } catch (error) { rejectResult(error) }
      void result.then(() => { pending.delete(result); value.username = ''; value.password = '' }, () => { pending.delete(result); value.username = ''; value.password = '' })
      return result
    },
    stopAccepting() { accepting = false },
    async drain() { await Promise.allSettled([...pending]) },
    close() {
      accepting = false
      if (pending.size) fail(409, 'CREDENTIAL_SERVICE_BUSY', '凭证使用尚未排空，不能关闭服务')
      if (!closed) { storage.close(); key.fill(0); closed = true }
    },
  }
  return service
}
export type ProjectCredentialService = ReturnType<typeof createProjectCredentialService>
