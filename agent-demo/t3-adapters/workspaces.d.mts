import type { WorkspaceSource, WorkspaceVersion, WorkspaceFile, WorkspaceTask, WorkspaceRelease, WorkspaceOverview, WorkspaceTreeEntry, WorkspaceContent } from '../../autoops/contracts/workspaces.ts'
export type { WorkspaceSource, WorkspaceVersion, WorkspaceFile, WorkspaceTask, WorkspaceRelease, WorkspaceOverview, WorkspaceTreeEntry, WorkspaceContent } from '../../autoops/contracts/workspaces.ts'
export interface WorkspaceStore {
  whenIdle(): Promise<void>;
  stopAccepting(): void;
  close(options?: {force?: boolean}): Promise<void>;
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
  startExternal(projectId: string, input: { sourceVersionId: string; rules?: Array<{ find: string; replace: string }>; requestId: string }, actorId?: string): WorkspaceTask;
  confirmExternal(projectId: string, versionId: string, input: { confirmedPaths: string[]; excludedPaths: string[] }): WorkspaceVersion;
  startPackages(projectId: string, input: { sourceVersionId: string; services: Array<'frontend' | 'backend'>; requestId: string }, actorId?: string): WorkspaceTask;
  packageFile(projectId: string, releaseId: string, service: string): { bytes: Uint8Array; name: string; mime: string };
  startImport(projectId: string, input: { repositoryUrl: string; branch?: string; requestId: string }, actorId?: string): WorkspaceTask;
  cancelTask(projectId: string, taskId: string): WorkspaceTask;
}
export class WorkspaceError extends Error { status: number; code: string; constructor(status: number, code: string, message: string); }
export interface WorkspaceAuthorization { authorizeTask?: (input: { actorId?: string; projectId: string; type: string }) => unknown }
export function createWorkspaceStore(options: WorkspaceAuthorization & { dataDir: string; taskLimits?: { maxConcurrent?: number; maxQueued?: number }; onTaskDiagnostic?: (event: { event: string; taskId: string; code: string }) => void }): WorkspaceStore;
export function configuredWorkspaceStore(options?: WorkspaceAuthorization): WorkspaceStore | undefined;

export function stopConfiguredWorkspaceStore(): void;
export function closeConfiguredWorkspaceStore(options?: {force?: boolean}): Promise<void>;
