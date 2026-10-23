export interface WorkspaceSource {
  repositories: Array<{ path: string; commit: string }>
  contentHash: string
  repositoryHost?: string
  branch?: string
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
  type: 'external' | 'packages' | 'import'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
  stage: string
  message: string
  createdAt: string
  versionId?: string
  releaseId?: string
  error?: string
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
