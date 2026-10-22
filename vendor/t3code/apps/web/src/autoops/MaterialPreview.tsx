import { isAutoOpsHosted } from './capabilities'
import { useEffect, useState } from 'react'
import FilePreviewPanel, { type FilePreviewPanelProps } from '~/components/files/FilePreviewPanel'
import { FileSurfaceFailure, FileSurfaceLoading } from '~/components/files/fileSurfaceChrome'
import { filesystemEnvironment } from '~/state/filesystem'
import { useAtomQueryRunner } from '~/state/use-atom-query-runner'
import { useStableCallback } from '~/hooks/useStableCallback'
import {
  autoOpsBusinessPath,
  autoOpsResourceAttachmentId,
  autoOpsResourceCwd,
  autoOpsResourceUrl,
} from './resources'
import { useAutoOpsThreadScope } from './useThreadScope'

/** Same T3 file/folder surfaces, with authorized resource identities as the data source. */
export default function AutoOpsMaterialPreview(props: FilePreviewPanelProps) {
  const path = props.attachment ? null : autoOpsBusinessPath(props.relativePath ?? undefined)
  const scope = useAutoOpsThreadScope(props.threadRef.threadId)
  const businessMode = isAutoOpsHosted() && !props.attachment
  const cwd = businessMode
    ? autoOpsResourceCwd(props.threadRef.threadId, scope?.projectId ?? path?.split('/')[1])
    : null
  const query = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    reportFailure: false,
    refresh: true,
  })
  const load = useStableCallback(async () => {
    if (!path) return
    const result = await query({ environmentId: props.environmentId, input: { paths: [path] } })
    if (result._tag !== 'Success' || !result.value.entries[0])
      throw new Error('资料不存在或当前会话没有访问权限。')
    return result.value.entries[0]
  })
  type Metadata = NonNullable<Awaited<ReturnType<typeof load>>>
  const [result, setResult] = useState<{
    path: string
    metadata?: Metadata
    error?: string
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    setResult(null)
    void load()
      .then((metadata) => {
        if (!cancelled && metadata) setResult({ path, metadata })
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setResult({ path, error: error instanceof Error ? error.message : '无法读取资料' })
      })
    return () => {
      cancelled = true
    }
  }, [path, props.environmentId, attempt, load])
  if (!path)
    return (
      <FilePreviewPanel
        {...props}
        {...(businessMode && cwd ? { cwd, knownDirectory: true } : {})}
      />
    )
  if (!result || result.path !== path) return <FileSurfaceLoading />
  if (result.error || !result.metadata || !cwd)
    return (
      <FileSurfaceFailure
        message={result.error ?? '会话范围不可用。'}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    )
  if (result.metadata.kind === 'directory')
    return <FilePreviewPanel {...props} cwd={cwd} knownDirectory />
  const url = autoOpsResourceUrl(path)
  if (result.metadata.kind !== 'file' || !url || result.metadata.byteLength === undefined)
    return <FileSurfaceFailure message="此资料类型无法预览。" />
  return (
    <FilePreviewPanel
      {...props}
      cwd={cwd}
      attachment={{
        type: 'file',
        id: autoOpsResourceAttachmentId(url),
        name: path.split('/').at(-1) ?? '资料',
        mimeType: result.metadata.mimeType ?? 'application/octet-stream',
        sizeBytes: result.metadata.byteLength,
      }}
    />
  )
}
