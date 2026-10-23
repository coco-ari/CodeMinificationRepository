import { autoOpsRequest } from './apiClient'
import { readAutoOpsHost, readAutoOpsThreadScope, type AutoOpsThreadScope } from './hostConfig'
import { formatWorkspacePathQuery, workspaceRelativePath } from './pathCompletion'

/** 目录补全保持可编辑，只有明确选择后才提交固定文件引用。 */
export function autoOpsWorkspaceDirectoryCompletion(
  path: string,
  scope: Pick<AutoOpsThreadScope, 'projectId' | 'workspaceType' | 'workspaceVersionId'> | undefined,
): string | null {
  const relative = workspaceRelativePath(path.replace(/\/$/u, ''), scope)
  return relative === null ? null : formatWorkspacePathQuery(`${relative}/`)
}

/** 展示工作区相对目录，资源身份仍保留完整输入标识。 */
export function autoOpsResourcePathDescription(
  path: string,
  scope: Pick<AutoOpsThreadScope, 'projectId' | 'workspaceVersionId'> | undefined,
): string {
  const relative = workspaceRelativePath(
    path,
    scope ? { ...scope, workspaceType: 'internal' } : undefined,
  )
  const displayPath = relative ?? path
  return displayPath.slice(0, Math.max(0, displayPath.lastIndexOf('/')))
}

export function autoOpsBusinessPath(value: string | undefined): string | null {
  if (!value) return null
  let path: string
  try {
    path = decodeURIComponent(value).replace(/^\//, '')
  } catch {
    return null
  }
  const parts = path.split('/')
  if (
    parts[0] !== 'autoops' ||
    (parts.length > 1 && !/^[a-zA-Z0-9_-]+$/.test(parts[1] ?? '')) ||
    parts.some((part) => !part || part === '.' || part === '..' || /[\\\x00-\x1f?#]/.test(part))
  )
    return null
  if (
    parts.length > 2 &&
    !['documents', 'environments', 'threads', 'workspaces', 'inputs'].includes(parts[2] ?? '')
  )
    return null
  return path
}
export function autoOpsResourceCwd(
  threadId: string | null,
  projectId: string | undefined,
  scopeOverride?: AutoOpsThreadScope,
  historicalVersionId?: string,
): string | null {
  if (!threadId || !projectId || !readAutoOpsHost()) return null
  const scope = scopeOverride ?? readAutoOpsThreadScope(threadId, projectId)
  if (historicalVersionId && historicalVersionId !== scope?.workspaceVersionId) return null
  // 日常浏览跟随当前资料，只有显式历史引用才恢复原版本目录。
  return scope && scope.executionBinding?.kind !== 'customer'
    ? `autoops://projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(scope.environmentId)}/threads/${encodeURIComponent(threadId)}${scope.workspaceType ? `?workspaceType=${scope.workspaceType}${historicalVersionId ? `&workspaceVersionId=${encodeURIComponent(historicalVersionId)}` : ''}` : ''}`
    : null
}
export function isAutoOpsResourceCwd(value: string | null): boolean {
  return (
    !!readAutoOpsHost() &&
    !!value &&
    /^autoops:\/\/projects\/[a-zA-Z0-9_-]+\/environments\/[a-zA-Z0-9_-]+\/threads\/[a-zA-Z0-9_-]+(?:\?workspaceType=(?:internal|external)(?:&workspaceVersionId=[a-zA-Z0-9_-]+|&inputId=[a-zA-Z0-9_-]+)?)?$/.test(
      value,
    )
  )
}
export function isAutoOpsWorkspaceResourceCwd(value: string | null): boolean {
  return (
    isAutoOpsResourceCwd(value) &&
    !!value &&
    /\?workspaceType=(?:internal|external)(?:&workspaceVersionId=[a-zA-Z0-9_-]+|&inputId=[a-zA-Z0-9_-]+)?$/.test(
      value,
    )
  )
}
export function autoOpsResourceRequestUrl(url: string, mode: 'metadata' | 'inline'): string {
  const target = new URL(url, readAutoOpsHost()?.httpBaseUrl)
  target.searchParams.set(mode, '1')
  return target.pathname + target.search
}

const resourceIdPrefix = 'autoops-resource:'
/** Restrict this transport adapter to existing authorized business endpoints. */
export function autoOpsResourceUrl(value: string | undefined): string | null {
  const host = readAutoOpsHost()
  if (!host || !value) return null
  const businessPath = autoOpsBusinessPath(value)
  if (businessPath)
    return `${host.gatewayBasePath}/autoops/resources?path=${encodeURIComponent(businessPath)}`
  try {
    const url = new URL(value, host.httpBaseUrl)
    if (url.origin !== new URL(host.httpBaseUrl).origin || url.hash) return null
    if (url.pathname === `${host.gatewayBasePath}/autoops/resources`) {
      if (
        [...url.searchParams.keys()].some((key) => key !== 'path') ||
        url.searchParams.getAll('path').length !== 1
      )
        return null
      const path = autoOpsBusinessPath(url.searchParams.get('path') ?? undefined)
      return path ? `${url.pathname}?path=${encodeURIComponent(path)}` : null
    }
    const scopedSkill = new RegExp(
      `^${host.gatewayBasePath}/autoops/skill-library/contexts/([a-f0-9]{64})/files/(autoops-[a-z][a-z0-9-]*)$`,
    ).exec(url.pathname)
    if (scopedSkill) {
      if (
        [...url.searchParams.keys()].some((key) => key !== 'path') ||
        url.searchParams.getAll('path').length !== 1
      )
        return null
      const path = url.searchParams.get('path') ?? ''
      if (
        !path ||
        path.startsWith('/') ||
        path
          .split('/')
          .some((part) => !part || part === '.' || part === '..' || /[\\\x00-\x1f?#]/u.test(part))
      )
        return null
      return `${url.pathname}?path=${encodeURIComponent(path)}`
    }
    if (url.search) return null
    const segment = '[a-zA-Z0-9_-]+'
    const legacy = new RegExp(
      `^/api/agent-demo/projects/(${segment})/documents/(${segment})$`,
    ).exec(url.pathname)
    if (legacy)
      return `${host.gatewayBasePath}/autoops/projects/${legacy[1]}/documents/${legacy[2]}`
    const suffix = url.pathname.startsWith(`${host.gatewayBasePath}/autoops/`)
      ? url.pathname.slice(`${host.gatewayBasePath}/autoops/`.length)
      : ''
    return new RegExp(
      `^(?:files/${segment}|attachments/${segment}|projects/${segment}/documents/${segment})$`,
    ).test(suffix)
      ? url.pathname
      : null
  } catch {
    return null
  }
}
export function autoOpsResourceAttachmentId(url: string): string {
  return resourceIdPrefix + encodeURIComponent(url)
}
export function autoOpsResourceFromAttachmentId(id: string | undefined): string | null {
  if (!id?.startsWith(resourceIdPrefix)) return null
  try {
    return autoOpsResourceUrl(decodeURIComponent(id.slice(resourceIdPrefix.length)))
  } catch {
    return null
  }
}

/** Shared package-relative Markdown semantics for the library and native tabs. */
export function autoOpsSkillPackageLink(
  fromPath: string,
  href: string,
): { path: string } | { error: string } | null {
  // Same-document anchors and explicit external URLs retain T3's native behavior.
  if (!href || href.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return null
  let path: string
  try {
    path = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? '')
  } catch {
    return { error: '文件链接编码无效。' }
  }
  if (!path || path.startsWith('/') || /[\\\u0000-\u001f]/.test(path))
    return { error: '此链接不属于当前技能包。' }
  const parts = fromPath.split('/').slice(0, -1)
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return { error: '此链接超出了当前技能包。' }
      parts.pop()
    } else parts.push(part)
  }
  return { path: parts.join('/') }
}

/** The authorized metadata endpoint verifies existence before a tab opens. */
export function autoOpsSkillResourceLink(
  sourceUrl: string | null | undefined,
  href: string,
): { url: string; path: string } | { error: string } | null {
  const source = autoOpsResourceUrl(sourceUrl ?? undefined)
  const host = readAutoOpsHost()
  if (!source || !host) return null
  const resource = new URL(source, host.httpBaseUrl)
  if (
    !new RegExp(
      `^${host.gatewayBasePath}/autoops/skill-library/contexts/[a-f0-9]{64}/files/autoops-[a-z][a-z0-9-]*$`,
    ).test(resource.pathname)
  )
    return null
  // Complete business identities are handled by ChatMarkdown's resource link,
  // including root-relative URLs. Its native opener rechecks server permission.
  if (autoOpsResourceUrl(href)) return null
  const resolved = autoOpsSkillPackageLink(resource.searchParams.get('path') ?? '', href)
  if (!resolved || 'error' in resolved) return resolved
  const target = resolved.path
  const url = autoOpsResourceUrl(`${resource.pathname}?path=${encodeURIComponent(target)}`)
  return url ? { url, path: target } : { error: '此链接不属于当前技能包。' }
}

/** 元数据只从既有资源白名单读取；文件字节继续交给原生查看器。 */
export async function loadAutoOpsResourceMetadata(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<{ name: string; mime: string; size: number }> {
  const url = autoOpsResourceUrl(sourceUrl)
  const host = readAutoOpsHost()
  if (!url || !host) throw new Error('文件不可用或当前账号没有访问权限。')
  const path = autoOpsResourceRequestUrl(url, 'metadata').slice(host.gatewayBasePath.length)
  const file = await autoOpsRequest<{ name?: unknown; mime?: unknown; size?: unknown }>(path, {
    label: '文件信息',
    ...(signal ? { signal } : {}),
  })
  if (
    typeof file.name !== 'string' ||
    typeof file.mime !== 'string' ||
    typeof file.size !== 'number' ||
    !Number.isFinite(file.size) ||
    file.size < 0
  )
    throw new Error('文件信息不可用，请重试。')
  return { name: file.name, mime: file.mime, size: file.size }
}
