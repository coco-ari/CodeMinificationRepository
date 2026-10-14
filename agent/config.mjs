import path from 'node:path';

export const VERSION = '1.0.0';
export const LABEL = 'io.cmr';
export function identifier(value, label = '标识') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error(`${label}无效`);
  return value;
}
export function relativePath(value, { glob = false } = {}) {
  if (typeof value !== 'string' || value.length > 240 || !value || /[\\\x00-\x1f:]/.test(value)
    || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..')
    || (!glob && /[*?\[\]]/.test(value)) || (glob && /[?\[\]]/.test(value))) throw new Error('相对路径无效');
  if (glob && value.includes('*') && value.slice(0, value.lastIndexOf('/') + 1).includes('*')) throw new Error('仅产物文件名允许通配符');
  return value;
}
export function safeChild(root, ...parts) {
  const base = path.resolve(root), result = path.resolve(base, ...parts);
  if (result === base || !result.startsWith(`${base}${path.sep}`)) throw new Error('路径必须位于专属工作目录内');
  return result;
}
function number(value, fallback, minimum, maximum, integer = false) {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < minimum || n > maximum || (integer && !Number.isInteger(n))) throw new Error('资源限制或端口无效');
  return n;
}
function strings(value = [], max = 50) {
  if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || x.length > 2048 || /[\x00-\x1f]/.test(x))) throw new Error('参数必须是有效字符串数组');
  return [...value];
}
export function imageName(value) {
  if (typeof value !== 'string' || value.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value)) throw new Error('镜像名称无效');
  return value;
}
export function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('部署配置无效');
  const module = input.module && input.module !== '.' ? relativePath(input.module) : '';
  if (module.startsWith('-')) throw new Error('Maven 模块不能以命令选项开头');
  const artifactPath = relativePath(input.artifactPath || `${module ? `${module}/` : ''}target/*.jar`, { glob: true });
  const profile = input.profile ?? 'test';
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9_,.-]{0,100}$/.test(profile)) throw new Error('Spring Profile 无效');
  const ports = input.ports ?? [];
  if (!Array.isArray(ports) || ports.length > 20) throw new Error('端口映射无效');
  const result = {
    module, artifactPath, buildImage: imageName(input.buildImage || 'maven:3.9.9-eclipse-temurin-8'),
    runtimeImage: imageName(input.runtimeImage || 'eclipse-temurin:8-jre'), profile,
    jvmArgs: strings(input.jvmArgs ?? ['-Xms64m', '-Xmx192m', '-XX:MaxMetaspaceSize=128m', '-XX:+ExitOnOutOfMemoryError']), args: strings(input.args),
    ports: ports.map(p => ({ host: p.host ?? '127.0.0.1', hostPort: number(p.hostPort, undefined, 1024, 65535, true), containerPort: number(p.containerPort, undefined, 1, 65535, true) })),
    networks: strings(input.networks, 10), volumes: input.volumes ?? [],
    build: { cpus: number(input.build?.cpus, 1, 0.1, 64), memoryMb: number(input.build?.memoryMb, 1024, 256, 131072, true) },
    runtime: { cpus: number(input.runtime?.cpus, 1, 0.1, 64), memoryMb: number(input.runtime?.memoryMb, 512, 128, 131072, true) },
    health: { port: number(input.health?.port, 8080, 1, 65535, true), path: input.health?.path ?? '/', status: number(input.health?.status, 200, 100, 599, true),
      bodyIncludes: input.health?.bodyIncludes ?? '', timeoutSeconds: number(input.health?.timeoutSeconds, 180, 10, 900, true), intervalSeconds: number(input.health?.intervalSeconds, 5, 2, 60, true) },
  };
  if (result.ports.some(p => !['127.0.0.1', '0.0.0.0'].includes(p.host))) throw new Error('仅支持明确的 IPv4 监听地址');
  if (result.networks.some(n => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(n))) throw new Error('Docker 网络名称无效');
  if (!Array.isArray(result.volumes) || result.volumes.length > 20) throw new Error('数据卷配置无效');
  result.volumes = result.volumes.map(v => {
    identifier(v.name, '数据卷');
    if (typeof v.mountPath !== 'string' || !/^\/app\/[a-zA-Z0-9_./-]+$/.test(v.mountPath) || v.mountPath.split('/').some(p => p === '..' || p === '.')) throw new Error('数据卷只能挂载到 /app 下的子目录');
    if (v.mountPath === '/app/app.jar') throw new Error('数据卷不能遮盖程序文件');
    return { name: v.name, mountPath: v.mountPath };
  });
  if (typeof result.health.path !== 'string' || !result.health.path.startsWith('/') || /[\x00-\x20]/.test(result.health.path) || result.health.path.length > 2000
    || typeof result.health.bodyIncludes !== 'string' || result.health.bodyIncludes.length > 1024) throw new Error('健康检查配置无效');
  if (result.jvmArgs.some(arg => !arg.startsWith('-') || /^-(?:jar|cp|classpath|javaagent|agentlib|agentpath)(?:[:=]|$)/.test(arg))) throw new Error('JVM 参数不能替换程序入口或加载代理');
  return result;
}
export function managedName(targetId) { return `cmr-${identifier(targetId)}`; }
export function releaseImage(targetId, taskId) { return `cmr/${identifier(targetId)}:${identifier(taskId)}`; }
export function labels(serverId, targetId, taskId) {
  return { [`${LABEL}.managed`]: 'true', [`${LABEL}.server`]: identifier(serverId), [`${LABEL}.target`]: identifier(targetId), ...(taskId ? { [`${LABEL}.task`]: identifier(taskId) } : {}) };
}
export function owns(resource, serverId, targetId) {
  const actual = resource?.Config?.Labels || resource?.Labels || {};
  return Object.entries(labels(serverId, targetId)).every(([key, value]) => actual[key] === value);
}
export function assertManaged(identity, task) {
  identifier(task.id, '任务'); identifier(task.targetId, '部署目标');
  const target = identity.targets?.find(t => t.id === task.targetId);
  if (identity.mode !== 'managed' || !target || target.mode !== 'managed' || (task.serverId && task.serverId !== identity.serverId)
    || (target.serverId && target.serverId !== identity.serverId)) throw new Error('仅观察模式禁止发布、重启、回退和清理');
  if (!['deploy', 'restart', 'rollback'].includes(task.action)) throw new Error('任务操作无效');
  return target;
}
