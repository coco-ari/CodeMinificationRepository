import { InfoIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Popover, PopoverTrigger, PopoverPopup, PopoverTitle } from '~/components/ui/popover'
import type { DeploymentTarget, DeploymentTask } from '../deployments'
import { DeploymentReleaseIdentity } from './DeploymentReleaseIdentity'
import { DeploymentSourceDetails } from './DeploymentSourceDetails'
import { deriveDeploymentRuntimeStatus } from './deploymentRuntimeStatus'
import { deploymentObservationLabel } from './deploymentPresentation'

export function DeploymentRuntimeSummary({
  target,
  tasks,
  serverName,
  online,
  onTask,
}: {
  target: DeploymentTarget
  tasks: DeploymentTask[]
  serverName: string
  online: boolean
  onTask: (id: string) => void
}) {
  const runtime = deriveDeploymentRuntimeStatus(target, tasks)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-4 py-2 text-xs">
      <div
        role="region"
        aria-label="已确认部署版本"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1"
      >
        <span>上次确认版本</span>
        {target.currentRelease ? (
          <DeploymentReleaseIdentity release={target.currentRelease} />
        ) : (
          <span>尚未发布</span>
        )}
        {target.currentRelease?.sourceIdentity ? (
          <DeploymentSourceDetails source={target.currentRelease.sourceIdentity} label="版本来源" />
        ) : null}
        <span>{deploymentObservationLabel(target)}</span>
      </div>
      <Popover>
        <PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label="运行信息" />}>
          <InfoIcon />
        </PopoverTrigger>
        <PopoverPopup width="md" padding="compact" align="end" touchBackdrop>
          <div aria-label="部署运行记录" className="space-y-3 text-sm">
            <PopoverTitle>运行信息</PopoverTitle>
            <p>
              {serverName} · {online ? '在线' : '离线'}
            </p>
            <p>{deploymentObservationLabel(target)}</p>
            <p className="text-xs text-muted-foreground">
              最后观测：
              {target.lastObservedAt
                ? new Date(target.lastObservedAt).toLocaleString('zh-CN')
                : '尚未报告'}
            </p>
            <code className="block break-all text-xs">
              {target.currentRelease?.revision ?? target.currentRelease?.id ?? '尚无成功记录'}
            </code>
            {target.currentRelease?.sourceIdentity ? (
              <DeploymentSourceDetails
                source={target.currentRelease.sourceIdentity}
                label="查看已确认版本来源"
              />
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      {runtime.state === 'uncertain' ? (
        <div className="flex basis-full flex-wrap items-center gap-2 text-destructive">
          <span>{runtime.message}</span>
          <Button
            size="xs"
            variant="outline"
            aria-label="查看待核对任务"
            onClick={() => onTask(runtime.attentionTaskId ?? '')}
          >
            查看任务
          </Button>
        </div>
      ) : runtime.state === 'updating' ? (
        <p className="basis-full text-muted-foreground">{runtime.message}</p>
      ) : null}
    </div>
  )
}
