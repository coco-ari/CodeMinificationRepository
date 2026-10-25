import { useMemo } from 'react'
import {
  customerFileReference,
  customerFilePathForTarget,
  type ScopedThreadRef,
} from '@t3tools/contracts'
import { ContextChip } from '~/components/ContextChip'
import { FileTagChipContent } from '~/components/chat/FileTagChip'
import type { FilePreviewPanelProps } from '~/components/files/FilePreviewPanel'
import { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'
import type { ReadOnlyFileSource } from '~/components/files/readOnlyFileSource'
import { FileSurfaceFailure } from '~/components/files/fileSurfaceChrome'
import { useComposerHandleContext } from '~/composerHandleContext'
import { useMediaQuery } from '~/hooks/useMediaQuery'
import { useRenderedAppearance } from '~/hooks/useTheme'
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from '~/rightPanelLayout'
import { useRightPanelStore } from '~/rightPanelStore'
import { Button } from '~/components/ui/button'
import { Menu, MenuTrigger, MenuPopup, MenuItem } from '~/components/ui/menu'
import { PaperclipIcon, FolderOpenIcon, UploadIcon } from 'lucide-react'
import type { AutoOpsThreadScope } from './hostConfig'
import { customerFilesCwd, readCustomerFiles } from './customerFiles'

export function CustomerFileAttachMenu(props: { onUpload: () => void; onBrowse: () => void }) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="icon-sm" aria-label="添加文件" />}
      >
        <PaperclipIcon />
      </MenuTrigger>
      <MenuPopup align="end" side="top">
        <MenuItem onClick={props.onUpload}>
          <UploadIcon />
          上传文件
        </MenuItem>
        <MenuItem onClick={props.onBrowse}>
          <FolderOpenIcon />
          引用电脑文件
        </MenuItem>
      </MenuPopup>
    </Menu>
  )
}

/** 客户文件只提供受限读取，布局、目录导航和引用操作复用问答文件面板。 */
export function CustomerFilePanel(props: FilePreviewPanelProps & { scope: AutoOpsThreadScope }) {
  const { scope, threadRef } = props
  const target = scope.executionBinding
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY)
  const composer = useComposerHandleContext()
  const cwd = customerFilesCwd(scope)
  const source = useMemo<ReadOnlyFileSource>(
    () => ({
      id: `${cwd}/${threadRef.threadId}`,
      allowReferences: true,
      allowExpandAll: false,
      directoryConcurrency: 1,
      mentionPath: (path) => {
        if (target?.kind !== 'customer') throw new Error('请选择客户工作区')
        return customerFileReference(target, path)
      },
      list: (path, signal) =>
        readCustomerFiles(scope, threadRef.threadId, { operation: 'list', path }, signal),
      search: (query, _limit, signal) =>
        readCustomerFiles(scope, threadRef.threadId, { operation: 'search', query }, signal),
      metadata: async (path, signal) => {
        const value = await readCustomerFiles(
          scope,
          threadRef.threadId,
          { operation: 'preview', path },
          signal,
        )
        if (!value.preview || value.preview.path !== path) throw new Error('电脑返回的文件预览无效')
        return {
          kind: 'file',
          name: path.split('/').at(-1)!,
          mimeType: 'application/octet-stream',
          sizeBytes: value.preview.size,
          preview: { ...value.preview, truncated: value.truncated },
        }
      },
    }),
    [cwd, scope, target, threadRef.threadId],
  )
  if (!cwd || target?.kind !== 'customer') return <FileSurfaceFailure message="请选择客户工作区" />
  const relative = props.relativePath ? customerFilePathForTarget(props.relativePath, target) : null
  if (props.relativePath && !relative)
    return <FileSurfaceFailure message="此文件不属于当前电脑工作区。" />
  const trail = props.folderTrail
    ? (customerFilePathForTarget(props.folderTrail, target) ?? undefined)
    : undefined
  const canonical = (path: string) => (path ? customerFileReference(target, path) : '')
  return (
    <ReadOnlyWorkspaceFiles
      environmentId={props.environmentId}
      cwd={cwd}
      projectName="电脑文件"
      relativePath={relative}
      source={source}
      threadRef={threadRef}
      revealRequestId={props.revealRequestId}
      // 面包屑保留已打开文件的下级路径，目录导航不额外读取父目录或文件正文。
      knownDirectory={relative === null || !!trail?.startsWith(`${relative}/`)}
      folderTrail={trail}
      onOpenFile={(path) => props.onOpenFile(canonical(path))}
      onNavigateFolder={(path, nextTrail, keepSource) =>
        props.onNavigateFolder(canonical(path), canonical(nextTrail), keepSource)
      }
      onReferenceAdded={() => {
        if (sheet) useRightPanelStore.getState().close(threadRef)
        requestAnimationFrame(() => composer?.current?.focusAtEnd())
      }}
    />
  )
}

export function CustomerFileLink(props: {
  scope: AutoOpsThreadScope
  threadRef: ScopedThreadRef
  path: string
  copyMarkdown: string
}) {
  const theme = useRenderedAppearance()
  const target = props.scope.executionBinding
  const path = target?.kind === 'customer' ? customerFilePathForTarget(props.path, target) : null
  if (!path) return <span>{props.path.split('/').at(-1)}</span>
  return (
    <ContextChip
      kind="mention"
      data-markdown-copy={props.copyMarkdown}
      render={
        <button
          type="button"
          aria-label={`预览 ${path.split('/').at(-1)}`}
          onClick={() => useRightPanelStore.getState().openFile(props.threadRef, props.path)}
        />
      }
    >
      <FileTagChipContent path={path} label={path.split('/').at(-1)!} theme={theme} />
    </ContextChip>
  )
}
