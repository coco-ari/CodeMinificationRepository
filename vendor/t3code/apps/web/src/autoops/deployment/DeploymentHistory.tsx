import { useEffect, useRef, useState } from 'react'
import { randomUUID } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { ScrollArea } from '~/components/ui/scroll-area'
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  AutoOpsRequestError,
  autoOpsApiUrl,
  autoOpsRequest,
  isAutoOpsAccessError,
} from '../apiClient'
import { readAutoOpsHost } from '../hostSnapshot'
import type { DeploymentRelease, DeploymentTarget } from '../deployments'
import { ConfigurationDetails } from './ConfigurationDetails'
import { DeploymentSourceDetails } from './DeploymentSourceDetails'
import { DeploymentReleaseIdentity } from './DeploymentReleaseIdentity'
import { dateLabel, errorLabel } from './deploymentPresentation'

type Props = {
  projectId: string
  target: DeploymentTarget
  releases: DeploymentRelease[]
  error: string | null
  disabled: boolean
  mutationDisabled: boolean
  allowCurrentRelease: boolean
  onRollback: (release: DeploymentRelease) => void
  onAccessDenied: (cause: unknown) => void
}
type ReleasePage = { releases: DeploymentRelease[]; total: number; nextOffset: number | null }

export function DeploymentHistory(props: Props) {
  return (
    <History
      key={`${readAutoOpsHost()?.principal.id ?? ''}:${props.projectId}:${props.target.id}`}
      {...props}
    />
  )
}

function History({
  projectId,
  target,
  releases,
  error: parentError,
  disabled,
  mutationDisabled,
  allowCurrentRelease,
  onRollback,
  onAccessDenied,
}: Props) {
  const base = `/autoops/projects/${encodeURIComponent(projectId)}/deployments/targets/${encodeURIComponent(target.id)}/releases`
  const key = `autoops:release-clear:${readAutoOpsHost()?.principal.id ?? ''}:${projectId}:${target.id}`
  const [page, setPage] = useState<ReleasePage>({
    releases: releases.slice(0, 20),
    total: releases.length,
    nextOffset: null,
  })
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<DeploymentRelease | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ releaseId: string; requestId: string } | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? 'null')
      return typeof value?.releaseId === 'string' && typeof value?.requestId === 'string'
        ? value
        : null
    } catch {
      return null
    }
  })
  const trigger = useRef<HTMLElement | null>(null)
  const scope = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    scope.current = controller
    return () => controller.abort()
  }, [])
  const denied = (cause: unknown) => {
    if (isAutoOpsAccessError(cause)) {
      setPage({ releases: [], total: 0, nextOffset: null })
      setSelected(null)
      onAccessDenied(cause)
    }
    setError(errorLabel(cause))
  }
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void autoOpsRequest<ReleasePage>(`${base}?offset=${offset}&limit=20`, {
      label: '发布记录',
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setPage(value)
          setError(null)
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) denied(cause)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [base, offset, revision, target.currentRelease?.id])
  const clear = async () => {
    const input = pending ?? (selected ? { releaseId: selected.id, requestId: randomUUID() } : null)
    if (!input || busy) return
    const signal = scope.current.signal
    try {
      sessionStorage.setItem(key, JSON.stringify(input))
      setPending(input)
      setBusy(true)
      setError(null)
      await autoOpsRequest(`${base}/${encodeURIComponent(input.releaseId)}/source`, {
        label: '清理源码',
        method: 'DELETE',
        body: { requestId: input.requestId },
        signal,
      })
      if (signal.aborted) return
      sessionStorage.removeItem(key)
      setPending(null)
      setSelected(null)
      setConfirm(false)
      setRevision((value) => value + 1)
    } catch (cause) {
      if (signal.aborted) return
      if (cause instanceof AutoOpsRequestError && !cause.uncertain) {
        sessionStorage.removeItem(key)
        setPending(null)
      }
      denied(cause)
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  const download = async () => {
    if (!selected) return
    const signal = scope.current.signal
    try {
      setBusy(true)
      setError(null)
      const url = `${base}/${encodeURIComponent(selected.id)}/source`
      const metadata = await autoOpsRequest<{ name: string }>(`${url}?metadata=1`, {
        label: '源码档案',
        signal,
      })
      if (signal.aborted) return
      const anchor = document.createElement('a')
      anchor.href = autoOpsApiUrl(url)
      anchor.download = metadata.name
      anchor.click()
    } catch (cause) {
      if (!signal.aborted) denied(cause)
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  return (
    <>
      {error || parentError ? (
        <p className="px-3 py-2 text-sm text-destructive" role="alert">
          {error || parentError}
        </p>
      ) : null}
      {pending ? (
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-sm">
          <span>上次清理尚未完成</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || mutationDisabled}
            onClick={() => void clear()}
          >
            重试
          </Button>
        </div>
      ) : null}
      <ScrollArea radius="none" className="min-h-0 flex-1">
        <div className="divide-y divide-border/60">
          {page.releases.map((release) => (
            <div key={release.id} className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <DeploymentReleaseIdentity release={release} />
                  {release.current ? (
                    <Badge size="sm" variant="secondary">
                      上次确认
                    </Badge>
                  ) : null}
                </div>
                <time className="text-xs text-muted-foreground">
                  {dateLabel(release.createdAt)}
                </time>
                {release.available === false ? (
                  <p className="text-xs text-muted-foreground">该版本目前不可恢复</p>
                ) : release.archiveStatus === 'available' ? (
                  <p className="text-xs text-muted-foreground">源码包可恢复</p>
                ) : release.archiveStatus ? (
                  <p className="text-xs text-muted-foreground">
                    中心源码档案不可用；回退需目标服务器仍保留本机版本。
                  </p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={(event) => {
                  trigger.current = event.currentTarget
                  setSelected(release)
                  setConfirm(false)
                  setError(null)
                }}
              >
                详情
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  disabled ||
                  (release.current === true && !allowCurrentRelease) ||
                  release.available === false
                }
                onClick={() => onRollback(release)}
              >
                回退
              </Button>
            </div>
          ))}
          {!page.releases.length && !loading ? (
            <p className="p-3 text-sm text-muted-foreground">还没有发布记录</p>
          ) : null}
        </div>
      </ScrollArea>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 text-xs">
        <span>{loading ? '正在读取…' : `共 ${page.total} 条记录`}</span>
        <div className="flex gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={loading || !offset}
            onClick={() => setOffset((value) => Math.max(0, value - 20))}
          >
            上一页
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={loading || page.nextOffset === null}
            onClick={() => setOffset(page.nextOffset!)}
          >
            下一页
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新记录
          </Button>
        </div>
      </div>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null)
            setConfirm(false)
          }
        }}
      >
        <DialogPopup finalFocus={() => trigger.current}>
          <DialogHeader>
            <DialogTitle>{confirm ? '清理版本源码' : '发布版本'}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {selected ? (
              <>
                <p className="break-all font-mono text-sm">{selected.revision ?? selected.id}</p>
                <p className="py-2 text-xs text-muted-foreground">
                  {dateLabel(selected.createdAt)}
                </p>
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                {confirm ? (
                  <p className="text-sm">
                    清理后无法用此源码重新构建该版本。当前运行版本和恢复基线不能清理。
                  </p>
                ) : (
                  <>
                    {selected.sourceIdentity ? (
                      <DeploymentSourceDetails source={selected.sourceIdentity} />
                    ) : null}
                    {selected.config ? (
                      <ConfigurationDetails
                        title="该版本配置"
                        target={{ ...target, config: selected.config }}
                      />
                    ) : null}
                  </>
                )}
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSelected(null)
                setConfirm(false)
              }}
            >
              关闭
            </Button>
            {confirm ? (
              <Button
                variant="destructive"
                disabled={busy || mutationDisabled || !!pending}
                onClick={() => void clear()}
              >
                确认清理
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={busy || selected?.archiveStatus !== 'available'}
                  onClick={() => void download()}
                >
                  下载源码
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    mutationDisabled ||
                    !!pending ||
                    selected?.archiveStatus !== 'available' ||
                    selected?.current === true ||
                    selected?.archiveProtected === true
                  }
                  onClick={() => setConfirm(true)}
                >
                  清理源码
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  )
}
