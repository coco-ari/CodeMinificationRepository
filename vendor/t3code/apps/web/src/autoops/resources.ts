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
  return scope
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
      `^(?:files/${segment}|attachments/${segment}|skills/${segment}|projects/${segment}/documents/${segment})$`,
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
