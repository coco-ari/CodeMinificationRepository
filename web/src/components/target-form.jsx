import { useState } from 'react'
import { Advanced, MappingRows } from './config-fields'
import { FieldSet, FieldLegend } from '@/components/ui/field'
import { Field, FormDialog, Notice, Empty } from './shared'
import { Separator } from '@/components/ui/separator'
import { useConsole } from '@/lib/console'
const lines = (value) =>
  (value || '')
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean)
const Grid = ({ children }) => <div className="grid gap-4 sm:grid-cols-2">{children}</div>
const Section = ({ title, children }) => (
  <FieldSet className="border-t pt-5">
    <FieldLegend>{title}</FieldLegend>
    {children}
  </FieldSet>
)
export function TargetForm({ item, onClose, service: fixedService, onSaved }) {
  const { data, environmentId, endpoint, request, refresh, notify } = useConsole()
  const available = data.servers.filter(
    (s) =>
      !s.revoked &&
      (item ||
        !fixedService ||
        !data.targets.some(
          (t) =>
            t.serverId === s.id &&
            t.serviceId === fixedService.id &&
            t.environmentId === environmentId,
        )),
  )
  const [env, setEnv] = useState(
    item?.environmentId || environmentId || data.environments[0]?.id || '',
  )
  const choices = data.services.filter(
    (s) =>
      (item ||
        data.environmentSources.some((v) => v.environmentId === env && v.serviceId === s.id)) &&
      (!fixedService || s.id === fixedService.id),
  )
  const [serviceId, setService] = useState(item?.serviceId || choices[0]?.id || '')
  const [serverId, setServer] = useState(item?.serverId || available[0]?.id || '')
  const c = item?.config || {}
  const module = data.services.find((s) => s.id === serviceId)?.module || '.'
  const isStatic = data.services.find((s) => s.id === serviceId)?.kind === 'static'
  const [packageManager, setPackageManager] = useState(c.packageManager || 'npm')
  const [artifact, setArtifact] = useState(
    c.artifactPath || `${module === '.' ? '' : `${module}/`}${isStatic ? 'dist' : 'target/*.jar'}`,
  )
  function selectService(id) {
    setService(id)
    const module = data.services.find((s) => s.id === id)?.module || '.'
    setArtifact(
      `${module === '.' ? '' : `${module}/`}${data.services.find((s) => s.id === id)?.kind === 'static' ? 'dist' : 'target/*.jar'}`,
    )
  }
  if (!item && !available.length)
    return (
      <Empty
        title="没有可用的部署位置"
        description="当前服务已配置到所有可用服务器，可返回服务详情编辑已有配置，或先绑定其他服务器。"
        label="返回服务列表"
        action={onClose}
      />
    )
  return (
    <FormDialog
      wide
      title={item ? '编辑部署目标' : '新增部署目标'}
      description={
        item
          ? '构建和运行配置仅影响当前部署位置，下次发布时生效。'
          : '为服务添加部署服务器。保存后需手动发布；不会迁移或停止其他服务器上的服务。'
      }
      onClose={onClose}
      submitLabel="保存部署目标"
      onSubmit={async (input) => {
        if (!serviceId) throw new Error('请先配置该环境的服务源码')
        if (!serverId) throw new Error('请先绑定服务器')
        const body = { environmentId: env, serviceId, serverId }
        const ports = JSON.parse(input.ports || '[]').map((port) => ({
          ...port,
          hostPort: Number(port.hostPort),
          containerPort: Number(port.containerPort),
        }))
        const volumes = JSON.parse(input.volumes || '[]')
        body.config = {
          module,
          artifactPath: artifact,
          buildImage: input.buildImage,
          ...(isStatic
            ? {
                packageManager,
                packageManagerVersion:
                  input.packageManagerVersion || (packageManager === 'pnpm' ? '10.11.0' : '10.9.9'),
                buildScript: input.buildScript,
                buildArgs: lines(input.buildArgs),
              }
            : {}),
          runtimeImage: input.runtimeImage,
          jvmArgs: lines(input.jvmArgs),
          args: lines(input.args),
          profile: input.profile,
          ports,
          networks: lines(input.networks),
          volumes,
          build: { cpus: Number(input.buildCpus), memoryMb: Number(input.buildMemory) },
          runtime: { cpus: Number(input.cpus), memoryMb: Number(input.memory) },
          health: {
            ...(isStatic ? { url: input.healthUrl } : {}),
            path: input.healthPath,
            port: Number(input.healthPort || 8080),
            status: Number(input.healthStatus || 200),
            bodyIncludes: input.healthBody,
            timeoutSeconds: Number(input.healthTimeout),
            intervalSeconds: Number(input.healthInterval),
          },
        }
        const saved = await request(
          `${endpoint}/targets${item ? `/${item.id}` : ''}`,
          body,
          item ? 'PUT' : 'POST',
        )
        await refresh()
        if (onSaved) onSaved(saved)
        else onClose()
        notify('部署配置已保存；发布后生效')
      }}
    >
      <Section title="部署位置">
        <Grid>
          <Field
            name="environmentId"
            label="环境"
            value={env}
            disabled={!!item || !!fixedService}
            required
            choices={data.environments.map((e) => [e.id, e.name])}
            onChange={(e) => {
              const id = e.target.value
              setEnv(id)
              selectService(
                data.services.find((s) =>
                  data.environmentSources.some(
                    (v) => v.environmentId === id && v.serviceId === s.id,
                  ),
                )?.id || '',
              )
            }}
          />
          <Field
            name="serviceId"
            label="服务"
            value={serviceId}
            disabled={!!item || !!fixedService}
            required
            choices={
              choices.length ? choices.map((s) => [s.id, s.name]) : [['', '请先配置环境源码']]
            }
            onChange={(e) => selectService(e.target.value)}
          />
        </Grid>
        <Grid>
          <Field
            name="serverId"
            label="目标服务器"
            required
            disabled={!!item}
            value={serverId}
            choices={
              available.length ? available.map((s) => [s.id, s.name]) : [['', '请先绑定服务器']]
            }
            onChange={(e) => setServer(e.target.value)}
          />
        </Grid>
      </Section>
      <div key={serviceId} className="space-y-5 managed-config">
        <Section title="构建配置">
          <Grid>
            <Field
              name="buildImage"
              label="构建镜像"
              defaultValue={
                c.buildImage ||
                (isStatic ? 'node:24-bookworm-slim' : 'maven:3.9.9-eclipse-temurin-8')
              }
              hint={
                isStatic ? '使用带 Node.js 和 npm 的构建镜像，无需服务器安装 Node。' : undefined
              }
              required
            />
            <Field
              name="artifactPath"
              label={isStatic ? '静态产物目录' : 'JAR 产物路径'}
              value={artifact}
              onChange={(e) => setArtifact(e.target.value)}
              hint={
                isStatic
                  ? '相对仓库根目录，例如 dist、build 或 frontend/dist；必须包含 index.html。'
                  : '相对源码根目录；文件名支持一个 *。'
              }
              required
            />
          </Grid>
          {isStatic && (
            <>
              <Grid>
                <Field
                  name="packageManager"
                  label="包管理器"
                  value={packageManager}
                  choices={[
                    ['npm', 'npm'],
                    ['pnpm', 'pnpm'],
                  ]}
                  onChange={(event) => setPackageManager(event.target.value)}
                />
                <Field
                  key={packageManager}
                  name="packageManagerVersion"
                  label={`${packageManager} 版本`}
                  defaultValue={
                    (c.packageManager === packageManager && c.packageManagerVersion) ||
                    (packageManager === 'pnpm' ? '10.11.0' : '10.9.9')
                  }
                  required
                  hint="使用此准确版本安装依赖并构建；pnpm 需与 package.json 的 packageManager 一致。"
                />
              </Grid>
              <Grid>
                <Field
                  name="buildScript"
                  label="构建脚本"
                  defaultValue={c.buildScript || 'build'}
                  required
                  hint="package.json 中的脚本名称，例如 build 或 build:test。"
                />
                <Field
                  name="buildArgs"
                  label="构建参数（每行一个）"
                  multiline
                  defaultValue={(c.buildArgs || []).join('\n')}
                  placeholder={'--mode\ntest'}
                />
              </Grid>
              <Notice>
                Agent
                使用锁文件安装依赖并构建，只发布输出目录。环境变量会进入浏览器产物，不能放数据库密码等服务端秘密。
              </Notice>
            </>
          )}
          <Advanced title="构建资源限制">
            <Grid>
              <Field
                name="buildCpus"
                label="构建 CPU 上限（核）"
                type="number"
                min="0.1"
                max="32"
                step="0.1"
                defaultValue={c.build?.cpus ?? 1}
              />
              <Field
                name="buildMemory"
                label="构建内存上限（MB）"
                type="number"
                min="256"
                max="65536"
                defaultValue={c.build?.memoryMb ?? 1024}
              />
            </Grid>
          </Advanced>
        </Section>
        {!isStatic && (
          <>
            <Section title="运行配置">
              <Grid>
                <Field
                  name="runtimeImage"
                  label="运行镜像"
                  defaultValue={c.runtimeImage || 'eclipse-temurin:8-jre'}
                  required
                />
                <Field name="profile" label="Spring Profile" defaultValue={c.profile ?? 'test'} />
              </Grid>
              <Advanced title="运行资源与附加参数">
                <Grid>
                  <Field
                    name="cpus"
                    label="运行 CPU 上限（核）"
                    type="number"
                    min="0.1"
                    max="32"
                    step="0.1"
                    defaultValue={c.runtime?.cpus ?? 0.5}
                  />
                  <Field
                    name="memory"
                    label="运行内存上限（MB）"
                    type="number"
                    min="128"
                    max="65536"
                    defaultValue={c.runtime?.memoryMb ?? 512}
                  />
                </Grid>
                <Grid>
                  <Field
                    name="jvmArgs"
                    label="JVM 参数（每行一个）"
                    multiline
                    rows={5}
                    defaultValue={(
                      c.jvmArgs || [
                        '-Duser.timezone=Asia/Shanghai',
                        '-Xms64m',
                        '-Xmx192m',
                        '-XX:MaxMetaspaceSize=128m',
                        '-XX:+ExitOnOutOfMemoryError',
                      ]
                    ).join('\n')}
                  />
                  <Field
                    name="args"
                    label="应用参数（每行一个）"
                    multiline
                    rows={5}
                    defaultValue={(c.args || []).join('\n')}
                    placeholder="--ybt.enable=false"
                  />
                </Grid>
              </Advanced>
            </Section>
            <Section title="网络与存储">
              <MappingRows
                name="ports"
                title="端口映射"
                initial={c.ports || []}
                emptyRow={{ host: '127.0.0.1', hostPort: '', containerPort: '8080' }}
                columns={[
                  { key: 'host', label: '绑定 IP' },
                  { key: 'hostPort', label: '服务器端口', type: 'number', min: 1, max: 65535 },
                  { key: 'containerPort', label: '容器端口', type: 'number', min: 1, max: 65535 },
                ]}
                hint="留空时不向宿主机发布端口；平台网络内仍可访问容器。"
              />
              <Advanced title="Docker 网络与持久化卷">
                <Field
                  name="networks"
                  label="Docker 网络（每行一个）"
                  multiline
                  defaultValue={(c.networks || []).join('\n')}
                  hint="留空使用平台独立网络。"
                />
                <MappingRows
                  name="volumes"
                  title="持久化卷"
                  initial={c.volumes || [{ name: 'logs', mountPath: '/app/logs' }]}
                  emptyRow={{ name: '', mountPath: '/app/' }}
                  columns={[
                    { key: 'name', label: '卷名' },
                    { key: 'mountPath', label: '容器目录' },
                  ]}
                  hint="仅支持 /app 子目录中的平台命名卷。"
                />
              </Advanced>
            </Section>
          </>
        )}
        {isStatic && (
          <Section title="共用 Nginx">
            <Notice>
              不创建新的 Web 容器。首次将前端发布目录挂载给现有
              Nginx，并配置站点；以后发布和回退只切换版本目录。
            </Notice>
            <p className="break-all text-sm text-muted-foreground">
              {item
                ? `默认宿主机目录：/opt/cmr-agent-static/${item.id}/current`
                : '保存部署目标后会生成该服务的专属发布目录。'}
            </p>
            <Field
              name="healthUrl"
              label="站点访问地址"
              type="url"
              required
              defaultValue={c.health?.url || ''}
              placeholder="https://app.example.com/"
              hint="填写 Agent 可访问的实际站点根地址；子路径站点例如 https://example.com/admin/。"
            />
          </Section>
        )}
        <Section title={isStatic ? '发布验证' : '健康检查'}>
          {!isStatic && (
            <>
              <Grid>
                <Field
                  name="healthPath"
                  label="检查路径"
                  defaultValue={c.health?.path || '/health'}
                />
                <Field
                  name="healthPort"
                  label="容器端口"
                  type="number"
                  min="1"
                  max="65535"
                  defaultValue={c.health?.port ?? 8080}
                />
              </Grid>
            </>
          )}
          <Grid>
            {!isStatic && (
              <Field
                name="healthStatus"
                label="成功 HTTP 状态码"
                type="number"
                min="200"
                max="399"
                defaultValue={c.health?.status ?? 200}
              />
            )}
            <Field
              name="healthBody"
              label="响应内容需包含（可选）"
              defaultValue={c.health?.bodyIncludes || ''}
            />
          </Grid>
          <Grid>
            <Field
              name="healthTimeout"
              label="等待健康最长时间（秒）"
              type="number"
              min="10"
              max="900"
              defaultValue={c.health?.timeoutSeconds ?? 180}
            />
            <Field
              name="healthInterval"
              label="检查间隔（秒）"
              type="number"
              min="2"
              max="60"
              defaultValue={c.health?.intervalSeconds ?? 5}
            />
          </Grid>
        </Section>
      </div>
    </FormDialog>
  )
}
