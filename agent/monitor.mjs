import { readFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { managedName, owns } from './config.mjs';
import { readJson } from './state.mjs';
import { checkStaticResponse } from './static-deployment.mjs';

export class Monitor {
  constructor({ docker, root, procRoot = '/host/proc' }) { this.docker = docker; this.root = root; this.procRoot = procRoot; this.previousCpu = null; }
  async metrics() {
    let cpuPercent = null, memory = { used: null, total: null }, disk = { used: null, total: null };
    try {
      const first = (await readFile(path.join(this.procRoot, 'stat'), 'utf8')).split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
      const total = first.slice(0, 8).reduce((a, b) => a + b, 0), idle = first[3] + first[4];
      if (this.previousCpu && total > this.previousCpu.total) cpuPercent = Math.max(0, Math.min(100, Math.round((1 - (idle - this.previousCpu.idle) / (total - this.previousCpu.total)) * 1000) / 10));
      this.previousCpu = { total, idle };
      const values = Object.fromEntries((await readFile(path.join(this.procRoot, 'meminfo'), 'utf8')).split('\n').filter(Boolean).map(line => { const [name, value] = line.split(/:\s*/); return [name, parseInt(value, 10) * 1024]; }));
      memory = { total: values.MemTotal, used: Math.max(0, values.MemTotal - (values.MemAvailable ?? values.MemFree)) };
    } catch { /* 主机采集失败时返回空值，不把容器自身资源冒充宿主机资源。 */ }
    try { const value = await statfs(this.root); disk = { total: value.blocks * value.bsize, used: (value.blocks - value.bfree) * value.bsize }; } catch { /* 保留未知状态。 */ }
    return { cpuPercent, memory, disk };
  }
  async containers(identity) {
    return Promise.all((identity.targets || []).map(async target => {
      if (target.mode === 'managed' && target.config?.kind === 'static') {
        const base = { targetId: target.id, kind: 'static', containerName: null, observedAt: new Date().toISOString(), managed: true };
        try {
          const release = await readJson(path.join(this.root, 'targets', target.id, 'current.json'));
          if (!release) return { ...base, exists: false, status: 'unpublished', health: 'unknown' };
          try { await checkStaticResponse(release, { timeoutMs: 2000 }); return { ...base, exists: true, status: 'published', health: 'healthy', revision: release.revision }; }
          catch { return { ...base, exists: true, status: 'published', health: 'unhealthy', revision: release.revision }; }
        } catch { return { ...base, exists: null, status: 'unknown', health: 'unknown' }; }
      }
      const containerName = target.mode === 'managed' ? managedName(target.id) : target.containerName;
      const base = { targetId: target.id, containerName: containerName || null, observedAt: new Date().toISOString(), managed: false };
      if (!containerName || typeof containerName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)) return { ...base, exists: false, status: 'unknown', health: 'unknown' };
      try {
        const info = await this.docker.inspect(containerName);
        if (!info) return { ...base, exists: false, status: 'missing', health: 'unknown' };
        return { ...base, exists: true, status: info.State.Status, health: info.State.Health?.Status || 'none', restartCount: info.RestartCount,
          image: info.Config.Image, startedAt: info.State.StartedAt, managed: owns(info, identity.serverId, target.id) };
      } catch { return { ...base, exists: null, status: 'unknown', health: 'unknown' }; }
    }));
  }
}
