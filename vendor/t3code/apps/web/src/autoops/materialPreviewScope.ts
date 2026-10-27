/** 预览只沿当前明确输入根目录导航，不能靠相似前缀跨目录。 */
export function workspacePreviewPathAllowed(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/')
}

export function workspaceInputRoot(path: string | null, projectId: string): string | null {
  if (!path || !/^[a-zA-Z0-9_-]+$/.test(projectId)) return null
  return new RegExp(`^autoops/${projectId}/inputs/[a-zA-Z0-9_-]+(?=/|$)`).exec(path)?.[0] ?? null
}

/** 当前文件别名只携带原身份；实际查看者与当前权限仍交给所有者裁决。 */
export function currentWorkspaceFileReference(path: string | null, projectId: string) {
  if (!path) return null
  const parts = path.split('/')
  if (
    parts[0] !== 'autoops' ||
    parts[1] !== projectId ||
    parts[2] !== 'current-input-files' ||
    parts.length < 7 ||
    parts.slice(3, 6).some((part) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(part)) ||
    parts
      .slice(6)
      .some(
        (part) =>
          !part || part === '.' || part === '..' || /[\\\p{Cc}\p{Cs}\u2028\u2029?#]/u.test(part),
      )
  )
    return null
  return { threadId: parts[3]!, inputId: parts[4]!, path: parts.slice(6).join('/') }
}

/** Historical threads retain file previews, not a route back to a host-directory browser. */
export function legacyPreviewPathAllowed(path: string | null, projectId: string): boolean {
  if (!path) return false
  const parts = path.split('/')
  return (
    parts[0] === 'autoops' &&
    parts[1] === projectId &&
    ((parts[2] === 'documents' && parts.length >= 5) ||
      (parts[2] === 'threads' &&
        ['attachments', 'reports'].includes(parts[4] ?? '') &&
        parts.length >= 7))
  )
}
