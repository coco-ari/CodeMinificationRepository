import type { AutoOpsThreadScope } from './hostConfig'

type WorkspacePathScope = Pick<
  AutoOpsThreadScope,
  'projectId' | 'workspaceType' | 'workspaceVersionId'
>

const unsafePathCharacters = /[\\\p{Cc}\p{Cs}\u2028\u2029]/u

function validRelativePath(path: string, allowTrailingSlash = false): boolean {
  if (!path || unsafePathCharacters.test(path)) return false
  const parts = path.split('/')
  if (allowTrailingSlash && parts.at(-1) === '') parts.pop()
  return parts.length > 0 && parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/** 当前候选使用不可变输入身份，显式旧引用只接受原绑定版本。 */
export function workspaceRelativePath(
  path: string,
  scope: WorkspacePathScope | undefined,
): string | null {
  if (
    !scope ||
    !['internal', 'external'].includes(scope.workspaceType ?? '') ||
    !/^[a-zA-Z0-9_-]+$/.test(scope.projectId)
  )
    return null
  const currentPrefix = new RegExp(
    `^autoops/${scope.projectId}/(?:inputs/[a-zA-Z0-9_-]+|current-input-files/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+)/`,
  ).exec(path)?.[0]
  const prefix =
    currentPrefix ??
    (scope.workspaceVersionId && /^[a-zA-Z0-9_-]+$/.test(scope.workspaceVersionId)
      ? `autoops/${scope.projectId}/workspaces/${scope.workspaceVersionId}/`
      : null)
  if (!prefix || !path.startsWith(prefix)) return null
  const relative = path.slice(prefix.length)
  return validRelativePath(relative) ? relative : null
}

/** Keep a partial path editable; a quoted query deliberately has no closing quote. */
export function formatWorkspacePathQuery(relativePath: string): string | null {
  const path = relativePath.startsWith('./') ? relativePath.slice(2) : relativePath
  if (!validRelativePath(path, true)) return null
  return /[\s"@]/u.test(relativePath)
    ? `@"${relativePath.replaceAll('"', '\\"')}`
    : `@${relativePath}`
}

/** Extend ambiguous Linux-style candidates without implicitly selecting the first one. */
export function completeWorkspaceCommonPrefix(
  entries: readonly { path: string; kind: 'file' | 'directory' }[],
  query: string,
  scope: WorkspacePathScope | undefined,
  options?: { truncated?: boolean },
): string | null {
  if (options?.truncated || entries.length < 2) return null
  const explicitRelative = query.startsWith('./')
  const relativeQuery = explicitRelative ? query.slice(2) : query
  if (relativeQuery && !validRelativePath(relativeQuery, true)) return null
  const candidates: string[][] = []
  let referenceRoot: string | undefined
  for (const entry of entries) {
    const relative = workspaceRelativePath(entry.path, scope)
    if (relative === null) return null
    const root = entry.path.slice(0, entry.path.length - relative.length)
    if (referenceRoot && referenceRoot !== root) return null
    referenceRoot = root
    candidates.push(Array.from(relative + (entry.kind === 'directory' ? '/' : '')))
  }
  const first = candidates[0]!
  let length = first.length
  for (const candidate of candidates.slice(1)) {
    let index = 0
    while (index < length && candidate[index] === first[index]) index++
    length = index
  }
  const common = first.slice(0, length).join('')
  if (!common.startsWith(relativeQuery) || common.length <= relativeQuery.length) return null
  return formatWorkspacePathQuery((explicitRelative ? './' : '') + common)
}
