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

export interface DeploymentRelease {
  id: string
  targetId: string
  kind?: 'static'
  createdAt: string
  revision?: string
  current?: boolean
  available?: boolean
  archiveStatus?: string
  sourceIdentity?: Partial<DeploymentSourceIdentity>
  config?: StaticDeploymentConfig
}

export interface DeploymentTarget {
  id: string
  name: string
  environmentId: string
  serverId: string
  kind?: 'static'
  service?: 'frontend'
  configKey: string
  config: StaticDeploymentConfig
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
  targets: DeploymentTarget[]
  tasks: DeploymentTask[]
}

export interface DeploymentSubmission {
  targetId: string
  action: 'deploy' | 'rollback'
  packageId?: string
  service: 'frontend'
  configKey: string
  releaseId?: string
  requestId: string
}

export interface DeploymentTargetSubmission {
  name: string
  environmentId: string
  serverId: string
  config: StaticDeploymentConfig
  requestId: string
}

export interface DeploymentServer {
  id: string
  name: string
  environmentId: string
  online?: boolean
  version?: string | null
  revoked?: boolean
  capabilities?: string[]
}
export interface DeploymentSourceIdentity {
  projectId: string
  sourceVersionId: string
  packageId: string
  service: 'frontend'
  contentHash: string
  repositories: Array<{ path: string; commit: string }>
}
