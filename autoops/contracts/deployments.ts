import type { WorkspaceBuildContext } from './workspaces.ts'
import type { WorkspaceDeploymentSourceInput } from './workspace-authoring.ts'

export type DeploymentKind = 'java' | 'static'
export interface JavaDeploymentConfig {
  kind: 'java'
  module: string
  artifactPath: string
  buildImage: string
  runtimeImage: string
  jvmArgs: string[]
  args: string[]
  profile: string
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
  error?: string | null
  lastSeq?: number
  requestId?: string
  stageHistory?: Array<{ stage: string; startedAt?: string; finishedAt?: string }>
  sourceIdentity?: Partial<DeploymentSourceIdentity>
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
  environmentId?: string
  online?: boolean
  version?: string | null
  revoked?: boolean
  capabilities?: string[]
  lastSeenAt?: string | null
  registeredAt?: string | null
  metrics?: {
    cpuPercent: number | null
    memory: { used: number | null; total: number | null } | null
    disk: { used: number | null; total: number | null } | null
    centerRttMs: number | null
  } | null
  storagePolicy?: { revision: number; retainedVersions: number; buildCacheGiB: number } | null
  storageState?: 'unsupported' | 'waiting' | 'pending' | 'applying' | 'applied' | 'failed'
  storageStatus?: {
    revision: number | null
    state: 'applying' | 'applied' | 'failed'
    startedAt: string | null
    checkedAt: string | null
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
