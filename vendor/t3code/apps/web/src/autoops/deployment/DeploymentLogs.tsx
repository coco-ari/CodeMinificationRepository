import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { ArrowDownIcon } from 'lucide-react'
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
  refresh,
  onAccessDenied,
}: DeploymentLogsProps) {
  const [task, setTask] = useState<DeploymentTask | null>(null)
  const [logs, setLogs] = useState<DeploymentLog[]>([])
  const [error, setError] = useState<{ message: string; retrying: boolean } | null>(null)
  const [following, setFollowing] = useState(true)
  const surface = useRef<HTMLDivElement | null>(null)
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
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="任务日志">
      {task ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
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
            {!deploymentTaskFinished(task) ? (
              <>
                <Spinner size="sm" />
                <span>{deploymentStageLabel(task.stage)}</span>
              </>
            ) : null}
            <span className="min-w-0 truncate text-muted-foreground">
              {dateLabel(task.createdAt)}
            </span>
          </div>
          {task.stageHistory?.length ? (
            <Collapsible className="mt-1">
              <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
                执行阶段（{task.stageHistory.length}）
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <ol
                  className="flex flex-wrap gap-x-3 gap-y-1 py-1 text-muted-foreground"
                  aria-label="执行阶段记录"
                >
                  {task.stageHistory.map((entry, index) => (
                    <li key={`${entry.stage}:${index}`}>{deploymentStageLabel(entry.stage)}</li>
                  ))}
                </ol>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
          <TaskOutcome task={task} />
          {task.sourceIdentity?.sourceVersionId ? (
            <Button
              size="xs"
              variant="ghost"
              className="mt-1"
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
            {logs.length
              ? logs.map((entry) => (
                  <span key={entry.seq} className="block">
                    {entry.at ? `[${new Date(entry.at).toLocaleTimeString('zh-CN')}] ` : ''}
                    {entry.stage ? `[${deploymentStageLabel(entry.stage)}] ` : ''}
                    {entry.message}
                  </span>
                ))
              : error && !error.retrying
                ? '当前任务日志不可用。'
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
