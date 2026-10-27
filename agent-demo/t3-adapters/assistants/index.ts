// @effect-diagnostics nodeBuiltinImport:off -- 助手模块复用已验证的同步 SQLite 基础设施。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import * as S from 'effect/Schema'
import * as DateTime from 'effect/DateTime'
import * as C from '../../../autoops/contracts/assistants.ts'
import * as R from '../../../autoops/contracts/project-management-receipts.ts'
import { DirectoryId } from '../../../autoops/contracts/project-directory.ts'
import type { ProjectMembership } from '../../../autoops/contracts/runtime.ts'
import type { CustomerRegistry } from '../customer-registry.mjs'
import { openDatabase } from '../../../autoops/server/platform/database.ts'
import { migrations } from './schema.ts'
import { SharedExecutionScope } from '../../../autoops/contracts/shared-execution.ts'
import type { SharedProfileVerifier } from '../shared-profile-approvals.ts'
import { validateRoleDefault, validateSharedAllocationConfiguration } from './allocation-policy.ts'
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
  verifySharedProfile?: SharedProfileVerifier
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
    if (!self) {
      const target = item.configuration.executionBinding
      if (target.kind !== 'customer' || !options.verifySharedProfile)
        return fail(403,'CUSTOMER_SHARED_ISOLATION_UNVERIFIED','此运行器尚未通过跨用户或跨项目执行隔离验证')
      options.verifySharedProfile({providerId:item.providedBy.id,sourceProjectId:item.providedBy.sourceProjectId,
        target,profile:providerRegistry().getCapabilities(item.providedBy.id,target)?.sharedProfile})
    }
    if (self && member.role === 'project_admin') return
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
    executionGrant(threadId: string, runId: string): SharedExecutionScope | undefined {
      const row = db.prepare('SELECT value_json FROM assistant_execution_grants WHERE thread_id=? AND run_id=?').get(threadId,runId)
      return row ? this.requireExecutionScope(decode(SharedExecutionScope,JSON.parse(String(row.value_json)))) : undefined
    },
    executionScope(actor: string, project: string, input: C.AssistantSelection, context: {threadId:string;runId:string}): SharedExecutionScope | undefined {
      const selected = this.validateSelection(actor,project,input,true)
      const item = preset(project,selected.assistantId), provider = item.providedBy
      if (!provider || (provider.id === actor && provider.sourceProjectId === project && !selected.configuration.customerProfile)) return undefined
      const target = selected.configuration.executionBinding
      if (target.kind !== 'customer' || !options.verifySharedProfile)
        return fail(403,'CUSTOMER_SHARED_ISOLATION_UNVERIFIED','此来源尚未通过共享执行验证')
      const capabilities = providerRegistry().getCapabilities(provider.id,target)
      const profile = options.verifySharedProfile({providerId:provider.id,sourceProjectId:provider.sourceProjectId,
        target,profile:capabilities?.sharedProfile})
      const member = membership(actor,project), share = shareFor(item.id,project),self=provider.id===actor&&provider.sourceProjectId===project
      const approval = db.prepare(
        "SELECT target_kind,target_id,allocation_revision,preset_revision,share_revision,source_json FROM assistant_allocation_sources WHERE project_id=? AND assistant_id=? AND ((target_kind='member' AND target_id=?) OR (target_kind='role' AND target_id=?)) ORDER BY target_kind",
      ).all(project,item.id,actor,member.role).find(value =>
        allocation(project,String(value.target_kind),String(value.target_id))?.revision === Number(value.allocation_revision) &&
        allocation(project,String(value.target_kind),String(value.target_id))?.assistantIds.includes(item.id) &&
        Number(value.preset_revision) === selected.presetRevision && Number(value.share_revision) === share?.revision &&
        value.source_json === stable(target))
      if ((!self&&(!approval||!share?.enabled)) || !capabilities)
        return fail(403,'ASSISTANT_PROVIDER_APPROVAL_REQUIRED','当前共享及分配不允许本次执行')
      const value = {
        actorId:actor,providerId:provider.id,projectId:project,sourceProjectId:provider.sourceProjectId,
        ...context,assistantId:item.id,presetRevision:selected.presetRevision,shareRevision:self?0:share!.revision,
        allocation:self?{kind:'self',id:actor,revision:selected.presetRevision}:{kind:approval!.target_kind,id:approval!.target_id,revision:Number(approval!.allocation_revision)},
        capabilityRevision:capabilities.revision,profile,target,model:selected.configuration.model,
        skillIds:selected.configuration.skillIds,
      }
      const scope = decode(SharedExecutionScope,{...value,grantId:`shared-${createHash('sha256').update(stable(value)).digest('hex')}`})
      // 哈希只用于稳定标识；已签发事实必须由中心保存，设备不能自行构造新任务范围。
      return transaction.run(() => {
        const previous = db.prepare('SELECT value_json FROM assistant_execution_grants WHERE thread_id=? AND run_id=?').get(context.threadId,context.runId)
        if (previous) {
          const stored = decode(SharedExecutionScope,JSON.parse(String(previous.value_json)))
          if (stable(stored) !== stable(scope))
            return fail(409,'CUSTOMER_SHARED_SCOPE_FIXED','原任务已固定运行范围，不能改用最新配置')
          return stored
        }
        db.prepare('INSERT INTO assistant_execution_grants VALUES(?,?,?,?,?,?)').run(scope.grantId,scope.threadId,scope.runId,scope.actorId,stable(scope),DateTime.formatIso(DateTime.nowUnsafe()))
        return scope
      })
    },
    requireExecutionScope(input: SharedExecutionScope): SharedExecutionScope {
      const original = decode(SharedExecutionScope,input)
      const issued = db.prepare('SELECT value_json FROM assistant_execution_grants WHERE grant_id=?').get(original.grantId)
      if (!issued || String(issued.value_json) !== stable(original))
        return fail(403,'CUSTOMER_SHARED_SCOPE_UNISSUED','此执行范围未经中心签发，不能执行')
      const row = db.prepare('SELECT value_json FROM assistant_versions WHERE assistant_id=? AND revision=?').get(original.assistantId,original.presetRevision)
      if (!row) return fail(403,'CUSTOMER_SHARED_SCOPE_REVOKED','原执行范围已失效')
      const details = decode(C.AssistantDetails,JSON.parse(String(row.value_json)))
      let current:SharedExecutionScope|undefined
      try {
        current = this.executionScope(original.actorId,original.projectId,{
          assistantId:original.assistantId,presetRevision:original.presetRevision,
          configuration:{...details.configuration,model:original.model,skillIds:original.skillIds},
        },{threadId:original.threadId,runId:original.runId})
      } catch(error) {
        // 设备核对已签发原许可时，当前授权消失统一拒绝；不能被解释成可改参数的新配置冲突。
        if(error&&typeof error==='object'&&'status' in error&&typeof error.status==='number'&&error.status>=400&&error.status<500)
          return fail(403,'CUSTOMER_SHARED_SCOPE_REVOKED','本次固定共享范围已失效，请核对原任务及收据')
        throw error
      }
      if (!current || stable(current) !== stable(original))
        return fail(403,'CUSTOMER_SHARED_SCOPE_REVOKED','本次固定共享范围已变化，不能改用最新配置执行')
      return current
    },
    /** 读取当前合法目录供修正失效参数，不生成执行许可，也不继承管理者权限。 */
    readRuntimeConfiguration(actor:string,project:string,input:unknown) {
      const selection=decode(C.AssistantSelection,input),member=membership(actor,project),allowed=applicable(actor,project,member)
      const item=all(project).find(item=>item.id===selection.assistantId&&visible(actor,project,item)&&(member.role==='project_admin'||allowed.ids.has(item.id)))
      if(!item)return fail(403,'ASSISTANT_NOT_ASSIGNED','当前成员未获分配此助手')
      if(!item.enabled)return fail(409,'ASSISTANT_DISABLED','助手已停用，请联系项目管理员')
      if(item.revision!==selection.presetRevision)return fail(409,'ASSISTANT_PRESET_CHANGED','助手预设已更新，请重新载入')
      providerAdmission(actor,project,member,item,selection.presetRevision)
      const configuration=selection.configuration,original=item.configuration
      if(stable(configuration.executionBinding)!==stable(original.executionBinding)||stable(configuration.customerProfile)!==stable(original.customerProfile)||configuration.agentId!==original.agentId)
        return fail(403,'ASSISTANT_SOURCE_FIXED','不能改变助手的运行来源或业务身份')
      if(!adjustable(member)&&stable(configuration)!==stable(original))
        return fail(403,'ASSISTANT_PARAMETERS_FIXED','当前成员只能使用已分配预设的参数')
      if(configuration.executionBinding.kind!=='customer'||configuration.agentId!=='a-project'||configuration.visibility!=='private')
        return fail(403,'CUSTOMER_CONTEXT_UNSUPPORTED','此目录只支持当前助手的私有客户来源')
      const source=providerRegistry().sourceOwner(configuration.executionBinding)
      if((source.ownerId!==actor||source.projectId!==project)&&member.workspaceAccess!=='internal')
        return fail(403,'CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED','此隔离来源尚未支持外部资料范围')
      try {options.validate(actor,project,configuration,member);return {selection,available:true as boolean}}
      catch(error){return {selection,available:false as boolean,reason:reason(error)}}
    },
    requireProviderAccess(actor: string, id?: string) {
      if (id !== undefined) ownedPreset(actor, id)
      else requireProvider(actor)
    },
    projectReceipt(
      actor: string,
      project: string,
      requestId: string,
    ): R.ProjectAssistantRequestReceipt | null {
      if (closed) fail(503, 'ASSISTANTS_CLOSED', '助手目录已停止')
      decode(DirectoryId, actor)
      decode(DirectoryId, project)
      decode(DirectoryId, requestId)
      const row = db
        .prepare(
          'SELECT * FROM assistant_receipts WHERE request_id=? AND actor_id=? AND project_id=?',
        )
        .get(requestId, actor, project)
      if (!row || !/^(?:preset\.save:|allocation\.save:)/.test(String(row.operation))) return null
      let available = true
      try {
        manage(actor, project)
      } catch (error) {
        const status = (error as { status?: number }).status
        if (status !== 403 && status !== 404) throw error
        available = false
      }
      try {
        const operation = String(row.operation)
        const encoded = String(row.payload)
        const payload = JSON.parse(encoded)
        if (
          payload.requestId !== requestId ||
          R.projectAssistantReceiptIntent(operation, payload) !== encoded
        )
          throw new Error('invalid intent')
        const isPreset = operation.startsWith('preset.save:')
        const result = isPreset
          ? S.decodeUnknownSync(R.ProjectAssistantPreset, { onExcessProperty: 'error' })(
              JSON.parse(String(row.result)),
            )
          : S.decodeUnknownSync(R.ProjectAssistantAllocation, { onExcessProperty: 'error' })(
              JSON.parse(String(row.result)),
            )
        if (result.revision !== payload.expectedRevision + 1) throw new Error('invalid revision')
        if (isPreset) {
          const preset = result as R.ProjectAssistantRequestReceipt['result'] & {
            id: string
            projectId: string
          }
          if (
            preset.projectId !== project ||
            (operation !== 'preset.save:new' && preset.id !== operation.slice('preset.save:'.length))
          )
            throw new Error('invalid preset')
        } else if (operation !== `allocation.save:${payload.target.kind}:${payload.target.id}`)
          throw new Error('invalid target')
        return S.decodeUnknownSync(R.ProjectAssistantRequestReceipt, { onExcessProperty: 'error' })({
          state: 'completed',
          requestId,
          actorId: actor,
          projectId: project,
          operation,
          saved: true,
          available,
          createdAt: String(row.created_at),
          publicIntent: {
            algorithm: 'sha256',
            digest: createHash('sha256').update(encoded).digest('hex'),
          },
          ...(available ? { result } : {}),
        })
      } catch {
        return fail(503, 'ASSISTANT_RECEIPT_INVALID', '原助手收据无法核对，请保留原请求稍后恢复')
      }
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
      return { items, sources: providerRegistry().listSources(actor).map(source=>{
        try {
          if(!options.verifySharedProfile)return fail(403,'CUSTOMER_SHARED_ISOLATION_UNVERIFIED','此来源尚未取得隔离验证许可')
          options.verifySharedProfile({providerId:actor,sourceProjectId:source.sourceProjectId,target:source.executionBinding,profile:source.capabilities?.sharedProfile})
          providerRegistry().validateTarget(actor,source.sourceProjectId,source.executionBinding,{requireOnline:true})
          return {...source,sharedProfileAvailable:true}
        } catch(error){return {...source,sharedProfileAvailable:false,sharedProfileReason:reason(error)}}
      }) }
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
            value.value.configuration.visibility !== 'private'
          )
            fail(403, 'CUSTOMER_CONTEXT_UNSUPPORTED', '此运行来源尚未支持平台资料、环境及共享会话')
          if((value.value.configuration.environmentId!==null||value.value.configuration.workspaceType!==null)&&source.capabilities?.platformToolsVersion!==1)
            fail(403,'CUSTOMER_CONTEXT_UNSUPPORTED','所选运行器尚未接入平台只读工具桥')
          if (
            new Set(value.value.configuration.skillIds).size !==
            value.value.configuration.skillIds.length
          )
            fail(400, 'ASSISTANT_SKILLS_DUPLICATE', '技能不能重复选择')
          if (value.value.enabled || value.value.configuration.customerProfile!==undefined)
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
            let assignmentReason: { code: string; message: string } | undefined
            try {
              if (!item.enabled) fail(409, 'ASSISTANT_DISABLED', '助手已停用，请联系提供者')
              const self =
                item.providedBy.id === actor && item.providedBy.sourceProjectId === project
              if (!self) {
                if (!shareFor(item.id, project)?.enabled)
                  fail(403, 'ASSISTANT_PROVIDER_SHARE_REQUIRED', '提供者尚未向此项目共享该助手')
                const profile = source.capabilities?.sharedProfile
                if (!options.verifySharedProfile)
                  return fail(
                    403,
                    'CUSTOMER_SHARED_ISOLATION_UNVERIFIED',
                    '此运行器尚未取得实际隔离验证许可',
                  )
                options.verifySharedProfile({
                  providerId: item.providedBy.id,
                  sourceProjectId: item.providedBy.sourceProjectId,
                  target: binding,
                  profile,
                })
                providerRegistry().validateTarget(
                  item.providedBy.id,
                  item.providedBy.sourceProjectId,
                  binding,
                  { requireOnline: true },
                )
                validateSharedAllocationConfiguration(item.configuration, profile, source.capabilities?.platformToolsVersion)
              }
              options.validate(actor, project, item.configuration, membership(actor, project))
            } catch (error) {
              assignmentReason = reason(error)
            }
            const candidate = {
              preset: item,
              source,
              share: shareFor(item.id, project),
              assignable: assignmentReason === undefined,
              ...(assignmentReason ? { assignmentReason } : {}),
            }
            try {
              available(actor, project, membership(actor, project), item)
              return { ...candidate, available: true }
            } catch (error) {
              return {
                ...candidate,
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
          options.validateTarget(project, value.target)
          const previous = allocation(project, value.target.kind, value.target.id)
          checkRevision(previous?.revision ?? 0, value.expectedRevision)
          for (const id of value.assistantIds) {
            const item = preset(project, id)
            if(item.configuration.executionBinding.kind==='customer') {
              if(value.target.kind==='role'&&value.target.id==='external')
                fail(403,'CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED','此隔离来源尚未支持外部资料范围，不能分配给外部角色')
              if(value.target.kind==='member'&&membership(value.target.id,project).workspaceAccess==='external') {
                const source=providerRegistry().sourceOwner(item.configuration.executionBinding)
                if(source.ownerId!==value.target.id||source.projectId!==project||item.configuration.customerProfile!==undefined)
                  fail(403,'CUSTOMER_SHARED_EXTERNAL_UNSUPPORTED','此隔离来源尚未支持外部资料范围，不能分配给外部成员')
              }
            }
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
          if (value.defaultAssistantId !== null) {
            const item = preset(project, value.defaultAssistantId)
            if (value.target.kind === 'member') {
              // 新分配事实在同一事务中可见；任何失败连来源确认、审计及收据一起回滚。
              available(value.target.id, project, membership(value.target.id, project), item)
            } else {
              if (!item.enabled) fail(409, 'ASSISTANT_DISABLED', '已停用助手不能设为默认')
              validateRoleDefault(value.target.id, item.configuration)
              if (item.providedBy) {
                const target = item.configuration.executionBinding
                if (target.kind !== 'customer' || !options.verifySharedProfile)
                  return fail(
                    403,
                    'CUSTOMER_SHARED_ISOLATION_UNVERIFIED',
                    '此运行器尚未取得实际隔离验证许可',
                  )
                const capabilities = providerRegistry().getCapabilities(item.providedBy.id, target), profile = capabilities?.sharedProfile
                options.verifySharedProfile({
                  providerId: item.providedBy.id,
                  sourceProjectId: item.providedBy.sourceProjectId,
                  target,
                  profile,
                })
                providerRegistry().validateTarget(
                  item.providedBy.id,
                  item.providedBy.sourceProjectId,
                  target,
                  { requireOnline: true },
                )
                validateSharedAllocationConfiguration(item.configuration, profile, capabilities?.platformToolsVersion)
              }
              // 角色模板只验证合法配置和固定外部边界，不借配置者环境权给未来成员扩权。
              options.validate(actor, project, item.configuration, membership(actor, project))
            }
          }
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
        configuration.agentId !== original.configuration.agentId ||
        stable(configuration.customerProfile)!==stable(original.configuration.customerProfile)
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
