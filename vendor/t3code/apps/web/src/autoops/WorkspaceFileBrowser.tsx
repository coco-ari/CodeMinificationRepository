import { useEffect, useMemo, useRef, useState } from 'react'
import { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'
import { fileScrollViewports } from '~/components/files/fileSurfaceChrome'
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
}: {
  projectId: string
  version: WorkspaceVersion
}) {
  const environmentId = usePrimaryEnvironmentId()
  const [view, setView] = useState(() => fileView(projectId, version.id))
  const root = useRef<HTMLElement | null>(null)
  useEffect(() => {
    saveSelection(`${projectId}:files:${version.id}`, JSON.stringify(view))
  }, [projectId, version.id, view])
  useEffect(() => {
    const element = root.current
    if (!element) return
    const key = `${projectId}:scroll:${version.id}:${view.selected ?? ''}`
    let saved: Array<{ top: number; left: number }> = []
    try {
      const parsed: unknown = JSON.parse(readSelection(key) ?? '[]')
      saved = Array.isArray(parsed)
        ? parsed.filter(
            (entry) =>
              entry &&
              typeof entry.top === 'number' &&
              Number.isFinite(entry.top) &&
              entry.top >= 0 &&
              typeof entry.left === 'number' &&
              Number.isFinite(entry.left) &&
              entry.left >= 0,
          )
        : []
    } catch {
      /* 无效的历史位置不影响当前浏览。 */
    }
    const restoredVertical = new WeakSet<HTMLElement>()
    const restoredHorizontal = new WeakSet<HTMLElement>()
    const observed = new WeakSet<Element>()
    let interrupted = false
    const viewports = () => fileScrollViewports(element)
    const restore = () => {
      if (interrupted) return
      viewports().forEach((viewport, index) => {
        // 原生代码预览异步绘制并调整高度，需等可滚动范围就绪后再恢复。
        for (const target of [viewport, viewport.firstElementChild]) {
          if (target && !observed.has(target)) {
            observed.add(target)
            resizeObserver.observe(target)
          }
        }
        const position = saved[index]
        if (!position) return
        // 窗口尺寸或换行变化后，分别钳制两轴；内容继续绘制时仍可恢复原位置。
        if (!restoredVertical.has(viewport)) {
          const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
          viewport.scrollTop = Math.min(position.top, maxTop)
          if (position.top <= maxTop) restoredVertical.add(viewport)
        }
        if (!restoredHorizontal.has(viewport)) {
          const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
          viewport.scrollLeft = Math.min(position.left, maxLeft)
          if (position.left <= maxLeft) restoredHorizontal.add(viewport)
        }
      })
    }
    const remember = () => {
      if (!interrupted && saved.length > viewports().length) return
      if (
        interrupted ||
        viewports().every(
          (viewport, index) =>
            !saved[index] || (restoredVertical.has(viewport) && restoredHorizontal.has(viewport)),
        )
      )
        saveSelection(
          key,
          JSON.stringify(
            viewports().map((viewport) => ({ top: viewport.scrollTop, left: viewport.scrollLeft })),
          ),
        )
    }
    const interact = () => {
      interrupted = true
    }
    const resizeObserver = new ResizeObserver(restore)
    const observer = new MutationObserver(restore)
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    element.addEventListener('scroll', remember, true)
    element.addEventListener('wheel', interact, { passive: true })
    element.addEventListener('pointerdown', interact, { passive: true })
    element.addEventListener('keydown', interact)
    restore()
    return () => {
      observer.disconnect()
      resizeObserver.disconnect()
      element.removeEventListener('scroll', remember, true)
      element.removeEventListener('wheel', interact)
      element.removeEventListener('pointerdown', interact)
      element.removeEventListener('keydown', interact)
    }
  }, [projectId, version.id, view.selected, environmentId])
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
        folderTrail={view.trail}
        onOpenFile={(path) => setView({ selected: path })}
        onNavigateFolder={(path, trail) => setView({ selected: path || null, trail })}
      />
    </section>
  )
}
