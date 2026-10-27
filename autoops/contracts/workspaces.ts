export interface WorkspaceBuildContext {
  service: 'frontend' | 'backend'
  root: string
  workingDirectory: string
}
export interface WorkspaceSource {
  repositories: Array<{
    path: string
    commit: string
    sourceId?: string
    configurationHash?: string
  }>
  contentHash: string
  repositoryHost?: string
  branch?: string
  authoringRevision?: number
  captureId?: string
  inputId?: string
  documents?: Array<{ path: string; sha256: string; revision: string }>
}
export interface WorkspaceVersion {
  id: string
  name: string
  type: 'internal' | 'external'
  status: 'published' | 'pending_review' | 'failed'
  sourceVersionId?: string
  createdAt: string
  publishedAt?: string
  fileCount: number
  byteLength: number
  source: WorkspaceSource
  report?: {
    removedGitEntries: number
    replacements: number
    pendingFiles: Array<{ path: string; reason: string }>
    excludedFiles: string[]
    reviewedFiles?: string[]
    rulesVersion: string
    customRules?: number
  }
  cacheKey?: string
  cachePurpose?: 'source' | 'deployment' | 'external-input'
  isExample?: boolean
}
export interface WorkspaceFile {
  path: string
  name: string
  mime: string
  size: number
  sha256: string
}
export interface WorkspaceTask {
  id: string
  requestId?: string
  type: 'external' | 'packages' | 'import' | 'snapshot' | 'sync' | 'input'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
  stage: string
  message: string
  createdAt: string
  versionId?: string
  releaseId?: string
  error?: string
  failureCode?: string
}
export interface WorkspaceRelease {
  id: string
  name: string
  sourceVersionId: string
  createdAt: string
  services: Array<{ service: 'frontend' | 'backend'; name: string; size: number; sha256: string }>
  manifest: Record<string, unknown>
}
export interface WorkspaceOverview {
  projectId: string
  internalVersions: WorkspaceVersion[]
  externalVersions: WorkspaceVersion[]
  releases: WorkspaceRelease[]
  tasks: WorkspaceTask[]
  import: { supported: boolean; hosts: string[]; maxBytes: number; maxFiles: number }
}
export interface WorkspaceTreeEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  size: number
}

export interface WorkspaceContent {
  path: string
  name: string
  mime: string
  contents: string
  byteLength: number
  truncated: boolean
}
