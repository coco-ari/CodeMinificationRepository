export interface SkillLibraryFile {
  path: string
  size: number
  sha256: string
  executable: boolean
  mime: string
  binary: boolean
}
export interface SkillLibrarySource {
  type: 'markdown' | 'archive' | 'git' | 'builtin' | 'legacy'
  url?: string
  commit?: string
  subdirectory?: string
  fileName?: string
}
export interface SkillLibraryVersion {
  id: string
  createdAt: string
  description: string
  displayName: string
  fileCount: number
  byteLength: number
  contentHash: string
  readiness: 'ready' | 'restricted'
  reason: string | null
  source: SkillLibrarySource
  files: SkillLibraryFile[]
  verifiedAt?: string
}
export interface SkillLibrarySkill {
  id: string
  name: string
  displayName: string
  description: string
  enabled: boolean
  createdAt: string
  deletedAt?: string
  builtin?: boolean
  latestVersionId: string
  versions: SkillLibraryVersion[]
}
export interface SkillLibraryAssignment {
  id: string
  skillId: string
  versionId: string
  targetType: 'global' | 'project' | 'assistant'
  targetId: string
  projectId?: string
  enabled: boolean
  createdAt: string
  updatedAt?: string
}
export interface SkillLibraryState {
  version: 3
  createdAt: string
  skills: SkillLibrarySkill[]
  assignments: SkillLibraryAssignment[]
}
export interface SkillLibraryCatalog {
  revision: string
  skills: SkillLibrarySkill[]
  assignments: SkillLibraryAssignment[]
}
export interface ResolvedLibrarySkill {
  id: string
  skillId: string
  name: string
  versionId: string
  contentHash: string
  packageRoot: string
  path: string
  description: string
  displayName: string
  enabled: boolean
  readiness: 'ready' | 'restricted'
  reason: string | null
  files: SkillLibraryFile[]
}
export class SkillLibraryError extends Error {
  constructor(status: number, code: string, message: string)
  status: number
  code: string
}
export function skillLibraryRevision(state: SkillLibraryState): string
export function readSkillLibrary(dataDirectory: string): SkillLibraryState
export function projectSkillDeletionReferences(
  dataDirectory: string,
  projectId: string,
  environmentId?: string,
): import('../../autoops/contracts/project-directory.ts').DeletionBlocker[]
export function resolveSkillLibrary(
  dataDirectory: string,
  scope: {
    projectId: string
    agentId: string
    workspaceType: 'internal' | 'external'
    assistantId?: string
    skillIds?: readonly string[]
    question?: { assistantId?: string; configuration: { skillIds: readonly string[] } }
  },
): ResolvedLibrarySkill[]
export function readSkillLibraryVersion(
  dataDirectory: string,
  skillId: string,
  versionId: string,
): ResolvedLibrarySkill & { instructions: string }
export function createSkillLibrary(dataDirectory: string): {
  catalog(): SkillLibraryCatalog
  removeAssignments(scope: { projectId?: string; assistantId?: string }): void
  importMarkdown(input: {
    revision: string
    contents: string
    skillId?: string
  }): SkillLibraryCatalog
  importArchive(input: {
    revision: string
    archiveBase64: string
    fileName?: string
    skillId?: string
  }): SkillLibraryCatalog
  importGit(input: {
    revision: string
    url: string
    ref: string
    subdirectory?: string
    skillId?: string
  }): Promise<SkillLibraryCatalog>
  setEnabled(input: { revision: string; skillId: string; enabled: boolean }): SkillLibraryCatalog
  assign(input: {
    revision: string
    skillId: string
    versionId: string
    targetType: 'global' | 'project' | 'assistant'
    targetId: string
    projectId?: string
    enabled?: boolean
  }): SkillLibraryCatalog
  unassign(input: { revision: string; assignmentId: string }): SkillLibraryCatalog
  remove(input: { revision: string; skillId: string }): SkillLibraryCatalog
  verify(input: { revision: string; skillId: string; versionId: string }): SkillLibraryCatalog
  readFile(
    skillId: string,
    versionId: string,
    path: string,
    raw: true,
  ): { name: string; mime: string; bytes: Buffer }
  readFile(
    skillId: string,
    versionId: string,
    path: string,
    raw?: false,
  ): {
    path: string
    contents: string | null
    encoding: 'binary' | 'utf8'
    size: number
    mime: string
    reason?: string
  }
}
