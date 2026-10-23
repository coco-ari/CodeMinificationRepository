/** 当前工作台共享的公开 DTO；不包含身份凭据、存储句柄或服务实现。 */
export interface ProjectCapabilities {
  'workspace.read': boolean
  'workspace.manage': boolean
  'deployment.read': boolean
  'deployment.execute': boolean
}

export type CustomerExecutionBinding = {
  kind: 'customer'
  deviceId: string
  registeredWorkspaceId: string
  workspaceBindingRevision: number
  runtimeId: 'codex'
}
export type ExecutionBinding = { kind: 'platform' } | CustomerExecutionBinding

export interface CustomerDevice {
  id: string
  ownerId: string
  label: string
  platform?: string
  connectorVersion?: string
  status: 'active' | 'disabled' | 'revoked'
  online: boolean
  connectionEpoch: number
  lastSeenAt?: string
  createdAt: string
}
export interface CustomerWorkspace {
  registeredWorkspaceId: string
  deviceId: string
  ownerId: string
  projectId: string
  label: string
  workspaceBindingRevision: number
  runtimeId: 'codex'
  status: 'active' | 'revoked'
  createdAt: string
  updatedAt: string
}
export interface CustomerModel {
  id: string
  name?: string
  supportedReasoningEfforts: string[]
}
export interface CustomerSkill {
  id: string
  name: string
  description: string
}
export interface CustomerCapabilityInput {
  registeredWorkspaceId: string
  workspaceBindingRevision: number
  runtimeId: 'codex'
  revision: string
  protocolVersion: 1
  runtimeVersion?: string
  configRevision?: string
  models: CustomerModel[]
  skills: CustomerSkill[]
  permissions?: { approvalPolicy: string; sandboxMode: string }
}
export interface CustomerCapabilities extends CustomerCapabilityInput {
  deviceId: string
  updatedAt: string
}
