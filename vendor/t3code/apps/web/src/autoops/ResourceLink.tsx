import type { ComponentProps } from 'react'
import type { ScopedThreadRef } from '@t3tools/contracts'
import { useRightPanelStore } from '~/rightPanelStore'
import { toastManager } from '~/components/ui/toast'
import { readAutoOpsHost } from './hostConfig'
import {
  autoOpsResourceAttachmentId,
  autoOpsResourceUrl,
  loadAutoOpsResourceMetadata,
} from './resources'

export async function openAutoOpsResource(
  sourceUrl: string,
  threadRef: ScopedThreadRef,
): Promise<void> {
  const url = autoOpsResourceUrl(sourceUrl)
  if (!url) return
  const resource = new URL(url, window.location.origin)
  const resourcePath = resource.searchParams.get('path')
  // 工作区文件使用业务路径定位；技能包的相对路径交给原生附件查看器。
  if (
    resource.pathname === `${readAutoOpsHost()?.gatewayBasePath}/autoops/resources` &&
    resourcePath
  ) {
    useRightPanelStore.getState().openFile(threadRef, resourcePath)
    return
  }
  try {
    const file = await loadAutoOpsResourceMetadata(url)
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

/** 使用 T3 现有附件标签页和查看器打开已授权资源。 */
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
