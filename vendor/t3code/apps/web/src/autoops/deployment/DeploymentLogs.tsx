import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { CopyIcon, DownloadIcon, ArrowDownIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '~/components/ui/collapsible'
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '~/components/ui/dialog'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { Input } from '~/components/ui/input'
import { Choice } from './DeploymentControls'
import {
  deploymentStageLabel,
  deploymentStatusLabel,
  deploymentTaskFinished,
  loadDeploymentTask,
  isDeploymentAccessError,
  type DeploymentTask,
  type DeploymentLog,
} from '../deployments'
import { dateLabel, errorLabel } from './deploymentPresentation'

type DeploymentLogsProps = {
  projectId: string
  targetId: string
  taskId: string
  taskPicker?: ReactNode
  refresh: number
  onAccessDenied?: (cause: unknown) => void
}

/** 切换任务必须重新建立游标与阅读位置，迟到响应由原任务的取消信号拦截。 */
export function DeploymentLogs(props: DeploymentLogsProps) {
  return (
    <DeploymentTaskLog key={`${props.projectId}:${props.targetId}:${props.taskId}`} {...props} />
  )
}

function DeploymentTaskLog({
  projectId,
  targetId,
  taskId,
  taskPicker,
  refresh,
  onAccessDenied,
}: DeploymentLogsProps) {
  const [task, setTask] = useState<DeploymentTask | null>(null)
  const [logs, setLogs] = useState<DeploymentLog[]>([])
  const [error, setError] = useState<{ message: string; retrying: boolean } | null>(null)
  const [following, setFollowing] = useState(true)
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState('all')
  const [exportError, setExportError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const surface = useRef<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)
  const follow = useRef(true)
  const cursor = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await loadDeploymentTask(
          projectId,
          taskId,
          cursor.current,
          controller.signal,
        )
        if (controller.signal.aborted) return
        if (result.task.id !== taskId) {
          setError({ message: '任务身份与当前选择不一致，请从任务列表重新选择。', retrying: false })
          return
        }
        if (result.task.targetId !== targetId) {
          setError({ message: '该任务不属于当前服务，请从任务列表重新选择。', retrying: false })
          return
        }
        setTask(result.task)
        setLogs((previous) => [
          ...previous,
          ...result.logs.filter((entry) => entry.seq > (previous.at(-1)?.seq ?? 0)),
        ])
        cursor.current = Math.max(cursor.current, result.nextSeq - 1)
        setError(null)
        if (deploymentTaskFinished(result.task) && cursor.current >= (result.task.lastSeq ?? 0))
          return
        timer = setTimeout(poll, cursor.current < (result.task.lastSeq ?? 0) ? 100 : 1000)
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (isDeploymentAccessError(cause)) {
            setTask(null)
            setLogs([])
            cursor.current = 0
            setError({ message: errorLabel(cause), retrying: false })
            onAccessDenied?.(cause)
            return
          }
          setError({ message: errorLabel(cause), retrying: true })
          timer = setTimeout(poll, 3000)
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [projectId, targetId, taskId, refresh, onAccessDenied])
  useEffect(() => {
    const viewport = surface.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (!viewport) return
    const onScroll = () => {
      follow.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 32
      setFollowing(follow.current)
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const viewport = surface.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (viewport && follow.current) viewport.scrollTop = viewport.scrollHeight
  }, [logs.length])
  const latest = () => {
    follow.current = true
    setFollowing(true)
    const viewport = surface.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }
  const filtered = logs.filter(
    (entry) =>
      (stage === 'all' || entry.stage === stage) &&
      entry.message.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  )
  const backfilling = !!task && cursor.current < (task.lastSeq ?? 0)
  const recordedStages = [
    ...new Set([
      ...(task?.stageHistory ?? []).map((entry) => entry.stage),
      ...logs.flatMap((entry) => (entry.stage ? [entry.stage] : [])),
    ]),
  ]
  // 结束标记不一定是执行阶段；只展示任务实际报告过的阶段，不推断各阶段成败。
  const reportedStage =
    task && (!deploymentTaskFinished(task) || recordedStages.includes(task.stage))
      ? task.stage
      : undefined
  const selectableStages = [
    ...new Set([...recordedStages, ...(reportedStage ? [reportedStage] : [])]),
  ]
  const selectStage = (value: string) => {
    setStage(value)
    setCopied(false)
  }
  const exportDisabled = !task || backfilling || !!error || !filtered.length
  const text = filtered
    .map(
      (entry) =>
        `${entry.at ? `[${entry.at}] ` : ''}${entry.stage ? `[${deploymentStageLabel(entry.stage)}] ` : ''}${entry.message}`,
    )
    .join('\n')
  const exportLogs = async (download: boolean) => {
    if (exportDisabled) return
    setExportError(null)
    try {
      if (!download) {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        return
      }
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `deployment-${taskId}.log`
        anchor.click()
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0)
      }
    } catch {
      setExportError(download ? '日志下载失败，请重试。' : '日志复制失败，请检查剪贴板权限后重试。')
    }
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="任务日志">
      {task || taskPicker ? (
        <Collapsible className="shrink-0 border-b border-border/60 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {taskPicker}
            {task ? (
              <>
                <Badge
                  size="sm"
                  variant={
                    task.status === 'succeeded'
                      ? 'success'
                      : ['failed', 'rolled_back', 'interrupted'].includes(task.status)
                        ? 'error'
                        : 'info'
                  }
                >
                  {deploymentStatusLabel(task.status)}
                </Badge>
                {!deploymentTaskFinished(task) ? <Spinner size="sm" /> : null}
                {reportedStage ? (
                  <Button
                    size="xs"
                    variant={stage === reportedStage ? 'secondary' : 'ghost'}
                    aria-label={`查看${deploymentStageLabel(reportedStage)}阶段日志`}
                    aria-pressed={stage === reportedStage}
                    onClick={() => selectStage(reportedStage)}
                  >
                    {deploymentStageLabel(reportedStage)}
                  </Button>
                ) : null}
                {!taskPicker ? (
                  <span className="min-w-0 truncate text-muted-foreground">
                    {dateLabel(task.createdAt)}
                  </span>
                ) : null}
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  {task.stageHistory?.length ? (
                    <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
                      执行阶段（{task.stageHistory.length}）
                    </CollapsibleTrigger>
                  ) : null}
                  {task.sourceIdentity?.sourceVersionId ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      render={
                        <Link
                          to="/workspaces"
                          search={{
                            projectId: ProjectId.make(projectId),
                            versionId: task.sourceIdentity.sourceVersionId,
                          }}
                        />
                      }
                    >
                      查看任务来源
                    </Button>
                  ) : null}
                </div>
              </>
            ) : error ? null : (
              <Spinner size="sm" />
            )}
          </div>
          {task ? <TaskOutcome task={task} /> : null}
          {task?.stageHistory?.length ? (
            <CollapsiblePanel>
              <ol
                className="flex flex-wrap items-center gap-1 pt-2 text-muted-foreground"
                aria-label="执行阶段记录"
              >
                {task.stageHistory.map((entry, index) => (
                  <li key={`${entry.stage}:${index}`} className="flex items-center gap-1">
                    {index ? <ChevronRightIcon className="size-3" aria-hidden="true" /> : null}
                    <Button
                      size="xs"
                      variant={stage === entry.stage ? 'secondary' : 'ghost'}
                      aria-label={`查看${deploymentStageLabel(entry.stage)}阶段日志`}
                      aria-pressed={stage === entry.stage}
                      onClick={() => selectStage(entry.stage)}
                    >
                      {deploymentStageLabel(entry.stage)}
                    </Button>
                  </li>
                ))}
              </ol>
            </CollapsiblePanel>
          ) : null}
        </Collapsible>
      ) : error ? null : (
        <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Spinner size="sm" />
          正在读取执行记录…
        </div>
      )}
      {error ? (
        <p
          className="shrink-0 border-b border-border/60 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error.message}{' '}
          {error.retrying ? '已保留当前日志，连接恢复后继续读取。' : '当前任务已停止读取。'}
        </p>
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <Input
          ref={search}
          className="min-w-28 flex-1"
          size="sm"
          aria-label="搜索部署日志"
          placeholder="搜索日志"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setCopied(false)
          }}
        />
        <div className="w-36 min-w-0 shrink-0">
          <Choice
            label="日志阶段"
            value={stage}
            options={[
              { id: 'all', name: '全部阶段' },
              ...selectableStages.map((id) => ({ id, name: deploymentStageLabel(id) })),
            ]}
            onChange={selectStage}
          />
        </div>
        {query || stage !== 'all' ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="清除日志筛选"
            title="清除日志筛选"
            onClick={() => {
              setQuery('')
              selectStage('all')
              search.current?.focus()
            }}
          >
            <XIcon />
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="复制日志"
          title={
            task && !deploymentTaskFinished(task)
              ? '复制截至当前读取进度的筛选日志'
              : '复制当前筛选日志'
          }
          disabled={exportDisabled}
          onClick={() => void exportLogs(false)}
        >
          <CopyIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="下载日志"
          title={
            task && !deploymentTaskFinished(task)
              ? '下载截至当前读取进度的筛选日志'
              : '下载当前筛选日志'
          }
          disabled={exportDisabled}
          onClick={() => void exportLogs(true)}
        >
          <DownloadIcon />
        </Button>
        {copied ? (
          <span role="status" className="text-xs text-muted-foreground">
            已复制
          </span>
        ) : null}
        {backfilling ? <span className="text-xs text-muted-foreground">正在补读日志…</span> : null}
      </div>
      {exportError ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {exportError}
        </p>
      ) : null}
      <div ref={surface} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ScrollArea
          contentSizing="viewport"
          radius="none"
          className="min-h-0 flex-1"
          viewportTabIndex={0}
        >
          <pre
            className="m-0 min-h-full whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-5"
            aria-label="部署增量日志"
          >
            {filtered.length
              ? filtered.map((entry) => (
                  <span key={entry.seq} className="block">
                    {entry.at ? `[${new Date(entry.at).toLocaleTimeString('zh-CN')}] ` : ''}
                    {entry.stage ? `[${deploymentStageLabel(entry.stage)}] ` : ''}
                    {entry.message}
                  </span>
                ))
              : error && !error.retrying
                ? '当前任务日志不可用。'
                : backfilling
                  ? '正在补读日志…'
                  : logs.length && (query || stage !== 'all')
                    ? '没有匹配的日志。'
                    : task && deploymentTaskFinished(task)
                      ? '该任务没有执行日志。'
                      : '等待部署执行器返回日志…'}
          </pre>
        </ScrollArea>
        {!following ? (
          <Button
            size="sm"
            variant="outline"
            className="absolute bottom-3 right-3"
            onClick={latest}
          >
            <ArrowDownIcon />
            回到最新日志
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function TaskOutcome({ task }: { task: DeploymentTask }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const result = task.result
  const errors = [task.error, result?.error, result?.rollback?.error, result?.cleanupError].filter(
    (value): value is string => !!value,
  )
  const uniqueErrors = [...new Set(errors)]
  const rollbackLabel = result?.rollback?.status
    ? {
        succeeded: '已恢复上一版本',
        failed: '自动恢复失败',
        unavailable: '没有可用的自动恢复版本',
      }[result.rollback.status]
    : null
  return (
    <>
      {uniqueErrors.length ? (
        <p className="mt-2 break-words text-destructive">
          {uniqueErrors[0]!.slice(0, 200)}
          {uniqueErrors[0]!.length > 200 ? '…' : ''}
        </p>
      ) : null}
      {rollbackLabel && !uniqueErrors[0]?.includes(rollbackLabel) ? (
        <p className="mt-1 text-muted-foreground">{rollbackLabel}</p>
      ) : null}
      {result?.cleanupError ? (
        <p className="mt-1 text-destructive">部署清理出现异常，请查看详情。</p>
      ) : null}
      {uniqueErrors.length ? (
        <Button
          ref={trigger}
          size="xs"
          variant="ghost"
          className="mt-1"
          onClick={() => setOpen(true)}
        >
          故障与恢复详情
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="sm:max-w-xl" finalFocus={() => trigger.current}>
          <DialogHeader>
            <DialogTitle>故障与恢复详情</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <dl className="space-y-4 text-sm">
              {[
                ['任务错误', task.error],
                ['原始失败原因', result?.error],
                ['自动恢复结果', rollbackLabel],
                ['自动恢复失败原因', result?.rollback?.error],
                ['清理异常', result?.cleanupError],
                ['恢复方式', result?.recoveryMethod],
              ]
                .filter((entry) => !!entry[1])
                .map(([label, value]) => (
                  <div key={label}>
                    <dt className="mb-1 text-xs text-muted-foreground">{label}</dt>
                    <dd className="whitespace-pre-wrap break-words">{value}</dd>
                  </div>
                ))}
            </dl>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  )
}
