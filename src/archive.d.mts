export interface ArchiveProject {
  id: string
  repository: string
  branch: string
  revision?: string | null
}
export interface ArchiveCredential { username: string; password: string }
export interface ArchiveBuilderOptions { timeoutMs?: number; maxArchiveBytes?: number; allowLocal?: boolean }
export interface ArchiveCommit { revision: string; author: string; at: string; subject: string }
export interface ArchiveHistory { commits: ArchiveCommit[]; refreshedAt: string | null }
export interface ArchiveResult { file: string; revision: string; commitSubject: string; sha256: string; size: number; cached: boolean }
export function validateRepository(value: unknown): string
export function validateBranch(value: unknown): string
export function validateRevision(value: unknown): string
export function sourceKey(project: ArchiveProject): string
export function archiveKey(project: ArchiveProject): string
export class ArchiveBuilder {
  directory: string
  timeoutMs: number
  maxArchiveBytes: number
  allowLocal: boolean
  askpass?: string
  gitConfig?: string
  hooks?: string
  constructor(directory: string, options?: ArchiveBuilderOptions)
  initialize(): Promise<void>
  git(args: readonly string[], credential?: ArchiveCredential | null, signal?: AbortSignal): Promise<{ code: number | null; output: string }>
  root(project: ArchiveProject): string
  branches(project: ArchiveProject, credential?: ArchiveCredential | null): Promise<{ branches: Array<{ name: string; revision: string }>; defaultBranch: string | null; refreshedAt: string }>
  pinRevision(project: ArchiveProject, taskId: string): Promise<void>
  releasePin(project: ArchiveProject, taskId: string): Promise<void>
  cachedCommitSubject(project: ArchiveProject, revision: string): Promise<string | null>
  history(project: ArchiveProject, credential?: ArchiveCredential | null, refresh?: boolean): Promise<ArchiveHistory>
  build(project: ArchiveProject, credential?: ArchiveCredential | null, onPhase?: (phase: 'source_fetch' | 'source_resolve' | 'source_archive') => void | Promise<void>): Promise<ArchiveResult>
}
