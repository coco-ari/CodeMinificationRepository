import { useId, useState, type ComponentProps, type ReactNode } from 'react'
import { PlusIcon, Trash2Icon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '~/components/ui/collapsible'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Textarea } from '~/components/ui/textarea'
import type { DeploymentConfig, DeploymentKind, JavaDeploymentConfig } from '../deployments'
import { Choice } from './DeploymentControls'

export function deploymentConfigDefaults(kind: DeploymentKind, module = '.'): DeploymentConfig {
  const prefix = !module || module === '.' ? '' : `${module}/`
  const shared = {
    module,
    build: { cpus: 1, memoryMb: 1024 },
    health: { bodyIncludes: '', status: 200, timeoutSeconds: 180, intervalSeconds: 5 },
  }
  return kind === 'static'
    ? {
        ...shared,
        kind,
        artifactPath: `${prefix}dist`,
        buildImage: 'node:24-bookworm-slim',
        packageManager: 'npm',
        packageManagerVersion: '10.9.9',
        buildScript: 'build',
        buildArgs: [],
        health: { ...shared.health, url: '' },
      }
    : {
        ...shared,
        kind,
        artifactPath: `${prefix}target/*.jar`,
        buildImage: 'maven:3.9.9-eclipse-temurin-8',
        runtimeImage: 'eclipse-temurin:8-jre',
        jvmArgs: ['-Xms64m', '-Xmx192m'],
        args: [],
        profile: '',
        ports: [],
        networks: [],
        volumes: [],
        runtime: { cpus: 0.5, memoryMb: 512 },
        health: { ...shared.health, path: '/health', port: 8080 },
      }
}

export function DeploymentField({
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
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function TextField({ label, ...props }: ComponentProps<typeof Input> & { label: string }) {
  return <DeploymentField label={label}>{(id) => <Input id={id} {...props} />}</DeploymentField>
}

function LinesField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: string[]
  onChange: (value: string[]) => void
  disabled: boolean
}) {
  const [text, setText] = useState(value.join('\n'))
  return (
    <DeploymentField label={label}>
      {(id) => (
        <Textarea
          id={id}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            const next = event.currentTarget.value
            setText(next)
            onChange(
              next
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            )
          }}
        />
      )}
    </DeploymentField>
  )
}

/** 表单只编辑所属位置的配置草稿，合法范围仍由部署引擎统一裁决。 */
export function DeploymentConfigurationFields({
  config,
  onChange,
  disabled,
}: {
  config: DeploymentConfig
  onChange: (config: DeploymentConfig) => void
  disabled: boolean
}) {
  const updateHealth = (
    change: Partial<
      Pick<DeploymentConfig['health'], 'bodyIncludes' | 'timeoutSeconds' | 'intervalSeconds'>
    >,
  ) => {
    if (config.kind === 'java') onChange({ ...config, health: { ...config.health, ...change } })
    else onChange({ ...config, health: { ...config.health, ...change } })
  }
  const field = (label: string, key: 'artifactPath' | 'buildImage') => (
    <TextField
      label={label}
      value={config[key]}
      required
      disabled={disabled}
      onValueChange={(value) => onChange({ ...config, [key]: value })}
    />
  )
  return (
    <>
      <fieldset className="min-w-0 space-y-4" disabled={disabled}>
        <legend className="mb-3 text-sm font-medium">构建</legend>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          {field(config.kind === 'java' ? 'JAR 产物路径' : '产物目录', 'artifactPath')}
          {field('构建镜像', 'buildImage')}
        </div>
        {config.kind === 'static' ? (
          <>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <DeploymentField label="包管理器">
                {() => (
                  <Choice
                    label="包管理器"
                    value={config.packageManager}
                    options={[
                      { id: 'npm', name: 'npm' },
                      { id: 'pnpm', name: 'pnpm' },
                    ]}
                    disabled={disabled}
                    onChange={(value) => {
                      if (value === 'npm' || value === 'pnpm')
                        onChange({
                          ...config,
                          packageManager: value,
                          packageManagerVersion: value === 'npm' ? '10.9.9' : '10.11.0',
                        })
                    }}
                  />
                )}
              </DeploymentField>
              <TextField
                label="包管理器版本"
                value={config.packageManagerVersion}
                required
                disabled={disabled}
                pattern="[0-9]+\.[0-9]+\.[0-9]+"
                onValueChange={(value) => onChange({ ...config, packageManagerVersion: value })}
              />
            </div>
            <TextField
              label="构建脚本"
              value={config.buildScript}
              required
              disabled={disabled}
              onValueChange={(value) => onChange({ ...config, buildScript: value })}
            />
          </>
        ) : (
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <TextField
              label="运行镜像"
              value={config.runtimeImage}
              required
              disabled={disabled}
              onValueChange={(value) => onChange({ ...config, runtimeImage: value })}
            />
            <TextField
              label="Spring Profile"
              value={config.profile}
              disabled={disabled}
              onValueChange={(value) => onChange({ ...config, profile: value })}
            />
          </div>
        )}
      </fieldset>
      <fieldset className="min-w-0 space-y-4" disabled={disabled}>
        <legend className="mb-3 text-sm font-medium">健康检查</legend>
        {config.kind === 'static' ? (
          <TextField
            label="站点检查地址"
            type="url"
            value={config.health.url}
            required
            disabled={disabled}
            placeholder="https://站点地址/"
            onValueChange={(value) =>
              onChange({ ...config, health: { ...config.health, url: value } })
            }
          />
        ) : (
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <TextField
              label="健康检查路径"
              value={config.health.path}
              required
              disabled={disabled}
              onValueChange={(value) =>
                onChange({ ...config, health: { ...config.health, path: value } })
              }
            />
            <TextField
              label="容器检查端口"
              type="number"
              min={1}
              max={65535}
              value={String(config.health.port)}
              required
              disabled={disabled}
              onValueChange={(value) =>
                onChange({ ...config, health: { ...config.health, port: Number(value) } })
              }
            />
          </div>
        )}
        <TextField
          label="检查响应包含（可选）"
          value={config.health.bodyIncludes}
          maxLength={1024}
          disabled={disabled}
          onValueChange={(value) => updateHealth({ bodyIncludes: value })}
        />
      </fieldset>
      <Collapsible disabled={disabled}>
        <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
          更多构建与检查配置
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="space-y-4 pt-3">
            {config.kind === 'static' ? (
              <LinesField
                label="构建附加参数"
                value={config.buildArgs}
                disabled={disabled}
                onChange={(buildArgs) => onChange({ ...config, buildArgs })}
              />
            ) : (
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <LinesField
                  label="JVM 参数（每行一个）"
                  value={config.jvmArgs}
                  disabled={disabled}
                  onChange={(jvmArgs) => onChange({ ...config, jvmArgs })}
                />
                <LinesField
                  label="应用参数（每行一个）"
                  value={config.args}
                  disabled={disabled}
                  onChange={(args) => onChange({ ...config, args })}
                />
              </div>
            )}
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <TextField
                label="构建 CPU"
                type="number"
                min={0.1}
                max={32}
                step={0.1}
                required
                disabled={disabled}
                value={String(config.build.cpus)}
                onValueChange={(value) =>
                  onChange({ ...config, build: { ...config.build, cpus: Number(value) } })
                }
              />
              <TextField
                label="构建内存（MB）"
                type="number"
                min={256}
                max={65536}
                required
                disabled={disabled}
                value={String(config.build.memoryMb)}
                onValueChange={(value) =>
                  onChange({ ...config, build: { ...config.build, memoryMb: Number(value) } })
                }
              />
              {config.kind === 'java' ? (
                <>
                  <TextField
                    label="运行 CPU"
                    type="number"
                    min={0.1}
                    max={32}
                    step={0.1}
                    required
                    disabled={disabled}
                    value={String(config.runtime.cpus)}
                    onValueChange={(value) =>
                      onChange({ ...config, runtime: { ...config.runtime, cpus: Number(value) } })
                    }
                  />
                  <TextField
                    label="运行内存（MB）"
                    type="number"
                    min={128}
                    max={65536}
                    required
                    disabled={disabled}
                    value={String(config.runtime.memoryMb)}
                    onValueChange={(value) =>
                      onChange({
                        ...config,
                        runtime: { ...config.runtime, memoryMb: Number(value) },
                      })
                    }
                  />
                  <TextField
                    label="预期响应状态"
                    type="number"
                    min={200}
                    max={399}
                    required
                    disabled={disabled}
                    value={String(config.health.status)}
                    onValueChange={(value) =>
                      onChange({ ...config, health: { ...config.health, status: Number(value) } })
                    }
                  />
                </>
              ) : null}
              <TextField
                label="检查超时（秒）"
                type="number"
                min={10}
                max={900}
                required
                disabled={disabled}
                value={String(config.health.timeoutSeconds)}
                onValueChange={(value) => updateHealth({ timeoutSeconds: Number(value) })}
              />
              <TextField
                label="检查间隔（秒）"
                type="number"
                min={2}
                max={60}
                required
                disabled={disabled}
                value={String(config.health.intervalSeconds)}
                onValueChange={(value) => updateHealth({ intervalSeconds: Number(value) })}
              />
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
      {config.kind === 'java' ? (
        <JavaNetworkFields config={config} onChange={onChange} disabled={disabled} />
      ) : null}
    </>
  )
}

function JavaNetworkFields({
  config,
  onChange,
  disabled,
}: {
  config: JavaDeploymentConfig
  onChange: (config: JavaDeploymentConfig) => void
  disabled: boolean
}) {
  return (
    <Collapsible disabled={disabled}>
      <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
        网络与存储
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-4 pt-3">
          <LinesField
            label="环境文件路径（env_file，每行一个）"
            value={config.envFiles ?? []}
            disabled={disabled}
            onChange={(envFiles) => {
              const { envFiles: previous, ...rest } = config
              void previous
              onChange(envFiles.length ? { ...rest, envFiles } : rest)
            }}
          />
          <p className="text-xs text-muted-foreground">
            可留空。填写 Agent 可读取的节点文件路径，容器化 Agent 可使用其数据目录的 env-files
            子目录。文件内容不会上传；配置后重启会重建当前版本容器，代码回滚仍使用路径下的当前文件。
          </p>
          <LinesField
            label="Docker 网络（每行一个）"
            value={config.networks}
            disabled={disabled}
            onChange={(networks) => onChange({ ...config, networks })}
          />
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">端口映射</legend>
            {config.ports.map((port, index) => (
              <div key={index} className="grid min-w-0 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <DeploymentField label={`绑定地址 ${index + 1}`}>
                  {() => (
                    <Choice
                      label={`绑定地址 ${index + 1}`}
                      value={port.host}
                      options={[
                        { id: '127.0.0.1', name: '127.0.0.1' },
                        { id: '0.0.0.0', name: '0.0.0.0' },
                      ]}
                      disabled={disabled}
                      onChange={(host) =>
                        onChange({
                          ...config,
                          ports: config.ports.map((entry, at) =>
                            at === index ? { ...entry, host } : entry,
                          ),
                        })
                      }
                    />
                  )}
                </DeploymentField>
                <TextField
                  label={`服务器端口 ${index + 1}`}
                  type="number"
                  min={1024}
                  max={65535}
                  required
                  disabled={disabled}
                  value={String(port.hostPort || '')}
                  onValueChange={(value) =>
                    onChange({
                      ...config,
                      ports: config.ports.map((entry, at) =>
                        at === index ? { ...entry, hostPort: Number(value) } : entry,
                      ),
                    })
                  }
                />
                <TextField
                  label={`容器端口 ${index + 1}`}
                  type="number"
                  min={1}
                  max={65535}
                  required
                  disabled={disabled}
                  value={String(port.containerPort || '')}
                  onValueChange={(value) =>
                    onChange({
                      ...config,
                      ports: config.ports.map((entry, at) =>
                        at === index ? { ...entry, containerPort: Number(value) } : entry,
                      ),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="self-end"
                  aria-label={`删除端口映射 ${index + 1}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange({ ...config, ports: config.ports.filter((_, at) => at !== index) })
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || config.ports.length >= 16}
              onClick={() =>
                onChange({
                  ...config,
                  ports: [...config.ports, { host: '127.0.0.1', hostPort: 0, containerPort: 8080 }],
                })
              }
            >
              <PlusIcon />
              添加端口
            </Button>
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">平台命名卷</legend>
            {config.volumes.map((volume, index) => (
              <div key={index} className="grid min-w-0 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <TextField
                  label={`数据卷名称 ${index + 1}`}
                  value={volume.name}
                  required
                  disabled={disabled}
                  onValueChange={(value) =>
                    onChange({
                      ...config,
                      volumes: config.volumes.map((entry, at) =>
                        at === index ? { ...entry, name: value } : entry,
                      ),
                    })
                  }
                />
                <TextField
                  label={`挂载目录 ${index + 1}`}
                  value={volume.mountPath}
                  placeholder="/app/data"
                  required
                  disabled={disabled}
                  onValueChange={(value) =>
                    onChange({
                      ...config,
                      volumes: config.volumes.map((entry, at) =>
                        at === index ? { ...entry, mountPath: value } : entry,
                      ),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="self-end"
                  aria-label={`删除数据卷 ${index + 1}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange({ ...config, volumes: config.volumes.filter((_, at) => at !== index) })
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || config.volumes.length >= 16}
              onClick={() =>
                onChange({
                  ...config,
                  volumes: [...config.volumes, { name: '', mountPath: '/app/data' }],
                })
              }
            >
              <PlusIcon />
              添加数据卷
            </Button>
          </fieldset>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}
