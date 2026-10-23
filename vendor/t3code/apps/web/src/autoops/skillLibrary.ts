import type { ProjectListEntriesResult } from '@t3tools/contracts'
import type { ReadOnlyFileSource } from '~/components/files/readOnlyFileSource'
import { autoOpsApiUrl, autoOpsRequest } from './apiClient'
import { autoOpsSkillPackageLink } from './resources'

export type SkillWorkspaceType = 'internal' | 'external'
export type SkillTargetType = 'agent' | 'project'
export interface SkillVersion {
  id: string
  createdAt: string
  fileCount: number
  readiness: 'ready' | 'restricted'
  reason: string | null
  contentHash: string
  byteLength: number
  source: {
    type: 'markdown' | 'archive' | 'git' | 'builtin' | 'legacy'
    url?: string
    commit?: string
    subdirectory?: string
    fileName?: string
  }
  files: Array<{ path: string; size: number; sha256: string; mime: string; binary: boolean }>
}
export interface LibrarySkill {
  id: string
  name: string
  displayName: string
  description: string
  enabled: boolean
  versions: SkillVersion[]
  latestVersionId: string
}
export interface SkillAssignment {
  id: string
  targetType: SkillTargetType
  targetId: string
  skillId: string
  versionId: string
  workspaceTypes: SkillWorkspaceType[]
  enabled: boolean
}
export interface SkillLibrary {
  revision: string
  canManage: boolean
  skills: LibrarySkill[]
  assignments: SkillAssignment[]
  projects: Array<{ id: string; name: string }>
  agents: Array<{ id: string; name: string; projectIds: string[] }>
}
export type SkillLibraryAction =
  | { action: 'import-markdown'; contents: string; skillId?: string }
  | { action: 'import-archive'; archiveBase64: string; fileName: string; skillId?: string }
  | { action: 'import-git'; url: string; subdirectory?: string; ref: string; skillId?: string }
  | { action: 'set-enabled'; skillId: string; enabled: boolean }
  | {
      action: 'assign'
      skillId: string
      versionId: string
      targetType: SkillTargetType
      targetId: string
      workspaceTypes: SkillWorkspaceType[]
      enabled?: boolean
    }
  | { action: 'unassign'; assignmentId: string }
  | { action: 'delete'; skillId: string }
  | { action: 'verify'; skillId: string; versionId: string }

const base = () => autoOpsApiUrl('/autoops/skill-library')
const request = (body?: SkillLibraryAction & { revision: string }, signal?: AbortSignal) =>
  autoOpsRequest<SkillLibrary>('/autoops/skill-library', { label: '技能库', ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}) })

export const loadSkillLibrary = (signal?: AbortSignal) => request(undefined, signal)
export const changeSkillLibrary = (revision: string, action: SkillLibraryAction) =>
  request({ ...action, revision })
export const skillVersionName = (version: SkillVersion) =>
  `${new Date(version.createdAt).toLocaleString('zh-CN')} · ${version.id.slice(0, 8)}`
export const skillSourceName = (source: SkillVersion['source']) =>
  ({
    markdown: 'SKILL.md',
    archive: 'ZIP 技能包',
    git: 'Git 仓库',
    builtin: '内置技能',
    legacy: '原有技能',
  })[source.type]
export const skillVersion = (skill: LibrarySkill, id?: string) =>
  skill.versions.find((version) => version.id === (id ?? skill.latestVersionId)) ??
  skill.versions[0]
export function skillFileSource(skill: LibrarySkill, version: SkillVersion): ReadOnlyFileSource {
  const entries = new Map<string, { path: string; kind: 'file' | 'directory' }>()
  for (const file of version.files) {
    entries.set(file.path, { path: file.path, kind: 'file' })
    const parts = file.path.split('/')
    for (let length = 1; length < parts.length; length++) {
      const path = parts.slice(0, length).join('/')
      entries.set(path, { path, kind: 'directory' })
    }
  }
  const sorted = [...entries.values()].sort((a, b) =>
    a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1,
  )
  const result = (values: typeof sorted, limit = values.length): ProjectListEntriesResult => ({
    entries: values.slice(0, limit),
    truncated: values.length > limit,
  })
  return {
    id: `skill-library:${skill.id}:${version.id}`,
    allowReferences: false,
    origin: '技能文件',
    resolveLink: (fromPath, href) => {
      const resolved = autoOpsSkillPackageLink(fromPath, href)
      if (!resolved || 'error' in resolved) return resolved
      const target = entries.get(resolved.path)
      return target ?? { error: '当前技能版本中没有此文件，请从右侧目录查看。' }
    },
    mentionPath: (path) => path,
    list: async (directory) =>
      result(
        sorted.filter(
          (entry) =>
            (entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '') ===
            directory,
        ),
      ),
    search: async (query, limit) =>
      result(
        sorted.filter((entry) =>
          entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        ),
        limit,
      ),
    metadata: async (path) => {
      if (entries.get(path)?.kind === 'directory') return { kind: 'directory' }
      const file = version.files.find((entry) => entry.path === path)
      if (!file) throw new Error('此版本中没有该文件，请刷新后重试。')
      return {
        kind: 'file',
        name: path.split('/').at(-1) ?? path,
        mimeType: file.mime,
        sizeBytes: file.size,
        url: `${base()}/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(version.id)}/content?path=${encodeURIComponent(path)}&raw=1`,
      }
    },
  }
}
