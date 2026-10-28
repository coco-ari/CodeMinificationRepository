import { useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import { SettingsSection, SettingsRow } from '~/components/settings/settingsLayout'
import type { ProjectSettings } from './projectDirectory'
import { isAutoOpsAccessError } from './apiClient'
import {
  loadAssistantSettings,
  loadAssistantChoices,
  type AssistantSettings,
  type AssistantChoices,
  type AssistantTarget,
} from './projectAssistants'
import {
  projectRoleNames,
  emptyConfig,
  type ProjectConfigurationEditor,
} from './projectConfiguration'
export function ProjectConfigurationPanel({
  project,
  disabled,
  revision,
  onOpen,
}: {
  project: ProjectSettings
  disabled: boolean
  revision: number
  onOpen(editor: ProjectConfigurationEditor, button: HTMLButtonElement): void
}) {
  const [assistants, setAssistants] = useState<AssistantSettings | null>(null)
  const [choices, setChoices] = useState<AssistantChoices | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accessDenied, setAccessDenied] = useState(false)
  const [attempt, setAttempt] = useState(0)
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
      <SettingsSection
        title="项目助手"
        headerAction={
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || !context || !!error}
              onClick={(event) =>
                context &&
                onOpen(
                  {
                    kind: 'assistant',
                    name: '',
                    description: '',
                    revision: 0,
                    value: {
                      name: '',
                      description: '',
                      instructions: '',
                      enabled: true,
                      configuration: emptyConfig(),
                    },
                    context,
                  },
                  event.currentTarget,
                )
              }
            >
              添加助手
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || !context || !!error}
              onClick={(event) => allocate({ kind: 'role', id: 'reader' }, event.currentTarget)}
            >
              分配助手
            </Button>
          </div>
        }
      >
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
        ) : !assistants ? (
          <p role="status">正在读取助手…</p>
        ) : (
          <>
            {assistants.presets.map((preset) => (
              <SettingsRow
                key={preset.id}
                title={preset.name}
                description={`${preset.enabled ? (preset.configuration.executionBinding.kind === 'platform' ? '平台运行器' : '用户运行器') : '已停用'} · ${preset.configuration.model.model}`}
                control={
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled || !context}
                    aria-label={`编辑助手 ${preset.name}`}
                    onClick={(event) =>
                      context &&
                      onOpen(
                        {
                          kind: 'assistant',
                          id: preset.id,
                          name: preset.name,
                          description: preset.description,
                          revision: preset.revision,
                          value: {
                            name: preset.name,
                            description: preset.description,
                            instructions: preset.instructions,
                            enabled: preset.enabled,
                            configuration: preset.configuration,
                          },
                          context,
                        },
                        event.currentTarget,
                      )
                    }
                  >
                    编辑
                  </Button>
                }
              />
            ))}
            {!assistants.presets.length ? <SettingsRow title="暂无助手" /> : null}
          </>
        )}
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
              </div>
            }
          >
            <span className="text-xs text-muted-foreground">
              {member.role === 'project_admin'
                ? '全部环境'
                : member.environmentIds
                    .map(
                      (id) =>
                        project.project.environments.find((env) => env.id === id)?.name ?? id,
                    )
                    .join('、') || '无环境'}
            </span>
          </SettingsRow>
        ))}
      </SettingsSection>
    </>
  )
}
