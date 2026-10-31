import { useEffect, useState, type ComponentProps } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { Alert, AlertAction, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Spinner } from '~/components/ui/spinner'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import {
  isDeploymentAccessError,
  loadDeploymentRepositoryHistory,
  loadDeploymentRepositoryRefs,
  type DeploymentRepositoryHistory,
  type DeploymentRepositoryRefs,
} from '../deployments'
import type { WorkspaceDeploymentSourceInput } from '../workspaceAuthoring'
import { Choice } from './DeploymentControls'

type Reference = Pick<WorkspaceDeploymentSourceInput['sources'][number], 'refKind' | 'ref'>

/** 引用清单和提交历史按需读取，关闭或切换后不接受旧响应。 */
export function DeploymentRepositoryVersionDialog({
  projectId,
  sourceId,
  sourceName,
  selection,
  onSelect,
  onAccessDenied,
  ...dialog
}: {
  projectId: string
  sourceId: string
  sourceName: string
  selection: Reference
  onSelect: (value: Reference) => void
  onAccessDenied?: ((cause: unknown) => void) | undefined
  open: boolean
  onOpenChange: (value: boolean) => void
  finalFocus: ComponentProps<typeof DialogPopup>['finalFocus']
}) {
  const [tab, setTab] = useState<'branch' | 'tag' | 'commit'>(
    selection.refKind === 'tag' ? 'tag' : selection.refKind === 'commit' ? 'commit' : 'branch',
  )
  const [historyRef, setHistoryRef] = useState<Reference>(selection)
  const [refs, setRefs] = useState<DeploymentRepositoryRefs | null>(null)
  const [history, setHistory] = useState<DeploymentRepositoryHistory | null>(null)
  const [refsError, setRefsError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [revision, refresh] = useState(0)
  const historyValue = `${historyRef.refKind ?? 'default'}:${historyRef.ref ?? ''}`
  useEffect(() => {
    if (!dialog.open) return
    const controller = new AbortController()
    setRefs(null)
    setRefsError(null)
    void loadDeploymentRepositoryRefs(projectId, sourceId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRefs(result)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setRefsError(cause instanceof Error ? cause.message : '读取仓库版本失败。')
        if (isDeploymentAccessError(cause)) onAccessDenied?.(cause)
      })
    return () => controller.abort()
  }, [projectId, sourceId, dialog.open, revision, onAccessDenied])
  useEffect(() => {
    if (!dialog.open || tab !== 'commit') return
    const controller = new AbortController()
    setHistory(null)
    setHistoryError(null)
    void loadDeploymentRepositoryHistory(projectId, sourceId, historyRef, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setHistory(result)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setHistoryError(cause instanceof Error ? cause.message : '读取提交历史失败。')
        if (isDeploymentAccessError(cause)) onAccessDenied?.(cause)
      })
    return () => controller.abort()
  }, [projectId, sourceId, dialog.open, tab, historyRef, revision, onAccessDenied])
  const choose = (value: Reference) => {
    onSelect(value)
    dialog.onOpenChange(false)
  }
  const error = tab === 'commit' ? (historyError ?? refsError) : refsError
  const pending = tab === 'commit' ? !history && !historyError : !refs && !refsError
  const items =
    tab === 'commit'
      ? (history?.commits.map((entry) => ({
          id: entry.revision,
          label: entry.subject,
          detail: `${entry.revision.slice(0, 12)} · ${new Date(entry.authoredAt).toLocaleString('zh-CN')}`,
        })) ?? [])
      : ((tab === 'tag' ? refs?.tags : refs?.branches)?.map((entry) => ({
          id: entry.name,
          label: entry.name,
          detail: entry.commit.slice(0, 12),
        })) ?? [])
  const filtered = items.filter((entry) =>
    `${entry.label} ${entry.detail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  )
  const refOptions = [
    { id: 'default:', name: '默认分支' },
    ...(refs?.branches.map((entry) => ({
      id: `branch:${entry.name}`,
      name: `分支 · ${entry.name}`,
    })) ?? []),
    ...(refs?.tags.map((entry) => ({ id: `tag:${entry.name}`, name: `标签 · ${entry.name}` })) ??
      []),
  ]
  if (!refOptions.some((entry) => entry.id === historyValue))
    refOptions.push({ id: historyValue, name: historyRef.ref || '当前版本' })
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogPopup className="sm:max-w-xl" finalFocus={dialog.finalFocus}>
        <DialogHeader>
          <DialogTitle>{sourceName} · 选择版本</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              variant="segmented"
              aria-label="仓库版本分类"
              value={[tab]}
              onValueChange={(value) => {
                const next = value[0]
                if (next === 'branch' || next === 'tag' || next === 'commit') {
                  setTab(next)
                  setQuery('')
                }
              }}
            >
              <Toggle value="branch">分支</Toggle>
              <Toggle value="tag">标签</Toggle>
              <Toggle value="commit">提交</Toggle>
            </ToggleGroup>
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              aria-label="刷新仓库版本"
              onClick={() => refresh((value) => value + 1)}
            >
              <RefreshCwIcon />
            </Button>
          </div>
          {tab === 'commit' ? (
            <Choice
              label="提交历史来源"
              value={historyValue}
              options={refOptions}
              onChange={(value) => {
                const colon = value.indexOf(':')
                const refKind = value.slice(0, colon)
                if (
                  refKind === 'default' ||
                  refKind === 'branch' ||
                  refKind === 'tag' ||
                  refKind === 'commit'
                )
                  setHistoryRef({ refKind, ref: value.slice(colon + 1) })
              }}
            />
          ) : null}
          <Input
            aria-label="搜索仓库版本"
            placeholder="搜索版本"
            value={query}
            onValueChange={setQuery}
          />
          {error ? (
            <Alert variant="error" role="alert">
              <AlertDescription>{error}</AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  className="mt-2"
                  onClick={() => refresh((value) => value + 1)}
                >
                  重试
                </Button>
              </AlertAction>
            </Alert>
          ) : pending ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner size="sm" />
              读取版本…
            </div>
          ) : (
            <div className="space-y-1">
              {tab === 'branch' && !query ? (
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => choose({ refKind: 'default', ref: '' })}
                >
                  默认分支{refs?.defaultRef ? ` · ${refs.defaultRef}` : ''}
                </Button>
              ) : null}
              {filtered.map((entry) => (
                <Button
                  key={entry.id}
                  variant="ghost"
                  size="row"
                  className="w-full justify-start"
                  onClick={() => choose({ refKind: tab, ref: entry.id })}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{entry.label}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {entry.detail}
                    </span>
                  </span>
                </Button>
              ))}
              {!filtered.length ? (
                <p className="py-4 text-sm text-muted-foreground">
                  {query ? '没有匹配的版本。' : '没有可用版本。'}
                </p>
              ) : null}
            </div>
          )}
          {(tab === 'commit' ? history?.truncated : refs?.truncated) ? (
            <p className="text-xs text-muted-foreground">
              这里只显示部分记录，也可以返回手动填写完整引用。
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}
