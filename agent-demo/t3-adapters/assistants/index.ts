// @effect-diagnostics nodeBuiltinImport:off -- 助手模块复用已验证的同步 SQLite 基础设施。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as S from 'effect/Schema'
import * as DateTime from 'effect/DateTime'
import * as C from '../../../autoops/contracts/assistants.ts'
import { DirectoryId } from '../../../autoops/contracts/project-directory.ts'
import type { ProjectMembership } from '../../../autoops/contracts/runtime.ts'
import type { CustomerRegistry } from '../customer-registry.mjs'
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
  providers?: { registry(): CustomerRegistry; displayName(actor: string): string }
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
  const providerRegistry = () => {
    if (closed) return fail(503, 'ASSISTANTS_CLOSED', '助手目录已停止')
    return (
      options.providers?.registry() ??
      fail(503, 'ASSISTANT_PROVIDERS_UNAVAILABLE', '提供者助手尚未完整装配')
    )
  }
  const requireProvider = (actor: string) => {
    providerRegistry().listDevices(actor)
  }
  const presetRow = (id: string) => {
    const row = db.prepare('SELECT * FROM assistant_presets WHERE id=?').get(id)
    if (!row) return fail(404, 'ASSISTANT_NOT_FOUND', '助手不存在或不属于当前项目')
    return row
  }
  const shareFor = (id: string, project: string): C.ProvidedAssistantShare | null => {
    const row = db
      .prepare(
        'SELECT enabled,revision FROM assistant_provider_shares WHERE assistant_id=? AND project_id=?',
      )
      .get(id, project)
    return row
      ? {
          assistantId: id,
          projectId: project,
          enabled: Boolean(row.enabled),
          revision: Number(row.revision),
        }
      : null
  }
  const presetFrom = (row: Record<string, unknown>, project: string): C.AssistantPreset => {
    const value = decode(C.AssistantDetails, JSON.parse(String(row.value_json)))
    const source = value.configuration.executionBinding
    const provider = source.kind === 'customer' ? providerRegistry().sourceOwner(source) : undefined
    return {
      ...value,
      id: String(row.id),
      projectId: project,
      revision: Number(row.revision),
      createdBy: String(row.created_by),
      updatedAt: String(row.updated_at),
      ...(provider
        ? {
            providedBy: {
              id: provider.ownerId,
              name: options.providers?.displayName(provider.ownerId) ?? '提供者',
              sourceProjectId: provider.projectId,
            },
          }
        : {}),
    }
  }
  const preset = (project: string, id: string): C.AssistantPreset => {
    const row = presetRow(id)
    const item = presetFrom(row, project)
    if (row.project_id !== project && !item.providedBy)
      return fail(404, 'ASSISTANT_NOT_FOUND', '助手不存在或不属于当前项目')
    return item
  }
  const all = (project: string) =>
    db
      .prepare(
        'SELECT DISTINCT p.* FROM assistant_presets p LEFT JOIN assistant_provider_shares s ON s.assistant_id=p.id AND s.project_id=? AND s.enabled=1 WHERE p.project_id=? OR s.assistant_id IS NOT NULL ORDER BY p.rowid',
      )
      .all(project, project)
      .map((row) => presetFrom(row, project))
  const visible = (actor: string, project: string, item: C.AssistantPreset) =>
    !item.providedBy ||
    (item.providedBy.id === actor && item.providedBy.sourceProjectId === project) ||
    shareFor(item.id, project)?.enabled === true
  const ownedPreset = (actor: string, id: string) => {
    requireProvider(actor)
    const row = db
      .prepare('SELECT * FROM assistant_presets WHERE id=?')
      .get(decode(DirectoryId, id))
    if (!row) return fail(404, 'ASSISTANT_PROVIDER_NOT_FOUND', '本人提供的助手不存在')
    const item = presetFrom(row, String(row.project_id))
    if (item.providedBy?.id !== actor || (row.provider_id !== actor && row.created_by !== actor))
      return fail(404, 'ASSISTANT_PROVIDER_NOT_FOUND', '本人提供的助手不存在')
    return item
  }
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
  const providerAdmission = (
    actor: string,
    project: string,
    member: ProjectMembership,
    item: C.AssistantPreset,
    revision = item.revision,
  ) => {
    if (!item.providedBy) return
    const self = item.providedBy.id === actor && item.providedBy.sourceProjectId === project
    const share = shareFor(item.id, project)
    if (!self && !share?.enabled)
      return fail(403, 'ASSISTANT_PROVIDER_SHARE_REQUIRED', '提供者尚未向此项目共享该助手')
    if (!self)
      return fail(
        403,
        'CUSTOMER_SHARED_ISOLATION_UNVERIFIED',
        '此运行器尚未通过跨用户或跨项目执行隔离验证',
      )
    if (member.role === 'project_admin') return
    const approvals = db
      .prepare(
        "SELECT target_kind,target_id,preset_revision,share_revision,source_json FROM assistant_allocation_sources WHERE project_id=? AND assistant_id=? AND ((target_kind='member' AND target_id=?) OR (target_kind='role' AND target_id=?))",
      )
      .all(project, item.id, actor, member.role)
    const allowed = applicable(actor, project, member).ids.has(item.id)
    if (
      !allowed ||
      !approvals.some(
        (value) =>
          allocation(
            project,
            String(value.target_kind),
            String(value.target_id),
          )?.assistantIds.includes(item.id) &&
          value.source_json === stable(item.configuration.executionBinding) &&
          Number(value.preset_revision) === revision &&
          (value.share_revision === null ||
            (share?.enabled && Number(value.share_revision) === share.revision)),
      )
    )
      return fail(
        403,
        'ASSISTANT_PROVIDER_APPROVAL_REQUIRED',
        '提供者预设已更新，请由项目管理员重新确认分配',
      )
  }
  const available = (
    actor: string,
    project: string,
    member: ProjectMembership,
    item: C.AssistantPreset,
  ) => {
    if (!item.enabled) fail(409, 'ASSISTANT_DISABLED', '助手已停用，请联系项目管理员')
    providerAdmission(actor, project, member, item)
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
      .filter(
        (item) =>
          visible(actor, project, item) &&
          (member.role === 'project_admin' || allowed.ids.has(item.id)),
      )
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
    authority: () => void = () => manage(actor, project),
  ): T =>
    transaction.run(() => {
      authority()
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
  const writePreset = (
    actor: string,
    project: string,
    id: string | null,
    value: C.AssistantDetails,
    previous: C.AssistantPreset | undefined,
    providerId: string | null,
  ) => {
    const nextId = id ?? randomUUID(),
      at = DateTime.formatIso(DateTime.nowUnsafe())
    db.prepare(
      'INSERT INTO assistant_presets(id,project_id,value_json,revision,created_by,updated_at,provider_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at,provider_id=excluded.provider_id',
    ).run(
      nextId,
      project,
      JSON.stringify(value),
      (previous?.revision ?? 0) + 1,
      previous?.createdBy ?? actor,
      at,
      providerId,
    )
    db.prepare('INSERT INTO assistant_versions VALUES(?,?,?,?)').run(
      nextId,
      (previous?.revision ?? 0) + 1,
      JSON.stringify(value),
      at,
    )
    return preset(project, nextId)
  }
  const fixedSource = (previous: C.AssistantPreset | undefined, value: C.AssistantDetails) => {
    if (
      previous &&
      stable(previous.configuration.executionBinding) !==
        stable(value.configuration.executionBinding)
    )
      fail(403, 'ASSISTANT_SOURCE_FIXED', '运行来源身份不能修改，请创建新的助手')
  }
  const shares = (id: string): C.ProvidedAssistantShare[] =>
    db
      .prepare(
        'SELECT project_id FROM assistant_provider_shares WHERE assistant_id=? ORDER BY project_id',
      )
      .all(id)
      .map((row) => shareFor(id, String(row.project_id))!)
  return {
    catalog,
    requireProviderAccess(actor: string, id?: string) {
      if (id !== undefined) ownedPreset(actor, id)
      else requireProvider(actor)
    },
    providedReceipt(actor: string, requestId: string): C.ProvidedAssistantReceipt {
      requireProvider(actor)
      const row = db
        .prepare('SELECT * FROM assistant_receipts WHERE request_id=?')
        .get(decode(DirectoryId, requestId))
      if (!row || row.actor_id !== actor || !String(row.operation).startsWith('provider.'))
        return fail(
          404,
          'ASSISTANT_PROVIDER_RECEIPT_NOT_FOUND',
          '尚未找到本人的已保存收据，请继续核对原请求',
        )
      return {
        requestId,
        operation: String(row.operation),
        projectId: String(row.project_id),
        payload: JSON.parse(String(row.payload)),
        result: JSON.parse(String(row.result)) as C.ProvidedAssistantReceipt['result'],
      }
    },
    providedSettings(actor: string): C.ProvidedAssistantSettings {
      requireProvider(actor)
      const items = db
        .prepare(
          'SELECT * FROM assistant_presets WHERE provider_id=? OR created_by=? ORDER BY rowid',
        )
        .all(actor, actor)
        .flatMap((row) => {
          const value = decode(C.AssistantDetails, JSON.parse(String(row.value_json)))
          if (value.configuration.executionBinding.kind !== 'customer') return []
          const item = presetFrom(row, String(row.project_id))
          return item.providedBy?.id === actor ? [{ preset: item, shares: shares(item.id) }] : []
        })
      return { items, sources: providerRegistry().listSources(actor) }
    },
    saveProvided(actor: string, id: string | null, input: unknown): C.AssistantPreset {
      requireProvider(actor)
      const value = decode(C.SaveAssistantCommand, input)
      const previous = id === null ? undefined : ownedPreset(actor, id)
      fixedSource(previous, value.value)
      const target = value.value.configuration.executionBinding
      if (target.kind !== 'customer')
        return fail(
          400,
          'ASSISTANT_PROVIDER_SOURCE_REQUIRED',
          '本人提供的助手必须使用本人已登记运行来源',
        )
      const source = providerRegistry().describeSource(actor, target)
      return command(
        actor,
        source.sourceProjectId,
        `provider.preset.save:${id ?? 'new'}`,
        value.requestId,
        value,
        id ?? 'new',
        () => {
          if (id === null) {
            membership(actor, source.sourceProjectId)
            if (source.workspaceStatus !== 'active' || source.deviceStatus === 'revoked')
              fail(
                409,
                'ASSISTANT_PROVIDER_SOURCE_UNAVAILABLE',
                '登记来源已撤销，请选择当前有效来源',
              )
          }
          if (
            value.value.configuration.agentId !== 'a-project' ||
            value.value.configuration.environmentId !== null ||
            value.value.configuration.workspaceType !== null ||
            value.value.configuration.visibility !== 'private'
          )
            fail(403, 'CUSTOMER_CONTEXT_UNSUPPORTED', '此运行来源尚未支持平台资料、环境及共享会话')
          if (
            new Set(value.value.configuration.skillIds).size !==
            value.value.configuration.skillIds.length
          )
            fail(400, 'ASSISTANT_SKILLS_DUPLICATE', '技能不能重复选择')
          if (value.value.enabled)
            options.validate(
              actor,
              source.sourceProjectId,
              value.value.configuration,
              membership(actor, source.sourceProjectId),
            )
          checkRevision(previous?.revision ?? 0, value.expectedRevision)
          return writePreset(actor, source.sourceProjectId, id, value.value, previous, actor)
        },
        () => requireProvider(actor),
      )
    },
    shareProvided(
      actor: string,
      id: string,
      project: string,
      input: unknown,
    ): C.ProvidedAssistantShare {
      const item = ownedPreset(actor, id),
        targetProject = decode(DirectoryId, project),
        value = decode(C.ShareProvidedAssistantCommand, input)
      return command(
        actor,
        targetProject,
        `provider.share:${id}`,
        value.requestId,
        value,
        id,
        () => {
          const previous = shareFor(id, targetProject)
          checkRevision(previous?.revision ?? 0, value.expectedRevision)
          if (!value.enabled && !previous)
            fail(404, 'ASSISTANT_PROVIDER_SHARE_NOT_FOUND', '共享记录不存在，无需撤回')
          if (value.enabled) {
            membership(actor, targetProject)
            const target = item.configuration.executionBinding
            if (target.kind !== 'customer')
              return fail(400, 'ASSISTANT_PROVIDER_SOURCE_REQUIRED', '请选择本人运行来源')
            const source = providerRegistry().describeSource(actor, target)
            if (source.deviceStatus !== 'active' || source.workspaceStatus !== 'active')
              fail(
                409,
                'ASSISTANT_PROVIDER_SOURCE_UNAVAILABLE',
                '运行来源已停用或撤销，不能新增共享',
              )
            if (!item.enabled) fail(409, 'ASSISTANT_DISABLED', '助手已停用，不能新增共享')
          }
          db.prepare(
            'INSERT INTO assistant_provider_shares VALUES(?,?,?,?,?,?) ON CONFLICT(assistant_id,project_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,source_json=excluded.source_json,updated_at=excluded.updated_at',
          ).run(
            id,
            targetProject,
            Number(value.enabled),
            (previous?.revision ?? 0) + 1,
            stable(item.configuration.executionBinding),
            DateTime.formatIso(DateTime.nowUnsafe()),
          )
          return shareFor(id, targetProject)!
        },
        () => requireProvider(actor),
      )
    },
    providedForProject(actor: string, project: string): C.ProjectProvidedAssistants {
      manage(actor, project)
      return {
        items: all(project)
          .filter((item) => item.providedBy && visible(actor, project, item))
          .map((item) => {
            const binding = item.configuration.executionBinding
            if (binding.kind !== 'customer' || !item.providedBy)
              return fail(503, 'ASSISTANT_PROVIDER_SOURCE_REQUIRED', '运行来源状态不一致')
            let source: C.ProvidedAssistantSource
            try {
              source = providerRegistry().describeSource(item.providedBy.id, binding)
            } catch {
              return fail(
                503,
                'ASSISTANT_PROVIDER_SOURCE_UNAVAILABLE',
                '获共享运行来源暂不可核对，请恢复后重试',
              )
            }
            try {
              available(actor, project, membership(actor, project), item)
              return { preset: item, source, share: shareFor(item.id, project), available: true }
            } catch (error) {
              return {
                preset: item,
                source,
                share: shareFor(item.id, project),
                available: false,
                reason: reason(error),
              }
            }
          }),
      }
    },
    deletionReferences(project: string, environment?: string) {
      const presets = all(project).filter(
        (preset) =>
          preset.enabled &&
          (environment === undefined || preset.configuration.environmentId === environment),
      )
      const sharing =
        environment === undefined
          ? Number(
              db
                .prepare(
                  'SELECT COUNT(*) AS n FROM assistant_provider_shares WHERE project_id=? AND enabled=1',
                )
                .get(project)?.n ?? 0,
            )
          : 0
      return [
        ...(presets.length
          ? [
              {
                kind: 'assistant-presets',
                count: presets.length,
                message: '仍有启用的助手预设引用此范围',
              },
            ]
          : []),
        ...(sharing
          ? [
              {
                kind: 'assistant-provider-shares',
                count: sharing,
                message: '仍有提供者向此项目共享助手',
              },
            ]
          : []),
      ]
    },
    choices(actor: string, project: string) {
      manage(actor, project)
      if (!options.choices)
        return fail(503, 'ASSISTANT_CHOICES_UNAVAILABLE', '助手配置目录尚未就绪')
      return options.choices(actor, project)
    },
    settings(actor: string, project: string) {
      manage(actor, project)
      return {
        presets: all(project).filter((item) => visible(actor, project, item)),
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
          const previous = id === null ? undefined : preset(project, decode(DirectoryId, id))
          if (previous?.providedBy && previous.providedBy.id !== actor)
            fail(403, 'ASSISTANT_PROVIDER_MANAGEMENT_REQUIRED', '使用分配不包含提供者助手管理权')
          fixedSource(previous, value.value)
          if (value.value.configuration.executionBinding.kind === 'customer') {
            const source = providerRegistry().describeSource(
              actor,
              value.value.configuration.executionBinding,
            )
            if (source.sourceProjectId !== project)
              fail(
                403,
                'ASSISTANT_SOURCE_PROJECT_MISMATCH',
                '请在本人助手中管理原来源，并主动共享给目标项目',
              )
          }
          if (value.value.enabled)
            options.validate(actor, project, value.value.configuration, membership(actor, project))
          checkRevision(previous?.revision ?? 0, value.expectedRevision)
          return writePreset(
            actor,
            project,
            id,
            value.value,
            previous,
            value.value.configuration.executionBinding.kind === 'customer' ? actor : null,
          )
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
          for (const id of value.assistantIds) {
            const item = preset(project, id)
            if (!item.providedBy) continue
            const self =
              value.target.kind === 'member' &&
              value.target.id === item.providedBy.id &&
              project === item.providedBy.sourceProjectId
            const share = shareFor(id, project)
            const source = db
              .prepare(
                'SELECT source_json FROM assistant_provider_shares WHERE assistant_id=? AND project_id=?',
              )
              .get(id, project)
            if (
              !self &&
              (!share?.enabled ||
                source?.source_json !== stable(item.configuration.executionBinding))
            )
              fail(403, 'ASSISTANT_PROVIDER_SHARE_REQUIRED', '提供者尚未向此项目共享该助手')
            db.prepare('INSERT INTO assistant_allocation_sources VALUES(?,?,?,?,?,?,?,?)').run(
              project,
              value.target.kind,
              value.target.id,
              id,
              (previous?.revision ?? 0) + 1,
              item.revision,
              self ? null : share!.revision,
              stable(item.configuration.executionBinding),
            )
          }
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
      const item = state.items.find((item) => item.preset.id === selection.assistantId)
      if (!state.ready && !(accepted && adjustable(member)))
        if (
          accepted &&
          item?.preset.providedBy &&
          state.items.some(
            (value) =>
              value.preset.id === state.defaultAssistantId &&
              value.reason?.code === 'ASSISTANT_PROVIDER_APPROVAL_REQUIRED',
          )
        )
          providerAdmission(actor, project, member, item.preset, selection.presetRevision)
        else
          return fail(
            409,
            state.reason?.code ?? 'DEFAULT_ASSISTANT_REQUIRED',
            state.reason?.message ?? '项目管理员尚未配置有效默认助手',
          )
      if (!item) return fail(403, 'ASSISTANT_NOT_ASSIGNED', '当前成员未获分配此助手')
      if (!accepted && item.preset.revision !== selection.presetRevision)
        fail(409, 'ASSISTANT_PRESET_CHANGED', '助手预设已更新，请重新载入')
      if (!accepted) available(actor, project, member, item.preset)
      if (accepted) providerAdmission(actor, project, member, item.preset, selection.presetRevision)
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
