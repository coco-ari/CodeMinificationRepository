import { CustomerFilePanel } from './CustomerFilePanel'
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
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
import {
  legacyPreviewPathAllowed,
  workspaceInputRoot,
  workspacePreviewPathAllowed,
} from './materialPreviewScope'

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
    return businessMode ? (
      <FileSurfaceFailure message="此旧对话仅支持已授权文件预览，请新建工作区对话浏览目录。" />
    ) : (
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
    return businessMode ? (
      <FileSurfaceFailure message="旧对话不开放目录浏览，请新建工作区对话。" />
    ) : (
      <FilePreviewPanel {...props} cwd={cwd} knownDirectory />
    )
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

/** 消息保留不可变输入身份，原生文件面板只显示项目相对路径。 */
export default function AutoOpsMaterialPreview(props: FilePreviewPanelProps) {
  const scope = useAutoOpsThreadScope(props.threadRef.threadId)
  if (
    !props.attachment &&
    (scope?.executionBinding?.kind === 'customer' ||
      props.relativePath?.startsWith('autoops-customer/') ||
      props.cwd.startsWith('autoops-customer://'))
  ) {
    return scope?.executionBinding?.kind === 'customer' ? (
      <CustomerFilePanel {...props} scope={scope} />
    ) : (
      <FileSurfaceFailure message="此文件不属于当前电脑工作区。" />
    )
  }
  return <WorkspaceMaterialPreview {...props} />
}

function WorkspaceMaterialPreview(props: FilePreviewPanelProps) {
  const knownScope = useAutoOpsThreadScope(props.threadRef.threadId)
  const canonical = autoOpsBusinessPath(props.relativePath ?? undefined)
  const providedCwd = isAutoOpsResourceCwd(props.cwd) ? props.cwd : null
  const projectId =
    knownScope?.projectId ??
    canonical?.split('/')[1] ??
    providedCwd?.match(/^autoops:\/\/projects\/([^/]+)/)?.[1]
  const scope =
    knownScope ??
    (projectId ? readAutoOpsThreadScope(props.threadRef.threadId, projectId) : undefined)
  // 原会话仍保留旧绑定用于核对收据；新轮的目录入口不能因此退回旧资料。
  const historyRoot =
    scope?.workspaceVersionId && projectId
      ? `autoops/${projectId}/workspaces/${scope.workspaceVersionId}`
      : null
  const versionId =
    historyRoot && canonical && workspacePreviewPathAllowed(canonical, historyRoot)
      ? (scope?.workspaceVersionId ?? null)
      : null
  // 保留的原生面板可能早于范围初始化，旧 cwd 不能覆盖当前绑定。
  const scopeCwd = scope
    ? autoOpsResourceCwd(props.threadRef.threadId, scope.projectId, scope, versionId ?? undefined)
    : null
  const referencedInput = !versionId && projectId ? workspaceInputRoot(canonical, projectId) : null
  const inputReadKey = `${scopeCwd ?? ''}:${referencedInput ?? 'current'}`
  const [resolved, setResolved] = useState<{
    key: string
    prefix: string | null
    error?: string
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (
      !isAutoOpsHosted() ||
      props.attachment ||
      !scopeCwd ||
      !projectId ||
      !scope?.workspaceType ||
      versionId
    )
      return
    let cancelled = false
    void executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.listEntries({
        environmentId: props.environmentId,
        input: {
          cwd: referencedInput ? `${scopeCwd}&inputId=${referencedInput.split('/')[3]}` : scopeCwd,
          directoryPath: referencedInput ?? '',
        },
      }),
      { refresh: true, reportFailure: false, reportDefect: false },
    )
      .then((result) => {
        if (cancelled) return
        if (result._tag !== 'Success') throw Cause.squash(result.cause)
        const first = result.value.entries[0]
        const returned = first ? workspaceInputRoot(first.path, projectId) : null
        if (first && (!returned || (referencedInput && returned !== referencedInput)))
          throw new Error('工作区返回的输入身份无效，请重试。')
        setResolved({ key: inputReadKey, prefix: referencedInput ?? returned })
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setResolved({
            key: inputReadKey,
            prefix: null,
            error: cause instanceof Error ? cause.message : '当前工作区不可用。',
          })
      })
    return () => {
      cancelled = true
    }
  }, [
    scopeCwd,
    projectId,
    scope?.workspaceType,
    versionId,
    referencedInput,
    inputReadKey,
    props.attachment,
    props.environmentId,
    attempt,
  ])
  const prefix =
    versionId && projectId
      ? `autoops/${projectId}/workspaces/${versionId}`
      : resolved?.key === inputReadKey
        ? resolved.prefix
        : null
  const inputId = prefix?.split('/')[2] === 'inputs' ? prefix.split('/')[3] : undefined
  const cwd = scopeCwd && inputId ? `${scopeCwd}&inputId=${inputId}` : scopeCwd
  const source = useMemo<ReadOnlyFileSource | undefined>(() => {
    if (!cwd || !prefix) return undefined
    const resourcePath = (relativePath: string) =>
      relativePath ? `${prefix}/${relativePath}` : prefix
    const relativeEntry = <T extends { path: string }>(entry: T): T | null =>
      entry.path.startsWith(prefix + '/')
        ? { ...entry, path: entry.path.slice(prefix.length + 1) }
        : null
    return {
      id: cwd,
      allowReferences: true,
      mentionPath: resourcePath,
      async list(directoryPath) {
        const result = await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.listEntries({
            environmentId: props.environmentId,
            input: { cwd, directoryPath: resourcePath(directoryPath) },
          }),
          { refresh: true, reportFailure: false, reportDefect: false },
        )
        if (result._tag !== 'Success') throw Cause.squash(result.cause)
        return {
          entries: result.value.entries.flatMap((entry) => {
            const relative = relativeEntry(entry)
            return relative ? [relative] : []
          }),
          truncated: result.value.truncated,
        }
      },
      async search(query, limit) {
        const result = await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.searchEntries({
            environmentId: props.environmentId,
            input: { cwd, query, limit },
          }),
          { refresh: true, reportFailure: false, reportDefect: false },
        )
        if (result._tag !== 'Success') throw Cause.squash(result.cause)
        return {
          entries: result.value.entries.flatMap((entry) => {
            const relative = relativeEntry(entry)
            return relative ? [relative] : []
          }),
          truncated: result.value.truncated,
        }
      },
      async metadata(path) {
        const canonicalPath = resourcePath(path)
        const result = await executeAtomQuery(
          appAtomRegistry,
          filesystemEnvironment.getMetadata({
            environmentId: props.environmentId,
            input: { paths: [canonicalPath] },
          }),
          { refresh: true, reportFailure: false, reportDefect: false },
        )
        if (result._tag !== 'Success') throw Cause.squash(result.cause)
        const metadata = result.value.entries[0],
          url = autoOpsResourceUrl(canonicalPath)
        if (metadata?.kind === 'directory') return { kind: 'directory' as const }
        if (metadata?.kind !== 'file' || metadata.byteLength === undefined || !url)
          throw new Error('资料不存在或当前对话无权访问。')
        return {
          kind: 'file' as const,
          name: path.split('/').at(-1) ?? path,
          mimeType: metadata.mimeType ?? 'application/octet-stream',
          sizeBytes: metadata.byteLength,
          url,
        }
      },
    }
  }, [cwd, prefix, props.environmentId])
  if (!isAutoOpsHosted() || props.attachment) return <LegacyMaterialPreview {...props} />
  if (!scope || !cwd)
    return <FileSurfaceFailure message="对话工作区范围不可用，请等待范围加载完成后重试。" />
  if (!versionId && !scope.workspaceType) {
    const legacyBound =
      knownScope?.scopeLocked ||
      knownScope?.scopeState === 'locked' ||
      knownScope?.compatibilityReadOnly
    if (
      !legacyBound ||
      scope.workspaceType === 'external' ||
      !legacyPreviewPathAllowed(canonical, scope.projectId)
    )
      return <FileSurfaceFailure message="此历史对话没有工作区范围，请新建对话使用当前资料。" />
    return <LegacyMaterialPreview {...props} />
  }
  if (!source || !prefix) {
    if (resolved?.key !== inputReadKey) return <FileSurfaceLoading />
    if (resolved.error)
      return (
        <FileSurfaceFailure
          message={resolved.error}
          onRetry={() => {
            setResolved(null)
            setAttempt((value) => value + 1)
          }}
        />
      )
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>当前工作区还没有文件</EmptyTitle>
          <EmptyDescription>上传资料或同步源码后，可重新打开文件浏览。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (canonical && !workspacePreviewPathAllowed(canonical, prefix))
    return <FileSurfaceFailure message="此资料不属于当前预览的输入，请从原文件引用重新打开。" />
  const relative =
    canonical === prefix
      ? null
      : canonical
        ? canonical.slice(prefix.length + 1)
        : props.relativePath
  const toCanonical = (path: string) => (path ? `${prefix}/${path}` : prefix)
  const trail =
    props.folderTrail === prefix
      ? ''
      : props.folderTrail?.startsWith(prefix + '/')
        ? props.folderTrail.slice(prefix.length + 1)
        : undefined
  return (
    <FilePreviewPanel
      {...props}
      cwd={cwd}
      readOnlySource={source}
      relativePath={relative}
      knownDirectory={props.knownDirectory || relative === null}
      folderTrail={trail}
      onOpenFile={(path) => props.onOpenFile(toCanonical(path))}
      onNavigateFolder={(path, nextTrail, keepSource) =>
        props.onNavigateFolder(toCanonical(path), toCanonical(nextTrail), keepSource)
      }
    />
  )
}
