import { useEffect, useMemo, useRef, useState } from 'react'
import { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'
import { useWorkspaceFileScroll } from './useWorkspaceFileScroll'
import type { ReadOnlyFileSource } from '~/components/files/readOnlyFileSource'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { usePrimaryEnvironmentId } from '~/state/environments'
import { readSelection, saveSelection } from './workspaceViewState'
import {
  loadWorkspaceTree,
  loadWorkspaceFileMetadata,
  searchWorkspaceFiles,
  workspaceFileDownloadUrl,
  type WorkspaceVersion,
} from './workspaces'

type FileView = { selected: string | null; trail?: string }
function fileView(projectId: string, versionId: string): FileView {
  try {
    const value = JSON.parse(
      readSelection(`${projectId}:files:${versionId}`) ?? 'null',
    ) as FileView | null
    return value && (value.selected === null || typeof value.selected === 'string')
      ? value
      : { selected: null }
  } catch {
    return { selected: null }
  }
}
export function WorkspaceFileBrowser({
  projectId,
  version,
  onRefresh,
}: {
  projectId: string
  version: WorkspaceVersion
  onRefresh?: () => void
}) {
  const environmentId = usePrimaryEnvironmentId()
  const [view, setView] = useState(() =>
    fileView(projectId, version.type === 'external' ? 'external' : version.id),
  )
  const root = useRef<HTMLElement | null>(null)
  useEffect(() => {
    saveSelection(
      `${projectId}:files:${version.type === 'external' ? 'external' : version.id}`,
      JSON.stringify(view),
    )
  }, [projectId, version.id, view])
  useWorkspaceFileScroll(
    root,
    `${projectId}:scroll:${version.id}:${view.selected ?? ''}`,
    environmentId,
  )
  const source = useMemo<ReadOnlyFileSource>(
    () => ({
      id: `management:${projectId}:${version.id}`,
      allowReferences: false,
      mentionPath: (path) => `autoops/${projectId}/workspaces/${version.id}/${path}`,
      list: (directory) => loadWorkspaceTree(projectId, version.id, directory),
      search: (query, limit) => searchWorkspaceFiles(projectId, version.id, query, limit),
      async metadata(path) {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        const directory = await loadWorkspaceTree(projectId, version.id, parent)
        const entry = directory.entries.find((item) => item.path === path)
        if (entry?.kind === 'directory') return { kind: 'directory' as const }
        const metadata = await loadWorkspaceFileMetadata(projectId, version.id, path)
        return {
          kind: 'file' as const,
          name: metadata.name,
          mimeType: metadata.mime,
          sizeBytes: metadata.size,
          url: workspaceFileDownloadUrl(projectId, version.id, path),
        }
      },
    }),
    [projectId, version.id],
  )
  if (!environmentId)
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>文件连接不可用</EmptyTitle>
          <EmptyDescription>请重新连接工作台后重试。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <section
      ref={root}
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      aria-label={`${version.name} 文件浏览`}
    >
      <ReadOnlyWorkspaceFiles
        environmentId={environmentId}
        cwd={source.id}
        projectName={version.name}
        relativePath={view.selected}
        source={source}
        compactNavigation
        onRefresh={onRefresh}
        folderTrail={view.trail}
        onOpenFile={(path) => setView({ selected: path })}
        onNavigateFolder={(path, trail) => setView({ selected: path || null, trail })}
      />
    </section>
  )
}
