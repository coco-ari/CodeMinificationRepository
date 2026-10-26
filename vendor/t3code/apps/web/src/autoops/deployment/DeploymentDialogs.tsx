import { useEffect, useId, useState, type ComponentProps, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { PlusIcon, RocketIcon, RotateCcwIcon, RefreshCwIcon } from 'lucide-react'
import { Alert, AlertAction, AlertDescription } from '~/components/ui/alert'
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
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Spinner } from '~/components/ui/spinner'
import type { ProjectRepositoryConnection } from '../workspaceAuthoring'
import {
  DeploymentSourceFields,
  DeploymentSourceNotice,
  useDeploymentSourceDraft,
} from './DeploymentSourceFields'
import type { WorkspaceRelease } from '../workspaces'
import { loadDeployments, isDeploymentAccessError } from '../deployments'
import type {
  DeploymentOverview,
  DeploymentRelease,
  DeploymentTarget,
  DeploymentSubmission,
  DeploymentTargetSubmission,
  DeploymentConfig,
  DeploymentKind,
  DeploymentService,
  DeploymentServiceSubmission,
  DeploymentTargetUpdate,
  DeploymentServiceSource,
  DeploymentServiceSourceSubmission,
} from '../deployments'
import {
  DeploymentConfigurationFields,
  deploymentConfigDefaults,
} from './DeploymentConfigurationFields'
import { Choice } from './DeploymentControls'
import { dateLabel, normalizeDirectory, packageDirectory } from './deploymentPresentation'

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus: ComponentProps<typeof DialogPopup>['finalFocus']
}

function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: (id: string) => ReactNode
  hint?: string
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function ServiceDialog({
  service: liveService,
  kindLocked = false,
  busy,
  error,
  onSubmit,
  ...dialog
}: DialogProps & {
  service?: DeploymentService | undefined
  kindLocked?: boolean
  busy: boolean
  error: string | null
  onSubmit: (input: Omit<DeploymentServiceSubmission, 'requestId'>) => Promise<void>
}) {
  const [service] = useState(liveService)
  const [name, setName] = useState(service?.name ?? '')
  const [kind, setKind] = useState<DeploymentKind>(service?.kind ?? 'static')
  const [module, setModule] = useState(service?.module ?? '.')
  const valid = !!name.trim() && !!module.trim()
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogPopup className="sm:max-w-lg" finalFocus={dialog.finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && valid)
              void onSubmit({
                ...(service ? { id: service.id, configKey: service.configKey } : {}),
                name: name.trim(),
                kind,
                module: module.trim(),
              })
          }}
        >
          <DialogHeader>
            <DialogTitle>{service ? '编辑服务' : '添加服务'}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Field label="服务名称">
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onValueChange={setName}
                  required
                  disabled={busy}
                  maxLength={100}
                />
              )}
            </Field>
            <Field label="服务类型">
              {() => (
                <Choice
                  label="服务类型"
                  value={kind}
                  disabled={busy || kindLocked}
                  options={[
                    { id: 'static', name: '静态站点' },
                    { id: 'java', name: 'Java / Maven' },
                  ]}
                  onChange={(value) => {
                    if (value === 'static' || value === 'java') setKind(value)
                  }}
                />
              )}
            </Field>
            <Field label="构建目录" hint="相对源码包根目录，根目录填写 .。">
              {(id) => (
                <Input id={id} value={module} onValueChange={setModule} required disabled={busy} />
              )}
            </Field>
            {error ? (
              <Alert variant="error" role="alert">
                {error}
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => dialog.onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy || !valid}>
              {busy ? <Spinner size="sm" /> : <PlusIcon />}
              {service ? '保存服务' : '添加服务'}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function TargetDialog({
  projectId,
  onAccessDenied,
  overview,
  service,
  target: liveTarget,
  environmentId,
  busy,
  error,
  onSubmit,
  onUpdate,
  ...dialog
}: DialogProps & {
  projectId?: string
  onAccessDenied?: (cause: unknown) => void
  overview: DeploymentOverview
  service: DeploymentService
  target?: DeploymentTarget | undefined
  environmentId: string
  busy: boolean
  error: string | null
  onSubmit: (input: Omit<DeploymentTargetSubmission, 'requestId'>) => Promise<void>
  onUpdate: (input: Omit<DeploymentTargetUpdate, 'requestId'>) => Promise<void>
}) {
  const [target] = useState(liveTarget)
  const usedServers = new Set(
    overview.targets
      .filter((entry) => entry.serviceId === service.id && entry.environmentId === environmentId)
      .map((entry) => entry.serverId),
  )
  const servers = overview.servers.filter(
    (entry) =>
      entry.environmentId === environmentId &&
      !entry.revoked &&
      (entry.id === target?.serverId || !usedServers.has(entry.id)),
  )
  const [serverId, setServerId] = useState(
    target?.serverId ?? servers.find((entry) => entry.online)?.id ?? servers[0]?.id ?? '',
  )
  const [config, setConfig] = useState<DeploymentConfig>(() =>
    structuredClone(target?.config ?? deploymentConfigDefaults(service.kind, service.module)),
  )
  const [templateId, setTemplateId] = useState('defaults')
  const [templateOverview, setTemplateOverview] = useState(overview)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [templateRevision, refreshTemplates] = useState(0)
  useEffect(() => {
    if (!projectId || !dialog.open || target) return
    const controller = new AbortController()
    setTemplateError(null)
    void loadDeployments(projectId, undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setTemplateOverview(result)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setTemplateError(cause instanceof Error ? cause.message : '读取配置模板失败。')
        if (isDeploymentAccessError(cause)) onAccessDenied?.(cause)
      })
    return () => controller.abort()
  }, [projectId, dialog.open, target, templateRevision, onAccessDenied])
  const templates = templateOverview.targets.filter(
    (entry) => entry.serviceId === service.id && entry.config.kind === service.kind,
  )
  const [network, setNetwork] = useState(target?.networkIdentity?.network ?? '')
  const [alias, setAlias] = useState(target?.networkIdentity?.alias ?? '')
  const healthValid =
    config.kind === 'static' ? !!config.health.url : !!config.health.path && config.health.port > 0
  const valid = !!serverId && !!environmentId && healthValid && !!network.trim() === !!alias.trim()
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogPopup className="sm:max-w-xl" finalFocus={dialog.finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
            )
              event.preventDefault()
          }}
          onSubmit={(event) => {
            event.preventDefault()
            if (busy || !valid) return
            const networkIdentity =
              network && alias ? { network: network.trim(), alias: alias.trim() } : null
            if (target) void onUpdate({ config, configKey: target.configKey, networkIdentity })
            else
              void onSubmit({
                serviceId: service.id,
                environmentId,
                serverId,
                config,
                networkIdentity,
              })
          }}
        >
          <DialogHeader>
            <DialogTitle>{target ? '编辑部署配置' : '添加部署位置'}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="text-sm font-medium">
              {service.name} ·{' '}
              {overview.environments.find((entry) => entry.id === environmentId)?.name ??
                environmentId}
            </div>
            <Field label="部署服务器">
              {() => (
                <Choice
                  label="部署服务器"
                  value={serverId}
                  disabled={busy || !!target}
                  options={servers.map((entry) => ({
                    id: entry.id,
                    name: `${entry.name} · ${entry.online ? '在线' : '离线'}`,
                  }))}
                  onChange={setServerId}
                  placeholder="当前环境没有可添加的服务器"
                />
              )}
            </Field>
            {!target && templates.length ? (
              <Field label="配置模板">
                {() => (
                  <Choice
                    label="配置模板"
                    value={templateId}
                    disabled={busy}
                    options={[
                      { id: 'defaults', name: '使用默认配置' },
                      ...templates.map((entry) => ({
                        id: entry.id,
                        name: `${templateOverview.servers.find((node) => node.id === entry.serverId)?.name ?? entry.name} · ${templateOverview.environments.find((env) => env.id === entry.environmentId)?.name ?? entry.environmentId}`,
                      })),
                    ]}
                    onChange={(value) => {
                      const template = templates.find((entry) => entry.id === value)
                      setTemplateId(value)
                      setConfig(
                        structuredClone(
                          template?.config ??
                            deploymentConfigDefaults(service.kind, service.module),
                        ),
                      )
                      setNetwork('')
                      setAlias('')
                    }}
                  />
                )}
              </Field>
            ) : null}
            {templateError ? (
              <Alert variant="error">
                <AlertDescription>{templateError}</AlertDescription>
                <AlertAction>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => refreshTemplates((value) => value + 1)}
                  >
                    重试读取模板
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
            <DeploymentConfigurationFields
              key={templateId}
              config={config}
              onChange={setConfig}
              disabled={busy}
            />
            {config.kind === 'java' ? (
              <Collapsible disabled={busy}>
                <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
                  固定网络身份
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="grid gap-4 pt-3 sm:grid-cols-2">
                    <Field label="固定网络">
                      {(id) => (
                        <Input
                          id={id}
                          value={network}
                          maxLength={64}
                          pattern={String.raw`[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}`}
                          onValueChange={setNetwork}
                          disabled={busy || !!target?.networkIdentity}
                          required={!!alias}
                        />
                      )}
                    </Field>
                    <Field label="服务别名">
                      {(id) => (
                        <Input
                          id={id}
                          value={alias}
                          maxLength={63}
                          pattern={String.raw`[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?`}
                          onValueChange={setAlias}
                          disabled={busy || !!target?.networkIdentity}
                          required={!!network}
                        />
                      )}
                    </Field>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            ) : (
              <p className="text-xs text-muted-foreground">
                保存后，需由运维按目标 ID 配置已有 Nginx
                的目录映射，并确认站点检查地址可访问。平台不会自动修改 Nginx。
              </p>
            )}
            {error ? (
              <Alert variant="error" role="alert">
                {error}
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => dialog.onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy || !valid}>
              {busy ? <Spinner size="sm" /> : <PlusIcon />}
              {target ? '保存配置' : '添加位置'}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function ServiceSourceDialog({
  projectId,
  onAccessDenied,
  service,
  environmentName,
  sources,
  source: liveSource,
  busy,
  error,
  onSubmit,
  ...dialog
}: DialogProps & {
  projectId?: string | undefined
  onAccessDenied?: ((cause: unknown) => void) | undefined
  service: DeploymentService
  environmentName?: string
  sources: ProjectRepositoryConnection[]
  source?: DeploymentServiceSource | undefined
  busy: boolean
  error: string | null
  onSubmit: (input: Omit<DeploymentServiceSourceSubmission, 'requestId'>) => Promise<void>
}) {
  const [source] = useState(liveSource)
  const draft = useDeploymentSourceDraft(
    sources,
    service.kind === 'java' ? 'backend' : 'frontend',
    service.module,
    source,
  )
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogPopup className="sm:max-w-xl" finalFocus={dialog.finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && draft.valid)
              void onSubmit({ ...draft.input, ...(source ? { configKey: source.configKey } : {}) })
          }}
        >
          <DialogHeader>
            <DialogTitle>默认发布来源</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <p className="text-sm font-medium">
              {service.name}
              {environmentName ? ` · ${environmentName}` : ''}
            </p>
            <DeploymentSourceNotice
              missing={draft.missingSources}
              onReset={draft.resetSources}
              disabled={busy}
            />
            <DeploymentSourceFields
              projectId={projectId}
              onAccessDenied={onAccessDenied}
              sources={sources}
              selection={draft.selection}
              disabled={busy}
              onSelect={draft.selectSource}
              onUpdate={draft.updateSource}
            />
            <Field label="构建上下文">
              {(id) => (
                <Input
                  id={id}
                  value={draft.root}
                  onValueChange={draft.setRoot}
                  disabled={busy}
                  required
                />
              )}
            </Field>
            <p className="text-xs text-muted-foreground">
              包内构建目录：{service.module || '.'}。此配置仅用于当前服务与环境的下一次发布。
            </p>
            {error ? (
              <Alert variant="error" role="alert">
                {error}
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => dialog.onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy || !draft.valid}>
              {busy ? <Spinner size="sm" /> : null}保存来源配置
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function ReleaseDialog({
  projectId,
  target: liveTarget,
  serverName,
  environmentName,
  packages,
  sources = [],
  defaultSource,
  sourcesError,
  onAccessDenied,
  releases,
  rollbackId,
  action,
  allowCurrentRelease = false,
  busy,
  error,
  onSubmit,
  ...dialog
}: DialogProps & {
  projectId: string
  target: DeploymentTarget
  serverName: string
  environmentName: string
  packages: WorkspaceRelease[]
  sources?: ProjectRepositoryConnection[]
  defaultSource?: DeploymentServiceSource | undefined
  sourcesError?: string | null
  onAccessDenied?: ((cause: unknown) => void) | undefined
  releases: DeploymentRelease[]
  rollbackId: string
  action: 'deploy' | 'rollback' | 'restart'
  allowCurrentRelease?: boolean
  busy: boolean
  error: string | null
  onSubmit: (input: Omit<DeploymentSubmission, 'requestId'>) => Promise<void>
}) {
  // 确认的是打开弹窗时显示的配置；服务端变更必须报冲突，不能悄悄替换快照。
  const [target] = useState(liveTarget)
  const service = target.config.kind === 'java' ? 'backend' : 'frontend'
  const [sourceMode, setSourceMode] = useState<'git' | 'package'>(
    sources.length ? 'git' : 'package',
  )
  const sourceDraft = useDeploymentSourceDraft(
    sources,
    service,
    target.config.module,
    defaultSource ?? target.currentRelease?.sourceSelection,
  )
  const compatible = packages.filter(
    (entry) =>
      entry.services.some((item) => item.service === service) &&
      packageDirectory(entry, service) === normalizeDirectory(target.config.module),
  )
  const [packageId, setPackageId] = useState(compatible[0]?.id ?? '')
  const selectedPackage = compatible.find((entry) => entry.id === packageId)
  const selectedRelease = releases.find((entry) => entry.id === rollbackId)
  const confirmationConfig =
    action === 'rollback'
      ? selectedRelease?.config
      : action === 'restart'
        ? target.currentRelease?.config
        : target.config
  const recoveringCurrent =
    action === 'rollback' && allowCurrentRelease && selectedRelease?.current === true
  const confirmationLabel =
    action === 'deploy'
      ? '确认发布'
      : action === 'restart'
        ? '确认重启'
        : recoveringCurrent
          ? '尝试重新恢复上次确认版本'
          : '确认回退'
  const zip = selectedPackage?.services.find((entry) => entry.service === service)
  const unavailable =
    busy ||
    !confirmationConfig ||
    (action === 'restart'
      ? target.config.kind !== 'java' || !target.currentRelease
      : action === 'deploy'
        ? sourceMode === 'git'
          ? !sourceDraft.valid || !!sourcesError
          : !selectedPackage
        : !selectedRelease ||
          (selectedRelease.current && !allowCurrentRelease) ||
          selectedRelease.available === false)
  return (
    <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
      <DialogPopup className="sm:max-w-xl" finalFocus={dialog.finalFocus}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (!unavailable)
              void onSubmit({
                targetId: target.id,
                action,
                service,
                configKey: target.configKey,
                ...(action === 'deploy'
                  ? sourceMode === 'git'
                    ? { sourceSelection: sourceDraft.input }
                    : { packageId }
                  : action === 'rollback'
                    ? { releaseId: rollbackId }
                    : {}),
              })
          }}
        >
          <DialogHeader>
            <DialogTitle>{confirmationLabel}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">服务</dt>
              <dd className="min-w-0 break-words">{target.name}</dd>
              <dt className="text-muted-foreground">环境</dt>
              <dd>{environmentName}</dd>
              <dt className="text-muted-foreground">服务器</dt>
              <dd className="min-w-0 break-words">{serverName}</dd>
              {confirmationConfig ? (
                <>
                  <dt className="text-muted-foreground">构建目录</dt>
                  <dd className="break-all font-mono">
                    {normalizeDirectory(confirmationConfig.module)}
                  </dd>
                  <dt className="text-muted-foreground">产物目录</dt>
                  <dd className="break-all font-mono">{confirmationConfig.artifactPath}</dd>
                  <dt className="text-muted-foreground">
                    {confirmationConfig.kind === 'java' ? '健康检查地址' : '站点检查地址'}
                  </dt>
                  <dd className="break-all">
                    {confirmationConfig.kind === 'java'
                      ? `容器端口 ${confirmationConfig.health.port}${confirmationConfig.health.path}`
                      : confirmationConfig.health.url}
                  </dd>
                  <dt className="text-muted-foreground">健康检查</dt>
                  <dd className="min-w-0 break-words">
                    HTTP {confirmationConfig.health.status}，
                    {confirmationConfig.health.timeoutSeconds} 秒内，每{' '}
                    {confirmationConfig.health.intervalSeconds} 秒检查
                  </dd>
                  <dt className="text-muted-foreground">检查响应包含</dt>
                  <dd className="min-w-0 break-words">
                    {confirmationConfig.health.bodyIncludes || '未指定'}
                  </dd>
                </>
              ) : null}
            </dl>
            {action === 'rollback' && !confirmationConfig ? (
              <Alert variant="error" role="alert">
                历史配置不可用，无法确认回退。请重新加载发布记录后核对。
              </Alert>
            ) : null}
            {action === 'restart' && !confirmationConfig ? (
              <Alert variant="error" role="alert">
                当前运行配置不可用，无法确认重启。请重新加载运行信息后核对。
              </Alert>
            ) : null}
            {action === 'deploy' ? (
              <>
                <Field label="发布来源">
                  {() => (
                    <Choice
                      label="发布来源"
                      value={sourceMode}
                      options={[
                        { id: 'git', name: 'Git 仓库' },
                        { id: 'package', name: '已有源码包' },
                      ]}
                      disabled={busy}
                      onChange={(value) => {
                        if (value === 'git' || value === 'package') setSourceMode(value)
                      }}
                    />
                  )}
                </Field>
                {sourceMode === 'git' ? (
                  <>
                    <DeploymentSourceNotice
                      missing={sourceDraft.missingSources}
                      onReset={sourceDraft.resetSources}
                      disabled={busy}
                    />
                    <DeploymentSourceFields
                      projectId={projectId}
                      onAccessDenied={onAccessDenied}
                      sources={sources}
                      selection={sourceDraft.selection}
                      disabled={busy || !!sourcesError}
                      onSelect={sourceDraft.selectSource}
                      onUpdate={sourceDraft.updateSource}
                    />
                    <Field label="构建上下文">
                      {(id) => (
                        <Input
                          id={id}
                          value={sourceDraft.root}
                          onValueChange={sourceDraft.setRoot}
                          disabled={busy}
                          required
                        />
                      )}
                    </Field>
                    {sourcesError ? (
                      <Alert variant="error" role="alert">
                        {sourcesError}
                      </Alert>
                    ) : !sources.length ? (
                      <Alert variant="warning">
                        还没有可用的 Git 仓库，请先在工作区配置源码来源。
                      </Alert>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Field label={service === 'backend' ? '后端源码包' : '前端源码包'}>
                      {() => (
                        <Choice
                          label="发布源码包"
                          value={packageId}
                          options={compatible.map((entry) => ({
                            id: entry.id,
                            name: `${entry.name} · ${dateLabel(entry.createdAt)}`,
                          }))}
                          onChange={setPackageId}
                          disabled={busy}
                          placeholder={`没有匹配构建目录的${service === 'backend' ? '后端' : '前端'}源码包`}
                        />
                      )}
                    </Field>
                    {!compatible.length ? (
                      <Alert variant="warning">
                        没有与该目标构建目录匹配的{service === 'backend' ? '后端' : '前端'}
                        源码包。请先生成对应源码包，或为其构建目录添加目标。
                      </Alert>
                    ) : null}
                    {selectedPackage ? (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        <p className="break-all">来源版本：{selectedPackage.sourceVersionId}</p>
                        <Button
                          size="xs"
                          variant="ghost"
                          render={
                            <Link
                              to="/workspaces"
                              search={{
                                projectId: ProjectId.make(projectId),
                                versionId: selectedPackage.sourceVersionId,
                              }}
                            />
                          }
                        >
                          查看工作区来源
                        </Button>
                        <p className="break-all font-mono">SHA-256：{zip?.sha256}</p>
                      </div>
                    ) : null}
                  </>
                )}
              </>
            ) : action === 'restart' ? (
              <p className="break-all text-sm">
                将重启当前已确认版本{' '}
                {target.currentRelease?.revision?.slice(0, 12) ?? target.currentRelease?.id}
                ，沿用该版本的运行配置并重新检查健康。
              </p>
            ) : (
              <p className="break-all text-sm">
                {recoveringCurrent
                  ? '当前运行结果待核查，本次尝试重新恢复上次确认版本'
                  : '将恢复版本'}{' '}
                {selectedRelease?.revision?.slice(0, 12) ?? selectedRelease?.id}{' '}
                及其历史配置，随后执行健康检查。
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {action === 'restart'
                ? '重启不会拉取源码、重新构建或应用下次发布配置。'
                : action === 'deploy'
                  ? sourceMode === 'git'
                    ? '提交后自动固定仓库版本并构建发布，关闭页面不会取消任务。'
                    : '本次使用固定源码包和配置快照。构建完成后切换服务；健康检查失败时由部署执行器尝试恢复上一版本。'
                  : recoveringCurrent
                    ? '执行器会先核对现场状态；若无法安全恢复，将保留失败结果，需要核对部署任务。'
                    : '回退通过原部署执行器完成；若本机产物已清理，会尝试从历史源码包重建。'}
            </p>
            {error ? (
              <Alert variant="error" role="alert">
                {error}
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => dialog.onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={unavailable}>
              {busy ? (
                <Spinner size="sm" />
              ) : action === 'deploy' ? (
                <RocketIcon />
              ) : action === 'restart' ? (
                <RefreshCwIcon />
              ) : (
                <RotateCcwIcon />
              )}
              {confirmationLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
