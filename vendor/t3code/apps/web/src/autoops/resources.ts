import { readAutoOpsHost, readAutoOpsThreadScope, type AutoOpsThreadScope } from './hostConfig'
import { formatWorkspacePathQuery, workspaceRelativePath } from './pathCompletion'

/** A directory stays editable until a file or folder is explicitly committed as a reference. */
export function autoOpsWorkspaceDirectoryCompletion(
  path: string,
  scope: Pick<AutoOpsThreadScope, 'projectId' | 'workspaceType' | 'workspaceVersionId'> | undefined,
): string | null {
  const relative = workspaceRelativePath(path.replace(/\/$/u, ''), scope)
  return relative === null ? null : formatWorkspacePathQuery(`${relative}/`)
}

/** Display workspace-relative directories while keeping resource identities canonical. */
export function autoOpsResourcePathDescription(
  path: string,
  scope: Pick<AutoOpsThreadScope, 'projectId' | 'workspaceVersionId'> | undefined,
): string {
  const prefix = scope?.workspaceVersionId
    ? `autoops/${scope.projectId}/workspaces/${scope.workspaceVersionId}/`
    : undefined
  const displayPath = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
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
  if (parts.length > 2 && !['documents', 'environments', 'threads', 'workspaces'].includes(parts[2] ?? ''))
    return null
  return path
}
export function autoOpsResourceCwd(
  threadId: string | null,
  projectId: string | undefined,
  scopeOverride?: AutoOpsThreadScope,
): string | null {
  if (!threadId || !projectId || !readAutoOpsHost()) return null
  const scope = scopeOverride ?? readAutoOpsThreadScope(threadId, projectId)
  return scope && scope.executionBinding?.kind !== 'customer'
    ? `autoops://projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(scope.environmentId)}/threads/${encodeURIComponent(threadId)}${scope.workspaceType && scope.workspaceVersionId ? `?workspaceType=${scope.workspaceType}&workspaceVersionId=${encodeURIComponent(scope.workspaceVersionId)}` : ''}`
    : null
}
export function isAutoOpsResourceCwd(value: string | null): boolean {
  return (
    !!readAutoOpsHost() &&
    !!value &&
    /^autoops:\/\/projects\/[a-zA-Z0-9_-]+\/environments\/[a-zA-Z0-9_-]+\/threads\/[a-zA-Z0-9_-]+(?:\?workspaceType=(?:internal|external)&workspaceVersionId=[a-zA-Z0-9_-]+)?$/.test(
      value,
    )
  )
}
export function isAutoOpsWorkspaceResourceCwd(value: string | null): boolean {
  return isAutoOpsResourceCwd(value) && !!value &&
    /\?workspaceType=(?:internal|external)&workspaceVersionId=[a-zA-Z0-9_-]+$/.test(value)
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
    const scopedSkill = new RegExp(`^${host.gatewayBasePath}/autoops/skill-library/contexts/([a-f0-9]{64})/files/(autoops-[a-z][a-z0-9-]*)$`).exec(url.pathname)
    if (scopedSkill) {
      if ([...url.searchParams.keys()].some((key) => key !== 'path') || url.searchParams.getAll('path').length !== 1) return null
      const path = url.searchParams.get('path') ?? ''
      if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..' || /[\\\x00-\x1f?#]/u.test(part))) return null
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
  if (!new RegExp(`^${host.gatewayBasePath}/autoops/skill-library/contexts/[a-f0-9]{64}/files/autoops-[a-z][a-z0-9-]*$`).test(resource.pathname)) return null
  // Complete business identities are handled by ChatMarkdown's resource link,
  // including root-relative URLs. Its native opener rechecks server permission.
  if (autoOpsResourceUrl(href)) return null
  const resolved = autoOpsSkillPackageLink(resource.searchParams.get('path') ?? '', href)
  if (!resolved || 'error' in resolved) return resolved
  const target = resolved.path
  const url = autoOpsResourceUrl(`${resource.pathname}?path=${encodeURIComponent(target)}`)
  return url ? { url, path: target } : { error: '此链接不属于当前技能包。' }
}
