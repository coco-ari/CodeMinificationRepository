import { useEffect, useRef } from 'react'
import { toastManager } from '~/components/ui/toast'
import { usePrimaryEnvironmentId, useEnvironmentHttpBaseUrl } from '~/state/environments'
import { useAtomQueryRunner } from '~/state/use-atom-query-runner'
import { assetEnvironment } from '~/state/assets'
import { resolveAssetUrl } from '~/assets/assetUrls'
import { usePromptStashStore } from '~/promptStashStore'
import { compressImageForStash } from '~/lib/imageCompression'
import { useStableCallback } from '~/hooks/useStableCallback'
import { autoOpsStorage, readAutoOpsHost } from './hostConfig'
import { recoverLegacyDrafts, type LegacyDraft } from './legacyDrafts'

export function AutoOpsLegacyDraftRecovery() {
  const environmentId = usePrimaryEnvironmentId()
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId)
  const started = useRef(false),
    inFlight = useRef(false)
  const createAsset = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  })
  const recover = useStableCallback(async () => {
    const host = readAutoOpsHost()
    if (!host || !environmentId || !httpBaseUrl || inFlight.current) return
    inFlight.current = true
    try {
      const response = await fetch(`${host.gatewayBasePath}/autoops/legacy-drafts`, {
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('迁移草稿暂时无法读取，服务器原件仍保留。')
      const { drafts } = (await response.json()) as { drafts: LegacyDraft[] }
      const storage = autoOpsStorage(window.localStorage)
      const result = await recoverLegacyDrafts({
        drafts,
        environmentId,
        entries: () => usePromptStashStore.getState().entries,
        stash: (entry) => usePromptStashStore.getState().stashEntry(entry),
        alreadyImported: (id) => storage.getItem(`legacy-draft-imported:${id}`) === '1',
        markImported: (id) => storage.setItem(`legacy-draft-imported:${id}`, '1'),
        readImage: async (file) => {
          const asset = await createAsset({
            environmentId,
            input: { resource: { _tag: 'attachment', attachmentId: file.id } },
          })
          if (asset._tag !== 'Success') throw new Error('无法读取草稿图片')
          const url = resolveAssetUrl(httpBaseUrl, asset.value.relativeUrl)
          if (!url) throw new Error('无法读取草稿图片')
          const response = await fetch(url, { credentials: 'same-origin' })
          if (!response.ok) throw new Error('无法读取草稿图片')
          const result = await compressImageForStash(
            new File([await response.blob()], file.name, { type: file.mimeType }),
          )
          if (!result.ok) throw new Error('图片无法完整保存到暂存')
          return {
            id: file.id,
            name: file.name,
            mimeType: result.image.mimeType,
            sizeBytes: result.image.sizeBytes,
            dataUrl: result.image.dataUrl,
          }
        },
      })
      if (result.imported || result.remaining)
        toastManager.add({
          type: result.remaining ? 'warning' : 'info',
          title: result.imported
            ? `已将 ${result.imported} 份历史草稿恢复到暂存`
            : '历史草稿仍保留在服务器',
          description: result.remaining
            ? '暂存容量或浏览器存储不足。现有草稿保持不变，释放暂存后可重试。'
            : '可通过输入框的暂存菜单恢复；当前输入内容保持不变。',
          ...(result.remaining
            ? { actionProps: { children: '重试恢复', onClick: () => void recover() } }
            : {}),
        })
    } catch (error) {
      toastManager.add({
        type: 'warning',
        title: '历史草稿尚未恢复',
        description: error instanceof Error ? error.message : '服务器原件仍保留。',
        actionProps: { children: '重试', onClick: () => void recover() },
      })
    } finally {
      inFlight.current = false
    }
  })
  useEffect(() => {
    if (!started.current && environmentId && httpBaseUrl) {
      started.current = true
      void recover()
    }
  }, [environmentId, httpBaseUrl, recover])
  return null
}
