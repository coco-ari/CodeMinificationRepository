import type { ComponentProps } from 'react'
import type { ScopedThreadRef } from '@t3tools/contracts'
import { useRightPanelStore } from '~/rightPanelStore'
import { toastManager } from '~/components/ui/toast'
import {
  autoOpsResourceAttachmentId,
  autoOpsResourceUrl,
  autoOpsResourceRequestUrl,
} from './resources'

export async function openAutoOpsResource(
  sourceUrl: string,
  threadRef: ScopedThreadRef,
): Promise<void> {
  const url = autoOpsResourceUrl(sourceUrl)
  if (!url) return
  const resourcePath = new URL(url, window.location.origin).searchParams.get('path')
  if (resourcePath) {
    useRightPanelStore.getState().openFile(threadRef, resourcePath)
    return
  }
  try {
    const response = await fetch(autoOpsResourceRequestUrl(url, 'metadata'), {
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error('文件不可用或当前账号没有访问权限。')
    const file = (await response.json()) as { name?: unknown; mime?: unknown; size?: unknown }
    if (
      typeof file.name !== 'string' ||
      typeof file.mime !== 'string' ||
      typeof file.size !== 'number' ||
      !Number.isFinite(file.size) ||
      file.size < 0
    )
      throw new Error('文件信息不可用，请重试。')
    useRightPanelStore.getState().openAttachment(threadRef, {
      type: 'file',
      id: autoOpsResourceAttachmentId(url),
      name: file.name,
      mimeType: file.mime,
      sizeBytes: file.size,
    })
  } catch (error) {
    toastManager.add({
      type: 'error',
      title: '无法打开文件',
      description: error instanceof Error ? error.message : '请稍后重试',
    })
  }
}

/** Open an authorized resource through T3's existing attachment tab and viewer. */
export function AutoOpsResourceLink({
  sourceUrl,
  threadRef,
  ...props
}: ComponentProps<'a'> & { sourceUrl: string; threadRef?: ScopedThreadRef }) {
  const url = autoOpsResourceUrl(sourceUrl)
  return (
    <a
      {...props}
      href={url ?? sourceUrl}
      onClick={(event) => {
        props.onClick?.(event)
        if (
          !url ||
          !threadRef ||
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey
        )
          return
        event.preventDefault()
        void openAutoOpsResource(url, threadRef)
      }}
    />
  )
}
