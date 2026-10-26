// @effect-diagnostics nodeBuiltinImport:off -- 助手模块复用已验证的同步 SQLite 基础设施。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as S from 'effect/Schema'
import * as DateTime from 'effect/DateTime'
import * as C from '../../../autoops/contracts/assistants.ts'
import { DirectoryId } from '../../../autoops/contracts/project-directory.ts'
import type { ProjectMembership } from '../../../autoops/contracts/runtime.ts'
import { openDatabase } from '../../../autoops/server/platform/database.ts'
import { migrations } from './schema.ts'
export { questionConfigurationPolicy, questionConfigurationChoices } from './policy.ts'
export { assertQuestionBinding, nativeQuestionModel } from './question.ts'

type Options = {
  dataDir: string
  membership(actor: string, project: string): ProjectMembership
  manage(actor: string, project: string): unknown
  /** 复用模型、技能和运行来源各自的当前能力；不复制凭据或设备状态。 */
  validate(
    actor: string,
    project: string,
    value: C.QuestionConfiguration,
    membership: ProjectMembership,
    accepted?: boolean,
  ): void
  validateTarget(project: string, target: C.AssistantTarget): void
  choices?: (actor: string, project: string) => C.AssistantChoices
}
const fail = (status: number, code: string, message: string): never => {
  throw Object.assign(new Error(message), { status, code })
}
const decode = <T extends S.ConstraintDecoder<unknown>>(schema: T, value: unknown): T['Type'] => {
  try {
    return S.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value)
  } catch {
    return fail(400, 'ASSISTANT_INPUT_INVALID', '助手字段、格式或长度无效')
  }
}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )
const reason = (error: unknown) => {
  const value = error as { code?: string; message?: string }
  return { code: value.code ?? 'ASSISTANT_UNAVAILABLE', message: value.message ?? '助手当前不可用' }
}
const adjustable = (member: ProjectMembership) =>
  member.role === 'project_admin' || member.canAdjustChat === true

export function createAssistantDirectory(options: Options) {
  mkdirSync(join(options.dataDir, 'assistants'), { recursive: true, mode: 0o700 })
  const database = openDatabase(join(options.dataDir, 'assistants/state.sqlite'), migrations)
  const { db, transaction } = database
  let closed = false
  const membership = (actor: string, project: string) => {
    if (closed) fail(503, 'ASSISTANTS_CLOSED', '助手目录已停止')
    return options.membership(actor, project)
  }
  const manage = (actor: string, project: string) => {
    membership(actor, project)
    options.manage(actor, project)
  }
  const preset = (project: string, id: string): C.AssistantPreset => {
    const row = db
      .prepare('SELECT * FROM assistant_presets WHERE id=? AND project_id=?')
      .get(id, project)
    if (!row) return fail(404, 'ASSISTANT_NOT_FOUND', '助手不存在或不属于当前项目')
    return {
      ...decode(C.AssistantDetails, JSON.parse(String(row.value_json))),
      id: String(row.id),
      projectId: String(row.project_id),
      revision: Number(row.revision),
      createdBy: String(row.created_by),
      updatedAt: String(row.updated_at),
    }
  }
  const all = (project: string) =>
    db
      .prepare('SELECT id FROM assistant_presets WHERE project_id=? ORDER BY rowid')
      .all(project)
      .map((row) => preset(project, String(row.id)))
  const allocation = (project: string, kind: string, id: string) => {
    const row = db
      .prepare(
        'SELECT * FROM assistant_allocations WHERE project_id=? AND target_kind=? AND target_id=?',
      )
      .get(project, kind, id)
    return row
      ? {
          assistantIds: JSON.parse(String(row.assistant_ids_json)) as string[],
          defaultAssistantId:
            row.default_assistant_id === null ? null : String(row.default_assistant_id),
          revision: Number(row.revision),
        }
      : undefined
  }
  const applicable = (actor: string, project: string, member: ProjectMembership) => {
    const own = allocation(project, 'member', actor),
      role = allocation(project, 'role', member.role)
    return {
      ids: new Set([...(role?.assistantIds ?? []), ...(own?.assistantIds ?? [])]),
      defaultId: own?.defaultAssistantId ?? role?.defaultAssistantId ?? null,
    }
  }
  const available = (
    actor: string,
    project: string,
    member: ProjectMembership,
    item: C.AssistantPreset,
  ) => {
    if (!item.enabled) fail(409, 'ASSISTANT_DISABLED', '助手已停用，请联系项目管理员')
    options.validate(actor, project, item.configuration, member)
  }
  function catalog(
    actor: string,
    project: string,
    override?: ProjectMembership,
  ): C.AssistantDirectory {
    const member = override ?? membership(actor, project),
      allowed = applicable(actor, project, member)
    const items = all(project)
      .filter((item) => member.role === 'project_admin' || allowed.ids.has(item.id))
      .map((item) => {
        try {
          available(actor, project, member, item)
          return { preset: item, available: true }
        } catch (error) {
          return { preset: item, available: false, reason: reason(error) }
        }
      })
    const canAdjust = adjustable(member)
    const validDefault = items.some(
      (item) => item.preset.id === allowed.defaultId && item.available,
    )
    return {
      items,
      defaultAssistantId: allowed.defaultId,
      canAdjust,
      ready: canAdjust ? items.some((item) => item.available) : validDefault,
      ...((canAdjust ? !items.some((item) => item.available) : !validDefault)
        ? {
            reason: {
              code: canAdjust ? 'ASSISTANT_REQUIRED' : 'DEFAULT_ASSISTANT_REQUIRED',
              message: canAdjust
                ? '尚无可用助手，请在项目管理中配置'
                : '项目管理员尚未配置有效默认助手',
            },
          }
        : {}),
    }
  }
  const command = <T>(
    actor: string,
    project: string,
    operation: string,
    request: string,
    payload: unknown,
    subject: string,
    execute: () => T,
  ): T =>
    transaction.run(() => {
      manage(actor, project)
      const encoded = stable(payload),
        row = db.prepare('SELECT * FROM assistant_receipts WHERE request_id=?').get(request)
      if (row) {
        if (
          row.actor_id !== actor ||
          row.project_id !== project ||
          row.operation !== operation ||
          row.payload !== encoded
        )
          fail(409, 'ASSISTANT_REQUEST_CONFLICT', '原请求已经用于其他操作或参数')
        return JSON.parse(String(row.result)) as T
      }
      const result = execute(),
        at = DateTime.formatIso(DateTime.nowUnsafe())
      db.prepare(
        'INSERT INTO assistant_audit(actor_id,project_id,operation,subject_id,created_at) VALUES(?,?,?,?,?)',
      ).run(actor, project, operation, subject, at)
      db.prepare('INSERT INTO assistant_receipts VALUES(?,?,?,?,?,?,?)').run(
        request,
        actor,
        project,
        operation,
        encoded,
        JSON.stringify(result),
        at,
      )
      return result
    })
  const checkRevision = (actual: number, expected: number) => {
    if (actual !== expected)
      fail(409, 'ASSISTANT_REVISION_CONFLICT', '助手配置已更新，请刷新后重试')
  }
  return {
    catalog,
    choices(actor: string, project: string) {
      manage(actor, project)
      if (!options.choices)
        return fail(503, 'ASSISTANT_CHOICES_UNAVAILABLE', '助手配置目录尚未就绪')
      return options.choices(actor, project)
    },
    settings(actor: string, project: string) {
      manage(actor, project)
      return {
        presets: all(project),
        allocations: db
          .prepare(
            'SELECT target_kind,target_id FROM assistant_allocations WHERE project_id=? ORDER BY target_kind,target_id',
          )
          .all(project)
          .map((row) => ({
            target: { kind: row.target_kind as 'member' | 'role', id: String(row.target_id) },
            ...allocation(project, String(row.target_kind), String(row.target_id))!,
          })),
      }
    },
    save(actor: string, project: string, id: string | null, input: unknown) {
      manage(actor, project)
      const value = decode(C.SaveAssistantCommand, input)
      if (
        new Set(value.value.configuration.skillIds).size !==
        value.value.configuration.skillIds.length
      )
        fail(400, 'ASSISTANT_SKILLS_DUPLICATE', '技能不能重复选择')
      return command(
        actor,
        project,
        `preset.save:${id ?? 'new'}`,
        value.requestId,
        value,
        id ?? 'new',
        () => {
          // 原请求先核对已保存收据；新写入才检查当下运行能力。
          if (value.value.enabled)
            options.validate(actor, project, value.value.configuration, membership(actor, project))
          const previous = id === null ? undefined : preset(project, decode(DirectoryId, id))
          checkRevision(previous?.revision ?? 0, value.expectedRevision)
          const nextId = id ?? randomUUID(),
            at = DateTime.formatIso(DateTime.nowUnsafe())
          db.prepare(
            'INSERT INTO assistant_presets VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at',
          ).run(
            nextId,
            project,
            JSON.stringify(value.value),
            (previous?.revision ?? 0) + 1,
            previous?.createdBy ?? actor,
            at,
          )
          db.prepare('INSERT INTO assistant_versions VALUES(?,?,?,?)').run(
            nextId,
            (previous?.revision ?? 0) + 1,
            JSON.stringify(value.value),
            at,
          )
          return preset(project, nextId)
        },
      )
    },
    assign(actor: string, project: string, input: unknown) {
      manage(actor, project)
      const value = decode(C.AssignAssistantCommand, input)
      options.validateTarget(project, value.target)
      if (
        new Set(value.assistantIds).size !== value.assistantIds.length ||
        (value.defaultAssistantId !== null &&
          !value.assistantIds.includes(value.defaultAssistantId))
      )
        fail(400, 'ASSISTANT_ALLOCATION_INVALID', '默认助手须属于所分配助手且不能重复')
      for (const id of value.assistantIds) preset(project, id)
      return command(
        actor,
        project,
        `allocation.save:${value.target.kind}:${value.target.id}`,
        value.requestId,
        value,
        value.target.id,
        () => {
          const previous = allocation(project, value.target.kind, value.target.id)
          checkRevision(previous?.revision ?? 0, value.expectedRevision)
          db.prepare(
            'INSERT INTO assistant_allocations VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,target_kind,target_id) DO UPDATE SET assistant_ids_json=excluded.assistant_ids_json,default_assistant_id=excluded.default_assistant_id,revision=excluded.revision',
          ).run(
            project,
            value.target.kind,
            value.target.id,
            JSON.stringify(value.assistantIds),
            value.defaultAssistantId,
            (previous?.revision ?? 0) + 1,
          )
          return allocation(project, value.target.kind, value.target.id)!
        },
      )
    },
    validateMember(project: string, actor: string, member: ProjectMembership) {
      if (member.status !== 'active' || adjustable(member)) return
      const state = catalog(actor, project, member)
      if (!state.ready)
        fail(
          409,
          'PROJECT_DEFAULT_ASSISTANT_REQUIRED',
          '受限成员需要先分配有效默认助手，且预设须符合新的资料和环境范围',
        )
    },
    instructions(actor: string, project: string, input: C.AssistantSelection): string {
      const selected = this.validateSelection(actor, project, input, true)
      const row = db
        .prepare('SELECT value_json FROM assistant_versions WHERE assistant_id=? AND revision=?')
        .get(selected.assistantId, selected.presetRevision)
      if (!row) return fail(409, 'ASSISTANT_PRESET_CHANGED', '原助手修订不存在')
      return decode(C.AssistantDetails, JSON.parse(String(row.value_json))).instructions
    },
    validateSelection(
      actor: string,
      project: string,
      input: unknown,
      accepted = false,
    ): C.AssistantSelection {
      const selection = decode(C.AssistantSelection, input)
      const member = membership(actor, project),
        state = catalog(actor, project)
      if (!state.ready && !(accepted && adjustable(member)))
        return fail(
          409,
          state.reason?.code ?? 'DEFAULT_ASSISTANT_REQUIRED',
          state.reason?.message ?? '项目管理员尚未配置有效默认助手',
        )
      const item = state.items.find((item) => item.preset.id === selection.assistantId)
      if (!item) return fail(403, 'ASSISTANT_NOT_ASSIGNED', '当前成员未获分配此助手')
      if (!accepted && item.preset.revision !== selection.presetRevision)
        fail(409, 'ASSISTANT_PRESET_CHANGED', '助手预设已更新，请重新载入')
      if (!accepted) available(actor, project, member, item.preset)
      if (!item.preset.enabled) fail(409, 'ASSISTANT_DISABLED', '助手已停用，请联系项目管理员')
      const version = db
        .prepare('SELECT value_json FROM assistant_versions WHERE assistant_id=? AND revision=?')
        .get(selection.assistantId, selection.presetRevision)
      if (!version)
        return fail(409, 'ASSISTANT_PRESET_CHANGED', '原预设修订不存在，请联系项目管理员')
      const original = decode(C.AssistantDetails, JSON.parse(String(version.value_json)))
      const configuration = decode(C.QuestionConfiguration, selection.configuration)
      if (
        stable(configuration.executionBinding) !==
          stable(original.configuration.executionBinding) ||
        configuration.agentId !== original.configuration.agentId
      )
        fail(403, 'ASSISTANT_SOURCE_FIXED', '不能改变助手的运行来源或业务身份')
      if (!adjustable(member) && stable(configuration) !== stable(original.configuration))
        fail(403, 'ASSISTANT_PARAMETERS_FIXED', '当前成员只能使用已分配预设的参数')
      options.validate(actor, project, configuration, member, accepted)
      return {
        assistantId: item.preset.id,
        presetRevision: selection.presetRevision,
        configuration,
      }
    },
    close() {
      if (!closed) {
        closed = true
        database.close()
      }
    },
  }
}

export type AssistantDirectoryService = ReturnType<typeof createAssistantDirectory>
