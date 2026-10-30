import { useEffect, useRef, useState } from 'react'
import { RefreshCwIcon, RocketIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Spinner } from '~/components/ui/spinner'
import { Choice } from './DeploymentControls'
import {
  DeploymentRequestError,
  type DeploymentServiceSource,
  type DeploymentSourceRef,
  type DeploymentSubmission,
  type DeploymentRepositoryHistory,
  type DeploymentRepositoryRefs,
} from '../deployments'
import { AutoOpsRequestError } from '../apiClient'
import type { ProjectRepositoryConnection } from '../workspaceAuthoring'
import type { DeploymentRepositoryQueries } from './repositoryQueries'

type ChoiceValue = Pick<DeploymentSourceRef, 'refKind' | 'ref' | 'commit'>
export type DeploymentCandidate = Pick<DeploymentSubmission, 'sourceSelection' | 'sourceRefs'>

/** 多仓库逐个选择固定提交，只有当前仓库查询 Git，避免挤占既有并发预算。 */
export function DeploymentRevisionPicker({
  projectId,
  queries,
  source,
  repositories,
  currentCommits,
  disabled,
  onPublish,
  onAccessDenied,
}: {
  projectId: string
  queries: DeploymentRepositoryQueries
  source: DeploymentServiceSource
  repositories: ProjectRepositoryConnection[]
  currentCommits: string[]
  disabled: boolean
  onPublish: (candidate: DeploymentCandidate) => void
  onAccessDenied: (cause: unknown) => void
}) {
  const [active, setActive] = useState(source.sources[0]?.sourceId ?? '')
  const [choices, setChoices] = useState<Record<string, ChoiceValue>>({})
  const complete =
    source.sources.length > 0 && source.sources.every((row) => !!choices[row.sourceId])
  return (
    <div className="min-w-0 space-y-4 p-4" aria-label="发布版本选择">
      {source.sources.map((row) => (
        <section key={row.sourceId} className="min-w-0 border-b border-border/60 pb-4">
          <Button
            variant="ghost"
            className="w-full justify-between"
            onClick={() => setActive(row.sourceId)}
            aria-expanded={active === row.sourceId}
          >
            <span className="truncate">
              {repositories.find((repo) => repo.id === row.sourceId)?.name ?? '仓库已不可用'}
            </span>
            <code className="ml-2 text-xs">
              {choices[row.sourceId]?.commit.slice(0, 12) ?? '请选择提交'}
            </code>
          </Button>
          {active === row.sourceId ? (
            <RepositoryCommits
              key={row.sourceId}
              projectId={projectId}
              queries={queries}
              sourceId={row.sourceId}
              initial={{ refKind: row.refKind ?? 'default', ref: row.ref ?? '' }}
              value={choices[row.sourceId]}
              currentCommits={currentCommits}
              onAccessDenied={onAccessDenied}
              onChange={(value) =>
                setChoices((old) => {
                  const next = { ...old }
                  if (value) next[row.sourceId] = value
                  else delete next[row.sourceId]
                  return next
                })
              }
            />
          ) : null}
        </section>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          本次发布 {source.sources.length} 个仓库的固定提交，构建目录沿用已保存配置。
        </p>
        <Button
          disabled={disabled || !complete}
          onClick={() => {
            if (!complete) return
            onPublish({
              sourceSelection: {
                sources: source.sources.map((row) => ({
                  ...row,
                  refKind: 'commit',
                  ref: choices[row.sourceId]!.commit,
                })),
                contexts: source.contexts,
              },
              sourceRefs: source.sources.map((row) => ({
                sourceId: row.sourceId,
                ...choices[row.sourceId]!,
              })),
            })
          }}
        >
          <RocketIcon />
          发布
        </Button>
      </div>
    </div>
  )
}

function RepositoryCommits({
  projectId,
  queries,
  sourceId,
  initial,
  value,
  currentCommits,
  onChange,
  onAccessDenied,
}: {
  projectId: string
  queries: DeploymentRepositoryQueries
  sourceId: string
  initial: { refKind: DeploymentSourceRef['refKind']; ref: string }
  value: ChoiceValue | undefined
  currentCommits: string[]
  onChange: (value: ChoiceValue | undefined) => void
  onAccessDenied: (cause: unknown) => void
}) {
  const [reference, setReference] = useState(() =>
    value ? { refKind: value.refKind, ref: value.ref } : initial,
  )
  const [refs, setRefs] = useState<DeploymentRepositoryRefs | null>(null)
  const [history, setHistory] = useState<DeploymentRepositoryHistory | null>(null)
  const [revision, refresh] = useState(0)
  const [branchRevision, refreshBranches] = useState(0)
  const [query, setQuery] = useState('')
  const [sha, setSha] = useState(reference.refKind === 'commit' ? reference.ref : '')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const refreshed = useRef({ refs: 0, history: 0 })
  const selected = useRef(value)
  const update = useRef(onChange)
  const denied = useRef(onAccessDenied)
  denied.current = onAccessDenied
  selected.current = value
  update.current = onChange
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true)
    setError(null)
    void (async () => {
      const forceRefs = refreshed.current.refs !== branchRevision
      const forceHistory = refreshed.current.history !== revision
      refreshed.current = { refs: branchRevision, history: revision }
      const { data: list } = await queries.refs(sourceId, forceRefs)
      if (controller.signal.aborted) return
      setRefs(list)
      const ref =
        reference.refKind === 'default'
          ? { refKind: 'branch' as const, ref: list.defaultRef ?? '' }
          : reference
      if (!ref.ref && ref.refKind === 'commit') {
        setHistory(null)
        return
      }
      if (!ref.ref) throw new Error('仓库没有可用的默认分支，请选择分支。')
      const { data: result, updatedAt: timestamp } = await queries.history(sourceId, ref, forceHistory)
      if (controller.signal.aborted) return
      setHistory(result)
      setUpdatedAt(timestamp)
      if (
        selected.current &&
        !result.commits.some((row) => row.revision === selected.current!.commit)
      ) {
        update.current(undefined)
        setError('所选提交不在刷新后的列表中，请重新选择。')
      }
    })()
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setHistory(null)
          update.current(undefined)
          setError(cause instanceof Error ? cause.message : '读取提交失败。')
          if (
            (cause instanceof DeploymentRequestError || cause instanceof AutoOpsRequestError) &&
            [401, 403].includes(cause.status ?? 0)
          ) {
            queries.clear()
            setRefs(null)
            denied.current(cause)
          }
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [projectId, sourceId, reference.refKind, reference.ref, revision, branchRevision, queries])
  const options = [
    ...(refs?.defaultRef
      ? [{ id: `branch:${refs.defaultRef}`, name: `${refs.defaultRef}（默认分支）` }]
      : []),
    ...(refs?.branches
      .filter((row) => row.name !== refs.defaultRef)
      .map((row) => ({ id: `branch:${row.name}`, name: row.name })) ?? []),
    ...(refs?.tags.map((row) => ({ id: `tag:${row.name}`, name: `标签 · ${row.name}` })) ?? []),
    { id: 'manual', name: '输入完整提交 SHA…' },
  ]
  const refValue =
    reference.refKind === 'default'
      ? `branch:${refs?.defaultRef ?? ''}`
      : `${reference.refKind}:${reference.ref}`
  if (!options.some((row) => row.id === refValue) && reference.ref)
    options.unshift({ id: refValue, name: reference.ref })
  const commits =
    history?.commits.filter((row) =>
      `${row.subject} ${row.revision}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ) ?? []
  return (
    <div className="space-y-3 pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label>发布分支或标签</Label>
          <Choice
            label="发布分支"
            value={refValue}
            options={options}
            disabled={busy && !refs}
            onChange={(next) => {
              update.current(undefined)
              setHistory(null)
              if (next === 'manual') {
                setReference({ refKind: 'commit', ref: '' })
                setSha('')
                return
              }
              const colon = next.indexOf(':')
              setReference({
                refKind: next.slice(0, colon) as 'branch' | 'tag',
                ref: next.slice(colon + 1),
              })
            }}
          />
        </div>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="刷新分支列表"
          disabled={busy}
          onClick={() => refreshBranches((n) => n + 1)}
        >
          <RefreshCwIcon />
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || (!reference.ref && reference.refKind !== 'default')}
          onClick={() => refresh((n) => n + 1)}
        >
          <RefreshCwIcon />
          刷新提交
        </Button>
      </div>
      {reference.refKind === 'commit' ? (
        <div className="flex gap-2">
          <Input
            aria-label="完整提交 SHA"
            placeholder="40 位提交 SHA"
            value={sha}
            onValueChange={setSha}
          />
          <Button
            variant="outline"
            disabled={!/^[a-f0-9]{40}$/.test(sha) || busy}
            onClick={() => setReference({ refKind: 'commit', ref: sha })}
          >
            读取提交
          </Button>
        </div>
      ) : null}
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {history && updatedAt && !busy ? (
        <p className="text-xs text-muted-foreground">
          提交读取于 {new Date(updatedAt).toLocaleTimeString('zh-CN')}；同仓库、同分支的服务共享查询，可手动刷新。
        </p>
      ) : null}
      <Input
        aria-label="搜索提交"
        placeholder="搜索提交说明或 SHA"
        value={query}
        onValueChange={setQuery}
      />
      {busy ? (
        <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner size="sm" />
          正在读取提交…
        </div>
      ) : (
        <div role="group" aria-label="选择发布提交" className="max-h-96 overflow-y-auto">
          {commits.map((commit) => (
            <Button
              key={commit.revision}
              variant="ghost"
              className={`h-auto w-full justify-start py-3 text-left ${value?.commit === commit.revision ? 'bg-accent' : ''}`}
              aria-pressed={value?.commit === commit.revision}
              onClick={() =>
                onChange({
                  refKind: reference.refKind === 'default' ? 'branch' : reference.refKind,
                  ref:
                    reference.refKind === 'default'
                      ? (history?.defaultRef ?? refs?.defaultRef ?? '')
                      : reference.ref,
                  commit: commit.revision,
                })
              }
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium">
                  {commit.subject || '无提交说明'}
                </span>
                <span className="mt-1 flex flex-wrap gap-x-3 text-xs font-normal text-muted-foreground">
                  <code title={commit.revision}>{commit.revision.slice(0, 12)}</code>
                  <span>{new Date(commit.authoredAt).toLocaleString('zh-CN')}</span>
                  {currentCommits.includes(commit.revision) ? <span>当前运行提交</span> : null}
                </span>
              </span>
            </Button>
          ))}
          {!commits.length && !error ? (
            <p className="py-4 text-sm text-muted-foreground">
              {query ? '没有匹配的提交。' : '没有可用提交。'}
            </p>
          ) : null}
        </div>
      )}
      {history?.truncated || refs?.truncated ? (
        <p className="text-xs text-muted-foreground">
          列表已截断，提交最多显示最近 100 条；可输入完整 SHA 查询其他提交。
        </p>
      ) : null}
    </div>
  )
}
