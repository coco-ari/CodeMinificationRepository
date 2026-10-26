import { useEffect, useRef, useState, type RefObject } from 'react'
import { EllipsisIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Menu, MenuTrigger, MenuPopup, MenuItem } from '~/components/ui/menu'
import { SettingsGroup } from '~/components/settings/SettingsGroup'
import { SettingsSection, SettingsRow } from '~/components/settings/settingsLayout'
import { isAutoOpsAccessError } from './apiClient'
import {
  loadProjectRepositories,
  checkProjectRepository,
  type ProjectRepositoryConnection,
} from './projectRepositories'
import { loadAuthoringCredentials, type WorkspaceCredentialMetadata } from './workspaceAuthoring'
import type { ProjectConfigurationEditor } from './projectConfiguration'

export function ProjectRepositoryPanel({
  projectId,
  revision,
  disabled,
  onOpen,
  addButtonRef,
}: {
  projectId: string
  revision: number
  disabled: boolean
  onOpen(editor: ProjectConfigurationEditor, button: HTMLButtonElement): void
  addButtonRef: RefObject<HTMLButtonElement | null>
}) {
  const [state, setState] = useState<{
    revision: number
    items: ProjectRepositoryConnection[]
    credentials: WorkspaceCredentialMetadata[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const manageButtons = useRef<Record<string, HTMLButtonElement | null>>({})
  const [checking, setChecking] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, { error: boolean; text: string }>>({})
  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    setChecking(null)
    setResult({})
    void Promise.all([
      loadProjectRepositories(projectId, controller.signal),
      loadAuthoringCredentials(projectId, controller.signal),
    ])
      .then(([next, credentials]) => {
        if (!controller.signal.aborted) {
          setState({ ...next, credentials: credentials.credentials })
          setResult({})
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        if (isAutoOpsAccessError(cause)) setState(null)
        setError(cause instanceof Error ? cause.message : '无法读取项目仓库')
      })
    return () => controller.abort()
  }, [projectId, revision, attempt])
  useEffect(() => {
    if (!checking) return
    const controller = new AbortController(),
      id = checking
    void checkProjectRepository(projectId, id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setResult((current) => ({
            ...current,
            [id]: {
              error: false,
              text: `连接正常 · ${value.branches.length}${value.truncated ? '+' : ''} 个分支`,
            },
          }))
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        if (isAutoOpsAccessError(cause)) {
          setState(null)
          setError(cause instanceof Error ? cause.message : '仓库管理权限已撤回')
        }
        setResult((current) => ({
          ...current,
          [id]: { error: true, text: cause instanceof Error ? cause.message : '连接检查失败' },
        }))
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(null)
      })
    return () => controller.abort()
  }, [projectId, checking])
  const open = (
    button: HTMLButtonElement,
    repository?: ProjectRepositoryConnection,
    remove = false,
  ) =>
    state &&
    onOpen(
      {
        kind: 'repository',
        name: repository?.name ?? '',
        description: '',
        revision: state.revision,
        ...(repository ? { id: repository.id } : {}),
        remove,
        value: repository
          ? {
              name: repository.name,
              url: repository.url,
              ...(repository.credentialId ? { credentialId: repository.credentialId } : {}),
            }
          : { name: '', url: '' },
        context: { credentials: state.credentials },
      },
      button,
    )
  return (
    <SettingsSection
      title="代码仓库"
      headerAction={
        <Button
          ref={addButtonRef}
          variant="ghost"
          size="sm"
          disabled={disabled || !state || !!error}
          onClick={(event) => open(event.currentTarget)}
        >
          添加仓库
        </Button>
      }
    >
      {error ? (
        <div role="alert" className="flex items-center gap-2">
          <span>{error}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试仓库配置
          </Button>
        </div>
      ) : null}
      {!state && !error ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取仓库
        </p>
      ) : null}
      <SettingsGroup>
        {state?.items.map((repository) => (
          <SettingsRow
            key={repository.id}
            title={repository.name}
            description={
              <span className="block min-w-0 space-y-1 break-all">
                <span className="block">{repository.url}</span>
                {repository.credentialId ? (
                  <span className="block">
                    凭证：
                    {state.credentials.find((value) => value.id === repository.credentialId)
                      ?.name ?? '已不可用'}
                  </span>
                ) : null}
                {result[repository.id] ? (
                  <span className="block" role={result[repository.id]!.error ? 'alert' : 'status'}>
                    {result[repository.id]!.text}
                  </span>
                ) : null}
              </span>
            }
            control={
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || checking !== null}
                  onClick={() => setChecking(repository.id)}
                >
                  {checking === repository.id ? '正在检查' : '检查连接'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`编辑仓库 ${repository.name}`}
                  onClick={(event) => open(event.currentTarget, repository)}
                >
                  编辑
                </Button>
                <Menu>
                  <MenuTrigger
                    ref={(element) => {
                      manageButtons.current[repository.id] =
                        element instanceof HTMLButtonElement ? element : null
                    }}
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`管理仓库 ${repository.name}`}
                        disabled={disabled}
                      />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      onClick={() => {
                        const button = manageButtons.current[repository.id]
                        if (button) open(button, repository, true)
                      }}
                    >
                      移除连接
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            }
          />
        ))}
        {state && !state.items.length ? <SettingsRow title="暂无仓库" /> : null}
      </SettingsGroup>
    </SettingsSection>
  )
}
