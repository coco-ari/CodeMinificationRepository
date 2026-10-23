import { useId, useState, type ComponentProps, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { PlusIcon, RocketIcon, RotateCcwIcon } from 'lucide-react'
import { Alert } from '~/components/ui/alert'
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
import { Textarea } from '~/components/ui/textarea'
import type { WorkspaceRelease } from '../workspaces'
import type {
  DeploymentOverview,
  DeploymentRelease,
  DeploymentTarget,
  DeploymentSubmission,
  DeploymentTargetSubmission,
  StaticDeploymentConfig,
} from '../deployments'
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

export function TargetDialog({
  overview,
  environmentId,
  defaultDirectory,
  busy,
  error,
  onSubmit,
  ...dialog
}: DialogProps & {
  overview: DeploymentOverview
  environmentId: string
  defaultDirectory: string
  busy: boolean
  error: string | null
  onSubmit: (input: Omit<DeploymentTargetSubmission, 'requestId'>) => Promise<void>
}) {
  const [name, setName] = useState('前端站点')
  const [buildArgsText, setBuildArgsText] = useState('')
  const [serverId, setServerId] = useState(
    overview.servers.find((entry) => entry.online && !entry.revoked)?.id ?? '',
  )
  const [config, setConfig] = useState<StaticDeploymentConfig>(() => ({
    kind: 'static',
    module: defaultDirectory,
    artifactPath: defaultDirectory === '.' ? 'dist' : `${defaultDirectory}/dist`,
    buildImage: 'node:24-bookworm-slim',
    packageManager: 'npm',
    packageManagerVersion: '10.9.9',
    buildScript: 'build',
    buildArgs: [],
    build: { cpus: 1, memoryMb: 1024 },
    health: { url: '', bodyIncludes: '', status: 200, timeoutSeconds: 180, intervalSeconds: 5 },
  }))
  const setField = <K extends keyof StaticDeploymentConfig>(
    key: K,
    value: StaticDeploymentConfig[K],
  ) => setConfig((previous) => ({ ...previous, [key]: value }))
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
            if (!busy && name.trim() && serverId && config.health.url)
              void onSubmit({ name: name.trim(), environmentId, serverId, config })
          }}
        >
          <DialogHeader>
            <DialogTitle>添加前端服务</DialogTitle>
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
            <Field label="部署服务器">
              {() => (
                <Choice
                  label="部署服务器"
                  value={serverId}
                  options={overview.servers
                    .filter((entry) => !entry.revoked)
                    .map((entry) => ({
                      id: entry.id,
                      name: `${entry.name} · ${entry.online ? '在线' : '离线'}`,
                    }))}
                  onChange={setServerId}
                  disabled={busy}
                />
              )}
            </Field>
            <Field
              label="站点检查地址"
              hint="填写部署服务器能访问的站点根地址；发布后会核对版本标识和首页。"
            >
              {(id) => (
                <Input
                  id={id}
                  type="url"
                  required
                  value={config.health.url}
                  onValueChange={(value) => setField('health', { ...config.health, url: value })}
                  placeholder="http://服务器地址/"
                  disabled={busy}
                />
              )}
            </Field>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Field label="构建目录" hint="相对源码包根目录，必须与所选包的构建上下文一致。">
                {(id) => (
                  <Input
                    id={id}
                    value={config.module}
                    onValueChange={(value) => setField('module', value)}
                    required
                    disabled={busy}
                  />
                )}
              </Field>
              <Field label="产物目录" hint="相对源码包根目录，例如 frontend/dist。">
                {(id) => (
                  <Input
                    id={id}
                    value={config.artifactPath}
                    onValueChange={(value) => setField('artifactPath', value)}
                    required
                    disabled={busy}
                  />
                )}
              </Field>
            </div>
            <Field label="构建镜像">
              {(id) => (
                <Input
                  id={id}
                  value={config.buildImage}
                  onValueChange={(value) => setField('buildImage', value)}
                  required
                  disabled={busy}
                />
              )}
            </Field>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Field label="包管理器">
                {() => (
                  <Choice
                    label="包管理器"
                    value={config.packageManager}
                    options={[
                      { id: 'npm', name: 'npm' },
                      { id: 'pnpm', name: 'pnpm' },
                    ]}
                    onChange={(value) => {
                      if (value === 'npm' || value === 'pnpm')
                        setConfig((previous) => ({
                          ...previous,
                          packageManager: value,
                          packageManagerVersion: value === 'npm' ? '10.9.9' : '10.11.0',
                        }))
                    }}
                    disabled={busy}
                  />
                )}
              </Field>
              <Field label="包管理器版本">
                {(id) => (
                  <Input
                    id={id}
                    value={config.packageManagerVersion}
                    onValueChange={(value) => setField('packageManagerVersion', value)}
                    required
                    disabled={busy}
                    pattern="[0-9]+\.[0-9]+\.[0-9]+"
                  />
                )}
              </Field>
            </div>
            <Field
              label="构建脚本"
              hint="package.json 中的脚本名称，例如 build；不填写 Shell 命令。"
            >
              {(id) => (
                <Input
                  id={id}
                  value={config.buildScript}
                  onValueChange={(value) => setField('buildScript', value)}
                  required
                  disabled={busy}
                />
              )}
            </Field>
            <Field label="检查响应包含（可选）">
              {(id) => (
                <Input
                  id={id}
                  value={config.health.bodyIncludes}
                  onValueChange={(value) =>
                    setField('health', { ...config.health, bodyIncludes: value })
                  }
                  disabled={busy}
                  maxLength={1024}
                />
              )}
            </Field>
            <Collapsible disabled={busy}>
              <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
                更多构建与检查配置
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="space-y-4 pt-3">
                  <Field label="构建附加参数" hint="每行一个参数，传给构建脚本。">
                    {(id) => (
                      <Textarea
                        id={id}
                        value={buildArgsText}
                        onChange={(event) => {
                          const value = event.target.value
                          setBuildArgsText(value)
                          setField(
                            'buildArgs',
                            value
                              .split('\n')
                              .map((line) => line.trim())
                              .filter(Boolean),
                          )
                        }}
                        disabled={busy}
                      />
                    )}
                  </Field>
                  <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                    <Field label="构建 CPU">
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={0.1}
                          max={32}
                          step={0.1}
                          required
                          value={String(config.build.cpus)}
                          onValueChange={(value) =>
                            setField('build', { ...config.build, cpus: Number(value) })
                          }
                          disabled={busy}
                        />
                      )}
                    </Field>
                    <Field label="构建内存（MB）">
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={256}
                          max={65536}
                          step={1}
                          required
                          value={String(config.build.memoryMb)}
                          onValueChange={(value) =>
                            setField('build', { ...config.build, memoryMb: Number(value) })
                          }
                          disabled={busy}
                        />
                      )}
                    </Field>
                    <Field label="检查超时（秒）">
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={10}
                          max={900}
                          step={1}
                          required
                          value={String(config.health.timeoutSeconds)}
                          onValueChange={(value) =>
                            setField('health', { ...config.health, timeoutSeconds: Number(value) })
                          }
                          disabled={busy}
                        />
                      )}
                    </Field>
                    <Field label="检查间隔（秒）">
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={2}
                          max={60}
                          step={1}
                          required
                          value={String(config.health.intervalSeconds)}
                          onValueChange={(value) =>
                            setField('health', { ...config.health, intervalSeconds: Number(value) })
                          }
                          disabled={busy}
                        />
                      )}
                    </Field>
                  </div>
                </div>
              </CollapsiblePanel>
            </Collapsible>
            <p className="text-xs text-muted-foreground">
              保存后，需由运维按目标 ID 配置已有 Nginx
              的目录映射，并确认站点检查地址可访问。平台不会自动修改 Nginx。
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
            <Button
              type="submit"
              disabled={busy || !name.trim() || !serverId || !environmentId || !config.health.url}
            >
              {busy ? <Spinner size="sm" /> : <PlusIcon />}添加服务
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
  releases: DeploymentRelease[]
  rollbackId: string
  action: 'deploy' | 'rollback'
  allowCurrentRelease?: boolean
  busy: boolean
  error: string | null
  onSubmit: (input: Omit<DeploymentSubmission, 'requestId'>) => Promise<void>
}) {
  // 确认的是打开弹窗时显示的配置；服务端变更必须报冲突，不能悄悄替换快照。
  const [target] = useState(liveTarget)
  const compatible = packages.filter(
    (entry) => packageDirectory(entry) === normalizeDirectory(target.config.module),
  )
  const [packageId, setPackageId] = useState(compatible[0]?.id ?? '')
  const selectedPackage = compatible.find((entry) => entry.id === packageId)
  const selectedRelease = releases.find((entry) => entry.id === rollbackId)
  const confirmationConfig = action === 'rollback' ? selectedRelease?.config : target.config
  const recoveringCurrent =
    action === 'rollback' && allowCurrentRelease && selectedRelease?.current === true
  const confirmationLabel =
    action === 'deploy' ? '确认发布' : recoveringCurrent ? '尝试重新恢复上次确认版本' : '确认回退'
  const zip = selectedPackage?.services.find((entry) => entry.service === 'frontend')
  const unavailable =
    busy ||
    !confirmationConfig ||
    (action === 'deploy'
      ? !selectedPackage
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
                service: 'frontend',
                configKey: target.configKey,
                ...(action === 'deploy' ? { packageId } : { releaseId: rollbackId }),
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
                  <dt className="text-muted-foreground">站点检查地址</dt>
                  <dd className="break-all">{confirmationConfig.health.url}</dd>
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
            {action === 'deploy' ? (
              <>
                <Field label="前端源码包">
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
                      placeholder="没有匹配构建目录的前端源码包"
                    />
                  )}
                </Field>
                {!compatible.length ? (
                  <Alert variant="warning">
                    没有与该目标构建目录匹配的前端源码包。请先生成对应源码包，或为其构建目录添加目标。
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
              {action === 'deploy'
                ? '本次使用固定源码包和配置快照。构建完成后切换站点；健康检查失败时由部署执行器尝试恢复上一版本。'
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
