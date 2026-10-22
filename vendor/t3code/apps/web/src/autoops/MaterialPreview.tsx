import { isAutoOpsHosted } from './capabilities'
import { useEffect, useMemo, useState } from 'react'
import { executeAtomQuery } from '@t3tools/client-runtime/state/runtime'
import * as Cause from 'effect/Cause'
import { appAtomRegistry } from '~/rpc/atomRegistry'
import { projectEnvironment } from '~/state/projects'
import type { ReadOnlyFileSource } from '~/components/files/readOnlyFileSource'
import { readAutoOpsThreadScope } from './hostConfig'
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
  isAutoOpsResourceCwd,
} from './resources'
import { useAutoOpsThreadScope } from './useThreadScope'
import { legacyPreviewPathAllowed, workspacePreviewPathAllowed } from './materialPreviewScope'

/** Same T3 file/folder surfaces, with authorized resource identities as the data source. */
function LegacyMaterialPreview(props: FilePreviewPanelProps) {
  const path = props.attachment ? null : autoOpsBusinessPath(props.relativePath ?? undefined)
  const scope = useAutoOpsThreadScope(props.threadRef.threadId)
  const businessMode = isAutoOpsHosted() && !props.attachment
  const cwd = businessMode
    ? autoOpsResourceCwd(props.threadRef.threadId, scope?.projectId ?? path?.split('/')[1], scope)
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
    return businessMode ? <FileSurfaceFailure message="此旧对话仅支持已授权文件预览，请新建工作区对话浏览目录。" /> : (
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
    return businessMode ? <FileSurfaceFailure message="旧对话不开放目录浏览，请新建工作区对话。" /> : <FilePreviewPanel {...props} cwd={cwd} knownDirectory />
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


/** Canonical references remain in messages; the file surface only shows project-relative paths. */
export default function AutoOpsMaterialPreview(props: FilePreviewPanelProps) {
  const knownScope = useAutoOpsThreadScope(props.threadRef.threadId)
  const canonical = autoOpsBusinessPath(props.relativePath ?? undefined)
  const providedCwd = isAutoOpsResourceCwd(props.cwd) ? props.cwd : null
  const projectId = knownScope?.projectId ?? canonical?.split('/')[1] ?? providedCwd?.match(/^autoops:\/\/projects\/([^/]+)/)?.[1]
  const scope = knownScope ?? (projectId ? readAutoOpsThreadScope(props.threadRef.threadId, projectId) : undefined)
  // A retained native surface may predate scope initialization; its cwd cannot override the current binding.
  const cwd = scope ? autoOpsResourceCwd(props.threadRef.threadId, scope.projectId, scope) : null
  const versionId = scope?.workspaceVersionId ?? null
  const prefix = versionId && projectId
    ? `autoops/${projectId}/workspaces/${versionId}`
    : projectId ? `autoops/${projectId}` : null
  const source = useMemo<ReadOnlyFileSource | undefined>(() => {
    if (!cwd || !prefix) return undefined
    const resourcePath = (relativePath: string) => relativePath ? `${prefix}/${relativePath}` : prefix
    const relativeEntry = <T extends { path: string }>(entry: T): T | null =>
      entry.path.startsWith(prefix + '/') ? { ...entry, path: entry.path.slice(prefix.length + 1) } : null
    return {
      id: cwd,
      allowReferences: true,
      mentionPath: resourcePath,
      async list(directoryPath) {
        const result = await executeAtomQuery(appAtomRegistry, projectEnvironment.listEntries({ environmentId: props.environmentId, input: { cwd, directoryPath: resourcePath(directoryPath) } }), { refresh: true, reportFailure: false, reportDefect: false })
        if (result._tag !== 'Success') throw Cause.squash(result.cause)
        return { entries: result.value.entries.flatMap((entry) => { const relative = relativeEntry(entry); return relative ? [relative] : [] }), truncated: result.value.truncated }
      },
      async search(query, limit) {
        const result = await executeAtomQuery(appAtomRegistry, projectEnvironment.searchEntries({ environmentId: props.environmentId, input: { cwd, query, limit } }), { refresh: true, reportFailure: false, reportDefect: false })
        if (result._tag !== 'Success') throw Cause.squash(result.cause)
        return { entries: result.value.entries.flatMap((entry) => { const relative = relativeEntry(entry); return relative ? [relative] : [] }), truncated: result.value.truncated }
      },
      async metadata(path) {
        const canonicalPath = resourcePath(path)
        const result = await executeAtomQuery(appAtomRegistry, filesystemEnvironment.getMetadata({ environmentId: props.environmentId, input: { paths: [canonicalPath] } }), { refresh: true, reportFailure: false, reportDefect: false })
        if (result._tag !== 'Success') throw Cause.squash(result.cause)
        const metadata = result.value.entries[0], url = autoOpsResourceUrl(canonicalPath)
        if (metadata?.kind === 'directory') return { kind: 'directory' as const }
        if (metadata?.kind !== 'file' || metadata.byteLength === undefined || !url) throw new Error('资料不存在或当前对话无权访问。')
        return { kind: 'file' as const, name: path.split('/').at(-1) ?? path, mimeType: metadata.mimeType ?? 'application/octet-stream', sizeBytes: metadata.byteLength, url }
      },
    }
  }, [cwd, prefix, props.environmentId])
  if (!isAutoOpsHosted() || props.attachment)
    return <LegacyMaterialPreview {...props} />
  if (!scope || !source || !prefix || !cwd)
    return <FileSurfaceFailure message="对话工作区范围不可用，请等待范围加载完成后重试。" />
  if (!versionId) {
    const legacyBound = knownScope?.scopeLocked || knownScope?.scopeState === 'locked' || knownScope?.compatibilityReadOnly
    if (!legacyBound || scope.workspaceType === 'external' || !legacyPreviewPathAllowed(canonical, scope.projectId))
      return <FileSurfaceFailure message="此对话尚未绑定可用的工作区版本，请先选择版本或新建对话。" />
    return <LegacyMaterialPreview {...props} />
  }
  if (canonical && !workspacePreviewPathAllowed(canonical, prefix))
    return <FileSurfaceFailure message="此资料不属于当前对话的固定工作区版本，请在对应工作区新建对话。" />
  const relative = canonical === prefix ? null : canonical ? canonical.slice(prefix.length + 1) : props.relativePath
  const toCanonical = (path: string) => path ? `${prefix}/${path}` : prefix
  const trail = props.folderTrail === prefix ? '' : props.folderTrail?.startsWith(prefix + '/') ? props.folderTrail.slice(prefix.length + 1) : undefined
  return <FilePreviewPanel
    {...props} cwd={cwd} readOnlySource={source} relativePath={relative}
    knownDirectory={props.knownDirectory || relative === null}
    folderTrail={trail}
    onOpenFile={(path) => props.onOpenFile(toCanonical(path))}
    onNavigateFolder={(path, nextTrail, keepSource) => props.onNavigateFolder(toCanonical(path), toCanonical(nextTrail), keepSource)}
  />
}
