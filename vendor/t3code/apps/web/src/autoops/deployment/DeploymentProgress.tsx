import { useEffect, useState } from 'react'
import { CheckIcon, CircleAlertIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { deploymentTaskFinished, type DeploymentTask } from '../deployments'

const aliases: Record<string, string> = {
  download: 'downloading',
  extract: 'downloading',
  extracting: 'downloading',
  build: 'building',
  deploy: 'deploying',
  health: 'verifying',
  healthcheck: 'verifying',
  checking: 'verifying',
  prepare: 'source_fetch',
  preparing: 'source_fetch',
}
export const normalizeDeploymentStage = (stage: string) => aliases[stage] ?? stage

export function deploymentProgress(task: DeploymentTask) {
  const stages =
    task.action === 'restart' || task.action === 'rollback'
      ? [
          ['deploying', task.action === 'restart' ? '重启服务' : '恢复版本'],
          ['verifying', '健康检查'],
        ]
      : [
          ['source_fetch', '获取源码'],
          ['source_resolve', '固定提交'],
          ['source_archive', '保存源码包'],
          ['downloading', '下载校验'],
          ['building', task.config?.kind === 'static' ? '构建前端' : '编译 JAR'],
          ...(task.config?.kind !== 'static' && task.detailedAgentStages
            ? [['image', '构建镜像']]
            : []),
          ['deploying', task.config?.kind === 'static' ? '切换站点' : '更新服务'],
          ['verifying', '健康检查'],
        ]
  const normalize = normalizeDeploymentStage
  const history = task.stageHistory ?? []
  const terminal = deploymentTaskFinished(task)
  return stages.map(([id, label]) => {
    const entries = history.filter((row) => normalize(row.stage) === id)
    const active = !terminal && normalize(task.stage) === id
    const failed =
      terminal &&
      task.status !== 'succeeded' &&
      entries.length > 0 &&
      (normalize(task.stage) === id ||
        !stages.some(
          ([later]) =>
            stages.findIndex(([value]) => value === later) >
              stages.findIndex(([value]) => value === id) &&
            history.some((row) => normalize(row.stage) === later),
        ))
    const finished =
      entries.length > 0 &&
      !active &&
      !failed &&
      entries.every((row) => !!row.finishedAt || terminal)
    return { id: id!, label: label!, entries, active, failed: !!failed, finished }
  })
}

/** 只把已记录的阶段画成完成，缺失事件与恢复结果均不猜测。 */
export function DeploymentProgress({
  task,
  selected,
  onSelect,
}: {
  task: DeploymentTask
  selected: string
  onSelect: (stage: string) => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (deploymentTaskFinished(task)) return
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, 1000)
    return () => clearInterval(timer)
  }, [task.id, task.status])
  if (deploymentTaskFinished(task) && !task.stageHistory?.length) return null
  const steps = deploymentProgress(task)
  return (
    <ol
      aria-label="发布执行流程"
      className="flex flex-wrap gap-1 border-b border-border/60 px-3 py-2"
    >
      {steps.map((step) => {
        const duration = step.entries.reduce((total, entry) => {
          const start = Date.parse(entry.startedAt ?? '')
          const end = Date.parse(entry.finishedAt ?? task.finishedAt ?? '')
          return (
            total +
            (entry.durationMs ??
              (Number.isFinite(start) && (Number.isFinite(end) || step.active)
                ? Math.max(0, (Number.isFinite(end) ? end : now) - start)
                : 0))
          )
        }, 0)
        return (
          <li key={step.id}>
            <Button
              size="xs"
              variant={selected === step.id ? 'secondary' : 'ghost'}
              disabled={!step.entries.length}
              aria-pressed={selected === step.id}
              onClick={() => onSelect(step.id)}
              className={step.failed ? 'text-destructive' : ''}
            >
              {step.active ? (
                <Spinner size="sm" />
              ) : step.failed ? (
                <CircleAlertIcon />
              ) : step.finished ? (
                <CheckIcon />
              ) : null}
              <span>{step.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {step.entries.length
                  ? `${(duration / 1000).toFixed(0)} 秒`
                  : deploymentTaskFinished(task)
                    ? '未记录'
                    : '等待'}
              </span>
            </Button>
          </li>
        )
      })}
    </ol>
  )
}
