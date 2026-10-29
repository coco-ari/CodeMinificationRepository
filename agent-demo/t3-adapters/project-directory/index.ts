// @effect-diagnostics nodeBuiltinImport:off -- 目录复用同步 SQLite 事务，异步运行仍由 T3 管理。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as S from 'effect/Schema'
import * as DateTime from 'effect/DateTime'
import * as C from '../../../autoops/contracts/project-directory.ts'
import type { ProjectAction } from '../../../autoops/contracts/project-access.ts'
import type {
  RuntimeProject as AutoOpsProject,
  RuntimeAgent as AutoOpsAgent,
  ProjectMembership,
} from '../../../autoops/contracts/runtime.ts'
import { openDatabase } from '../../../autoops/server/platform/database.ts'
import { migrations } from './schema.ts'

type User = {
  id: string
  name: string
  role: string
  kind?: 'internal' | 'external'
  status?: string
}
type Catalog = {
  users: User[]
  projects: AutoOpsProject[]
  agents: AutoOpsAgent[]
  removedProjectAudience?: (project: string) => string[]
}
type Options = {
  dataDir: string
  seed: Catalog
  validateMember?: (project: string, actor: string, member: ProjectMembership) => void
  authorize: (actor: string, project: string, action: ProjectAction) => ProjectMembership
}
const fail = (status: number, code: string, message: string): never => {
  throw Object.assign(new Error(message), { status, code })
}
function decode<T extends S.ConstraintDecoder<unknown>>(schema: T, input: unknown): T['Type'] {
  try {
    return S.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
  } catch {
    return fail(400, 'PROJECT_INPUT_INVALID', '项目配置字段、格式或长度无效')
  }
}

export function createProjectDirectory({ dataDir, seed, authorize, validateMember }: Options) {
  const directory = join(dataDir, 'project-directory')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const database = openDatabase(join(directory, 'state.sqlite'), migrations)
  const { db, transaction } = database
  const removedAudiences = new Map<string, string[]>()
  let closed = false
  const active = (actor: string) => {
    if (closed) fail(503, 'PROJECT_DIRECTORY_CLOSED', '项目目录已停止')
    const user = seed.users.find(
      (user) => user.id === actor && (user.status === undefined || user.status === 'active'),
    )
    return user ?? fail(403, 'PROJECT_ACTOR_FORBIDDEN', '当前账号不可用')
  }
  const permitted = (actor: string, project: string, action: ProjectAction = 'project.manage') => {
    active(actor)
    return authorize(actor, project, action)
  }
  const rowFor = (project: string) =>
    db.prepare("SELECT * FROM directory_projects WHERE id=? AND state='active'").get(project) ??
    fail(404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问')
  function members(project: string, users?: ReadonlyMap<string, User>): C.DirectoryMember[] {
    const rows = db
      .prepare('SELECT * FROM directory_members WHERE project_id=? ORDER BY user_id')
      .all(project)
    if (!rows.length) return []
    const usersById = users ?? new Map(seed.users.map((user) => [user.id, user]))
    return rows.map((row) => {
      const user = usersById.get(String(row.user_id))
      const environments = db
        .prepare(
          'SELECT environment_id,role FROM directory_member_environments WHERE project_id=? AND user_id=? ORDER BY environment_id',
        )
        .all(project, row.user_id!)
      return {
        userId: String(row.user_id),
        name: user?.name ?? '不可用账号',
        kind: user?.kind ?? 'internal',
        role: row.role as C.DirectoryMember['role'],
        status: row.status as C.DirectoryMember['status'],
        environmentIds: environments.map((env) => String(env.environment_id)),
        environmentRoles: Object.fromEntries(
          environments
            .filter((env) => env.role !== null)
            .map((env) => [String(env.environment_id), env.role]),
        ) as C.DirectoryMember['environmentRoles'],
        canAdjustChat: Boolean(row.can_adjust_chat),
        authorizationPending: Boolean(row.pending),
        revision: Number(row.revision),
      }
    })
  }
  function projectDetails(project: string): C.DirectoryProject {
    const row = rowFor(project)
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      revision: Number(row.revision),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      environments: db
        .prepare(
          "SELECT id,name,revision FROM directory_environments WHERE project_id=? AND state='active' ORDER BY rowid",
        )
        .all(project)
        .map((env) => ({
          id: String(env.id),
          name: String(env.name),
          revision: Number(env.revision),
        })),
    }
  }
  function writeMember(
    project: string,
    member: C.MembershipDetails,
    revision: number,
    pending = false,
  ) {
    db.prepare(
      'INSERT INTO directory_members VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,can_adjust_chat=excluded.can_adjust_chat,pending=excluded.pending,status=excluded.status,revision=excluded.revision',
    ).run(
      project,
      member.userId,
      member.role,
      Number(member.canAdjustChat),
      Number(pending),
      member.status,
      revision,
    )
    db.prepare('DELETE FROM directory_member_environments WHERE project_id=? AND user_id=?').run(
      project,
      member.userId,
    )
    for (const environment of member.environmentIds)
      db.prepare('INSERT INTO directory_member_environments VALUES(?,?,?,?)').run(
        project,
        member.userId,
        environment,
        member.environmentRoles[environment] ?? null,
      )
  }
  try {
    transaction.run(() => {
      if (db.prepare('SELECT id FROM directory_seed WHERE id=1').get()) return
      const at = DateTime.formatIso(DateTime.nowUnsafe())
      for (const project of seed.projects) {
        db.prepare(
          'INSERT INTO directory_projects(id,name,description,revision,created_by,created_at) VALUES(?,?,?,1,?,?)',
        ).run(project.id, project.name, '', 'u-admin', at)
        for (const env of project.environments)
          db.prepare(
            'INSERT INTO directory_environments(project_id,id,name,revision) VALUES(?,?,?,1)',
          ).run(project.id, env.id, env.name)
        for (const member of project.memberships ?? [])
          writeMember(
            project.id,
            {
              ...member,
              environmentRoles: member.environmentRoles ?? {},
              canAdjustChat: member.canAdjustChat === true,
            },
            1,
            member.authorizationPending === true,
          )
      }
      db.prepare('INSERT INTO directory_seed VALUES(1)').run()
    })
  } catch (error) {
    database.close()
    throw error
  }
  // 当前资料和助手仍由原所属模块提供；目录只拥有项目、环境和成员事实。
  const catalog: Catalog = {
    get users() {
      return seed.users
    },
    get projects() {
      const rows = db
        .prepare("SELECT id FROM directory_projects WHERE state='active' ORDER BY rowid")
        .all()
      if (!rows.length) return []
      // 仅本次同步目录投影复用账号读数，下次读取仍取当前账号与成员状态。
      const users = new Map(seed.users.map((user) => [user.id, user]))
      return rows.map((row) => {
        const project = projectDetails(String(row.id)),
          existing = seed.projects.find((entry) => entry.id === project.id)
        const assignments = members(project.id, users)
        return {
          ...project,
          memberIds: assignments
            .filter((member) => member.status === 'active')
            .map((member) => member.userId),
          memberships: assignments.map((member) => ({
            ...member,
            environmentIds: [...member.environmentIds],
            environmentRoles: { ...member.environmentRoles },
            workspaceAccess:
              member.role === 'external' ? ('external' as const) : ('internal' as const),
          })),
          documents: existing?.documents ?? [],
          resources: existing?.resources ?? [],
        }
      })
    },
    get agents() {
      let projectIds: string[] | undefined
      return seed.agents.map((agent) => ({
        ...agent,
        projectIds: ['a-project', 'a-report'].includes(agent.id)
          ? [...(projectIds ??= db
              .prepare("SELECT id FROM directory_projects WHERE state='active' ORDER BY rowid")
              .all()
              .map((row) => String(row.id)))]
          : [...agent.projectIds],
      }))
    },
    removedProjectAudience(project) {
      if (removedAudiences.has(project)) return removedAudiences.get(project)!
      const removed = db
        .prepare("SELECT id FROM directory_projects WHERE id=? AND state IN ('deleting','deleted')")
        .get(project)
      return removed
        ? members(project)
            .filter((member) => member.status === 'active')
            .map((member) => member.userId)
        : []
    },
  }
  function command<T>(
    actor: string,
    project: string,
    operation: string,
    requestId: string,
    payload: unknown,
    execute: () => T,
  ): T {
    return transaction.run(() => {
      if (operation === 'project.create') {
        if (active(actor).kind === 'external')
          fail(403, 'PROJECT_CREATE_FORBIDDEN', '外部账号不能创建项目')
      } else
        permitted(
          actor,
          project,
          operation.startsWith('member.') ? 'project.members.manage' : 'project.manage',
        )
      if (db.prepare('SELECT 1 FROM directory_retired_requests WHERE request_id=?').get(requestId))
        fail(404, 'PROJECT_RESOURCE_DELETED', '原请求所属资源已删除，请重新操作')
      const encoded = JSON.stringify(payload)
      if (
        db.prepare('SELECT request_id FROM directory_deletions WHERE request_id=?').get(requestId)
      )
        fail(409, 'PROJECT_REQUEST_CONFLICT', '原请求已用于删除操作')
      const previous = db
        .prepare('SELECT * FROM directory_receipts WHERE request_id=?')
        .get(requestId)
      if (previous) {
        if (
          previous.actor_id !== actor ||
          previous.project_id !== project ||
          previous.operation !== operation ||
          previous.payload !== encoded
        )
          fail(409, 'PROJECT_REQUEST_CONFLICT', '原请求已用于其他操作者或配置')
        return JSON.parse(String(previous.result)) as T
      }
      const result = execute(),
        at = DateTime.formatIso(DateTime.nowUnsafe())
      db.prepare(
        'INSERT INTO directory_audit(actor_id,project_id,operation,subject_id,created_at) VALUES(?,?,?,?,?)',
      ).run(actor, project, operation, project, at)
      db.prepare('INSERT INTO directory_receipts VALUES(?,?,?,?,?,?,?)').run(
        requestId,
        actor,
        project,
        operation,
        encoded,
        JSON.stringify(result),
        at,
      )
      return result
    })
  }
  const revision = (actual: number, expected: number) => {
    if (actual !== expected)
      fail(409, 'PROJECT_REVISION_CONFLICT', '配置已被修改，请刷新后核对再保存')
  }
  type Inspect = () => C.DeletionBlocker[]
  function inspectDeletion(
    project: string,
    environment: string | null,
    inspect: Inspect,
  ): C.DeletionBlocker[] {
    const values = inspect()
    if (
      !Array.isArray(values) ||
      values.some(
        (value) =>
          !value ||
          !Number.isSafeInteger(value.count) ||
          value.count < 0 ||
          typeof value.kind !== 'string' ||
          typeof value.message !== 'string',
      )
    )
      return fail(503, 'PROJECT_DELETE_INSPECTION_UNAVAILABLE', '引用检查不可用，尚未删除')
    const blockers = values
      .filter((value) => value.count > 0)
      .map((value) => ({
        kind: value.kind.slice(0, 80),
        count: Math.min(value.count, 9999),
        message: value.message.slice(0, 160),
      }))
    if (environment === null) {
      const count = Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM directory_environments WHERE project_id=? AND state!='deleted'",
          )
          .get(project)?.n ?? 0,
      )
      if (count)
        blockers.unshift({
          kind: 'environments',
          count,
          message: '项目内的环境将一并删除',
        })
    }
    return blockers
  }
  const blocked = (blockers: C.DeletionBlocker[]): never =>
    fail(
      409,
      'PROJECT_DELETE_BLOCKED',
      `仍有引用，尚未删除：${blockers
        .slice(0, 8)
        .map((value) => `${value.message}（${value.count}）`)
        .join('；')}`,
    )
  function deletionAuthority(actor: string, project: string) {
    const user = active(actor)
    if (user.kind === 'external')
      fail(403, 'PROJECT_DELETE_FORBIDDEN', '外部账号不能删除项目或环境')
    if (db.prepare("SELECT id FROM directory_projects WHERE id=? AND state='active'").get(project))
      return permitted(actor, project)
    if (
      user.role === 'admin' ||
      members(project).some(
        (member) =>
          member.userId === actor && member.role === 'project_admin' && member.status === 'active',
      )
    )
      return
    fail(403, 'PROJECT_DELETE_FORBIDDEN', '当前账号没有原删除请求的管理权限')
  }
  function deletionReceipt(
    actor: string,
    project: string,
    environment: string | null,
    input: unknown,
  ) {
    const value = decode(C.DeleteDirectoryCommand, input)
    const previous = db
      .prepare('SELECT * FROM directory_deletions WHERE request_id=?')
      .get(value.requestId)
    if (previous) {
      if (
        previous.actor_id !== actor ||
        previous.project_id !== project ||
        previous.environment_id !== environment ||
        previous.payload !== JSON.stringify(value)
      )
        fail(409, 'PROJECT_REQUEST_CONFLICT', '原删除请求已用于其他操作者、范围或修订')
      if (previous.state === 'deleted') active(actor)
      else deletionAuthority(actor, project)
      return { value, previous }
    }
    permitted(actor, project)
    if (
      db
        .prepare('SELECT request_id FROM directory_receipts WHERE request_id=?')
        .get(value.requestId)
    )
      fail(409, 'PROJECT_REQUEST_CONFLICT', '原请求已用于其他配置')
    return { value, previous: undefined }
  }
  function acceptedProjectDeletion(actor: string, requestId: string) {
    active(actor)
    decode(C.DirectoryId, requestId)
    const row = db
      .prepare('SELECT * FROM directory_deletions WHERE request_id=? AND actor_id=?')
      .get(requestId, actor)
    if (!row) return fail(404, 'PROJECT_DELETE_RECEIPT_NOT_FOUND', '没有本人的已受理项目删除请求')
    if (row.state !== 'deleted') deletionAuthority(actor, String(row.project_id))
    if (row.state !== 'pending' && row.state !== 'deleted')
      return fail(409, 'PROJECT_DELETE_NOT_PENDING', '原项目删除已被阻止，不能继续执行')
    return row
  }
  function deletionAudit(actor: string, project: string, operation: string, subject: string) {
    db.prepare(
      'INSERT INTO directory_audit(actor_id,project_id,operation,subject_id,created_at) VALUES(?,?,?,?,?)',
    ).run(actor, project, operation, subject, DateTime.formatIso(DateTime.nowUnsafe()))
  }
  function publicDeletion(row: Record<string, unknown>): C.ProjectDeletionReceipt {
    return {
      state: row.state as C.ProjectDeletionReceipt['state'],
      projectId: String(row.project_id),
      requestId: String(row.request_id),
      blockers: JSON.parse(String(row.blockers)) as C.DeletionBlocker[],
    }
  }
  function receiptValue<T extends S.ConstraintDecoder<unknown>>(
    schema: T,
    input: unknown,
  ): T['Type'] {
    try {
      return S.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
    } catch {
      return fail(503, 'PROJECT_RECEIPT_INVALID', '原项目请求事实不可核对，请保留原请求')
    }
  }
  function requestReceipt(actor: string, requestId: string): C.DirectoryRequestReceipt | null {
    active(actor)
    decode(C.DirectoryId, requestId)
    const saved = db
      .prepare('SELECT * FROM directory_receipts WHERE request_id=? AND actor_id=?')
      .get(requestId, actor)
    const deletion = db
      .prepare('SELECT * FROM directory_deletions WHERE request_id=? AND actor_id=?')
      .get(requestId, actor)
    if (!saved && !deletion) return null
    if (saved && deletion)
      return fail(503, 'PROJECT_RECEIPT_INVALID', '原项目请求事实冲突，请保留原请求')
    const row = (saved ?? deletion)!
    const project = String(row.project_id)
    const operation = saved
      ? String(saved.operation)
      : deletion!.environment_id === null
        ? 'project.delete'
        : 'environment.delete'
    let payload:
      | typeof C.CreateProjectCommand.Type
      | typeof C.SaveEnvironmentCommand.Type
      | typeof C.SaveMemberCommand.Type
      | typeof C.DeleteDirectoryCommand.Type
    try {
      const schema = deletion
        ? C.DeleteDirectoryCommand
        : operation === 'project.create' || operation === 'project.save'
          ? C.CreateProjectCommand
          : operation.startsWith('environment.save:')
            ? C.SaveEnvironmentCommand
            : operation.startsWith('member.delete:')
              ? C.DirectoryCommand
              : operation.startsWith('member.save:')
                ? C.SaveMemberCommand
                : undefined
      if (!schema) return fail(503, 'PROJECT_RECEIPT_INVALID', '原项目请求操作不可核对')
      payload = receiptValue(schema, JSON.parse(String(row.payload)))
    } catch {
      return fail(503, 'PROJECT_RECEIPT_INVALID', '原项目请求参数不可核对')
    }
    if (payload.requestId !== requestId)
      return fail(503, 'PROJECT_RECEIPT_INVALID', '原项目请求标识不可核对')
    const environment = deletion
      ? deletion.environment_id === null
        ? null
        : String(deletion.environment_id)
      : operation.startsWith('environment.save:')
        ? operation.slice('environment.save:'.length) === 'new' && payload.expectedRevision === 0
          ? null
          : operation.slice('environment.save:'.length)
        : null
    let available = true
    try {
      permitted(
        actor,
        project,
        operation.startsWith('member.') ? 'project.members.manage' : 'project.manage',
      )
    } catch (error) {
      if (![403, 404].includes((error as { status?: number }).status ?? 0)) throw error
      available = false
    }
    const { requestId: _requestId, ...publicIntent } = payload
    let result: unknown
    if (saved) {
      try {
        result = JSON.parse(String(saved.result))
        const value = result as { id?: string; userId?: string; revision?: number }
        if (
          value.revision !== payload.expectedRevision + 1 ||
          ((operation === 'project.create' || operation === 'project.save') &&
            value.id !== project) ||
          (environment !== null && value.id !== environment) ||
          (operation.startsWith('member.save:') &&
            (value.userId !== operation.slice('member.save:'.length) ||
              !('value' in payload) ||
              !payload.value ||
              typeof payload.value !== 'object' ||
              !('userId' in payload.value) ||
              value.userId !== payload.value.userId))
        )
          return fail(503, 'PROJECT_RECEIPT_INVALID', '原项目请求结果范围不可核对')
      } catch {
        return fail(503, 'PROJECT_RECEIPT_INVALID', '原项目请求结果不可核对')
      }
    } else if (deletion!.state === 'deleted') {
      // 删除后目录可见性已经消失；本人原收据只证明最小删除事实。
      result = {
        deleted: true,
        projectId: project,
        ...(environment === null ? {} : { environmentId: environment }),
      }
    }
    let blockers: C.DeletionBlocker[] | undefined
    if (available && deletion?.state === 'blocked') {
      try {
        blockers = (JSON.parse(String(deletion.blockers)) as C.DeletionBlocker[]).slice(0, 24)
      } catch {
        return fail(503, 'PROJECT_RECEIPT_INVALID', '原删除阻止事实不可核对')
      }
    }
    let canResume: boolean | undefined
    if (deletion?.state === 'pending') {
      try {
        deletionAuthority(actor, project)
        canResume = true
      } catch (error) {
        const status = (error as { status?: number }).status
        if (status !== 403 && status !== 404) throw error
        canResume = false
      }
    }
    return receiptValue(C.DirectoryRequestReceipt, {
      state: saved || deletion!.state === 'deleted' ? 'completed' : deletion!.state,
      requestId,
      actorId: actor,
      projectId: project,
      environmentId: environment,
      operation,
      saved: true,
      available,
      publicIntent,
      createdAt: String(row.created_at),
      nativeSynchronization:
        operation === 'project.create' || operation === 'project.save'
          ? 'unverified'
          : 'not-required',
      ...((available || deletion?.state === 'deleted') && result !== undefined ? { result } : {}),
      ...(blockers ? { blockers } : {}),
      ...(canResume === undefined ? {} : { canResume }),
    })
  }
  return {
    catalog,
    receipt: requestReceipt,
    requireProjectDeletionResumeAccess(actor: string, requestId: string) {
      acceptedProjectDeletion(actor, requestId)
    },
    purgeUser(user: string) {
      transaction.run(() => {
        db.prepare('DELETE FROM directory_member_environments WHERE user_id=?').run(user)
        db.prepare('DELETE FROM directory_members WHERE user_id=?').run(user)
        db.prepare('DELETE FROM directory_retired_requests WHERE actor_id=?').run(user)
        db.prepare('DELETE FROM directory_receipts WHERE actor_id=?').run(user)
        db.prepare('DELETE FROM directory_audit WHERE actor_id=? OR subject_id=?').run(user, user)
        db.prepare('DELETE FROM directory_deletions WHERE actor_id=? AND state<>?').run(
          user,
          'pending',
        )
      })
    },
    resumeProjectDeletion(
      actor: string,
      requestId: string,
      input: unknown,
      inspect: (project: string, environment?: string) => C.DeletionBlocker[],
    ) {
      return transaction.run(() => {
        const row = acceptedProjectDeletion(actor, requestId)
        const value = decode(C.ResumeProjectDeletionCommand, input)
        let command: typeof C.DeleteDirectoryCommand.Type
        try {
          command = receiptValue(C.DeleteDirectoryCommand, JSON.parse(String(row.payload)))
        } catch {
          return fail(503, 'PROJECT_RECEIPT_INVALID', '原删除意图无法核对，请保留原请求')
        }
        if (
          value.projectId !== row.project_id ||
          (value.environmentId ?? null) !== row.environment_id ||
          value.operation !==
            (row.environment_id === null ? 'project.delete' : 'environment.delete') ||
          command.requestId !== requestId ||
          value.publicIntent.expectedRevision !== command.expectedRevision
        )
          return fail(409, 'PROJECT_REQUEST_CONFLICT', '继续删除的范围或原意图不一致')
        if (row.state === 'pending') {
          const blockers = inspectDeletion(
            value.projectId,
            row.environment_id === null ? null : String(row.environment_id),
            () => inspect(value.projectId, value.environmentId),
          )
          if (blockers.some((value) => value.kind === 'native-project-synchronization'))
            return blocked(blockers)
          // 各 owner 的只读检查可能触发同步撤权；原步骤继续前重新核对当前权限。
          deletionAuthority(actor, value.projectId)
        }
        return {
          projectId: value.projectId,
          ...(value.environmentId === undefined ? {} : { environmentId: value.environmentId }),
          command,
        }
      })
    },
    requireDeletionAccess(actor: string, project: string) {
      active(actor)
      if (
        db
          .prepare(
            "SELECT 1 FROM directory_deletions WHERE project_id=? AND actor_id=? AND state='deleted'",
          )
          .get(project, actor)
      )
        return
      deletionAuthority(actor, project)
    },
    deletionPreview(
      actor: string,
      project: string,
      environment: string | null,
      inspect: Inspect,
    ): C.DeletionPreview {
      permitted(actor, project)
      const current =
        environment === null
          ? rowFor(project)
          : db
              .prepare(
                "SELECT revision FROM directory_environments WHERE project_id=? AND id=? AND state='active'",
              )
              .get(project, decode(C.DirectoryId, environment))
      if (!current) return fail(404, 'ENVIRONMENT_NOT_FOUND', '环境不存在或不属于当前项目')
      const blockers = inspectDeletion(project, environment, inspect)
      return {
        revision: Number(current.revision),
        canDelete: !blockers.some((value) => value.kind === 'native-project-synchronization'),
        blockers: blockers.slice(0, 24),
        truncated: blockers.length > 24,
      }
    },
    beginProjectDeletion(
      actor: string,
      project: string,
      input: unknown,
      inspect: Inspect,
    ): C.ProjectDeletionReceipt {
      return transaction.run(() => {
        const { value, previous } = deletionReceipt(actor, project, null, input)
        if (previous) return publicDeletion(previous)
        revision(Number(rowFor(project).revision), value.expectedRevision)
        const blockers = inspectDeletion(project, null, inspect)
        if (blockers.some((value) => value.kind === 'native-project-synchronization'))
          return blocked(blockers)
        db.prepare(
          "UPDATE directory_projects SET state='deleting',revision=revision+1 WHERE id=?",
        ).run(project)
        db.prepare("INSERT INTO directory_deletions VALUES(?,?,?,NULL,?,'pending','[]',?)").run(
          value.requestId,
          actor,
          project,
          JSON.stringify(value),
          DateTime.formatIso(DateTime.nowUnsafe()),
        )
        deletionAudit(actor, project, 'project.delete.pending', project)
        return { state: 'pending', projectId: project, requestId: value.requestId, blockers: [] }
      })
    },
    completeProjectDeletion(
      actor: string,
      project: string,
      input: unknown,
    ): C.DirectoryDeletionResult {
      return transaction.run(() => {
        const { value, previous } = deletionReceipt(actor, project, null, input)
        if (!previous || previous.state === 'blocked')
          return fail(409, 'PROJECT_DELETE_NOT_PENDING', '没有可继续的原删除请求')
        if (previous.state !== 'deleted') {
          removedAudiences.set(
            project,
            members(project)
              .filter((value) => value.status === 'active')
              .map((value) => value.userId),
          )
          db.prepare(
            'INSERT OR IGNORE INTO directory_retired_requests SELECT request_id,actor_id FROM directory_receipts WHERE project_id=?',
          ).run(project)
          for (const table of [
            'directory_member_environments',
            'directory_members',
            'directory_environments',
            'directory_receipts',
            'directory_audit',
          ])
            db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(project)
          db.prepare('DELETE FROM directory_deletions WHERE project_id=? AND request_id!=?').run(
            project,
            value.requestId,
          )
          db.prepare('DELETE FROM directory_projects WHERE id=?').run(project)
          db.prepare("UPDATE directory_deletions SET state='deleted' WHERE request_id=?").run(
            value.requestId,
          )
        }
        return { deleted: true, projectId: project }
      })
    },
    blockProjectDeletion(
      actor: string,
      project: string,
      input: unknown,
      blockers: C.DeletionBlocker[],
    ) {
      return transaction.run(() => {
        const { value, previous } = deletionReceipt(actor, project, null, input)
        if (!previous || previous.state !== 'pending')
          fail(409, 'PROJECT_DELETE_NOT_PENDING', '没有可继续的原删除请求')
        db.prepare(
          "UPDATE directory_projects SET state='active',revision=revision+1 WHERE id=? AND state='deleting'",
        ).run(project)
        db.prepare(
          "UPDATE directory_deletions SET state='blocked',blockers=? WHERE request_id=?",
        ).run(JSON.stringify(blockers), value.requestId)
        deletionAudit(actor, project, 'project.delete.blocked', project)
      })
    },
    beginEnvironmentDeletion(actor: string, project: string, environment: string, input: unknown) {
      return transaction.run(() => {
        const { value, previous } = deletionReceipt(actor, project, environment, input)
        if (previous) return publicDeletion(previous)
        const current = db
          .prepare(
            "SELECT revision FROM directory_environments WHERE project_id=? AND id=? AND state='active'",
          )
          .get(project, decode(C.DirectoryId, environment))
        if (!current) return fail(404, 'ENVIRONMENT_NOT_FOUND', '环境不存在或不属于当前项目')
        revision(Number(current.revision), value.expectedRevision)
        db.prepare(
          "UPDATE directory_environments SET state='deleting' WHERE project_id=? AND id=?",
        ).run(project, environment)
        db.prepare("INSERT INTO directory_deletions VALUES(?,?,?,?,?,'pending','[]',?)").run(
          value.requestId,
          actor,
          project,
          environment,
          JSON.stringify(value),
          DateTime.formatIso(DateTime.nowUnsafe()),
        )
        return {
          state: 'pending' as const,
          projectId: project,
          requestId: value.requestId,
          blockers: [],
        }
      })
    },
    deleteEnvironment(
      actor: string,
      project: string,
      environment: string,
      input: unknown,
      inspect: Inspect,
    ): C.DirectoryDeletionResult {
      return transaction.run(() => {
        const { value, previous } = deletionReceipt(actor, project, environment, input)
        if (previous?.state === 'deleted')
          return { deleted: true, projectId: project, environmentId: environment }
        const current = db
          .prepare(
            "SELECT revision FROM directory_environments WHERE project_id=? AND id=? AND state IN ('active','deleting')",
          )
          .get(project, decode(C.DirectoryId, environment))
        if (!current) return fail(404, 'ENVIRONMENT_NOT_FOUND', '环境不存在或不属于当前项目')
        revision(Number(current.revision), value.expectedRevision)
        const blockers = inspectDeletion(project, environment, inspect)
        if (blockers.some((value) => value.kind === 'native-project-synchronization'))
          return blocked(blockers)
        db.prepare(
          "UPDATE directory_environments SET state='deleting' WHERE project_id=? AND id=?",
        ).run(project, environment)
        db.prepare(
          'UPDATE directory_members SET revision=revision+1 WHERE project_id=? AND user_id IN (SELECT user_id FROM directory_member_environments WHERE project_id=? AND environment_id=?)',
        ).run(project, project, environment)
        db.prepare(
          'DELETE FROM directory_member_environments WHERE project_id=? AND environment_id=?',
        ).run(project, environment)
        db.prepare('DELETE FROM directory_environments WHERE project_id=? AND id=?').run(project, environment)
        db.prepare("INSERT OR IGNORE INTO directory_retired_requests SELECT request_id,actor_id FROM directory_receipts WHERE project_id=? AND (operation=? OR (operation='environment.save:new' AND json_extract(result,'$.id')=?) OR EXISTS(SELECT 1 FROM json_each(payload,'$.value.environmentIds') WHERE value=?))").run(project, `environment.save:${environment}`, environment, environment)
        db.prepare('DELETE FROM directory_receipts WHERE request_id IN (SELECT request_id FROM directory_retired_requests)').run()
        db.prepare('DELETE FROM directory_audit WHERE project_id=? AND subject_id=?').run(project, environment)
        db.prepare("INSERT INTO directory_deletions VALUES(?,?,?,?,?,'deleted','[]',?) ON CONFLICT(request_id) DO UPDATE SET state='deleted',blockers='[]'").run(value.requestId,actor,project,environment,JSON.stringify(value),DateTime.formatIso(DateTime.nowUnsafe()))
        deletionAudit(actor, project, 'environment.delete', environment)
        return { deleted: true, projectId: project, environmentId: environment }
      })
    },
    list(actor: string) {
      active(actor)
      return catalog.projects.flatMap((project) => {
        try {
          const membership = permitted(actor, project.id, 'project.read')
          const details = projectDetails(project.id)
          return [
            {
              ...details,
              environments: details.environments.filter((env) =>
                membership.environmentIds.includes(env.id),
              ),
            },
          ]
        } catch (error) {
          if ((error as { status?: number }).status === 404) return []
          throw error
        }
      })
    },
    settings(actor: string, project: string): C.ProjectSettings {
      permitted(actor, project)
      return {
        project: projectDetails(project),
        members: members(project),
        candidates: seed.users
          .filter((user) => user.status === undefined || user.status === 'active')
          .map((user) => ({ id: user.id, name: user.name, kind: user.kind ?? 'internal' })),
      }
    },
    create(actor: string, input: unknown) {
      const user = active(actor),
        value = decode(C.CreateProjectCommand, input)
      if (
        db
          .prepare('SELECT 1 FROM directory_retired_requests WHERE request_id=?')
          .get(value.requestId)
      )
        fail(404, 'PROJECT_NOT_FOUND', '原创建对象已删除，请重新创建')
      if (user.kind === 'external') fail(403, 'PROJECT_CREATE_FORBIDDEN', '外部账号不能创建项目')
      if (value.expectedRevision !== 0) fail(400, 'PROJECT_INPUT_INVALID', '新项目修订必须为零')
      const previous = db
        .prepare('SELECT project_id FROM directory_receipts WHERE request_id=?')
        .get(value.requestId)
      const id = previous ? String(previous.project_id) : randomUUID()
      if (previous) permitted(actor, id)
      return command(actor, id, 'project.create', value.requestId, value, () => {
        db.prepare(
          'INSERT INTO directory_projects(id,name,description,revision,created_by,created_at) VALUES(?,?,?,1,?,?)',
        ).run(
          id,
          value.value.name,
          value.value.description,
          actor,
          DateTime.formatIso(DateTime.nowUnsafe()),
        )
        writeMember(
          id,
          {
            userId: actor,
            role: 'project_admin',
            status: 'active',
            environmentIds: [],
            environmentRoles: {},
            canAdjustChat: true,
          },
          1,
        )
        return projectDetails(id)
      })
    },
    saveProject(actor: string, project: string, input: unknown) {
      permitted(actor, project)
      const value = decode(C.CreateProjectCommand, input)
      return command(actor, project, 'project.save', value.requestId, value, () => {
        revision(Number(rowFor(project).revision), value.expectedRevision)
        db.prepare(
          'UPDATE directory_projects SET name=?,description=?,revision=revision+1 WHERE id=?',
        ).run(value.value.name, value.value.description, project)
        return projectDetails(project)
      })
    },
    saveEnvironment(actor: string, project: string, environment: string | null, input: unknown) {
      permitted(actor, project)
      const value = decode(C.SaveEnvironmentCommand, input)
      return command(
        actor,
        project,
        `environment.save:${environment ?? 'new'}`,
        value.requestId,
        value,
        () => {
          const existing =
            environment === null
              ? undefined
              : db
                  .prepare(
                    "SELECT * FROM directory_environments WHERE project_id=? AND id=? AND state='active'",
                  )
                  .get(project, decode(C.DirectoryId, environment))
          if (environment !== null && !existing)
            fail(404, 'ENVIRONMENT_NOT_FOUND', '环境不存在或不属于当前项目')
          revision(existing ? Number(existing.revision) : 0, value.expectedRevision)
          const id = environment ?? randomUUID(),
            next = Number(existing?.revision ?? 0) + 1
          db.prepare(
            'INSERT INTO directory_environments(project_id,id,name,revision) VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET name=excluded.name,revision=excluded.revision',
          ).run(project, id, value.value.name, next)
          return { id, name: value.value.name, revision: next }
        },
      )
    },
    removeMember(
      actor: string,
      project: string,
      userId: string,
      input: unknown,
      purge: () => void,
    ) {
      permitted(actor, project, 'project.members.manage')
      const value = decode(C.DirectoryCommand, input)
      return command(actor, project, `member.delete:${userId}`, value.requestId, value, () => {
        const member = members(project).find((row) => row.userId === userId)
        if (!member) return fail(404, 'PROJECT_MEMBER_NOT_FOUND', '成员不存在')
        revision(member.revision, value.expectedRevision)
        purge()
        db.prepare(
          'DELETE FROM directory_member_environments WHERE project_id=? AND user_id=?',
        ).run(project, userId)
        db.prepare('DELETE FROM directory_members WHERE project_id=? AND user_id=?').run(
          project,
          userId,
        )
        db.prepare(
          'DELETE FROM directory_receipts WHERE project_id=? AND (operation=? OR operation=?)',
        ).run(project, `member.save:${userId}`, `member.delete:${userId}`)
        db.prepare('DELETE FROM directory_audit WHERE project_id=? AND subject_id=?').run(
          project,
          userId,
        )
        return { deleted: true, userId, revision: member.revision + 1 }
      })
    },
    saveMember(actor: string, project: string, input: unknown) {
      permitted(actor, project, 'project.members.manage')
      const value = decode(C.SaveMemberCommand, input),
        member = value.value
      const user = seed.users.find(
        (user) =>
          user.id === member.userId && (user.status === undefined || user.status === 'active'),
      )
      if (!user || (user.kind === 'external' && member.role !== 'external'))
        fail(400, 'PROJECT_MEMBER_INVALID', '账号不可用或外部账号不能分配内部角色')
      if (
        new Set(member.environmentIds).size !== member.environmentIds.length ||
        (member.role === 'external' && member.environmentIds.length) ||
        Object.keys(member.environmentRoles).some((id) => !member.environmentIds.includes(id))
      )
        fail(400, 'PROJECT_MEMBER_SCOPE_INVALID', '环境范围或显式角色无效')
      for (const id of member.environmentIds)
        if (
          !db
            .prepare(
              "SELECT id FROM directory_environments WHERE project_id=? AND id=? AND state='active'",
            )
            .get(project, id)
        )
          fail(400, 'PROJECT_MEMBER_SCOPE_INVALID', '环境不属于当前项目')
      return command(actor, project, `member.save:${member.userId}`, value.requestId, value, () => {
        if (validateMember)
          validateMember(project, member.userId, {
            ...member,
            environmentIds: [...member.environmentIds],
            environmentRoles: { ...member.environmentRoles },
            workspaceAccess: member.role === 'external' ? 'external' : 'internal',
          })
        else if (
          member.status === 'active' &&
          member.role !== 'project_admin' &&
          !member.canAdjustChat
        )
          fail(409, 'PROJECT_DEFAULT_ASSISTANT_REQUIRED', '受限成员需要先分配有效默认助手')

        const current = members(project),
          previous = current.find((entry) => entry.userId === member.userId)
        revision(previous?.revision ?? 0, value.expectedRevision)
        if (
          previous?.role === 'project_admin' &&
          previous.status === 'active' &&
          (member.role !== 'project_admin' || member.status !== 'active') &&
          !current.some(
            (entry) =>
              entry.userId !== member.userId &&
              entry.role === 'project_admin' &&
              entry.status === 'active' &&
              seed.users.some(
                (user) =>
                  user.id === entry.userId &&
                  (user.status === undefined || user.status === 'active'),
              ),
          )
        )
          fail(409, 'PROJECT_LAST_ADMIN', '请先分配另一位项目管理员')
        writeMember(project, member, (previous?.revision ?? 0) + 1)
        return members(project).find((entry) => entry.userId === member.userId)!
      })
    },
    close() {
      if (!closed) {
        closed = true
        database.close()
      }
    },
  }
}
export type ProjectDirectory = ReturnType<typeof createProjectDirectory>
