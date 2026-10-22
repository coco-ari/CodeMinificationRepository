/** A preview follows the conversation's fixed version, even when the user can read other versions. */
export function workspacePreviewPathAllowed(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/')
}

/** Historical threads retain file previews, not a route back to a host-directory browser. */
export function legacyPreviewPathAllowed(path: string | null, projectId: string): boolean {
  if (!path) return false
  const parts = path.split('/')
  return parts[0] === 'autoops' && parts[1] === projectId && (
    (parts[2] === 'documents' && parts.length >= 5) ||
    (parts[2] === 'threads' && ['attachments', 'reports'].includes(parts[4] ?? '') && parts.length >= 7)
  )
}
