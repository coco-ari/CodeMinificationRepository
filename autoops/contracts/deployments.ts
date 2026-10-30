import type { WorkspaceBuildContext } from './workspaces.ts'
import type { WorkspaceDeploymentSourceInput } from './workspace-authoring.ts'

export type DeploymentKind = 'java' | 'static'
export interface DeploymentEnvironmentCapabilities {
  read: boolean
  configure: boolean
  publish: boolean
  restart: boolean
  rollback: boolean
  sourceDownload: boolean
  sourceClear: boolean
  nodeBind: boolean
}
export interface DeploymentCapabilities {
  serviceManage: boolean
  environments: Record<string, DeploymentEnvironmentCapabilities>
}
export interface DeploymentSourceRef {
  sourceId: string
  refKind: 'default' | 'branch' | 'tag' | 'commit'
  ref: string
  commit: string
}
export interface DeploymentRequestReceipt {
  state: 'not_observed' | 'accepted' | 'completed'
  requestId: string
  operation?: string
  environmentId?: string | null
  publicIntent?: { serviceId: string; environmentId: string; configKey: string }
  result?: unknown
}
export interface JavaDeploymentConfig {
  kind: 'java'
  module: string
  artifactPath: string
  buildImage: string
  runtimeImage: string
  jvmArgs: string[]
  args: string[]
  profile: string
  envFiles?: string[]
  ports: Array<{ host: string; hostPort: number; containerPort: number }>
  networks: string[]
  volumes: Array<{ name: string; mountPath: string }>
  build: { cpus: number; memoryMb: number }
  runtime: { cpus: number; memoryMb: number }
  health: {
    path: string
    port: number
    status: number
    bodyIncludes: string
    timeoutSeconds: number
    intervalSeconds: number
  }
}
export interface StaticDeploymentConfig {
  kind: 'static'
  module: string
  artifactPath: string
  buildImage: string
  packageManager: 'npm' | 'pnpm'
  packageManagerVersion: string
  buildScript: string
  buildArgs: string[]
  build: { cpus: number; memoryMb: number }
  health: {
    url: string
    bodyIncludes: string
    status: number
    timeoutSeconds: number
    intervalSeconds: number
  }
}

export type DeploymentConfig = StaticDeploymentConfig | JavaDeploymentConfig
export interface DeploymentService {
  id: string
  name: string
  kind: DeploymentKind
  module: string
  configKey: string
  hasTargets?: boolean
}
export interface DeploymentServiceSubmission {
  id?: string
  name: string
  kind: DeploymentKind
  module: string
  configKey?: string
  requestId: string
}
export interface DeploymentServiceSource {
  serviceId: string
  environmentId: string
  sources: WorkspaceDeploymentSourceInput['sources']
  contexts: WorkspaceBuildContext[]
  configKey: string
}
export interface DeploymentServiceSourceSubmission {
  sources: WorkspaceDeploymentSourceInput['sources']
  contexts: WorkspaceBuildContext[]
  configKey?: string
  requestId: string
}
export interface DeploymentRepositoryRefs {
  sourceId: string
  defaultRef: string | null
  branches: Array<{ name: string; commit: string }>
  tags: Array<{ name: string; commit: string }>
  truncated: boolean
}
export interface DeploymentRepositoryHistory {
  sourceId: string
  refKind: 'default' | 'branch' | 'tag' | 'commit'
  ref: string
  defaultRef: string | null
  commit: string
  commits: Array<{ revision: string; subject: string; authoredAt: string }>
  truncated: boolean
}

export interface DeploymentRelease {
  id: string
  targetId: string
  kind?: DeploymentKind
  createdAt: string
  revision?: string
  current?: boolean
  available?: boolean
  archiveStatus?: string
  archiveProtected?: boolean
  sourceIdentity?: Partial<DeploymentSourceIdentity>
  sourceSelection?: Pick<WorkspaceDeploymentSourceInput, 'sources' | 'contexts'>
  config?: DeploymentConfig
  sourceRefs?: DeploymentSourceRef[]
}

export interface DeploymentTarget {
  id: string
  name: string
  environmentId: string
  serverId: string
  serviceId: string
  kind?: DeploymentKind
  service?: 'frontend' | 'backend'
  configKey: string
  config: DeploymentConfig
  staticServingPath?: string | null
  networkIdentity?: { network: string; alias: string } | null
  observation?: {
    targetId: string
    kind?: DeploymentKind
    exists: boolean | null
    status: string
    health: string
    managed?: boolean
    restartCount?: number
    startedAt?: string
  } | null
  lastObservedAt?: string | null
  observationStale?: boolean
  currentRelease?: DeploymentRelease | null
}

export interface DeploymentTask {
  id: string
  targetId: string
  status: string
  stage: string
  action?: string
  createdAt: string
  serverId?: string
  environmentId?: string
  actor?: { id: string; displayName?: string }
  updatedAt?: string
  startedAt?: string
  finishedAt?: string
  config?: DeploymentConfig
  detailedAgentStages?: boolean
  error?: string | null
  lastSeq?: number
  requestId?: string
  stageHistory?: Array<{
    stage: string
    startedAt?: string
    finishedAt?: string
    durationMs?: number
  }>
  sourceIdentity?: Partial<DeploymentSourceIdentity>
  sourceRefs?: DeploymentSourceRef[]
  result?: {
    error?: string
    cleanupError?: string
    recoveryMethod?: string
    release?: Pick<DeploymentRelease, 'id'> & Partial<Omit<DeploymentRelease, 'id'>>
    rollback?: {
      status?: 'succeeded' | 'failed' | 'unavailable'
      error?: string
      release?: Pick<DeploymentRelease, 'id'> & Partial<Omit<DeploymentRelease, 'id'>>
    }
  }
}

export interface DeploymentLog {
  seq: number
  at?: string
  receivedAt?: string
  status?: string
  stage?: string
  message: string
}
export interface DeploymentTaskDetails {
  task: DeploymentTask
  logs: DeploymentLog[]
  nextSeq: number
}
export interface DeploymentOverview {
  enabled: boolean
  environments: Array<{ id: string; name: string }>
  servers: DeploymentServer[]
  services: DeploymentService[]
  serviceSources?: DeploymentServiceSource[]
  targets: DeploymentTarget[]
  tasks: DeploymentTask[]
  capabilities?: DeploymentCapabilities
  availableServices?: DeploymentService[]
  configuration?: Record<string, { missing: Array<'source' | 'target'>; configKey: string }>
}

export interface DeploymentSubmission {
  targetId: string
  action: 'deploy' | 'rollback' | 'restart'
  packageId?: string
  sourceSelection?: Pick<WorkspaceDeploymentSourceInput, 'sources' | 'contexts'>
  service: 'frontend' | 'backend'
  configKey: string
  releaseId?: string
  requestId: string
  sourceRefs?: DeploymentSourceRef[]
}

export interface DeploymentTargetSubmission {
  name?: string
  serviceId?: string
  environmentId: string
  serverId: string
  config: DeploymentConfig
  networkIdentity?: { network: string; alias: string } | null
  requestId: string
}

export interface DeploymentTargetUpdate {
  config: DeploymentConfig
  configKey: string
  networkIdentity?: { network: string; alias: string } | null
  requestId: string
}

export interface DeploymentServer {
  id: string
  name: string
  projectAllowed?: boolean
  environmentId?: string
  online?: boolean
  version?: string | null
  revoked?: boolean
  capabilities?: string[]
  lastSeenAt?: string | null
  registeredAt?: string | null
  registrationState?: 'pending' | 'expired' | 'registered' | 'revoked'
  registrationExpiresAt?: string | null
  metrics?: {
    cpuPercent: number | null
    memory: { used: number | null; total: number | null } | null
    disk: { used: number | null; total: number | null } | null
    centerRttMs: number | null
  } | null
  storagePolicy?: { revision: number; retainedVersions: number; buildCacheGiB: number } | null
  storageState?: 'unsupported' | 'waiting' | 'pending' | 'applying' | 'applied' | 'failed'
  storageWaitingReason?: 'offline' | 'busy' | null
  storageStatus?: {
    revision: number | null
    state: 'applying' | 'applied' | 'failed'
    startedAt: string | null
    checkedAt: string | null
    errors?: string[]
    cache: {
      bytes: number | null
      limitBytes: number | null
      reclaimedBytes: number | null
      withinLimit: boolean
    } | null
  } | null
}
export interface DeploymentServerManagement {
  servers: DeploymentServer[]
  availableServers: DeploymentServer[]
  canAdmin: boolean
  canBind: boolean
}
export interface DeploymentGlobalNodeCatalog {
  installation?: { origin: string; ca: { url: string; sha256: string } | null }
  servers: DeploymentServer[]
  projects: Array<{ id: string; name: string; environments: Array<{ id: string; name: string }> }>
  projectAccess: Array<{ projectId: string; serverIds: string[]; revision: number }>
  bindings: Array<{ projectId: string; environmentId: string; serverId: string }>
}
export type DeploymentNodePublicIntent =
  | { name: string }
  | { serverId: string }
  | { serverId: string; environmentId: string }
  | { serverId: string; expectedRevision: number; retainedVersions: number; buildCacheGiB: number }
  | { projectId: string; serverId: string; allowed: boolean; expectedRevision: number }
  | { serverId: string; projectId: string; environmentIds: string[]; expectedRevision: number }
export interface DeploymentNodeReceipt {
  state: 'completed'
  requestId: string
  operation:
    | 'create'
    | 'bind'
    | 'unbind'
    | 'revoke'
    | 'delete'
    | 'storage'
    | 'access'
    | 'assign'
    | 'registration'
  projectId: string | null
  environmentId: string | null
  serverId: string
  targetProjectId?: string
  publicIntent: DeploymentNodePublicIntent
  result:
    | DeploymentServer
    | { ok: true }
    | { projectId: string; serverId: string; allowed: boolean; revision: number }
    | DeploymentNodeAssignment
}
export interface DeploymentNodeAssignment {
  serverId: string
  projectId: string
  environmentIds: string[]
  revision: number
}
export interface DeploymentServerRegistration {
  server: DeploymentServer
  registrationToken: string | null
  expiresAt: string | null
  installCommand?: string | null
  repeated?: boolean
}
export interface DeploymentSourceIdentity {
  projectId: string
  sourceVersionId: string
  packageId: string
  service: 'frontend' | 'backend'
  contentHash: string
  repositories: Array<{ path: string; commit: string }>
}
