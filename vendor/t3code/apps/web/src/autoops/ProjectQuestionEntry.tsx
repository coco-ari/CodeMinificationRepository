import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { Button } from '~/components/ui/button'
import type { AutoOpsT3Bootstrap } from './hostConfig'
import { refreshProjectHost } from './projectDirectory'

type ProjectQuestionEntryProps = {
  project: AutoOpsT3Bootstrap['projects'][number]
  disabled?: boolean
}

export function ProjectQuestionEntry(props: ProjectQuestionEntryProps) {
  return <ProjectQuestionEntryContent key={props.project.id} {...props} />
}

function ProjectQuestionEntryContent({ project, disabled = false }: ProjectQuestionEntryProps) {
  const search = useLocation({ select: (location) => location.search }) as {
    section?: string
    from?: string
  }
  const directory = project.assistants
  const ready = directory?.ready === true
  const canManage = project.capabilities?.['project.manage'] === true
  const defaultAssistant = directory?.items.find(
    (item) => item.preset.id === directory.defaultAssistantId,
  )
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshController = useRef<AbortController | null>(null)

  useEffect(() => {
    setRefreshing(false)
    setError(null)
    return () => {
      refreshController.current?.abort()
      refreshController.current = null
    }
  }, [directory, canManage])

  async function refresh() {
    if (refreshController.current || disabled) return
    const controller = new AbortController()
    refreshController.current = controller
    setRefreshing(true)
    setError(null)
    try {
      await refreshProjectHost(controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '无法刷新问答状态，请重试。')
    } finally {
      if (refreshController.current === controller) {
        refreshController.current = null
        setRefreshing(false)
      }
    }
  }

  const action = ready ? (
    disabled ? (
      <Button size="sm" disabled>
        开始问答
      </Button>
    ) : (
      <Button size="sm" render={<Link to="/" search={{ projectId: ProjectId.make(project.id) }} />}>
        开始问答
      </Button>
    )
  ) : (
    <div className="flex flex-wrap items-center gap-2">
      {canManage && directory ? (
        disabled ? (
          <Button size="sm" disabled>
            配置助手
          </Button>
        ) : (
          <Button
            size="sm"
            render={
              <Link
                to="/assistants"
                search={{
                  projectId: ProjectId.make(project.id),
                  from: 'projects',
                  ...(search.section === 'git' ? { returnSection: 'git' } : {}),
                  ...(search.from === 'deployments' ? { returnFrom: 'deployments' } : {}),
                }}
              />
            }
          >
            配置助手
          </Button>
        )
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || refreshing}
        aria-busy={refreshing}
        onClick={() => void refresh()}
      >
        刷新状态
      </Button>
    </div>
  )

  return (
    <SettingsSection title="开始使用">
      <SettingsRow
        title="问答"
        description={
          ready ? (
            <span className="wrap-anywhere">
              {defaultAssistant?.available
                ? `默认助手：${defaultAssistant.preset.name}。`
                : '问答已可用。'}
              {directory?.canAdjust ? '可在问答中调整配置。' : '使用管理员预设的配置。'}
            </span>
          ) : directory ? (
            ((defaultAssistant?.available === false ? defaultAssistant.reason?.message : null) ??
            directory.reason?.message ??
            '问答暂不可用，请刷新后重试。')
          ) : (
            '问答状态尚未提供，请刷新后重试。'
          )
        }
        status={
          !ready && directory && !canManage && !defaultAssistant
            ? '请联系项目管理员完成助手分配。'
            : undefined
        }
        control={action}
      >
        {error ? (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  )
}
