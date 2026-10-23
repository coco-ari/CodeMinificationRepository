import type { DeploymentTarget } from '../deployments'
import { normalizeDirectory } from './deploymentPresentation'

export function ConfigurationDetails({ target }: { target: DeploymentTarget }) {
  const config = target.config
  return (
    <dl className="divide-y divide-border/60 px-3 text-sm">
      {[
        ['服务类型', '前端静态站点'],
        ['目标 ID', target.id],
        ['站点检查地址', config.health.url],
        ['构建镜像', config.buildImage],
        ['构建目录', normalizeDirectory(config.module)],
        ['产物目录（相对包根目录）', config.artifactPath],
        ['包管理器', `${config.packageManager} ${config.packageManagerVersion}`],
        ['构建脚本', config.buildScript],
        ['构建参数', config.buildArgs?.join(' ') || '无'],
        ['构建资源', `${config.build.cpus} CPU / ${config.build.memoryMb} MB`],
        ['检查响应包含', config.health.bodyIncludes || '未指定'],
        [
          '健康检查',
          `${config.health.timeoutSeconds} 秒内，每 ${config.health.intervalSeconds} 秒检查`,
        ],
      ].map(([label, value]) => (
        <div
          key={label}
          className="grid min-w-0 grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-3 py-2.5"
        >
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all text-xs">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
