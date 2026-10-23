/** 预览只沿当前明确输入根目录导航，不能靠相似前缀跨目录。 */
export function workspacePreviewPathAllowed(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/')
}

export function workspaceInputRoot(path: string | null, projectId: string): string | null {
  if (!path || !/^[a-zA-Z0-9_-]+$/.test(projectId)) return null
  return new RegExp(`^autoops/${projectId}/inputs/[a-zA-Z0-9_-]+(?=/|$)`).exec(path)?.[0] ?? null
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
