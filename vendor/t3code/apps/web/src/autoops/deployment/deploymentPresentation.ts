import type { WorkspaceRelease } from '../workspaces'

export const errorLabel = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请重试。'
export const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN')
export const normalizeDirectory = (value: string | undefined) =>
  !value || value === '.' ? '.' : value.replace(/\/$/, '')
export function packageDirectory(release: WorkspaceRelease) {
  const manifest = release.manifest as {
    services?: Array<{ service: string; context?: { workingDirectory?: string } }>
  }
  return normalizeDirectory(
    manifest.services?.find((item) => item.service === 'frontend')?.context?.workingDirectory,
  )
}
