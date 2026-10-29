import { Link, useLocation } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import { SettingsSection, SettingsRow } from '~/components/settings/settingsLayout'
import type { ProjectSettings } from './projectDirectory'
import type { AssistantSetupSummary } from './ProjectSetupOverview'
import { isAutoOpsAccessError } from './apiClient'
import {
  loadAssistantSettings,
  loadAssistantChoices,
  type AssistantSettings,
  type AssistantChoices,
  type AssistantTarget,
} from './projectAssistants'
import { projectRoleNames, type ProjectConfigurationEditor } from './projectConfiguration'
export function ProjectConfigurationPanel({
  project,
  disabled,
  revision,
  onOpen,
  onSummary,
}: {
  project: ProjectSettings
  disabled: boolean
  revision: number
  onOpen(editor: ProjectConfigurationEditor, button: HTMLButtonElement): void
  onSummary?: (value: AssistantSetupSummary | null) => void
}) {
  const search = useLocation({ select: (location) => location.search }) as {
    section?: string
    from?: string
  }
  const [assistants, setAssistants] = useState<AssistantSettings | null>(null)
  const [choices, setChoices] = useState<AssistantChoices | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accessDenied, setAccessDenied] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    onSummary?.(
      error
        ? { error }
        : assistants
          ? {
              enabled: assistants.presets.filter((preset) => preset.enabled).length,
              allocations: assistants.allocations.filter(
                (allocation) => allocation.assistantIds.length > 0,
              ).length,
            }
          : null,
    )
  }, [assistants, error, onSummary])
  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    void Promise.all([
      loadAssistantSettings(project.project.id, controller.signal),
      loadAssistantChoices(project.project.id, controller.signal),
    ])
      .then(([next, capabilities]) => {
        if (!controller.signal.aborted) {
          setAssistants(next)
          setChoices(capabilities)
          setAccessDenied(false)
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) return
        if (isAutoOpsAccessError(cause)) {
          setAssistants(null)
          setChoices(null)
          setAccessDenied(true)
        }
        setError(cause instanceof Error ? cause.message : '助手读取失败')
      })
    return () => controller.abort()
  }, [project.project.id, revision, attempt])
  const context = assistants && choices ? { project, assistants, choices } : null
  const allocate = (target: AssistantTarget, button: HTMLButtonElement) => {
    if (!context) return
    const previous = context.assistants.allocations.find(
      (item) => item.target.kind === target.kind && item.target.id === target.id,
    )
    onOpen(
      {
        kind: 'allocation',
        name: '分配助手',
        description: '',
        revision: previous?.revision ?? 0,
        target,
        assistantIds: previous?.assistantIds ?? [],
        defaultAssistantId: previous?.defaultAssistantId ?? null,
        context,
      },
      button,
    )
  }
  if (accessDenied)
    return (
      <SettingsSection title="项目配置">
        <div role="alert" className="space-y-2">
          <p>{error}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试项目配置
          </Button>
        </div>
      </SettingsSection>
    )
  return (
    <>
      <SettingsSection title="项目助手">
        <SettingsRow
          title="助手配置"
          description={
            assistants
              ? `${assistants.presets.filter((preset) => preset.enabled).length} 个已启用助手`
              : '管理本项目的助手与分配'
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              render={
                <Link
                  to="/assistants"
                  search={{
                    projectId: ProjectId.make(project.project.id),
                    from: 'projects',
                    ...(search.section === 'git' ? { returnSection: 'git' } : {}),
                    ...(search.from === 'deployments' ? { returnFrom: 'deployments' } : {}),
                  }}
                />
              }
            >
              管理助手
            </Button>
          }
        />
        {error ? (
          <div role="alert" className="space-y-2">
            <p>{error}</p>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试助手目录
            </Button>
          </div>
        ) : null}
      </SettingsSection>
      <SettingsSection
        title="成员与权限"
        headerAction={
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={(event) =>
              onOpen(
                {
                  kind: 'member',
                  name: '添加成员',
                  description: '',
                  revision: 0,
                  value: {
                    userId: '',
                    role: 'reader',
                    environmentIds: [],
                    environmentRoles: {},
                    canAdjustChat: false,
                    status: 'active',
                  },
                  context: { project },
                },
                event.currentTarget,
              )
            }
          >
            添加成员
          </Button>
        }
      >
        {project.members.map((member) => (
          <SettingsRow
            key={member.userId}
            title={member.name}
            description={
              member.authorizationPending
                ? '待管理员分配'
                : member.status === 'disabled'
                  ? '已停用'
                  : projectRoleNames[member.role]
            }
            control={
              <div className="flex flex-wrap gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || !context || !!error}
                  aria-label={`分配助手给 ${member.name}`}
                  onClick={(event) =>
                    allocate({ kind: 'member', id: member.userId }, event.currentTarget)
                  }
                >
                  助手
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`编辑成员 ${member.name}`}
                  onClick={(event) =>
                    onOpen(
                      {
                        kind: 'member',
                        name: member.name,
                        description: '',
                        revision: member.revision,
                        value: {
                          userId: member.userId,
                          role: member.role,
                          environmentIds: [...member.environmentIds],
                          environmentRoles: { ...member.environmentRoles },
                          canAdjustChat: member.canAdjustChat,
                          status: member.status,
                        },
                        context: { project },
                      },
                      event.currentTarget,
                    )
                  }
                >
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`移除成员 ${member.name}`}
                  onClick={(event) =>
                    onOpen(
                      {
                        kind: 'member',
                        remove: true,
                        name: member.name,
                        description: '',
                        revision: member.revision,
                        value: {
                          userId: member.userId,
                          role: member.role,
                          environmentIds: member.environmentIds,
                          environmentRoles: member.environmentRoles,
                          canAdjustChat: member.canAdjustChat,
                          status: member.status,
                        },
                        context: { project },
                      },
                      event.currentTarget,
                    )
                  }
                >
                  移除
                </Button>
              </div>
            }
          >
            <span className="text-xs text-muted-foreground">
              {member.role === 'project_admin'
                ? '全部环境'
                : member.environmentIds
                    .map(
                      (id) => project.project.environments.find((env) => env.id === id)?.name ?? id,
                    )
                    .join('、') || '无环境'}
            </span>
          </SettingsRow>
        ))}
      </SettingsSection>
    </>
  )
}
