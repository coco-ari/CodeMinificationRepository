export interface WorkspaceSource {
  repositories: Array<{ path: string; commit: string }>;
  contentHash: string;
  repositoryHost?: string;
  branch?: string;
}
export interface WorkspaceVersion {
  id: string;
  name: string;
  type: 'internal' | 'external';
  status: 'published' | 'pending_review' | 'failed';
  sourceVersionId?: string;
  createdAt: string;
  publishedAt?: string;
  fileCount: number;
  byteLength: number;
  source: WorkspaceSource;
  report?: {
    removedGitEntries: number;
    replacements: number;
    pendingFiles: Array<{ path: string; reason: string }>;
    excludedFiles: string[];
    reviewedFiles?: string[];
    rulesVersion: string;
    customRules?: number;
  };
  isExample?: boolean;
}
export interface WorkspaceFile { path: string; name: string; mime: string; size: number; sha256: string }
export interface WorkspaceTask {
  id: string;
  type: 'external' | 'packages' | 'import';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  stage: string;
  message: string;
  createdAt: string;
  versionId?: string;
  releaseId?: string;
  error?: string;
}
export interface WorkspaceRelease {
  id: string;
  name: string;
  sourceVersionId: string;
  createdAt: string;
  services: Array<{ service: 'frontend' | 'backend'; name: string; size: number; sha256: string }>;
  manifest: Record<string, unknown>;
}
export interface WorkspaceOverview {
  projectId: string;
  internalVersions: WorkspaceVersion[];
  externalVersions: WorkspaceVersion[];
  releases: WorkspaceRelease[];
  tasks: WorkspaceTask[];
  import: { supported: boolean; hosts: string[]; maxBytes: number; maxFiles: number };
}
export interface WorkspaceStore {
  ensureProject(project: { id: string; name: string; documents?: ReadonlyArray<{ id: string; name: string; mime?: string; content: string }> }): Promise<void>;
  overview(projectId: string): WorkspaceOverview;
  getVersion(projectId: string, versionId: string): WorkspaceVersion;
  files(projectId: string, versionId: string): WorkspaceFile[];
  tree(projectId: string, versionId: string, directory?: string): { entries: Array<{ path: string; name: string; kind: 'file' | 'directory'; size: number }>; truncated: boolean };
  /** Management-only tree, including pending external review. */
  managementTree(projectId: string, versionId: string, directory?: string): ReturnType<WorkspaceStore['tree']>;
  managementSearch(projectId: string, versionId: string, query?: string, limit?: number): { entries: Array<{ path: string; kind: 'file' | 'directory' }>; truncated: boolean };
  read(projectId: string, versionId: string, path: string): { path: string; name: string; mime: string; contents: string; byteLength: number; truncated: boolean };
  /** Management-only text preview, including pending external review. */
  managementRead(projectId: string, versionId: string, path: string): ReturnType<WorkspaceStore['read']>;
  /** Only published versions may be downloaded through an Agent resource. */
  readBytes(projectId: string, versionId: string, path: string): Uint8Array;
  /** Management-only preview, including pending binary review. Never use for Agent resources. */
  versionFile(projectId: string, versionId: string, path: string): { bytes: Uint8Array; name: string; mime: string };
  startExternal(projectId: string, input: { sourceVersionId: string; rules?: Array<{ find: string; replace: string }>; requestId: string }): WorkspaceTask;
  confirmExternal(projectId: string, versionId: string, input: { confirmedPaths: string[]; excludedPaths: string[] }): WorkspaceVersion;
  startPackages(projectId: string, input: { sourceVersionId: string; services: Array<'frontend' | 'backend'>; requestId: string }): WorkspaceTask;
  packageFile(projectId: string, releaseId: string, service: string): { bytes: Uint8Array; name: string; mime: string };
  startImport(projectId: string, input: { repositoryUrl: string; branch?: string; requestId: string }): WorkspaceTask;
  cancelTask(projectId: string, taskId: string): WorkspaceTask;
}
export class WorkspaceError extends Error { status: number; code: string; constructor(status: number, code: string, message: string); }
export function createWorkspaceStore(options: { dataDir: string }): WorkspaceStore;
export function configuredWorkspaceStore(): WorkspaceStore | undefined;
