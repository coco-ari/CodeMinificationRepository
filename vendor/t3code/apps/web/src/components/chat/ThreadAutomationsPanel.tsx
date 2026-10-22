import { useAtomValue } from '@effect/atom-react'
import { ThreadDetailsControl } from './ThreadDetailsControl'
import { useNavigate } from '@tanstack/react-router'
import { CalendarClockIcon, PencilIcon, PlayIcon, Settings2Icon } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from '@t3tools/contracts'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'

import { ThreadDetailsSection } from './ThreadDetailsSection'
import { cn } from '../../lib/utils'
import { ScheduledRelativeLabel, scheduleLabel } from '../settings/ScheduledTasksSettings'
import { useEnvironmentQuery } from '../../state/query'
import { serverEnvironment } from '../../state/server'
import { useAtomCommand } from '../../state/use-atom-command'
import { autoOpsFeature } from '../../autoops/capabilities'

import { readEnvironmentScope } from '../../state/session'
import { Switch } from '../ui/switch'
import { stackedThreadToast, toastManager } from '../ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from './threadDetailsPanelStyles'

const STATUS_DOT_CLASS: Record<ScheduledTask['lastRunStatus'], string> = {
  never: 'bg-muted-foreground/40',
  running: 'bg-sky-500',
  succeeded: 'bg-emerald-500',
  failed: 'bg-destructive',
}

function taskScheduleLine(task: ScheduledTask) {
  return (
    <>
      {scheduleLabel(task.schedule)}
      {task.enabled && task.nextRunAt !== null ? (
        <>
          {' · next '}
          <ScheduledRelativeLabel value={task.nextRunAt} />
        </>
      ) : task.enabled ? (
        ''
      ) : (
        ' · paused'
      )}
    </>
  )
}

interface ThreadAutomationsPanelProps {
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
}

export function ThreadAutomationsPanel(props: ThreadAutomationsPanelProps): ReactElement | null {
  // The native scheduler stays available to standalone T3. AutoOps has no
  // registered scheduled business actions, so don't mount its live query or
  // turn a denied scheduler RPC into a misleading authentication failure.
  if (!autoOpsFeature('scheduledTasks')) {
    return (
      <ThreadDetailsSection
        headingId="thread-details-automations-heading"
        title="定时任务"
        data-thread-automations-panel
        actions={
          <ThreadDetailsControl
            size="icon-xs"
            variant="ghost"
            part="icon"
            aria-label="管理定时任务"
            disabled
          >
            <Settings2Icon className="size-3.5" />
          </ThreadDetailsControl>
        }
      >
        <p className="px-2.5 py-1.5 text-2xs text-muted-foreground">
          当前业务环境尚未开放定时任务。
        </p>
      </ThreadDetailsSection>
    )
  }
  return <EnabledThreadAutomationsPanel {...props} />
}

function EnabledThreadAutomationsPanel(props: ThreadAutomationsPanelProps) {
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(props.environmentId),
  )
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  )
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: 'thread automation toggle',
  })
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: 'thread automation run now',
  })
  const navigate = useNavigate()
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)

  const boundTasks = (tasksQuery.data?.tasks ?? []).filter(
    (task) => task.threadId === props.threadId,
  )

  if (tasksQuery.error === null && boundTasks.length === 0) return null

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: 'error',
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  const toggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return
    setBusyTaskId(task.id)
    // Partial update: only the enabled flag changes, so a toggle can never
    // revert concurrent edits made to the task elsewhere.
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    })
    setBusyTaskId(null)
    if (result._tag === 'Failure' && !isAtomCommandInterrupted(result)) {
      reportFailure("无法更新定时任务", squashAtomCommandFailure(result))
    }
  }

  const runNow = async (task: ScheduledTask) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return
    setBusyTaskId(task.id)
    const result = await runTaskNow({
      environmentId: props.environmentId,
      input: { id: task.id },
    })
    setBusyTaskId(null)
    if (result._tag === 'Failure' && !isAtomCommandInterrupted(result)) {
      reportFailure("无法执行定时任务", squashAtomCommandFailure(result))
    }
  }

  return (
    <ThreadDetailsSection
      headingId="thread-details-automations-heading"
      title="定时任务"
      data-thread-automations-panel
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="管理定时任务"
                onClick={() =>
                  void navigate({
                    to: '/settings/scheduled-tasks',
                    search: { environmentId: props.environmentId },
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>管理定时任务</TooltipPopup>
        </Tooltip>
      }
    >
      {tasksQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          
          无法加载定时任务： {tasksQuery.error}
        </p>
      ) : null}

      <ul className="m-0 list-none p-0">
        {boundTasks.map((task) => (
          <li
            key={task.id}
            className={cn(
              'group flex items-center rounded-lg py-1.5',
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
              <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span
                className={cn(
                  'absolute -right-1 -top-1 size-1.5 rounded-full',
                  STATUS_DOT_CLASS[task.lastRunStatus],
                )}
                aria-hidden
              />
            </span>
            <Tooltip>
              <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
                <span className="block truncate text-sm font-medium text-foreground/80">
                  {task.title}
                </span>
                <p className="truncate text-2xs text-muted-foreground">{taskScheduleLine(task)}</p>
              </TooltipTrigger>
              <TooltipPopup side="left">
                <p className="font-medium">{task.title}</p>
                <p className="text-muted-foreground">{taskScheduleLine(task)}</p>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`编辑 ${task.title}`}
                    onClick={() =>
                      void navigate({
                        to: '/settings/scheduled-tasks',
                        search: { environmentId: props.environmentId, taskId: task.id },
                      })
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>编辑定时任务</TooltipPopup>
            </Tooltip>
            {/* A webhook task runs from its URL; there is no request to run it with. */}
            {task.schedule.type === 'webhook' ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={`执行 ${task.title} now`}
                      disabled={
                        !canOperate || busyTaskId !== null || task.lastRunStatus === 'running'
                      }
                      onClick={() => void runNow(task)}
                    >
                      <PlayIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>立即执行</TooltipPopup>
              </Tooltip>
            )}
            <Switch
              checked={task.enabled}
              disabled={!canOperate || busyTaskId !== null}
              aria-label={task.enabled ? `暂停 ${task.title}` : `恢复 ${task.title}`}
              onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
            />
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  )
}
