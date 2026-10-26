import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { decodeContract } from '../../autoops/contracts/index.ts'
import { SharedProfileCapability } from '../../autoops/contracts/shared-execution.ts'

// Device and authorization metadata only. Commands, runs and chat history remain in T3.
export class CustomerRegistryError extends Error {
  constructor(status, code, message) { super(message); this.name = 'CustomerRegistryError'; this.status = status; this.code = code }
}
const fail = (status, code, message) => { throw new CustomerRegistryError(status, code, message) }
const hash = (value) => createHash('sha256').update(value).digest('hex')
const text = (value, name, max = 160) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail(400, 'INVALID_CUSTOMER_METADATA', `${name}无效`)
  return value.trim()
}
const id = (value, name) => {
  const result = text(value, name, 160)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) fail(400, 'INVALID_CUSTOMER_ID', `${name}必须是登记标识，不能是文件路径`)
  return result
}
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(400, 'INVALID_CUSTOMER_METADATA', '客户登记字段无效；中心不接受目录路径或执行参数')
  return value
}
const revision = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'INVALID_WORKSPACE_REVISION', '工作区绑定版本无效')
  return value
}
export function normalizeExecutionBinding(value) {
  if (value === undefined || value === null) return { kind: 'platform' }
  if (value?.kind === 'platform') { object(value, ['kind']); return { kind: 'platform' } }
  object(value, ['kind', 'deviceId', 'registeredWorkspaceId', 'workspaceBindingRevision', 'runtimeId'])
  if (value.kind !== 'customer' || value.runtimeId !== 'codex') fail(400, 'INVALID_EXECUTION_BINDING', '执行目标或运行器无效')
  return { kind: 'customer', deviceId: id(value.deviceId, '设备ID'), registeredWorkspaceId: id(value.registeredWorkspaceId, '工作区ID'), workspaceBindingRevision: revision(value.workspaceBindingRevision), runtimeId: 'codex' }
}
export function initializeCustomerRegistrySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_pairings (
      code_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, label TEXT,
      expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_devices (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, label TEXT NOT NULL,
      platform TEXT, connector_version TEXT, token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','revoked')),
      connection_epoch INTEGER NOT NULL DEFAULT 0, connected INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_devices_owner ON customer_devices(owner_id);
    CREATE TABLE IF NOT EXISTS customer_workspaces (
      id TEXT NOT NULL, device_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      project_id TEXT NOT NULL, label TEXT NOT NULL, binding_revision INTEGER NOT NULL,
      runtime_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(device_id,id)
    );
    CREATE TABLE IF NOT EXISTS customer_capabilities (
      device_id TEXT NOT NULL, workspace_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
      binding_revision INTEGER NOT NULL, revision TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(device_id,workspace_id,runtime_id)
    );
  `)
}

export function isCustomerAgentsEnabled(env = process.env) { return env.AUTOOPS_CUSTOMER_AGENTS === '1' }
export function requireCustomerAgentsEnabled() { if (!isCustomerAgentsEnabled()) fail(409, 'CUSTOMER_AGENTS_DISABLED', '客户 Agent 接入尚未开放；已有对话仍可查看') }

export function createCustomerRegistry({ db, requireOwner, requireProjectForUser, now = Date.now, onlineTimeoutMs = 45_000, enabled = isCustomerAgentsEnabled }) {
  initializeCustomerRegistrySchema(db)
  const requireEnabled = () => { if (!enabled()) fail(409, 'CUSTOMER_AGENTS_DISABLED', '客户 Agent 接入尚未开放；已有对话仍可查看') }
  const owner = (ownerId) => { id(ownerId, '用户ID'); requireOwner(ownerId); return ownerId }
  const deviceRow = (deviceId) => db.prepare('SELECT * FROM customer_devices WHERE id=?').get(id(deviceId, '设备ID'))
  const publicDevice = (row) => ({ id: row.id, ownerId: row.owner_id, label: row.label,
    ...(row.platform ? { platform: row.platform } : {}), ...(row.connector_version ? { connectorVersion: row.connector_version } : {}),
    status: row.status, online: row.status !== 'revoked' && Boolean(row.connected) && row.last_seen_at !== null && now() - row.last_seen_at < onlineTimeoutMs,
    connectionEpoch: row.connection_epoch, ...(row.last_seen_at !== null ? { lastSeenAt: new Date(row.last_seen_at).toISOString() } : {}), createdAt: new Date(row.created_at).toISOString() })
  const publicWorkspace = (row) => ({ registeredWorkspaceId: row.id, deviceId: row.device_id, ownerId: row.owner_id, projectId: row.project_id, label: row.label, workspaceBindingRevision: row.binding_revision, runtimeId: row.runtime_id, status: row.status, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() })
  const ownedDevice = (ownerId, deviceId) => {
    owner(ownerId)
    const row = deviceRow(deviceId)
    if (!row || row.owner_id !== ownerId) fail(404, 'CUSTOMER_DEVICE_NOT_FOUND', '设备不存在或不属于当前用户')
    return row
  }
  const devicePrincipal = (principal) => {
    const row = principal && deviceRow(principal.deviceId)
    if (!row || row.owner_id !== principal.ownerId || row.status === 'revoked' || typeof principal.tokenHash !== 'string' || principal.tokenHash.length !== row.token_hash.length || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(principal.tokenHash))) fail(401, 'CUSTOMER_DEVICE_UNAUTHENTICATED', '设备凭据无效或已撤销，请在本机重新配对')
    owner(row.owner_id)
    return row
  }
  const workspaceRow = (deviceId, workspaceId) => db.prepare('SELECT * FROM customer_workspaces WHERE device_id=? AND id=?').get(id(deviceId, '设备ID'), id(workspaceId, '工作区ID'))
  const activeDevice = (principal) => {
    const row = devicePrincipal(principal)
    if (row.status !== 'active') fail(409, 'CUSTOMER_DEVICE_DISABLED', '设备已停用，不能接收新的登记或执行')
    return row
  }
  const validateTarget = (ownerId, projectId, target, { requireOnline = false } = {}) => {
    const binding = normalizeExecutionBinding(target)
    if (binding.kind !== 'customer') fail(400, 'CUSTOMER_TARGET_REQUIRED', '请选择客户工作区')
    requireProjectForUser(owner(ownerId), id(projectId, '项目ID'))
    const device = ownedDevice(ownerId, binding.deviceId)
    const workspace = workspaceRow(binding.deviceId, binding.registeredWorkspaceId)
    if (!workspace || workspace.owner_id !== ownerId || workspace.project_id !== projectId) fail(404, 'CUSTOMER_WORKSPACE_NOT_FOUND', '工作区不存在或不属于此项目与当前用户')
    if (device.status !== 'active') fail(409, 'CUSTOMER_DEVICE_DISABLED', '设备已停用或凭据已撤销；历史对话仍可查看')
    if (workspace.status !== 'active') fail(409, 'CUSTOMER_WORKSPACE_REVOKED', '本机已撤销此工作区授权；历史对话仍可查看')
    if (workspace.binding_revision !== binding.workspaceBindingRevision || workspace.runtime_id !== binding.runtimeId) fail(409, 'CUSTOMER_WORKSPACE_BINDING_CHANGED', '本机目录身份或运行器已改变，请新建对话')
    if (requireOnline && !publicDevice(device).online) fail(409, 'CUSTOMER_DEVICE_OFFLINE', '客户设备离线，草稿已保留；连接恢复后再发送')
    return { device: publicDevice(device), workspace: publicWorkspace(workspace) }
  }
  const listeners = new Set()
  const registry = {
    createPairing(ownerId, input = {}) {
      requireEnabled()
      owner(ownerId); object(input, ['label'])
      const label = input.label === undefined ? null : text(input.label, '设备名称')
      db.prepare('DELETE FROM customer_pairings WHERE expires_at<=? OR consumed_at IS NOT NULL').run(now())
      if (db.prepare('SELECT count(*) AS count FROM customer_pairings WHERE owner_id=?').get(ownerId).count >= 5) fail(429, 'CUSTOMER_PAIRING_LIMIT', '待配对请求过多，请等待已有配对码过期')
      const pairingCode = `pair_${randomBytes(24).toString('base64url')}`, expiresAt = now() + 10 * 60_000
      db.prepare('INSERT INTO customer_pairings VALUES(?,?,?,?,NULL,?)').run(hash(pairingCode), ownerId, label, expiresAt, now())
      return { pairingCode, expiresAt: new Date(expiresAt).toISOString() }
    },
    consumePairing(pairingCode, input) {
      requireEnabled()
      text(pairingCode, '配对码', 100); object(input, ['label', 'platform', 'connectorVersion'])
      const label = text(input.label, '设备名称'), platform = input.platform === undefined ? null : text(input.platform, '操作系统', 80), version = input.connectorVersion === undefined ? null : text(input.connectorVersion, '连接程序版本', 80)
      db.exec('BEGIN IMMEDIATE')
      try {
        const pairing = db.prepare('SELECT * FROM customer_pairings WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?').get(hash(pairingCode), now())
        if (!pairing) fail(401, 'CUSTOMER_PAIRING_INVALID', '配对码无效、已使用或已过期，请重新生成')
        owner(pairing.owner_id)
        const deviceId = randomUUID(), deviceToken = `device_${randomBytes(32).toString('base64url')}`
        db.prepare('UPDATE customer_pairings SET consumed_at=? WHERE code_hash=?').run(now(), hash(pairingCode))
        db.prepare('INSERT INTO customer_devices(id,owner_id,label,platform,connector_version,token_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(deviceId, pairing.owner_id, pairing.label || label, platform, version, hash(deviceToken), now())
        db.exec('COMMIT')
        return { device: publicDevice(deviceRow(deviceId)), deviceToken }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    authenticateToken(token) {
      if (typeof token !== 'string' || !/^device_[A-Za-z0-9_-]{43}$/u.test(token)) fail(401, 'CUSTOMER_DEVICE_UNAUTHENTICATED', '设备凭据无效')
      const row = db.prepare('SELECT * FROM customer_devices WHERE token_hash=?').get(hash(token))
      if (!row) fail(401, 'CUSTOMER_DEVICE_UNAUTHENTICATED', '设备凭据无效')
      const principal = Object.freeze({ deviceId: row.id, ownerId: row.owner_id, tokenHash: row.token_hash })
      devicePrincipal(principal)
      return principal
    },
    listDevices(ownerId) { owner(ownerId); return db.prepare('SELECT * FROM customer_devices WHERE owner_id=? ORDER BY created_at DESC').all(ownerId).map(publicDevice) },
    // 只供可信助手组合查询来源身份；不是面向用户的全局设备目录。
    sourceOwner(target) {
      const binding = normalizeExecutionBinding(target)
      if (binding.kind !== 'customer') fail(400,'CUSTOMER_TARGET_REQUIRED','请选择客户工作区')
      const device = deviceRow(binding.deviceId), workspace = workspaceRow(binding.deviceId,binding.registeredWorkspaceId)
      if (!device || !workspace || workspace.binding_revision !== binding.workspaceBindingRevision || workspace.runtime_id !== binding.runtimeId)
        fail(404,'CUSTOMER_WORKSPACE_NOT_FOUND','运行来源不存在或登记身份已改变')
      return {ownerId:device.owner_id,projectId:workspace.project_id}
    },
    describeSource(ownerId,target) {
      const binding = normalizeExecutionBinding(target)
      if (binding.kind !== 'customer') fail(400,'CUSTOMER_TARGET_REQUIRED','请选择客户工作区')
      const device = ownedDevice(ownerId,binding.deviceId), workspace = workspaceRow(binding.deviceId,binding.registeredWorkspaceId)
      if (!workspace || workspace.owner_id !== ownerId || workspace.binding_revision !== binding.workspaceBindingRevision || workspace.runtime_id !== binding.runtimeId)
        fail(404,'CUSTOMER_WORKSPACE_NOT_FOUND','运行来源不存在或不属于当前提供者')
      const snapshot = db.prepare('SELECT snapshot_json,updated_at FROM customer_capabilities WHERE device_id=? AND workspace_id=? AND runtime_id=? AND binding_revision=?').get(binding.deviceId,binding.registeredWorkspaceId,binding.runtimeId,binding.workspaceBindingRevision)
      return {executionBinding:binding,sourceProjectId:workspace.project_id,deviceName:device.label,workspaceName:workspace.label,
        deviceStatus:device.status,workspaceStatus:workspace.status,online:publicDevice(device).online,
        capabilities:snapshot?{...JSON.parse(snapshot.snapshot_json),updatedAt:new Date(snapshot.updated_at).toISOString()}:null}
    },
    listSources(ownerId) {
      owner(ownerId)
      return db.prepare('SELECT * FROM customer_workspaces WHERE owner_id=? ORDER BY created_at,id').all(ownerId).map(workspace=>this.describeSource(ownerId,{kind:'customer',deviceId:workspace.device_id,registeredWorkspaceId:workspace.id,workspaceBindingRevision:workspace.binding_revision,runtimeId:workspace.runtime_id}))
    },
    listWorkspaces(ownerId, projectId) {
      owner(ownerId)
      if (projectId !== undefined) requireProjectForUser(ownerId, id(projectId, '项目ID'))
      return db.prepare('SELECT * FROM customer_workspaces WHERE owner_id=? ORDER BY created_at DESC').all(ownerId).filter((row) => {
        if (projectId !== undefined && row.project_id !== projectId) return false
        try { requireProjectForUser(ownerId, row.project_id); return true } catch { return false }
      }).map(publicWorkspace)
    },
    registerWorkspace(principal, input) {
      requireEnabled()
      object(input, ['registeredWorkspaceId', 'projectId', 'label', 'workspaceBindingRevision', 'runtimeId'])
      const device = activeDevice(principal), workspaceId = id(input.registeredWorkspaceId, '工作区ID'), projectId = id(input.projectId, '项目ID'), label = text(input.label, '工作区名称'), bindingRevision = revision(input.workspaceBindingRevision)
      if (input.runtimeId !== 'codex') fail(400, 'CUSTOMER_RUNTIME_UNSUPPORTED', '首版只支持客户本机 Codex')
      requireProjectForUser(device.owner_id, projectId)
      const current = workspaceRow(device.id, workspaceId)
      if (current) {
        if (current.status !== 'active') fail(409, 'CUSTOMER_WORKSPACE_REVOKED', '已撤销的目录登记不能重新启用，请在本机重新登记')
        if (current.project_id !== projectId || current.binding_revision !== bindingRevision || current.runtime_id !== input.runtimeId) fail(409, 'CUSTOMER_WORKSPACE_BINDING_CHANGED', '目录身份不能改投其他项目或路径；请创建新的工作区登记')
        db.prepare('UPDATE customer_workspaces SET label=?,updated_at=? WHERE device_id=? AND id=?').run(label, now(), device.id, workspaceId)
      } else db.prepare('INSERT INTO customer_workspaces(id,device_id,owner_id,project_id,label,binding_revision,runtime_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(workspaceId, device.id, device.owner_id, projectId, label, bindingRevision, input.runtimeId, now(), now())
      return publicWorkspace(workspaceRow(device.id, workspaceId))
    },
    updateCapabilities(principal, input) {
      object(input, ['registeredWorkspaceId', 'workspaceBindingRevision', 'runtimeId', 'revision', 'protocolVersion', 'runtimeVersion', 'configRevision', 'models', 'skills', 'permissions', 'attachments', 'workspaceFiles', 'assistantConfiguration', 'sharedProfile'])
      if (input.assistantConfiguration !== undefined && typeof input.assistantConfiguration !== 'boolean') fail(400, 'CUSTOMER_CAPABILITIES_INVALID', '助手配置能力无效')
      if (input.workspaceFiles !== undefined && typeof input.workspaceFiles !== 'boolean') fail(400, 'CUSTOMER_CAPABILITIES_INVALID', '文件浏览能力无效')
      const device = activeDevice(principal), workspace = workspaceRow(device.id, input.registeredWorkspaceId)
      if (!workspace) fail(404, 'CUSTOMER_WORKSPACE_NOT_FOUND', '请先在本机登记工作区')
      validateTarget(device.owner_id, workspace.project_id, {kind:'customer',deviceId:device.id,registeredWorkspaceId:workspace.id,workspaceBindingRevision:input.workspaceBindingRevision,runtimeId:input.runtimeId})
      if (input.protocolVersion !== 1) fail(409, 'CUSTOMER_PROTOCOL_UNSUPPORTED', '连接程序协议不兼容，请更新后重连')
      if (!Array.isArray(input.models) || input.models.length > 1000 || !Array.isArray(input.skills) || input.skills.length > 2000) fail(400, 'CUSTOMER_CAPABILITIES_LIMIT', '模型或技能目录过大或格式无效')
      const models = input.models.map((model) => {
        object(model, ['id', 'name', 'supportedReasoningEfforts', 'defaultReasoningEffort'])
        if (!Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 16) fail(400, 'CUSTOMER_CAPABILITIES_INVALID', '思考强度目录无效')
        const supportedReasoningEfforts = [...new Set(model.supportedReasoningEfforts.map((effort) => text(effort, '思考强度', 40)))]
        const defaultReasoningEffort = model.defaultReasoningEffort === undefined ? undefined : text(model.defaultReasoningEffort, '默认思考强度', 40)
        if (defaultReasoningEffort !== undefined && !supportedReasoningEfforts.includes(defaultReasoningEffort)) fail(400, 'CUSTOMER_CAPABILITIES_INVALID', '默认思考强度不在支持目录中')
        return { id: text(model.id, '模型ID', 200), ...(model.name ? {name:text(model.name,'模型名称',200)} : {}), supportedReasoningEfforts, ...(defaultReasoningEffort === undefined ? {} : {defaultReasoningEffort}) }
      })
      const skills = input.skills.map((skill) => { object(skill, ['id','name','description']); return {id:id(skill.id,'技能ID'),name:text(skill.name,'技能名称'),description:typeof skill.description === 'string' && !skill.description ? '' : text(skill.description,'技能描述',4000)} })
      if (new Set(models.map((model) => model.id)).size !== models.length || new Set(skills.map((skill) => skill.id)).size !== skills.length) fail(400, 'CUSTOMER_CAPABILITIES_INVALID', '模型或技能标识重复')
      const permissions = input.permissions === undefined ? undefined : (() => { object(input.permissions,['approvalPolicy','sandboxMode']); return {approvalPolicy:text(input.permissions.approvalPolicy,'审批策略',80),sandboxMode:text(input.permissions.sandboxMode,'本机权限',80)} })()
      const attachments = input.attachments === undefined ? undefined : (() => {
        object(input.attachments, ['maxFileBytes', 'maxTotalBytes', 'maxCount'])
        const limits = {maxFileBytes:50*1024*1024, maxTotalBytes:100*1024*1024, maxCount:100}
        for (const [key, limit] of Object.entries(limits)) if (!Number.isSafeInteger(input.attachments[key]) || input.attachments[key] < 1 || input.attachments[key] > limit) fail(400, 'CUSTOMER_CAPABILITIES_INVALID', '附件能力无效')
        return {...input.attachments}
      })()
      const snapshot = {...(attachments ? {attachments} : {}),deviceId:device.id,registeredWorkspaceId:workspace.id,workspaceBindingRevision:workspace.binding_revision,runtimeId:workspace.runtime_id,revision:text(input.revision,'能力版本'),protocolVersion:1,...(input.runtimeVersion ? {runtimeVersion:text(input.runtimeVersion,'运行器版本',100)} : {}),...(input.configRevision ? {configRevision:text(input.configRevision,'配置版本')} : {}),models,skills,...(permissions ? {permissions} : {})}
      if (input.sharedProfile !== undefined) {
        try {
          const profile = decodeContract(SharedProfileCapability, input.sharedProfile)
          if (new Set(profile.models.map(model => model.id)).size !== profile.models.length ||
            new Set(profile.skills.map(skill => skill.id)).size !== profile.skills.length ||
            profile.models.some(model => model.defaultReasoningEffort !== undefined && !model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)))
            throw new Error('invalid shared catalog')
          snapshot.sharedProfile = profile
        } catch {
          fail(400, 'CUSTOMER_SHARED_PROFILE_INVALID', '隔离运行器能力目录无效')
        }
      }
      if (input.assistantConfiguration === true) snapshot.assistantConfiguration = true
      if (input.workspaceFiles === true) snapshot.workspaceFiles = true
      const encoded = JSON.stringify(snapshot)
      if (Buffer.byteLength(encoded) > 1024 * 1024) fail(413, 'CUSTOMER_CAPABILITIES_LIMIT', '能力目录超过大小限制')
      db.prepare('INSERT INTO customer_capabilities VALUES(?,?,?,?,?,?,?) ON CONFLICT(device_id,workspace_id,runtime_id) DO UPDATE SET binding_revision=excluded.binding_revision,revision=excluded.revision,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at').run(device.id,workspace.id,workspace.runtime_id,workspace.binding_revision,snapshot.revision,encoded,now())
      return {...snapshot,updatedAt:new Date(now()).toISOString()}
    },
    getCapabilities(ownerId, target) {
      const binding = normalizeExecutionBinding(target)
      if (binding.kind !== 'customer') fail(400,'CUSTOMER_TARGET_REQUIRED','请选择客户工作区')
      ownedDevice(ownerId,binding.deviceId)
      const workspace = workspaceRow(binding.deviceId,binding.registeredWorkspaceId)
      if (!workspace || workspace.owner_id !== ownerId) fail(404,'CUSTOMER_WORKSPACE_NOT_FOUND','工作区不存在或无权访问')
      requireProjectForUser(ownerId,workspace.project_id)
      if (workspace.binding_revision !== binding.workspaceBindingRevision || workspace.runtime_id !== binding.runtimeId) fail(409,'CUSTOMER_WORKSPACE_BINDING_CHANGED','工作区绑定版本已改变')
      const row = db.prepare('SELECT * FROM customer_capabilities WHERE device_id=? AND workspace_id=? AND runtime_id=? AND binding_revision=?').get(binding.deviceId,binding.registeredWorkspaceId,binding.runtimeId,binding.workspaceBindingRevision)
      return row ? {...JSON.parse(row.snapshot_json),updatedAt:new Date(row.updated_at).toISOString()} : undefined
    },
    validateTarget,
    validateSelection(ownerId, projectId, target, { modelId, reasoningEffort, skillIds = [] }) {
      requireEnabled()
      validateTarget(ownerId,projectId,target,{requireOnline:true})
      const capabilities = this.getCapabilities(ownerId,target)
      if (!capabilities) fail(409,'CUSTOMER_CAPABILITIES_UNAVAILABLE','本机尚未上报模型与技能目录，请刷新设备能力')
      const model = capabilities.models.find((entry) => entry.id === modelId)
      if (!model) fail(409,'CUSTOMER_MODEL_UNAVAILABLE','所选模型不在客户本机能力目录中，请重新选择')
      if (reasoningEffort !== undefined && !model.supportedReasoningEfforts.includes(reasoningEffort)) fail(409,'CUSTOMER_REASONING_UNAVAILABLE','所选思考强度不被本机模型支持')
      if (!Array.isArray(skillIds) || skillIds.some((skillId) => !capabilities.skills.some((skill) => skill.id === skillId))) fail(409,'CUSTOMER_SKILL_UNAVAILABLE','所选本地技能不可用，请刷新后重新选择')
      return capabilities
    },
    setDeviceStatus(ownerId, deviceId, status) {
      const current = ownedDevice(ownerId,deviceId)
      if (!['active','disabled'].includes(status) || current.status === 'revoked') fail(409,'CUSTOMER_DEVICE_STATUS_INVALID','已吊销的设备凭据不能重新启用，请重新配对')
      db.prepare('UPDATE customer_devices SET status=? WHERE id=?').run(status,deviceId)
      return publicDevice(deviceRow(deviceId))
    },
    revokeCredential(ownerId, deviceId) {
      ownedDevice(ownerId,deviceId)
      db.prepare("UPDATE customer_devices SET status='revoked',connected=0 WHERE id=?").run(deviceId)
      return publicDevice(deviceRow(deviceId))
    },
    revokeWorkspace(principal, workspaceId) {
      const device = devicePrincipal(principal), workspace = workspaceRow(device.id,workspaceId)
      if (!workspace) fail(404,'CUSTOMER_WORKSPACE_NOT_FOUND','工作区不存在')
      db.prepare("UPDATE customer_workspaces SET status='revoked',updated_at=? WHERE device_id=? AND id=?").run(now(),device.id,workspaceId)
      return publicWorkspace(workspaceRow(device.id,workspaceId))
    },
    markConnected(principal, input = {}) {
      object(input,['connectorVersion']); const device = devicePrincipal(principal)
      db.prepare('UPDATE customer_devices SET connected=1,connection_epoch=connection_epoch+1,last_seen_at=?,connector_version=COALESCE(?,connector_version) WHERE id=?').run(now(),input.connectorVersion ? text(input.connectorVersion,'连接程序版本',80) : null,device.id)
      const updated = publicDevice(deviceRow(device.id)); return {device:updated,connectionEpoch:updated.connectionEpoch}
    },
    markHeartbeat(principal, connectionEpoch) {
      const device = devicePrincipal(principal)
      if (!Number.isSafeInteger(connectionEpoch) || connectionEpoch !== device.connection_epoch || !device.connected) fail(409,'CUSTOMER_CONNECTION_REPLACED','设备连接已被新连接替换')
      db.prepare('UPDATE customer_devices SET last_seen_at=? WHERE id=? AND connection_epoch=?').run(now(),device.id,connectionEpoch)
    },
    markDisconnected(deviceId, connectionEpoch) { db.prepare('UPDATE customer_devices SET connected=0 WHERE id=? AND connection_epoch=?').run(id(deviceId,'设备ID'),connectionEpoch) },
    resetPresence() { db.exec('UPDATE customer_devices SET connected=0') },
    // Internal service enumeration only; HTTP handlers must use owner-scoped listDevices.
    listRegisteredDevices() { return db.prepare('SELECT * FROM customer_devices ORDER BY created_at').all().map(publicDevice) },
    deletionReferences(projectId, environmentId) {
      if (environmentId !== undefined) return []
      const count = Number(db.prepare("SELECT COUNT(*) AS n FROM customer_workspaces WHERE project_id=? AND status='active'").get(projectId)?.n ?? 0)
      return count ? [{kind:'customer-workspaces',count,message:'仍有提供者登记的电脑目录'}] : []
    },
    subscribeChanges(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  for (const name of ['consumePairing','registerWorkspace','updateCapabilities','setDeviceStatus','revokeCredential','revokeWorkspace','markConnected','markDisconnected']) {
    const operation=registry[name]
    registry[name]=function (...args) { const result=operation.apply(this,args); for(const listener of listeners)listener(); return result }
  }
  return registry
}
