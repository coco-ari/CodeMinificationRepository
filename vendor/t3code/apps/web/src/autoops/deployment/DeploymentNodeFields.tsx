import { useState } from 'react'
import { CopyIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { writeTextToClipboard } from '~/hooks/useCopyToClipboard'
import { Choice } from './DeploymentControls'
import type {
  DeploymentGlobalNodeCatalog,
  DeploymentServer,
  DeploymentServerRegistration,
} from './deploymentServersApi'

export const nodeTime = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '暂无观测'

export function nodeStatus(server: DeploymentServer) {
  if (server.projectAllowed === false) return '项目授权已撤回'
  if (server.revoked) return '已撤销'
  if (server.registrationState === 'expired') return '接入口令已过期'
  if (server.registrationState === 'pending') return '等待首次连接'
  return server.online ? '在线' : '离线'
}

export function storageStateText(server: DeploymentServer) {
  if (server.revoked) return '节点已撤销，无法应用新设置'
  if (server.storageWaitingReason === 'offline') return '已保存，等待节点上线且空闲后应用'
  if (server.storageWaitingReason === 'busy' || server.storageState === 'waiting')
    return '已保存，等待当前任务结束'
  return {
    unsupported: '当前 Agent 不支持存储管理，升级后应用',
    pending: '已保存，等待节点应用',
    applying: '正在应用',
    applied: '已应用',
    failed: '应用失败，节点空闲时自动重试',
  }[server.storageState ?? 'unsupported']
}

export function NodeInstallationGuide({
  installation,
}: {
  installation?: DeploymentGlobalNodeCatalog['installation'] | undefined
}) {
  return (
    <SettingsSection title="安装前准备">
      <SettingsRow
        title="服务器要求"
        description="Linux、sudo 或 root 权限，已启动 Docker 并安装 Compose 插件、curl 和 tar。Agent 需要管理宿主机 Docker 容器。"
      />
      <SettingsRow
        title="网络与 HTTPS"
        description={`服务器需要能访问${installation?.origin ? ` ${installation.origin}` : '中心 HTTPS 地址'}及构建所需镜像仓库。先配置 DNS 和证书信任，再执行安装命令。`}
      />
      {installation?.ca ? (
        <SettingsRow
          title="内部 CA 信任"
          description="先下载公开证书，并通过管理员提供的可信记录核对指纹；确认一致后，将证书传到目标服务器。"
        >
          <div className="space-y-2 py-3 text-xs text-muted-foreground">
            <p className="select-text break-all font-mono">SHA256：{installation.ca.sha256}</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all">
              {
                'openssl x509 -in autoops-internal-ca.crt -noout -fingerprint -sha256\nsudo install -m 644 autoops-internal-ca.crt /usr/local/share/ca-certificates/autoops-internal-ca.crt\nsudo update-ca-certificates'
              }
            </pre>
            <Button
              variant="outline"
              size="sm"
              render={<a href={installation.ca.url} download="autoops-internal-ca.crt" />}
            >
              下载公开 CA 证书
            </Button>
          </div>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  )
}

export function NodeConnectionPanel({
  assigned,
  server,
  registration,
  installation,
  disabled,
  onRenew,
  onAssign,
  onSkip,
  onError,
}: {
  server: DeploymentServer
  registration: DeploymentServerRegistration | null
  assigned: boolean
  installation?: DeploymentGlobalNodeCatalog['installation'] | undefined
  disabled: boolean
  onRenew: () => void
  onAssign: () => void
  onSkip: () => void
  onError: (message: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const registered = !!server.registeredAt || server.registrationState === 'registered'
  const expires = server.registrationExpiresAt ?? registration?.expiresAt
  const expired =
    server.registrationState === 'expired' || (!!expires && Date.parse(expires) <= Date.now())
  const delayed = !!expires && Date.now() - (Date.parse(expires) - 15 * 60_000) > 120_000
  return (
    <div className="space-y-4">
      <SettingsSection title="连接状态">
        <SettingsRow
          title={nodeStatus(server)}
          description={
            registered
              ? server.online
                ? assigned
                  ? '节点已连接，已分配范围可在节点配置中查看；在线状态不代表业务已部署。'
                  : '节点已连接，尚未分配。分配到项目和环境后，可继续配置部署服务。'
                : '节点已注册但当前离线，请检查 Agent 容器、中心网络和证书。'
              : expired
                ? '接入口令已过期，请重新生成安装命令。'
                : `在目标服务器执行安装命令，完成后此处会自动更新。口令有效期至 ${nodeTime(expires)}。`
          }
        />
      </SettingsSection>
      {!registered && !server.revoked ? (
        <>
          <NodeInstallationGuide installation={installation} />
          {registration?.installCommand && !expired ? (
            <>
              <pre
                tabIndex={0}
                className="max-w-full select-text overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs"
                aria-label="节点安装命令"
              >
                {registration.installCommand}
              </pre>
              <Button
                variant="outline"
                onClick={() => {
                  void writeTextToClipboard(registration.installCommand!, '节点安装命令')
                    .then(() => setCopied(true))
                    .catch(() => onError('复制失败，请手动选择安装命令复制。'))
                }}
              >
                <CopyIcon />
                {copied ? '已复制安装命令' : '复制安装命令'}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              口令只提供一次且不会保存在浏览器中。需要时重新生成安装命令。
            </p>
          )}
          <SettingsRow
            title="重新生成安装命令"
            description="旧口令会立即失效；已注册的节点不能使用此操作覆盖身份。"
            control={
              <Button variant="outline" size="sm" disabled={disabled} onClick={onRenew}>
                重新生成安装命令
              </Button>
            }
          />
        </>
      ) : null}
      {((delayed && !registered) || (registered && !server.online)) && !server.revoked ? (
        <SettingsSection title="连接排查">
          <SettingsRow
            title="确认 Agent 运行与中心访问"
            description="检查 DNS、HTTPS 证书和防火墙。安装命令结束不代表注册成功，请查看容器和日志；不要删除原身份目录。"
          >
            <pre className="overflow-x-auto whitespace-pre-wrap py-3 text-xs text-muted-foreground">
              {'sudo docker ps -a --filter name=cmr-agent\nsudo docker logs --tail 100 cmr-agent'}
            </pre>
          </SettingsRow>
        </SettingsSection>
      ) : null}
      {registered && !server.revoked ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={onAssign}>
            分配到项目／环境
          </Button>
          <Button variant="outline" disabled={disabled} onClick={onSkip}>
            暂不分配
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export type NodeAssignmentDraft = {
  projectId: string
  environmentIds: string[]
  expectedRevision: number
  projectOnly: boolean
}

export function NodeAssignmentFields({
  catalog,
  server,
  draft,
  onChange,
  disabled,
}: {
  catalog: DeploymentGlobalNodeCatalog
  server: DeploymentServer
  draft: NodeAssignmentDraft
  onChange: (draft: NodeAssignmentDraft) => void
  disabled: boolean
}) {
  const project = catalog.projects.find((value) => value.id === draft.projectId)
  const boundIds = catalog.bindings
    .filter((value) => value.projectId === draft.projectId && value.serverId === server.id)
    .map((value) => value.environmentId)
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        一次确认即可允许所选项目使用此节点，并绑定所选环境。已有分配保持有效。
      </p>
      <Choice
        label="分配到项目"
        value={draft.projectId}
        options={catalog.projects.map((value) => ({ id: value.id, name: value.name }))}
        disabled={disabled}
        onChange={(projectId) =>
          onChange({
            projectId,
            environmentIds: catalog.bindings
              .filter((value) => value.projectId === projectId && value.serverId === server.id)
              .map((value) => value.environmentId),
            expectedRevision:
              catalog.projectAccess.find((value) => value.projectId === projectId)?.revision ?? 1,
            projectOnly: false,
          })
        }
      />
      {project ? (
        <SettingsSection title="选择环境">
          <SettingsRow
            title="仅授权项目，稍后绑定"
            description="项目管理员以后可绑定到获授权的环境。"
            control={
              <Checkbox
                aria-label="仅授权项目，稍后绑定"
                checked={draft.projectOnly}
                disabled={disabled}
                onCheckedChange={(projectOnly) => onChange({ ...draft, projectOnly })}
              />
            }
          />
          {project.environments.map((environment) => (
            <SettingsRow
              key={environment.id}
              title={environment.name}
              description={
                boundIds.includes(environment.id)
                  ? '已绑定；解绑需在对应环境中单独操作。'
                  : undefined
              }
              control={
                <Checkbox
                  aria-label={`绑定${environment.name}`}
                  checked={
                    boundIds.includes(environment.id) ||
                    draft.environmentIds.includes(environment.id)
                  }
                  disabled={disabled || draft.projectOnly || boundIds.includes(environment.id)}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...draft,
                      environmentIds: checked
                        ? [...draft.environmentIds, environment.id]
                        : draft.environmentIds.filter((id) => id !== environment.id),
                    })
                  }
                />
              }
            />
          ))}
          {!project.environments.length ? (
            <SettingsRow title="此项目尚无环境" description="可先仅授权项目，创建环境后再绑定。" />
          ) : null}
        </SettingsSection>
      ) : null}
    </div>
  )
}

export function NodeStorageFields({
  server,
  canEdit,
  disabled,
  retainedVersions,
  buildCacheGiB,
  onVersions,
  onCache,
}: {
  server: DeploymentServer
  canEdit: boolean
  disabled: boolean
  retainedVersions: string
  buildCacheGiB: string
  onVersions: (value: string) => void
  onCache: (value: string) => void
}) {
  return (
    <div id="deployment-node-storage" tabIndex={-1}>
      <SettingsSection title="存储设置">
        <SettingsRow title="应用状态" description={storageStateText(server)} />
        <SettingsRow
          title="作用范围"
          description="设置作用于此节点上的全部项目。可在未分配、离线或执行任务时保存，节点在线且空闲后应用。"
        />
        {server.storagePolicy ? (
          <>
            <SettingsRow
              title="保留成功版本数"
              description="2–20 个，按每个部署位置保留。当前运行及受保护版本继续保留，实际数量可能超过此值。"
              control={
                canEdit ? (
                  <div className="w-24">
                    <Input
                      aria-label="保留成功版本数"
                      type="number"
                      min={2}
                      max={20}
                      step={1}
                      value={retainedVersions}
                      onValueChange={onVersions}
                      disabled={disabled || server.revoked}
                    />
                  </div>
                ) : (
                  `${server.storagePolicy.retainedVersions} 个`
                )
              }
            />
            <SettingsRow
              title="构建缓存上限（GiB）"
              description="1–20 GiB，仅限制平台专用构建缓存，不是宿主机总磁盘限额。"
              control={
                canEdit ? (
                  <div className="w-24">
                    <Input
                      aria-label="构建缓存上限（GiB）"
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      value={buildCacheGiB}
                      onValueChange={onCache}
                      disabled={disabled || server.revoked}
                    />
                  </div>
                ) : (
                  `${server.storagePolicy.buildCacheGiB} GiB`
                )
              }
            />
            <SettingsRow
              title="保存与应用版本"
              description={`已保存 v${server.storagePolicy.revision}；最近报告${server.storageStatus?.revision ? ` v${server.storageStatus.revision}` : '：尚无报告'}。`}
            />
          </>
        ) : null}
        <SettingsRow
          title="最后报告时间"
          description={nodeTime(server.storageStatus?.checkedAt ?? server.storageStatus?.startedAt)}
        />
        {server.storageStatus?.errors?.map((error) => (
          <SettingsRow key={error} title="维护失败原因" description={error} />
        ))}
        {!canEdit ? (
          <SettingsRow title="只读配置" description="节点接入和存储设置由平台管理员维护。" />
        ) : null}
      </SettingsSection>
    </div>
  )
}
