import { mkdir, writeFile, readdir, lstat, realpath, copyFile, chown, chmod, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { identifier, safeChild, normalizeConfig, managedName, releaseImage, labels, owns, assertManaged } from './config.mjs';
import { readJson, writeJson } from './state.mjs';
import { extractZip } from './archive.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
export const terminal = status => ['succeeded', 'failed', 'rolled_back', 'interrupted'].includes(status);
export function composeFor(identity, task, release) {
  const config = normalizeConfig(release.config), project = managedName(task.targetId), resourceLabels = labels(identity.serverId, task.targetId, release.id);
  const networkNames = config.networks.length ? config.networks : ['default'];
  return { name: project, services: { app: {
    container_name: project, image: release.image, restart: 'unless-stopped', user: '1000:1000', init: true,
    stop_grace_period: '45s', mem_limit: `${config.runtime.memoryMb}m`, memswap_limit: `${Math.round(config.runtime.memoryMb * 1.5)}m`, cpus: config.runtime.cpus, pids_limit: 256,
    labels: resourceLabels, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    ports: config.ports.map(p => `${p.host}:${p.hostPort}:${p.containerPort}`), networks: networkNames,
    volumes: config.volumes.map(v => `${v.name}:${v.mountPath}`),
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    healthcheck: { test: ['CMD', 'java', '-Xms8m', '-Xmx32m', '-cp', '/cmr', 'HealthProbe', String(config.health.port), config.health.path, String(config.health.status), config.health.bodyIncludes],
      interval: `${config.health.intervalSeconds}s`, timeout: '7s', retries: Math.ceil(config.health.timeoutSeconds / config.health.intervalSeconds), start_period: '10s' },
  } }, networks: config.networks.length ? Object.fromEntries(config.networks.map(n => [n, { external: true, name: n }])) : { default: { name: `${project}-network`, labels: labels(identity.serverId, task.targetId) } },
  volumes: Object.fromEntries(config.volumes.map(v => [v.name, { name: `${project}-${v.name}`, labels: labels(identity.serverId, task.targetId) }])) };
}

export class DeploymentExecutor {
  constructor({ root, identity, journal, client, docker, sleepFn = sleep }) {
    this.root = root; this.identity = identity; this.journal = journal; this.client = client; this.docker = docker; this.sleep = sleepFn;
  }
  getIdentity() { return typeof this.identity === 'function' ? this.identity() : this.identity; }
  targetRoot(task) { return safeChild(this.root, 'targets', identifier(task.targetId)); }
  taskRoot(task) { return safeChild(this.root, 'work', identifier(task.id)); }
  async event(task, stage, message, extra = {}) { return this.journal.emit(task.id, { stage, message, ...extra }); }
  async output(task, stage, text) {
    for (let offset = 0; offset < text.length; offset += 16384) await this.event(task, stage, text.slice(offset, offset + 16384));
  }
  async mutation(task, args, options) { assertManaged(this.getIdentity(), task); return this.docker.run(args, options); }
  async current(task) { return readJson(safeChild(this.targetRoot(task), 'current.json')); }
  async requireOwned(task, name = managedName(task.targetId), kind = 'container') {
    const resource = await this.docker.inspect(name, kind);
    if (resource && !owns(resource, this.getIdentity().serverId, task.targetId)) throw new Error(`拒绝修改非平台所属的 ${kind}：${name}`);
    return resource;
  }
  async preflight(task, config) {
    assertManaged(this.getIdentity(), task);
    await this.requireOwned(task);
    for (const volume of config.volumes) await this.requireOwned(task, `${managedName(task.targetId)}-${volume.name}`, 'volume');
    if (!config.networks.length) await this.requireOwned(task, `${managedName(task.targetId)}-network`, 'network');
    for (const network of config.networks) if (!await this.docker.inspect(network, 'network')) throw new Error(`部署网络不存在：${network}`);
  }
  async mountDirectory(directoryPath) {
    await mkdir(directoryPath, { recursive: true, mode: 0o755 });
    // 构建容器使用非特权用户，不共享 Agent 的身份文件和 Docker Socket。
    if (process.platform !== 'win32') await chown(directoryPath, 1000, 1000);
    await chmod(directoryPath, 0o755);
  }
  async makeSourceWritable(root) {
    if (process.platform === 'win32') return;
    await chown(root, 1000, 1000); await chmod(root, 0o755);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = safeChild(root, entry.name);
      if (entry.isDirectory()) await this.makeSourceWritable(file);
      else if (entry.isFile()) await chown(file, 1000, 1000);
      else throw new Error('源码中出现了不允许的文件类型');
    }
  }
  async builder(task, config, suffix, mounts, args, stage = 'building') {
    const name = `cmr-build-${task.id}-${suffix}`;
    await this.requireOwned(task, name);
    const labelArgs = Object.entries(labels(this.getIdentity().serverId, task.targetId, task.id)).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
    const run = ['run', '--rm', '--name', name, ...labelArgs, '--cpus', String(config.build.cpus), '--memory', `${config.build.memoryMb}m`, '--memory-swap', `${Math.round(config.build.memoryMb * 1.5)}m`, '--pids-limit', '256', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--env', 'HOME=/tmp', '--env', 'MAVEN_CONFIG=/tmp/.m2', '--env', `MAVEN_OPTS=-Xmx${Math.floor(config.build.memoryMb * 0.6)}m -XX:MaxMetaspaceSize=${Math.max(96, Math.floor(config.build.memoryMb * 0.18))}m -Duser.home=/tmp`,
      ...mounts.flatMap(([hostPath, containerPath, readOnly]) => ['--mount', `type=bind,src=${hostPath},dst=${containerPath}${readOnly ? ',readonly' : ''}`]), '--workdir', '/workspace', config.buildImage, ...args];
    try { return await this.mutation(task, run, { onOutput: text => this.output(task, stage, text) }); }
    finally {
      const leftover = await this.requireOwned(task, name);
      if (leftover) await this.mutation(task, ['rm', '-f', name], { timeoutMs: 15000 });
    }
  }
  async findArtifact(source, pattern) {
    const relativeDirectory = path.posix.dirname(pattern), namePattern = path.posix.basename(pattern);
    const parent = relativeDirectory === '.' ? source : safeChild(source, ...relativeDirectory.split('/'));
    const sourceReal = await realpath(source), parentReal = await realpath(parent);
    if (parentReal !== sourceReal && !parentReal.startsWith(`${sourceReal}${path.sep}`)) throw new Error('构建产物目录越出源码目录');
    const matcher = new RegExp(`^${namePattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const matches = (await readdir(parent, { withFileTypes: true })).filter(e => e.isFile() && matcher.test(e.name) && !/-(?:sources|javadoc)\.jar$/.test(e.name));
    if (matches.length !== 1) throw new Error(`产物路径应匹配一个 JAR，当前匹配 ${matches.length} 个`);
    const artifact = safeChild(parent, matches[0].name), info = await lstat(artifact), artifactReal = await realpath(artifact);
    if (!artifactReal.startsWith(`${sourceReal}${path.sep}`)) throw new Error('构建产物越出源码目录');
    if (!info.isFile() || info.isSymbolicLink() || info.size < 22 || info.size > 512 * 1024 * 1024) throw new Error('JAR 产物无效');
    return artifact;
  }
  async build(task, config) {
    const root = this.taskRoot(task); await mkdir(root, { recursive: true, mode: 0o700 });
    const zip = safeChild(root, 'source.zip'), source = safeChild(root, 'source');
    await this.event(task, 'downloading', '正在下载固定版本的完整源码 ZIP');
    await this.client.download(task, zip); await extractZip(zip, source); await this.makeSourceWritable(source);
    await lstat(safeChild(source, 'pom.xml'));
    await this.event(task, 'building', '正在编译目标模块及公共依赖');
    const cache = safeChild(this.root, 'cache', identifier(task.applicationId || task.targetId), 'maven'); await this.mountDirectory(cache);
    const args = ['mvn', '-B', '-ntp', '-Dmaven.repo.local=/cache', '-DskipTests', ...(config.module ? ['-pl', config.module, '-am'] : []), 'clean', 'package'];
    await this.builder(task, config, 'maven', [[source, '/workspace'], [cache, '/cache']], args);
    const imageRoot = safeChild(root, 'image'); await this.mountDirectory(imageRoot);
    await copyFile(await this.findArtifact(source, config.artifactPath), safeChild(imageRoot, 'app.jar'));
    await copyFile(path.join(directory, 'HealthProbe.java'), safeChild(imageRoot, 'HealthProbe.java'));
    await this.builder(task, config, 'probe', [[imageRoot, '/workspace']], ['javac', '-encoding', 'UTF-8', '-source', '8', '-target', '8', '/workspace/HealthProbe.java']);
    const entrypoint = ['java', ...config.jvmArgs, '-jar', '/app/app.jar', ...(config.profile ? [`--spring.profiles.active=${config.profile}`] : []), ...config.args];
    const dockerfile = [`FROM ${config.runtimeImage}`, 'WORKDIR /app', `RUN ${JSON.stringify(['mkdir', '-p', '/app/logs', '/cmr', ...config.volumes.map(v => v.mountPath)])}`, 'RUN ["chown","-R","1000:1000","/app"]', 'COPY app.jar /app/app.jar', 'COPY HealthProbe.class /cmr/HealthProbe.class', 'USER 1000:1000', `ENTRYPOINT ${JSON.stringify(entrypoint)}`, ''].join('\n');
    await writeFile(safeChild(imageRoot, 'Dockerfile'), dockerfile, { mode: 0o600 });
    await writeFile(safeChild(imageRoot, '.dockerignore'), '*\n!Dockerfile\n!app.jar\n!HealthProbe.class\n', { mode: 0o600 });
    const release = { id: task.id, image: releaseImage(task.targetId, task.id), revision: task.source.revision, config, createdAt: new Date().toISOString() };
    await this.requireOwned(task, release.image, 'image');
    const labelArgs = Object.entries(labels(this.getIdentity().serverId, task.targetId, task.id)).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
    await this.mutation(task, ['build', ...labelArgs, '-t', release.image, imageRoot], { onOutput: text => this.output(task, 'building', text) });
    return release;
  }
  async requireRelease(task, release) {
    if (!release || release.image !== releaseImage(task.targetId, release.id)) throw new Error('发布版本不属于当前部署目标');
    normalizeConfig(release.config);
    if (!await this.requireOwned(task, release.image, 'image')) throw new Error('需要的历史镜像不存在');
    return release;
  }
  async activate(task, release) {
    await this.requireRelease(task, release); await this.preflight(task, normalizeConfig(release.config));
    const file = safeChild(this.taskRoot(task), `compose-${identifier(release.id)}.json`);
    await writeJson(file, composeFor(this.getIdentity(), task, release));
    await this.mutation(task, ['compose', '--project-name', managedName(task.targetId), '-f', file, 'up', '-d', '--no-deps', 'app'], { timeoutMs: 120000, onOutput: text => this.output(task, 'deploying', text) });
  }
  async health(task, release) {
    const config = normalizeConfig(release.config), deadline = Date.now() + config.health.timeoutSeconds * 1000;
    do {
      const container = await this.requireOwned(task);
      if (!container || container.Config.Image !== release.image) throw new Error('实际容器版本与任务版本不一致');
      if (container.State?.OOMKilled || container.State?.Status === 'exited' || container.State?.Status === 'dead') throw new Error('业务容器已退出或触发内存限制');
      if (container.State?.Health?.Status === 'healthy' && container.State?.Running === true) return;
      await this.sleep(config.health.intervalSeconds * 1000);
    } while (Date.now() < deadline);
    throw new Error('业务健康检查超时');
  }
  async saveRelease(task, release, previous) {
    await writeJson(safeChild(this.targetRoot(task), 'releases', `${identifier(release.id)}.json`), release);
    await writeJson(safeChild(this.targetRoot(task), 'current.json'), { ...release, previousId: previous?.id ?? null });
  }
  async finish(task, release, previous) {
    await this.saveRelease(task, release, previous);
    try { await this.cleanup(task, release, previous); } catch (error) { await this.event(task, 'verifying', `发布已成功，历史清理延后：${error.message}`); }
    await this.event(task, 'verifying', '部署成功，业务健康检查通过', { status: 'succeeded', result: { release } });
  }
  async rollbackFailure(task, error, previous) {
    const message = String(error.message || error).slice(0, 3000);
    if (!previous) {
      let cleanupError;
      try {
        const actual = await this.requireOwned(task);
        // 首次发布失败时只移除本任务新建的容器，保留卷，避免阻塞下一次正常发布。
        if (actual && actual.Config?.Labels?.['io.cmr.task'] === task.id && actual.Config.Image === releaseImage(task.targetId, task.id)) {
          await this.mutation(task, ['rm', '-f', managedName(task.targetId)], { timeoutMs: 30000 });
        }
      } catch (failure) { cleanupError = String(failure.message).slice(0, 2000); }
      await this.event(task, 'verifying', message, { status: 'failed', result: { error: message, rollback: { status: 'unavailable' }, ...(cleanupError ? { cleanupError } : {}) } }); return;
    }
    try {
      await this.event(task, 'deploying', '发布未通过，正在恢复上一成功版本');
      await this.activate(task, previous); await this.event(task, 'verifying', '正在验证回退版本'); await this.health(task, previous);
      await this.saveRelease(task, previous, null);
      await this.event(task, 'verifying', '发布失败，已恢复上一成功版本', { status: 'rolled_back', result: { error: message, release: previous, rollback: { status: 'succeeded', release: previous } } });
    } catch (rollbackError) {
      await this.event(task, 'verifying', '发布失败且自动回退未通过，请检查任务日志', { status: 'failed', result: { error: message, rollback: { status: 'failed', error: String(rollbackError.message).slice(0, 3000) } } });
    }
  }
  async execute(task) {
    const existing = await this.journal.get(task.id); if (existing) { if (terminal(existing.status)) return; return this.recover(existing); }
    await this.journal.create(task);
    let previous = null, deploying = false;
    try {
      assertManaged(this.getIdentity(), task); const config = normalizeConfig(task.config);
      await this.preflight(task, config);
      previous = await this.current(task);
      const actual = await this.requireOwned(task);
      if (actual && (!previous || actual.Config.Image !== previous.image)) throw new Error('运行容器与本地成功版本记录不一致，拒绝覆盖');
      if (!previous && task.previousRelease) throw new Error('本机缺少上一版本记录，必须先恢复 Agent 持久化数据');
      if (previous) await this.requireRelease(task, previous);
      await this.journal.update(task.id, { previousRelease: previous });
      let release;
      if (task.action === 'deploy') release = await this.build(task, config);
      else if (task.action === 'rollback') {
        const requested = task.release;
        if (!requested?.id) throw new Error('必须指定需要回退的成功版本');
        release = await readJson(safeChild(this.targetRoot(task), 'releases', `${identifier(requested.id)}.json`));
        if (!release || release.image !== requested.image) throw new Error('指定版本不在本机保留的成功版本中');
        await this.requireRelease(task, release);
      } else { if (!previous) throw new Error('目标尚无成功部署版本'); release = previous; }
      await this.journal.update(task.id, { release });
      await this.event(task, 'deploying', task.action === 'restart' ? '正在重启当前平台容器' : '正在更新当前部署目标');
      deploying = true;
      if (task.action === 'restart') { await this.requireOwned(task); await this.mutation(task, ['restart', '--time', '45', managedName(task.targetId)], { timeoutMs: 90000 }); }
      else await this.activate(task, release);
      await this.event(task, 'verifying', '正在等待业务健康检查通过'); await this.health(task, release); await this.finish(task, release, previous);
    } catch (error) {
      if (deploying) await this.rollbackFailure(task, error, previous);
      else await this.event(task, (await this.journal.get(task.id)).stage, String(error.message).slice(0, 3000), { status: 'failed', result: { error: String(error.message).slice(0, 3000) } });
    } finally {
      if (terminal((await this.journal.get(task.id))?.status)) await this.cleanupWork(task).catch(() => {});
    }
  }
  async recover(record) {
    const task = record.task;
    try {
      assertManaged(this.getIdentity(), task);
      if (['deploying', 'verifying'].includes(record.stage) && record.release) {
        await this.event(task, 'verifying', 'Agent 重启，正在核对已执行的部署状态');
        try { await this.health(task, record.release); await this.finish(task, record.release, record.previousRelease); }
        catch (error) { await this.rollbackFailure(task, error, record.previousRelease); }
      } else {
        for (const suffix of ['maven', 'probe']) {
          const name = `cmr-build-${task.id}-${suffix}`, container = await this.requireOwned(task, name);
          if (container) await this.mutation(task, ['rm', '-f', name], { timeoutMs: 15000 });
        }
        await this.event(task, record.stage, 'Agent 重启时编译或下载被中断；请重新创建发布任务', { status: 'interrupted', result: { error: 'Agent 在部署开始前重启，未重复执行任务' } });
      }
    } catch (error) { await this.event(task, record.stage, String(error.message).slice(0, 3000), { status: 'interrupted', result: { error: String(error.message).slice(0, 3000) } }); }
    finally { if (terminal((await this.journal.get(task.id))?.status)) await this.cleanupWork(task).catch(() => {}); }
  }
  async cleanupWork(task) {
    assertManaged(this.getIdentity(), task);
    const record = await this.journal.get(task.id);
    if (task.action === 'deploy' && record?.status !== 'succeeded') {
      const image = releaseImage(task.targetId, task.id), actual = await this.requireOwned(task);
      if (actual?.Config.Image !== image && await this.requireOwned(task, image, 'image')) {
        await this.mutation(task, ['image', 'rm', image], { allowFailure: true, timeoutMs: 30000 });
      }
    }
    // 仅移除本任务私有的构建产物，保留日志、版本记录和恢复需要的 Compose 文件。
    for (const name of ['source.zip', 'source', 'image']) await rm(safeChild(this.taskRoot(task), name), { recursive: true, force: true });
  }
  async cleanup(task, current, previous) {
    assertManaged(this.getIdentity(), task);
    const root = safeChild(this.targetRoot(task), 'releases');
    const releases = (await Promise.all((await readdir(root)).filter(n => n.endsWith('.json')).map(n => readJson(safeChild(root, n))))).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const keep = new Set([...releases.slice(0, 5).map(r => r.id), current.id, previous?.id].filter(Boolean));
    for (const release of releases) {
      if (keep.has(release.id)) continue;
      await this.requireRelease(task, release);
      const result = await this.mutation(task, ['image', 'rm', release.image], { allowFailure: true, timeoutMs: 30000 });
      if (result.code === 0) await rm(safeChild(root, `${identifier(release.id)}.json`));
    }
  }
}
