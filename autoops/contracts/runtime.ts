import type { SharedProfileCapability } from './shared-profile.ts'

/** 当前工作台共享的公开 DTO；不包含身份凭据、存储句柄或服务实现。 */
export interface ProjectCapabilities {
  'project.manage'?: boolean
  'chat.use'?: boolean
  'chat.configure'?: boolean
  'workspace.external.publish'?: boolean
  'workspace.read': boolean
  'workspace.manage': boolean
  'credential.use'?: boolean
  'credential.manage'?: boolean
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
  defaultReasoningEffort?: string
}
export interface CustomerSkill {
  id: string
  name: string
  description: string
}
export interface CustomerCapabilityInput {
  sharedProfile?: SharedProfileCapability
  workspaceFiles?: boolean
  assistantConfiguration?: boolean
  registeredWorkspaceId: string
  workspaceBindingRevision: number
  runtimeId: 'codex'
  revision: string
  protocolVersion: 1
  runtimeVersion?: string
  configRevision?: string
  models: CustomerModel[]
  skills: CustomerSkill[]
  attachments?: { maxFileBytes: number; maxTotalBytes: number; maxCount: number }
  permissions?: { approvalPolicy: string; sandboxMode: string }
}
export interface CustomerCapabilities extends CustomerCapabilityInput {
  deviceId: string
  updatedAt: string
}

export interface ProjectMembership {
  userId: string
  workspaceAccess: 'internal' | 'external'
  role: import('./project-access.ts').ProjectRole
  environmentRoles?: Record<string, import('./project-access.ts').EnvironmentRole>
  canAdjustChat?: boolean
  authorizationPending?: boolean
  environmentIds: string[]
  status: 'active' | 'disabled'
}
export interface RuntimeProject {
  id: string
  name: string
  description?: string
  revision?: number
  memberIds: string[]
  memberships?: ProjectMembership[]
  environments: { id: string; name: string }[]
  documents: { id: string; name: string; mime: string; content: string; excerpt?: string }[]
  resources: { id: string; name: string; type: string; environmentId: string }[]
}
export interface RuntimeAgent {
  id: string
  name: string
  description: string
  projectIds: string[]
  capabilities: string[]
}
