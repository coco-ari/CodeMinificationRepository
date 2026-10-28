import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { ArrowLeftIcon, FolderGit2Icon, PencilIcon, PlusIcon, RefreshCwIcon, ServerIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Label } from '~/components/ui/label'
import { SidebarInset } from '~/components/ui/sidebar'
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from '~/components/ui/dialog'
import { SettingsSection, SettingsRow } from '~/components/settings/settingsLayout'
import { WorkspacePageContainer } from '~/components/WorkspacePageContainer'
import { useMediaQuery } from '~/hooks/useMediaQuery'
import { toastManager } from '~/components/ui/toast'
import {
  ModuleHeader,
  ModuleSidebar,
  ModuleSidebarItem,
  ModuleSidebarEmpty,
} from './ModuleWorkspace'
import { ModuleErrorBoundary } from './ModuleErrorBoundary'
import { readAutoOpsHost, useAutoOpsHost } from './hostConfig'
import { selectAutoOpsProject } from './projectNavigation'
import { isAutoOpsAccessError, AutoOpsRequestError } from './apiClient'
import {
  loadProjectDirectory,
  loadProjectSettings,
  prepareProjectWrite,
  prepareProjectMutation,
  readPendingProjectWrite,
  submitProjectWrite,
  recoverProjectWrite,
  PendingProjectDeletion,
  refreshProjectHost,
  type DirectoryProject,
  type ProjectSettings,
} from './projectDirectory'

import { ProjectCredentialsPanel } from './ProjectCredentialsPanel'
import { ProjectRepositoryPanel } from './ProjectRepositoryPanel'
import { ProjectConfigurationPanel } from './ProjectConfigurationPanel'
import { ProjectConfigurationFields } from './ProjectConfigurationFields'
import { focusProjectSettingsArea, ProjectSettingsNavigation, ProjectSettingsTarget } from './ProjectSettingsNavigation'
import { DeploymentServers } from './deployment'
import { ProjectRemovalAction, ProjectRemovalDialog, type ProjectRemovalTarget } from './ProjectRemovalDialog'
import { EnvironmentMcpDialog } from './EnvironmentMcpDialog'
import { ProjectSetupOverview, type RepositorySetupSummary, type AssistantSetupSummary } from './ProjectSetupOverview'
import {
  isConfigurationEditor,
  configurationMutation,
  type ProjectConfigurationEditor,
} from './projectConfiguration'

type Editor =
  | ProjectConfigurationEditor
  | {
      kind: 'create' | 'project' | 'environment'
      environmentId?: string
      revision: number
      name: string
      description: string
    }
export function AutoOpsProjectsPage() {
  const location = useLocation()
  const focusDirectory = useRef(false)
  return (
    <ModuleErrorBoundary label="项目管理" resetKey={location.href}>
      <ProjectsContent
        key={String((location.search as { projectId?: string }).projectId ?? 'all')}
        focusDirectory={focusDirectory}
      />
    </ModuleErrorBoundary>
  )
}
function ProjectsContent({focusDirectory}: {focusDirectory: {current: boolean}}) {
  const wideHeader = useMediaQuery('sm')
  const [mcpEnvironment, setMcpEnvironment] = useState<{id: string; name: string} | null>(null)
  const mcpTrigger = useRef<HTMLButtonElement | null>(null)
  const [removalTarget, setRemovalTarget] = useState<ProjectRemovalTarget | null>(null)
  const [removalLocked, setRemovalLocked] = useState(false)
  const [removalCanResume, setRemovalCanResume] = useState(false)
  const removalReturn = useRef<HTMLButtonElement | null>(null)
  const refreshButton = useRef<HTMLButtonElement | null>(null)
  const [nodeScope, setNodeScope] = useState<{ scope: 'platform' } | { scope: 'project'; projectId: string; environmentId: string } | null>(null)
  const nodeTrigger = useRef<HTMLButtonElement | null>(null)
  const [credentialLocked, setCredentialLocked] = useState(false)
  const repositoryAddButton = useRef<HTMLButtonElement | null>(null)
  const host = useAutoOpsHost()
  const location = useLocation()
  const navigate = useNavigate()
  const search = location.search as { projectId?: string; section?: string; from?: string }
  const explicit = search.projectId
  const selected = host?.projects.find((project) => project.id === explicit)
  const manageable = selected?.capabilities?.['project.manage'] === true
  const [projects, setProjects] = useState<DirectoryProject[]>([])
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [configurationRevision, setConfigurationRevision] = useState(0)
  const [repositorySummary, setRepositorySummary] = useState<RepositorySetupSummary | null>(null)
  const [assistantSummary, setAssistantSummary] = useState<AssistantSetupSummary | null>(null)
  const readPending = () => readPendingProjectWrite(explicit ? { projectId: explicit } : undefined)
  const [pending, setPending] = useState(readPending)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const request = useRef<AbortController | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const load = useCallback(
    async (background = false) => {
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      if (!background) setLoading(true)
      setError(null)
      try {
        const [directory, details] = await Promise.all([
          loadProjectDirectory(controller.signal),
          explicit && manageable
            ? loadProjectSettings(explicit, controller.signal)
            : Promise.resolve(null),
        ])
        if (controller.signal.aborted) return
        setProjects(directory.items)
        setSettings(details)
      } catch (cause) {
        if (controller.signal.aborted) return
        if (isAutoOpsAccessError(cause)) {
          setProjects([])
          setSettings(null)
          if (!readPendingProjectWrite(explicit ? { projectId: explicit } : undefined)) setEditor(null)
        }
        setError(cause instanceof Error ? cause.message : '项目读取失败')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    },
    [explicit, manageable],
  )
  useEffect(() => {
    void load()
    return () => request.current?.abort()
  }, [load])
  const locatedSection = useRef<string | null>(null)
  useEffect(() => {
    if (loading || !settings || !manageable || search.section !== 'git' || locatedSection.current === location.href) return
    locatedSection.current = location.href
    focusProjectSettingsArea('git')
  }, [loading, settings, manageable, search.section, location.href])
  const go = (id?: string) => {
    if (id) selectAutoOpsProject(id)
    void navigate({ href: id ? `/projects?projectId=${encodeURIComponent(id)}` : '/projects' })
  }
  const open = (value: Editor, button: HTMLButtonElement) => {
    trigger.current = button
    setError(null)
    setEditor(value)
  }
  const save = async (retry = false) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const original = retry
        ? readPending()
        : editor
          ? isConfigurationEditor(editor)
            ? prepareProjectMutation(
                configurationMutation(explicit!, editor).path,
                editor.revision,
                configurationMutation(explicit!, editor).payload,
              )
            : prepareProjectWrite(
                editor.kind === 'create'
                  ? '/api/v1/projects'
                  : editor.kind === 'project'
                    ? `/api/v1/projects/${explicit}/settings`
                    : `/api/v1/projects/${explicit}/environments${editor.environmentId ? '/' + editor.environmentId : ''}`,
                editor.revision,
                editor.kind === 'environment'
                  ? { name: editor.name }
                  : { name: editor.name, description: editor.description },
              )
          : null
      if (!original) throw new Error('没有可重试的保存')
      let result: Record<string, unknown>
      try {
        result = retry ? await recoverProjectWrite(original) : await submitProjectWrite(original)
      } catch (cause) {
        if (retry || !(cause instanceof AutoOpsRequestError) || !cause.uncertain) throw cause
        result = await recoverProjectWrite(original)
      }
      if (!alive.current) return
      setPending(readPending())
      const unavailable = result.saved === true && result.available === false
      const entryUnverified = result.nativeSynchronization === 'unverified'
      toastManager.add({
        type: unavailable || entryUnverified ? 'info' : 'success',
        title: unavailable ? '操作已保存，当前对象不可访问' : entryUnverified ? '已保存，运行入口待核对' : '已保存',
      })
      try {
        await refreshProjectHost()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '配置已保存，项目范围尚未刷新')
      }
      if (
        original.path === '/api/v1/projects' &&
        typeof result.id === 'string' &&
        readAutoOpsHost()?.projects.some((project) => project.id === result.id)
      )
        go(result.id)
      else await load(true)
      if (alive.current) {
        if (editor?.kind === 'repository' && editor.remove)
          trigger.current = repositoryAddButton.current
        setConfigurationRevision((value) => value + 1)
        setEditor(null)
      }
    } catch (cause) {
      if (!alive.current) return
      setPending(readPending())
      if (cause instanceof PendingProjectDeletion && cause.canResume) {
        removalReturn.current = refreshButton.current
        setRemovalCanResume(true)
        setRemovalTarget({ ...cause.target, name: projects.find(project => project.id === cause.target.projectId)?.name ?? '原项目' })
        setEditor(null)
        setError(null)
        return
      }
      if (isAutoOpsAccessError(cause)) {
        setEditor(null)
        setSettings(null)
        setProjects([])
        void refreshProjectHost().catch(() => {})
      }
      setError(cause instanceof Error ? cause.message : '保存未完成')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  useEffect(() => {
    if (!loading && !explicit && focusDirectory.current) {
      focusDirectory.current = false
      refreshButton.current?.focus()
    }
  }, [loading, explicit, focusDirectory])
  const beginRemoval = (target: ProjectRemovalTarget, button: HTMLButtonElement) => {
    removalReturn.current = button
    setRemovalCanResume(false)
    setRemovalTarget(target)
  }
  const current = projects.find((project) => project.id === explicit)
  return (
    <SidebarInset className="h-dvh min-h-0 min-w-0 overflow-hidden" data-project-directory>
      <ModuleSidebar label="项目管理">
        <ModuleSidebarItem
          label="全部项目"
          selected={!explicit}
          icon={FolderGit2Icon}
          onClick={() => go()}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {projects.map((project) => (
            <ModuleSidebarItem
              key={project.id}
              label={project.name}
              selected={project.id === explicit}
              onClick={() => go(project.id)}
            />
          ))}
          {!loading && !projects.length ? (
            <ModuleSidebarEmpty>没有可见项目</ModuleSidebarEmpty>
          ) : null}
        </div>
      </ModuleSidebar>
      <ModuleHeader
        title="项目管理"
        detail={explicit ? (wideHeader ? '项目配置' : (selected?.name ?? '项目不可用')) : '全部项目'}
        actions={
          <>
            {host?.canManageDeploymentNodes ? (
              <Button variant="outline" size={wideHeader ? 'sm' : 'icon-sm'}
                aria-label="平台节点" title="平台节点"
                disabled={busy || !!pending || credentialLocked || removalLocked}
                onClick={(event) => {
                  nodeTrigger.current = event.currentTarget
                  setNodeScope({ scope: 'platform' })
                }}>
                <ServerIcon />
                {wideHeader ? '平台节点' : null}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              ref={refreshButton}
              aria-label="刷新项目"
              disabled={loading || busy}
              onClick={() => {
                void refreshProjectHost()
                  .then(() => load())
                  .then(() => setConfigurationRevision((value) => value + 1))
                  .catch((cause) => setError(String(cause.message)))
              }}
            >
              <RefreshCwIcon />
            </Button>
            {host?.canCreateProject && !explicit ? (
              <Button
                size="sm"
                onClick={(event) =>
                  open(
                    { kind: 'create', revision: 0, name: '', description: '' },
                    event.currentTarget,
                  )
                }
                disabled={busy || !!pending || credentialLocked || removalLocked}
              >
                <PlusIcon />
                创建项目
              </Button>
            ) : null}
            {manageable && settings ? (
              <Button
                variant="outline"
                size={wideHeader ? 'sm' : 'icon-sm'}
                aria-label="编辑项目"
                title="编辑项目"
                disabled={busy || !!pending || credentialLocked || removalLocked}
                onClick={(event) =>
                  open(
                    {
                      kind: 'project',
                      revision: settings.project.revision,
                      name: settings.project.name,
                      description: settings.project.description,
                    },
                    event.currentTarget,
                  )
                }
              >
                <PencilIcon />
                {wideHeader ? '编辑项目' : null}
              </Button>
            ) : null}
            {manageable && settings ? <ProjectRemovalAction
              target={{projectId: settings.project.id, name: settings.project.name, revision: settings.project.revision}}
              disabled={busy || !!pending || credentialLocked || removalLocked}
              onSelect={beginRemoval}
            /> : null}
          </>
        }
      />
      {!loading && explicit && current ? (
        <ProjectSettingsNavigation
          canManage={manageable && settings !== null}
          returnAction={search.from === 'deployments' && selected?.capabilities?.['deployment.read'] ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || credentialLocked || removalLocked}
              render={<Link to="/deployments" search={{ projectId: ProjectId.make(explicit) }} />}
            >
              <ArrowLeftIcon />返回部署
            </Button>
          ) : undefined}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer>
          {error ? (
            <div role="alert" className="space-y-2">
              <p>{error}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void (pending ? save(true) : load())
                }}
              >
                重试
              </Button>
            </div>
          ) : null}
          {pending && !error ? (
            <div role="status" className="space-y-2">
              <p>上一次保存结果尚待确认</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void save(true)
                }}
              >
                重试
              </Button>
            </div>
          ) : null}
          {loading ? (
            <p role="status">正在读取项目…</p>
          ) : explicit && !current ? (
            <p role="alert">项目不存在或无权访问</p>
          ) : !explicit ? (
            <SettingsSection title="项目">
              {projects.map((project) => (
                <SettingsRow
                  key={project.id}
                  title={project.name}
                  description={project.description || undefined}
                  control={
                    <Button variant="ghost" size="sm" onClick={() => go(project.id)}>
                      打开
                    </Button>
                  }
                >
                  <span className="text-xs text-muted-foreground">
                    {project.environments.length} 个可见环境
                  </span>
                </SettingsRow>
              ))}
            </SettingsSection>
          ) : (
            <>
              <ProjectSettingsTarget area="general">
                <SettingsSection title="项目信息">
                  <SettingsRow title="名称" control={<span className="min-w-0 break-words">{current?.name}</span>} />
                  {current?.description ? (
                    <SettingsRow title="说明">
                      <p className="whitespace-pre-wrap break-words text-sm">
                        {current.description}
                      </p>
                    </SettingsRow>
                  ) : null}
                </SettingsSection>
                {manageable && settings ? (
                  <ProjectSetupOverview
                    project={settings}
                    repositories={repositorySummary}
                    assistants={assistantSummary}
                    revision={configurationRevision}
                    canReadWorkspace={selected?.capabilities?.['workspace.manage'] === true}
                    canReadDeployments={selected?.capabilities?.['deployment.read'] === true}
                  />
                ) : null}
              </ProjectSettingsTarget>
              <ProjectSettingsTarget area="environments">
                <SettingsSection
                  title="环境"
                  headerAction={
                    manageable ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || !!pending || credentialLocked || removalLocked}
                        onClick={(event) =>
                          open(
                            { kind: 'environment', revision: 0, name: '', description: '' },
                            event.currentTarget,
                          )
                        }
                      >
                        <PlusIcon />
                        添加环境
                      </Button>
                    ) : undefined
                  }
                >
                  {current?.environments.map((env) => (
                    <SettingsRow
                      key={env.id}
                      title={env.name}
                      control={
                        manageable ? (
                          <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm"
                            aria-label={`管理${env.name} MCP`}
                            disabled={busy || !!pending || credentialLocked || removalLocked}
                            onClick={(event) => {
                              mcpTrigger.current = event.currentTarget
                              setMcpEnvironment({id: env.id, name: env.name})
                            }}>
                            MCP
                          </Button>
                          <Button variant="ghost" size="sm"
                            aria-label={`管理${env.name}节点`}
                            disabled={busy || !!pending || credentialLocked || removalLocked}
                            onClick={(event) => {
                              nodeTrigger.current = event.currentTarget
                              setNodeScope({ scope: 'project', projectId: current!.id, environmentId: env.id })
                            }}>
                            节点
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy || !!pending || credentialLocked || removalLocked}
                            onClick={(event) =>
                              open(
                                {
                                  kind: 'environment',
                                  environmentId: env.id,
                                  revision: env.revision,
                                  name: env.name,
                                  description: '',
                                },
                                event.currentTarget,
                              )
                            }
                          >
                            编辑
                          </Button>
                          <ProjectRemovalAction
                            target={{projectId: current!.id, environmentId: env.id, name: env.name, revision: env.revision}}
                            disabled={busy || !!pending || credentialLocked || removalLocked}
                            onSelect={beginRemoval}
                          />
                          </div>
                        ) : undefined
                      }
                    />
                  ))}
                  {!current?.environments.length ? (
                    <SettingsRow title="暂无环境" description="可直接使用无环境问答。" />
                  ) : null}
                </SettingsSection>
              </ProjectSettingsTarget>
              {manageable && settings ? (
                <ProjectSettingsTarget area="git">
                  <ProjectRepositoryPanel
                    projectId={settings.project.id}
                    revision={configurationRevision}
                    disabled={busy || !!pending || credentialLocked || removalLocked}
                    onOpen={open}
                    addButtonRef={repositoryAddButton}
                    onSummary={setRepositorySummary}
                  />
                  <ProjectCredentialsPanel
                    projectId={settings.project.id}
                    disabled={busy || !!pending}
                    onChanged={() => setConfigurationRevision((value) => value + 1)}
                    onLockChange={setCredentialLocked}
                  />
                </ProjectSettingsTarget>
              ) : null}
              {manageable && settings ? (
                <ProjectSettingsTarget area="access">
                  <ProjectConfigurationPanel
                    project={settings}
                    revision={configurationRevision}
                    disabled={busy || !!pending || credentialLocked || removalLocked}
                    onOpen={open}
                    onSummary={setAssistantSummary}
                  />
                </ProjectSettingsTarget>
              ) : null}
            </>
          )}
        </WorkspacePageContainer>
      </div>
      {removalTarget ? <ProjectRemovalDialog
        key={`${removalTarget.projectId}:${removalTarget.environmentId ?? 'project'}`}
        target={removalTarget} finalFocus={removalReturn} initialCanResume={removalCanResume}
        onLockChange={setRemovalLocked}
        onClose={() => setRemovalTarget(null)}
        onAccessDenied={(cause) => {
          setError(cause instanceof Error ? cause.message : '当前管理权限不可用')
          void refreshProjectHost().catch(() => {})
        }}
        onRemoved={() => {
          removalReturn.current = refreshButton.current
          setPending(readPending())
          setRemovalTarget(null)
          if (removalTarget.environmentId) {
            void load(true)
          } else {
            focusDirectory.current = true
            if (!explicit) void load()
            go()
          }
        }}
      /> : null}
      {mcpEnvironment && explicit ? <EnvironmentMcpDialog
        key={`${explicit}:${mcpEnvironment.id}`}
        projectId={explicit} environmentId={mcpEnvironment.id} environmentName={mcpEnvironment.name}
        open finalFocus={mcpTrigger}
        onOpenChange={(value) => { if (!value) setMcpEnvironment(null) }}
        onChanged={() => setConfigurationRevision(value => value + 1)}
        onAccessDenied={(cause) => {
          setError(cause instanceof Error ? cause.message : '当前环境管理权限不可用')
          void refreshProjectHost().catch(() => {})
        }}
      /> : null}
      {nodeScope ? <DeploymentServers {...nodeScope} open
        finalFocus={nodeTrigger}
        onOpenChange={(value) => { if (!value) setNodeScope(null) }}
        onAccessDenied={(cause) => {
          setError(cause instanceof Error ? cause.message : '当前节点权限已撤销')
          void refreshProjectHost().catch(() => {})
        }}
        onChanged={() => { void load(true); setConfigurationRevision(value => value + 1) }}
      /> : null}
      <Dialog
        open={editor !== null}
        onOpenChange={(value) => {
          if (!value && !busy) setEditor(null)
        }}
      >
        <DialogPopup finalFocus={pending ? refreshButton : trigger} showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {editor?.kind === 'create'
                ? '创建项目'
                : editor?.kind === 'repository'
                  ? editor.remove
                    ? '移除仓库连接'
                    : editor.id
                      ? '编辑仓库'
                      : '添加仓库'
                  : editor?.kind === 'environment'
                    ? '环境'
                    : editor?.kind === 'assistant'
                      ? editor.id
                        ? '编辑助手'
                        : '添加助手'
                      : editor?.kind === 'allocation'
                        ? '分配助手'
                        : editor?.kind === 'member'
                          ? '成员权限'
                          : '编辑项目'}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <form
              id="directory-editor-form"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <div className="space-y-4">
                {editor && isConfigurationEditor(editor) ? (
                  <ProjectConfigurationFields
                    editor={editor}
                    disabled={busy || !!pending || credentialLocked || removalLocked}
                    onChange={setEditor}
                  />
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="directory-name">名称</Label>
                      <Input
                        id="directory-name"
                        value={editor?.name ?? ''}
                        maxLength={120}
                        required
                        disabled={busy || !!pending || credentialLocked || removalLocked}
                        onChange={(event) =>
                          setEditor((value) =>
                            value ? { ...value, name: event.target.value } : null,
                          )
                        }
                        autoFocus
                      />
                    </div>
                    {editor?.kind !== 'environment' ? (
                      <div className="space-y-2">
                        <Label htmlFor="directory-description">说明（可选）</Label>
                        <Textarea
                          id="directory-description"
                          value={editor?.description ?? ''}
                          maxLength={2000}
                          disabled={busy || !!pending || credentialLocked || removalLocked}
                          onChange={(event) =>
                            setEditor((value) =>
                              value ? { ...value, description: event.target.value } : null,
                            )
                          }
                        />
                      </div>
                    ) : null}
                  </>
                )}
                {error ? <p role="alert">{error}</p> : null}
              </div>
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={busy || credentialLocked || removalLocked}
              onClick={() => setEditor(null)}
            >
              {pending ? '关闭' : '取消'}
            </Button>
            <Button
              form="directory-editor-form"
              type={pending ? 'button' : 'submit'}
              disabled={
                busy ||
                (!pending &&
                  (!editor?.name.trim() ||
                    (editor.kind === 'member' && !editor.value.userId) ||
                    (editor.kind === 'assistant' &&
                      editor.value.enabled &&
                      !editor.value.configuration.model.model)))
              }
              onClick={
                pending
                  ? () => {
                      void save(true)
                    }
                  : undefined
              }
            >
              {busy
                ? '正在保存…'
                : pending
                  ? '重试'
                  : editor?.kind === 'repository' && editor.remove
                    ? '移除连接'
                    : '保存'}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  )
}
