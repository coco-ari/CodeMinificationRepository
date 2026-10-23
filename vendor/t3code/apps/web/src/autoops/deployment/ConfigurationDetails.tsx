import { WorkspacePageContainer } from '~/components/WorkspacePageContainer'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { Button } from '~/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '~/components/ui/collapsible'
import type { DeploymentTarget } from '../deployments'
import { normalizeDirectory } from './deploymentPresentation'

export function ConfigurationDetails({ target }: { target: DeploymentTarget }) {
  const config = target.config
  return (
    <WorkspacePageContainer>
      <SettingsSection title="目标与站点">
        <SettingsRow title="服务类型" description="前端静态站点" />
        <SettingsRow
          title="站点检查地址"
          description={<span className="block break-all">{config.health.url}</span>}
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
          title="产物目录（相对包根目录）"
          description={<span className="block break-all font-mono">{config.artifactPath}</span>}
        />
        <SettingsRow
          title="构建镜像"
          description={<span className="block break-all font-mono">{config.buildImage}</span>}
        />
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
        <SettingsRow
          title="构建资源"
          description={`${config.build.cpus} CPU / ${config.build.memoryMb} MB`}
        />
      </SettingsSection>
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
          description="切换站点后的健康检查失败时，执行器尝试恢复上一版本并重新验证；首次发布没有可恢复版本。实际恢复结果在任务日志中查看。"
        />
      </SettingsSection>
    </WorkspacePageContainer>
  )
}
