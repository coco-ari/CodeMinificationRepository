import { WorkspacePageContainer } from '~/components/WorkspacePageContainer'
import type { ReactNode } from 'react'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { Button } from '~/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '~/components/ui/collapsible'
import type { DeploymentTarget } from '../deployments'
import { normalizeDirectory } from './deploymentPresentation'

export function ConfigurationDetails({
  target,
  editAction,
  title = '下次发布配置',
}: {
  target: DeploymentTarget
  editAction?: ReactNode
  title?: string
}) {
  const config = target.config
  return (
    <WorkspacePageContainer>
      <SettingsSection title={title} headerAction={editAction}>
        <SettingsRow
          title="服务类型"
          description={config.kind === 'java' ? 'Java / Maven 服务' : '前端静态站点'}
        />
        <SettingsRow
          title={config.kind === 'java' ? '健康检查地址' : '站点检查地址'}
          description={
            <span className="block break-all">
              {config.kind === 'java'
                ? `容器端口 ${config.health.port}${config.health.path}`
                : config.health.url}
            </span>
          }
        />
        <Collapsible>
          <SettingsRow
            title="部署目标"
            description={<span className="block break-words">{target.name}</span>}
            control={
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                查看目标标识
              </CollapsibleTrigger>
            }
          />
          <CollapsiblePanel>
            <SettingsRow
              title="目标 ID"
              description={
                <span className="block select-text break-all font-mono">{target.id}</span>
              }
            />
          </CollapsiblePanel>
        </Collapsible>
      </SettingsSection>
      <SettingsSection title="构建">
        <SettingsRow
          title="构建目录"
          description={
            <span className="block break-all font-mono">{normalizeDirectory(config.module)}</span>
          }
        />
        <SettingsRow
          title={
            config.kind === 'java' ? 'JAR 产物路径（相对包根目录）' : '产物目录（相对包根目录）'
          }
          description={<span className="block break-all font-mono">{config.artifactPath}</span>}
        />
        <SettingsRow
          title="构建镜像"
          description={<span className="block break-all font-mono">{config.buildImage}</span>}
        />
        {config.kind === 'static' ? (
          <>
            <SettingsRow
              title="包管理器"
              description={`${config.packageManager} ${config.packageManagerVersion}`}
            />
            <SettingsRow
              title="构建脚本"
              description={<span className="block break-all font-mono">{config.buildScript}</span>}
            />
            <SettingsRow
              title="构建参数"
              description={
                <span className="block whitespace-pre-wrap break-all font-mono">
                  {config.buildArgs?.join('\n') || '无'}
                </span>
              }
            />
          </>
        ) : null}
        <SettingsRow
          title="构建资源"
          description={`${config.build.cpus} CPU / ${config.build.memoryMb} MB`}
        />
      </SettingsSection>
      {config.kind === 'java' ? (
        <SettingsSection title="运行">
          <SettingsRow
            title="运行镜像"
            description={<span className="block break-all font-mono">{config.runtimeImage}</span>}
          />
          <SettingsRow title="Spring Profile" description={config.profile || '未指定'} />
          <SettingsRow
            title="JVM 参数"
            description={
              <span className="block whitespace-pre-wrap break-all font-mono">
                {config.jvmArgs.join('\n') || '无'}
              </span>
            }
          />
          <SettingsRow
            title="应用参数"
            description={
              <span className="block whitespace-pre-wrap break-all font-mono">
                {config.args.join('\n') || '无'}
              </span>
            }
          />
          <SettingsRow
            title="运行资源"
            description={`${config.runtime.cpus} CPU / ${config.runtime.memoryMb} MB`}
          />
          <SettingsRow
            title="端口映射"
            description={
              <span className="block whitespace-pre-wrap break-all font-mono">
                {config.ports
                  .map((port) => `${port.host}:${port.hostPort} → ${port.containerPort}`)
                  .join('\n') || '未配置'}
              </span>
            }
          />
          <SettingsRow title="Docker 网络" description={config.networks.join('、') || '默认网络'} />
          {config.envFiles?.length ? (
            <>
              <SettingsRow
                title="环境文件（env_file）"
                description={
                  <span className="block whitespace-pre-wrap break-all font-mono">
                    {config.envFiles.join('\n')}
                  </span>
                }
              />
              <SettingsRow
                title="环境文件更新与恢复"
                description="重启会使用当前成功镜像重建容器，重新注入变量；代码回滚恢复历史路径，使用该路径下的当前文件。"
              />
            </>
          ) : null}
          <SettingsRow
            title="平台命名卷"
            description={
              <span className="block whitespace-pre-wrap break-all font-mono">
                {config.volumes
                  .map((volume) => `${volume.name} → ${volume.mountPath}`)
                  .join('\n') || '未配置'}
              </span>
            }
          />
          {target.networkIdentity ? (
            <SettingsRow
              title="固定网络别名"
              description={`${target.networkIdentity.network} / ${target.networkIdentity.alias}`}
            />
          ) : null}
        </SettingsSection>
      ) : null}
      <SettingsSection title="验证与恢复">
        <SettingsRow title="预期响应状态" description={`HTTP ${config.health.status}`} />
        <SettingsRow
          title="检查响应包含"
          description={
            <span className="block break-words">{config.health.bodyIncludes || '未指定'}</span>
          }
        />
        <SettingsRow
          title="健康检查"
          description={`${config.health.timeoutSeconds} 秒内，每 ${config.health.intervalSeconds} 秒检查`}
        />
        <SettingsRow
          title="失败恢复"
          description="切换后的健康检查失败时，执行器尝试恢复上一版本并重新验证；首次发布没有可恢复版本。实际恢复结果在任务日志中查看。"
        />
      </SettingsSection>
    </WorkspacePageContainer>
  )
}
