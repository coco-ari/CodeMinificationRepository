import type { WorkspaceBuildContext } from './workspaces.ts'

export type WorkspaceSourceRole = 'frontend' | 'backend' | 'shared' | 'documentation' | 'other'
export type WorkspaceRepositoryRefKind = 'default' | 'branch' | 'tag' | 'commit'

export interface WorkspaceRepositorySource {
  id: string
  name: string
  role: WorkspaceSourceRole
  url: string
  refKind: WorkspaceRepositoryRefKind
  ref: string
  mountPath: string
  sourcePath?: string
  credentialId?: string
}
export type WorkspaceSourceInput = Omit<WorkspaceRepositorySource, 'id'> & { id?: string }
export interface WorkspaceCredentialVersionReference {
  projectId: string
  credentialId: string
  version: number
}
export interface WorkspaceCredentialMetadata {
  id: string
  projectId: string
  name: string
  revision: number
  version: number
  revoked: boolean
  createdAt: string
  updatedAt: string
}
export interface WorkspaceResolvedRepository {
  sourceId: string
  commit: string
  refKind: WorkspaceRepositoryRefKind
  ref: string
  defaultRef: string | null
  credentialVersion?: WorkspaceCredentialVersionReference
}

export interface WorkspaceAuthoringMutation {
  requestId: string
  expectedRevision: number
}
export interface WorkspaceExtraction {
  status: 'pending' | 'ready' | 'unavailable'
  contentHash: string
  parserVersion: string
  code?: string
  message?: string
}
export interface WorkspaceMaterialEntry {
  id: string
  path: string
  name: string
  kind: 'file' | 'directory'
  revision: string
  updatedAt: string
  size: number
  mime: string
  sha256?: string
  editable: boolean
  extraction?: WorkspaceExtraction
}
export interface WorkspaceAuthoringOverview {
  projectId: string
  revision: number
  sources: WorkspaceRepositorySource[]
  entries: WorkspaceMaterialEntry[]
  limits: { maxFileBytes: number; maxFiles: number; maxBytes: number }
  sourceStatus?: Array<{
    sourceId: string
    status: 'unsynced' | 'queued' | 'syncing' | 'synced' | 'failed'
    versionId?: string
    commit?: string
    createdAt?: string
    updatedAt?: string
    requestId?: string
    error?: { code: string; message: string }
  }>
  publishedRevision?: number
  hasUnpublishedChanges?: boolean
}
export interface WorkspaceAuthoringResult {
  requestId: string
  revision: number
  entry?: WorkspaceMaterialEntry
  source?: WorkspaceRepositorySource
  skipped?: boolean
}
export interface WorkspaceUploadInput extends WorkspaceAuthoringMutation {
  path: string
  size: number
  sha256: string
  conflict: 'replace' | 'keep-both' | 'skip'
}
export interface WorkspaceTextSaveInput extends WorkspaceAuthoringMutation {
  path: string
  expectedContentRevision: string
  contents: string
}
export interface WorkspaceMoveInput extends WorkspaceAuthoringMutation {
  path: string
  destination: string
  expectedContentRevision: string
}
export interface WorkspaceDeleteInput extends WorkspaceAuthoringMutation {
  path: string
  expectedContentRevision: string
}
export interface WorkspaceExtractionRetryInput extends WorkspaceAuthoringMutation {
  path: string
  expectedContentRevision: string
}
export interface WorkspaceCapturedFile {
  path: string
  id: string
  revision: string
  sha256: string
  size: number
  mime: string
  extraction: WorkspaceExtraction
}
export interface WorkspaceAuthoringCapture {
  id: string
  projectId: string
  requestId: string
  revision: number
  createdAt: string
  status: 'active' | 'released'
  resolution: 'pending' | 'resolved' | 'failed'
  resolutionError?: { code: string; message: string }
  resolvedRepositories?: WorkspaceResolvedRepository[]
  sources: WorkspaceRepositorySource[]
  files: WorkspaceCapturedFile[]
  directories: string[]
}
export interface WorkspaceMaterialContent {
  path: string
  revision: string
  mime: string
  size: number
  sha256: string
  extraction: WorkspaceExtraction
  contents?: string
}

export interface WorkspaceInputRepository extends WorkspaceResolvedRepository {
  source: WorkspaceRepositorySource
  versionId: string
}
export interface WorkspaceInputSourceIssue {
  sourceId: string
  name: string
  mountPath: string
  code: string
  message: string
}
export interface WorkspaceInputCapture {
  id: string
  projectId: string
  requestId: string
  workspaceType: 'internal' | 'external'
  revision: number
  createdAt: string
  status: 'active' | 'released'
  repositories: WorkspaceInputRepository[]
  files: WorkspaceCapturedFile[]
  directories: string[]
  captureId?: string
  externalVersionId?: string
  sourceErrors?: WorkspaceInputSourceIssue[]
  sourceWarnings?: WorkspaceInputSourceIssue[]
}
export interface WorkspaceDeploymentSourceInput {
  requestId: string
  sources: Array<{ sourceId: string; refKind?: WorkspaceRepositoryRefKind; ref?: string }>
  contexts: WorkspaceBuildContext[]
}
export interface WorkspaceDeploymentSourceCapture {
  id: string
  projectId: string
  requestId: string
  versionId: string
  repositories: WorkspaceInputRepository[]
  contexts: WorkspaceBuildContext[]
}
export interface WorkspaceSourceSyncRecord {
  sourceId: string
  configurationHash: string
  requestId: string
  status: 'queued' | 'syncing' | 'synced' | 'failed'
  updatedAt: string
  versionId?: string
  commit?: string
  error?: { code: string; message: string }
}
