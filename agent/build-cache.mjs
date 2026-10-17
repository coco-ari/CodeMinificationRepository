import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { identifier } from './config.mjs';

export class BuildCache {
  constructor({ root, docker, identity }) { this.root = root; this.docker = docker; this.identity = identity; }
  get name() { return `cmr-${identifier(this.identity().serverId)}`; }
  run(args, options) { return this.docker.run(['--config', path.join(this.root, 'docker-config'), 'buildx', ...args], options); }
  async ensure() {
    await mkdir(path.join(this.root, 'docker-config'), { recursive: true, mode: 0o700 });
    const found = await this.run(['inspect', this.name], { allowFailure: true, timeoutMs: 30000 });
    if (found.code !== 0) {
      if (!/no builder|not found|does not exist/i.test(found.output)) throw new Error(`无法检查平台构建器：${found.output.slice(-500)}`);
      // 缓存清理由空闲维护执行，避免后台 GC 与运行中的任务竞争。
      const config = path.join(this.root, 'buildkitd.toml');
      await writeFile(config, '[worker.oci]\n  gc = false\n');
      await this.run(['create', '--name', this.name, '--driver', 'docker-container', '--buildkitd-config', config,
        '--driver-opt', 'memory=512m,memory-swap=768m,cpu-period=100000,cpu-quota=100000', 'unix:///var/run/docker.sock']);
    }
    const info = (await this.run(['inspect', this.name, '--bootstrap'])).output;
    const name = /^Name:\s+(.+)$/m.exec(info)?.[1].trim(), driver = /^Driver:\s+(.+)$/m.exec(info)?.[1].trim();
    const endpoints = [...info.matchAll(/^Endpoint:\s+(.+)$/gm)].map(match => match[1].trim());
    if (name !== this.name || driver !== 'docker-container' || endpoints.length !== 1 || endpoints[0] !== 'unix:///var/run/docker.sock') throw new Error('平台构建器归属或驱动不匹配');
    return this.name;
  }
  async build(args, options) {
    await this.ensure();
    return this.run(['build', '--builder', this.name, '--load', '--provenance=false', ...args], options);
  }
  async usage() {
    // buildx 的格式化容量可能带单位；专用 BuildKit 返回原始字节数，避免额度取整误判。
    const result = await this.docker.run(['exec', `buildx_buildkit_${this.name}0`, 'buildctl', 'du', '--format', '{{json .}}']);
    const rows = JSON.parse(result.output);
    if (!Array.isArray(rows)) throw new Error('构建缓存用量返回格式无效');
    let bytes = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.size) || row.size < 0) throw new Error('构建缓存用量返回格式无效');
      bytes += row.size;
    }
    return bytes;
  }
  async prune(policy) {
    await this.ensure();
    const beforeBytes = await this.usage(), limitBytes = policy.buildCacheGiB * 1024 ** 3;
    await this.run(['prune', '--builder', this.name, '--force', '--all', '--reserved-space', '0', '--max-used-space', String(limitBytes)]);
    const bytes = await this.usage();
    return { builder: this.name, beforeBytes, bytes, limitBytes, reclaimedBytes: Math.max(0, beforeBytes - bytes), withinLimit: bytes <= limitBytes };
  }
}
