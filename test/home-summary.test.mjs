import test from 'node:test';
import assert from 'node:assert/strict';
import { homeServices, hostMetrics, serviceHealth, serviceVersion, targetVersion } from '../web/src/lib/home-summary.js';

const servers = [{ id: 'a', name: '服务器 A', online: true }, { id: 'b', name: '服务器 B', online: true }];
const target = (extra = {}) => ({ id: 't1', serviceId: 's1', environmentId: 'test', serverId: 'a', observation: { state: 'running', health: 'healthy' }, ...extra });
const release = { id: 'r1', revision: 'a'.repeat(40), sourceSnapshot: { id: 'repo', name: '仓库', branch: 'main' }, createdAt: '2026-10-15T01:00:00Z' };

test('首页区分发布记录、未知分支、仅有运行版本及实际版本偏离', () => {
  assert.equal(targetVersion(target({ currentRelease: release })).label, 'main');
  assert.equal(targetVersion(target({ currentRelease: { ...release, sourceSnapshot: null } })).label, '分支未知');
  assert.equal(targetVersion(target()).label, '尚未发布');
  assert.equal(targetVersion(target({ observation: { revision: release.revision } })).kind, 'observed');
  const drift = targetVersion(target({ currentRelease: release, observation: { revision: 'b'.repeat(40) } }));
  assert.equal(drift.kind, 'drift');
  assert.equal(drift.revision, 'b'.repeat(40));
  assert.equal(drift.branch, undefined);
  const pendingObservation = target({ currentRelease: release, observation: { state: 'running', health: 'healthy', revision: 'b'.repeat(40) }, lastObservedAt: '2026-10-15T01:00:00Z', lastDeployedAt: '2026-10-15T01:01:00Z' });
  assert.equal(targetVersion(pendingObservation).kind, 'released');
  assert.equal(serviceHealth([pendingObservation], servers).label, '状态待上报');
});

test('多位置版本汇总不选择任意服务器，不把部分发布当成全部发布', () => {
  const a = target({ currentRelease: release });
  const b = target({ id: 't2', serverId: 'b', currentRelease: { ...release, id: 'r2' } });
  assert.equal(serviceVersion([a, b]).revision, release.revision);
  assert.equal(serviceVersion([a, target({ id: 't2', serverId: 'b' })]).kind, 'mixed');
  assert.equal(serviceVersion([a, { ...b, currentRelease: { ...release, revision: 'b'.repeat(40) } }]).kind, 'mixed');
  assert.equal(serviceVersion([a, { ...b, currentRelease: { ...release, sourceSnapshot: { ...release.sourceSnapshot, branch: 'develop' } } }]).kind, 'mixed');
  assert.equal(serviceVersion([]).kind, 'unpublished');
});

test('聚合健康状态明确区分部分异常、服务器离线和等待上报', () => {
  const a = target(), b = target({ id: 't2', serverId: 'b', observation: { state: 'stopped' } });
  assert.equal(serviceHealth([a, b], servers).label, '1/2 待处理');
  assert.equal(serviceHealth([a, b], servers).attention, 1);
  assert.equal(serviceHealth([a], [{ ...servers[0], online: false }]).label, '失联待确认');
  assert.equal(serviceHealth([a], [{ ...servers[0], revoked: true }]).value, 'unhealthy');
  assert.equal(serviceHealth([target({ observation: null })], servers).label, '状态待上报');
});

test('首页按环境汇总全部服务，原列表第四个异常服务进入前三位，进行中任务也优先', () => {
  const db = {
    servers,
    services: Array.from({ length: 5 }, (_, i) => ({ id: `s${i + 1}`, name: `服务 ${i + 1}` })),
    targets: [target(), target({ id: 't2', serviceId: 's2' }), target({ id: 't3', serviceId: 's3' }), target({ id: 't4', serviceId: 's4', observation: { state: 'stopped' } }), target({ id: 'prod', serviceId: 's1', environmentId: 'production', observation: { health: 'unhealthy' } })],
    tasks: [{ id: 'active', targetId: 't3', status: 'running' }, { id: 'old', targetId: 't2', status: 'failed' }],
    repositories: [], environmentSources: [],
  };
  const rows = homeServices(db, 'test');
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.slice(0, 3).map(row => row.id), ['s4', 's3', 's1']);
  assert.equal(rows.find(row => row.id === 's1').needsAttention, false);
  assert.equal(rows.find(row => row.id === 's2').activeTasks.length, 0);
  assert.equal(rows.find(row => row.id === 's5').health.label, '待配置');
  assert.equal(db.services[0].id, 's1');
  assert.equal(homeServices(db, 'production').find(row => row.id === 's1').needsAttention, true);
});

test('健康服务最近发布失败仍需处理，多个活动任务保留完整集合', () => {
  const db = { servers, services: [{ id: 's1' }], environmentSources: [], repositories: [],
    targets: [target({ latestTask: { id: 'failed', status: 'rolled_back', createdAt: '2026-10-15T02:00:00Z' }, currentRelease: release, lastDeployedAt: '2026-10-15T03:00:00Z' }), target({ id: 't2', serverId: 'b' })],
    tasks: [{ id: 'a', targetId: 't1', status: 'running' }, { id: 'b', targetId: 't2', status: 'queued' }],
  };
  const row = homeServices(db, 'test')[0];
  assert.equal(row.health.value, 'healthy');
  assert.equal(row.needsAttention, true);
  assert.equal(row.failedTask.id, 'failed');
  assert.equal(row.activeTasks.length, 2);
  assert.equal(row.lastDeployedAt, '2026-10-15T03:00:00Z');
});

test('资源按类型阈值告警，显示剩余磁盘，离线与缺失指标不冒充当前值', () => {
  const server = { ...servers[0], metrics: { cpuPercent: 85, memory: { used: 72, total: 100 }, disk: { used: 93 * 1024 ** 3, total: 100 * 1024 ** 3 } } };
  const metrics = hostMetrics(server);
  assert.deepEqual(metrics.map(metric => metric.level), ['warning', 'normal', 'critical']);
  assert.equal(metrics[2].remaining, 7 * 1024 ** 3);
  assert.equal(metrics[2].message, '空间紧张');
  assert.ok(hostMetrics({ ...server, online: false }).every(metric => !metric.known && !metric.message));
  assert.ok(hostMetrics({ ...servers[0], metrics: {} }).every(metric => metric.level === 'unknown'));
  assert.equal(hostMetrics({ ...servers[0], metrics: { cpuPercent: 0 } })[0].known, true);
  assert.equal(hostMetrics({ ...servers[0], metrics: { disk: { used: 0, total: 0 } } })[2].remaining, null);
});
