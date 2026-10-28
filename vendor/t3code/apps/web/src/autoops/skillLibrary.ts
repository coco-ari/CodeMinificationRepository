import {
  effectiveSkillAssignment,
  GLOBAL_SKILL_TARGET,
} from '../../../../../../autoops/contracts/skill-scope.mjs'
export { effectiveSkillAssignment, GLOBAL_SKILL_TARGET }
export const skillScopeNames = {
  global: '所有项目',
  project: '当前项目',
  assistant: '指定助手',
} as const
import type { ProjectListEntriesResult, ServerProviderSkill } from '@t3tools/contracts'
import type { ReadOnlyFileSource } from '~/components/files/readOnlyFileSource'
import { autoOpsApiUrl, autoOpsRequest } from './apiClient'
import { autoOpsSkillPackageLink } from './resources'

export type SkillWorkspaceType = 'internal' | 'external'
export type SkillTargetType = 'global' | 'project' | 'assistant'
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
  projectId?: string
  enabled: boolean
}
export interface SkillLibrary {
  revision: string
  canManage: boolean
  skills: LibrarySkill[]
  assignments: SkillAssignment[]
  projects: Array<{ id: string; name: string; canManage: boolean }>
  assistants: Array<{
    id: string
    name: string
    projectId: string
    executionKind: 'platform' | 'customer'
  }>
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
      projectId?: string
      enabled?: boolean
    }
  | { action: 'unassign'; assignmentId: string }
  | { action: 'delete'; skillId: string }
  | { action: 'verify'; skillId: string; versionId: string }

const base = () => autoOpsApiUrl('/autoops/skill-library')
const request = (
  body?: SkillLibraryAction & { revision: string },
  signal?: AbortSignal,
  projectId?: string,
) =>
  autoOpsRequest<SkillLibrary>(
    `/autoops/skill-library${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    {
      label: 'skills',
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    },
  )

export const loadSkillLibrary = (signal?: AbortSignal, projectId?: string) =>
  request(undefined, signal, projectId)
export const changeSkillLibrary = (
  revision: string,
  action: SkillLibraryAction,
  projectId?: string,
) => request({ ...action, revision }, undefined, projectId)
export const skillVersionName = (version: SkillVersion) =>
  `${new Date(version.createdAt).toLocaleString('zh-CN')} · ${version.id.slice(0, 8)}`
export const skillSourceName = (source: SkillVersion['source']) =>
  ({
    markdown: 'SKILL.md',
    archive: 'ZIP skill包',
    git: 'Git 仓库',
    builtin: '内置skill',
    legacy: '原有skill',
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
    origin: 'skill文件',
    resolveLink: (fromPath, href) => {
      const resolved = autoOpsSkillPackageLink(fromPath, href)
      if (!resolved || 'error' in resolved) return resolved
      const target = entries.get(resolved.path)
      return target ?? { error: '当前skill版本中没有此文件，请从右侧目录查看。' }
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

export interface SkillContext {
  cwd: string
  snapshotId: string
  skills: { name: string; displayName?: string; description?: string; versionId: string }[]
}

/** 标签展示只依赖已授权快照；原生目录尚未发现新版本时也不清空已有标签。 */
export function skillContextDisplaySkills(
  context: SkillContext | null | undefined,
): ServerProviderSkill[] {
  return (
    context?.skills.map((skill) => ({
      name: skill.name,
      ...(skill.displayName ? { displayName: skill.displayName } : {}),
      ...(skill.description ? { description: skill.description } : {}),
      enabled: true,
      path: `${base()}/contexts/${encodeURIComponent(context.snapshotId)}/files/${encodeURIComponent(skill.name)}?path=SKILL.md`,
    })) ?? []
  )
}

/** 接受既有范围缓存键，统一处理同源、取消、预算及登录上下文校验。 */
export async function loadSkillContext(
  requestKey: string,
  signal?: AbortSignal,
): Promise<SkillContext> {
  const endpoint = autoOpsApiUrl('/autoops/skill-library/context')
  if (!requestKey.startsWith(endpoint + '?')) throw new Error('当前skill范围地址无效。')
  const path = '/autoops/skill-library/context' + requestKey.slice(endpoint.length)
  return autoOpsRequest(path, { label: '当前skill范围', ...(signal ? { signal } : {}) })
}

/** 上层开启时下层只显示继承，关闭上层不会丢失原下层设置。 */
export function inheritedSkillAssignment(
  catalog: SkillLibrary,
  skillId: string,
  type: SkillTargetType,
  projectId: string,
) {
  const effective = effectiveSkillAssignment(catalog.assignments, skillId, { projectId })
  return effective &&
    (type === 'assistant' || (type === 'project' && effective.targetType === 'global'))
    ? effective
    : undefined
}
export function canManageSkillScope(
  catalog: SkillLibrary,
  type: SkillTargetType,
  projectId: string,
) {
  return type === 'global'
    ? catalog.canManage
    : catalog.projects.some((project) => project.id === projectId && project.canManage)
}
