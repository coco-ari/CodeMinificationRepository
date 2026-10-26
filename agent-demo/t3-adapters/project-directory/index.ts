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
type Catalog = { users: User[]; projects: AutoOpsProject[]; agents: AutoOpsAgent[] }
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
    db.prepare('SELECT * FROM directory_projects WHERE id=?').get(project) ??
    fail(404, 'PROJECT_NOT_FOUND', '项目不存在或无权访问')
  function members(project: string): C.DirectoryMember[] {
    return db
      .prepare('SELECT * FROM directory_members WHERE project_id=? ORDER BY user_id')
      .all(project)
      .map((row) => {
        const user = seed.users.find((user) => user.id === row.user_id)
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
          'SELECT id,name,revision FROM directory_environments WHERE project_id=? ORDER BY rowid',
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
        db.prepare('INSERT INTO directory_projects VALUES(?,?,?,1,?,?)').run(
          project.id,
          project.name,
          '',
          'u-admin',
          at,
        )
        for (const env of project.environments)
          db.prepare('INSERT INTO directory_environments VALUES(?,?,?,1)').run(
            project.id,
            env.id,
            env.name,
          )
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
      return db
        .prepare('SELECT id FROM directory_projects ORDER BY rowid')
        .all()
        .map((row) => {
          const project = projectDetails(String(row.id)),
            existing = seed.projects.find((entry) => entry.id === project.id)
          const assignments = members(project.id)
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
      return seed.agents.map((agent) => ({
        ...agent,
        projectIds: ['a-project', 'a-report'].includes(agent.id)
          ? catalog.projects.map((project) => project.id)
          : [...agent.projectIds],
      }))
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
      const encoded = JSON.stringify(payload)
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
  return {
    catalog,
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
      if (user.kind === 'external') fail(403, 'PROJECT_CREATE_FORBIDDEN', '外部账号不能创建项目')
      if (value.expectedRevision !== 0) fail(400, 'PROJECT_INPUT_INVALID', '新项目修订必须为零')
      const previous = db
        .prepare('SELECT project_id FROM directory_receipts WHERE request_id=?')
        .get(value.requestId)
      const id = previous ? String(previous.project_id) : randomUUID()
      if (previous) permitted(actor, id)
      return command(actor, id, 'project.create', value.requestId, value, () => {
        db.prepare('INSERT INTO directory_projects VALUES(?,?,?,1,?,?)').run(
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
                  .prepare('SELECT * FROM directory_environments WHERE project_id=? AND id=?')
                  .get(project, decode(C.DirectoryId, environment))
          if (environment !== null && !existing)
            fail(404, 'ENVIRONMENT_NOT_FOUND', '环境不存在或不属于当前项目')
          revision(existing ? Number(existing.revision) : 0, value.expectedRevision)
          const id = environment ?? randomUUID(),
            next = Number(existing?.revision ?? 0) + 1
          db.prepare(
            'INSERT INTO directory_environments VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET name=excluded.name,revision=excluded.revision',
          ).run(project, id, value.value.name, next)
          return { id, name: value.value.name, revision: next }
        },
      )
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
            .prepare('SELECT id FROM directory_environments WHERE project_id=? AND id=?')
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
