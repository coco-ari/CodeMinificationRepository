import assert from 'node:assert/strict'
import test from 'node:test'
import {
  autoOpsAreaFromPath,
  autoOpsAreaAvailable,
  AUTOOPS_AREAS,
  createAutoOpsProjectNavigation,
  normalizeAutoOpsChatHref,
  resolveAutoOpsNativeThreadProjectId,
  resolveAutoOpsRouteProjectId,
} from '../vendor/t3code/apps/web/src/autoops/projectNavigation.logic.ts'

test('归档会话保留真实项目上下文，但不能恢复为最近聊天目的地', () => {
  const archived = { projectId: 'project-a', deletedAt: null, archivedAt: '2026-10-22T00:00:00Z' }
  assert.equal(resolveAutoOpsNativeThreadProjectId(archived, null), 'project-a')
  assert.equal(resolveAutoOpsNativeThreadProjectId(archived, null, 'recent'), '')
  assert.equal(resolveAutoOpsNativeThreadProjectId(null, archived), 'project-a')
  assert.equal(resolveAutoOpsNativeThreadProjectId(null, archived, 'recent'), '')
  const current = { ...archived, archivedAt: null }
  assert.equal(resolveAutoOpsNativeThreadProjectId(current, null, 'recent'), 'project-a')
})

test('原生明细可补齐未列入 shell 的会话归属，加载中不回退旧项目', () => {
  const detail = { projectId: 'project-b', deletedAt: null, archivedAt: null }
  assert.equal(resolveAutoOpsNativeThreadProjectId(null, undefined), '')
  assert.equal(resolveAutoOpsNativeThreadProjectId(null, detail), 'project-b')
  assert.equal(resolveAutoOpsNativeThreadProjectId(null, detail, 'recent'), 'project-b')
  assert.equal(resolveAutoOpsNativeThreadProjectId({ ...detail, projectId: 'project-a' }, detail), '')
})

test('已删除的原生 shell 或明细不能提供项目上下文或最近聊天目的地', () => {
  const current = { projectId: 'project-a', deletedAt: null, archivedAt: null }
  const deleted = { ...current, deletedAt: '2026-10-22T00:00:00Z' }
  for (const purpose of ['context', 'recent']) {
    assert.equal(resolveAutoOpsNativeThreadProjectId(deleted, null, purpose), '')
    assert.equal(resolveAutoOpsNativeThreadProjectId(null, deleted, purpose), '')
    assert.equal(resolveAutoOpsNativeThreadProjectId(current, deleted, purpose), '')
  }
})

function fixture() {
  let host = { principal: { id: 'alice' }, projects: [{ id: 'project-a' }, { id: 'project-b' }] }
  let search = {}
  let nativeProjectId = null
  let storageBlocked = false
  const saved = new Map()
  const chatOwners = new Map()
  const storage = {
    getItem(key) { return saved.get(key) ?? null },
    setItem(key, value) { saved.set(key, value) },
    removeItem(key) { saved.delete(key) },
  }
  const options = {
    readHost: () => host,
    readRouteSearch: () => search,
    readNativeProjectId: () => nativeProjectId,
    readStorage: () => { if (storageBlocked) throw new Error('storage disabled'); return storage },
    ownsChatHref: (projectId, href) => chatOwners.get(href) === projectId,
  }
  return {
    store: createAutoOpsProjectNavigation(options), saved, chatOwners,
    recreate: () => createAutoOpsProjectNavigation(options),
    setHost(value) { host = value },
    setSearch(value) { search = value },
    setNativeProject(value) { nativeProjectId = value },
    blockStorage() { storageBlocked = true },
  }
}

test('项目路由明确区分未指定、授权项目与无效项目，不接受歧义查询', () => {
  const projects = [{ id: '项目 A/1' }]
  for (const search of [{}, '', '?other=1', new URLSearchParams('other=1')]) {
    assert.deepEqual(resolveAutoOpsRouteProjectId(search, projects), { status: 'absent' })
  }
  for (const search of [
    { projectId: '项目 A/1' }, '?projectId=%E9%A1%B9%E7%9B%AE+A%2F1',
    '/workspaces?projectId=%E9%A1%B9%E7%9B%AE+A%2F1',
    new URL('https://example.test/agent-demo.html#/deployments?projectId=%E9%A1%B9%E7%9B%AE+A%2F1'),
  ]) {
    assert.deepEqual(resolveAutoOpsRouteProjectId(search, projects), { status: 'selected', projectId: '项目 A/1' })
  }
  for (const search of [
    { projectId: '' }, { projectId: undefined }, { projectId: null }, { projectId: ['项目 A/1'] },
    '?projectId=unknown', '?projectId=', '?projectId=%E9%A1%B9%E7%9B%AE+A%2F1&projectId=%E9%A1%B9%E7%9B%AE+A%2F1',
  ]) {
    assert.deepEqual(resolveAutoOpsRouteProjectId(search, projects), { status: 'invalid' })
  }
})

test('页面查询优先于统一项目，明确无效查询不回退到其它项目', () => {
  const f = fixture()
  assert.equal(f.store.readProjectId(), 'project-a')
  f.store.selectProject('project-b')
  assert.equal(f.store.readProjectId(), 'project-b')
  f.setSearch({ projectId: 'project-a' })
  assert.equal(f.store.readProjectId(), 'project-a')
  f.setSearch({ projectId: 'removed-project' })
  assert.equal(f.store.readProjectId(), '')
  f.setSearch({})
  assert.equal(f.store.readProjectId(), 'project-b', '读取直接链接不应覆盖已保存的项目选择')
})

test('原生会话与草稿归属优先，实体未就绪时不能相信聊天链接的项目查询', () => {
  const f = fixture()
  f.store.selectProject('project-b')
  f.setSearch({ projectId: 'project-b' })
  f.setNativeProject('project-a')
  assert.equal(f.store.readProjectId(), 'project-a')
  f.setNativeProject('')
  assert.equal(f.store.readProjectId(), '')
  f.setNativeProject('removed-project')
  assert.equal(f.store.readProjectId(), '')
  f.setNativeProject(null)
  assert.equal(f.store.readProjectId(), 'project-b')
})

test('切换项目通知订阅者、按用户保存，拒绝未授权项目且存储不可用仍能使用', () => {
  const f = fixture()
  let notifications = 0
  const unsubscribe = f.store.subscribe(() => notifications++)
  f.store.selectProject('project-b')
  assert.equal(notifications, 1)
  assert.equal(f.saved.get('autoops:project-navigation:alice:project'), 'project-b')
  assert.equal(f.recreate().readProjectId(), 'project-b')
  assert.throws(() => f.store.selectProject('not-authorized'), /无权/)
  assert.equal(notifications, 1)
  assert.equal(f.store.readProjectId(), 'project-b')
  f.blockStorage()
  f.store.selectProject('project-a')
  assert.equal(f.store.readProjectId(), 'project-a')
  unsubscribe()
  f.store.selectProject('project-b')
  assert.equal(notifications, 2)
})

test('身份变化与权限撤销不复用前一用户或已失效项目的内存状态', () => {
  const f = fixture()
  f.store.selectProject('project-b')
  f.chatOwners.set('/env/thread-a', 'project-b')
  f.store.rememberChatLocation('project-b', '/env/thread-a')
  f.setHost({ principal: { id: 'bob' }, projects: [{ id: 'project-a' }, { id: 'project-b' }] })
  assert.equal(f.store.readProjectId(), 'project-a')
  assert.equal(f.store.projectHref('chat', 'project-b'), '/?projectId=project-b')
  f.store.selectProject('project-b')
  f.setHost({ principal: { id: 'bob' }, projects: [{ id: 'project-a' }] })
  assert.equal(f.store.readProjectId(), 'project-a')
  assert.throws(() => f.store.projectHref('workspaces', 'project-b'), /无权/)
  f.setHost(undefined)
  assert.equal(f.store.readProjectId(), '')
  assert.equal(f.store.projectHref('chat', 'project-a'), '/')
  assert.doesNotThrow(() => f.store.selectProject('project-a'))
})

test('区域链接使用独立路径和完整项目查询，路径前缀不会误判', () => {
  const f = fixture()
  assert.equal(f.store.projectHref('workspaces', 'project-b'), '/workspaces?projectId=project-b')
  assert.equal(f.store.projectHref('deployments', 'project-b'), '/deployments?projectId=project-b')
  assert.equal(f.store.projectHref('skills', 'project-b'), '/skills?projectId=project-b')
  assert.equal(f.store.projectHref('chat', 'project-b'), '/?projectId=project-b')
  assert.equal(autoOpsAreaFromPath('/workspaces'), 'workspaces')
  assert.equal(autoOpsAreaFromPath('/workspaces/version'), 'workspaces')
  assert.equal(autoOpsAreaFromPath('/deployments'), 'deployments')
  assert.equal(autoOpsAreaFromPath('/deployments/task'), 'deployments')
  assert.equal(autoOpsAreaFromPath('/skills'), 'skills')
  assert.equal(autoOpsAreaFromPath('/skills/skill-a'), 'skills')
  assert.equal(autoOpsAreaFromPath('/draft/draft-a'), 'chat')
  assert.equal(autoOpsAreaFromPath('/workspaces-other'), 'chat')
  assert.equal(autoOpsAreaFromPath('/skills-other'), 'chat')
})

test('技能切项目仅保留已知视图与授权助手，清除旧项目资源和动作参数', () => {
  const f = fixture()
  f.setHost({ principal: { id: 'alice' }, projects: [
    { id: 'project-a', agents: [{ id: 'agent-a' }] },
    { id: 'project-b', agents: [{ id: 'agent-b' }] },
  ] })
  const oldHref = '/skills?projectId=project-a&skillView=agent&agentId=agent-a&skillId=old&versionId=v1&action=assign'
  assert.equal(f.store.projectHref('skills', 'project-b', oldHref), '/skills?projectId=project-b&skillView=agent&agentId=agent-a')
  assert.equal(f.store.readProjectId(), 'project-a', '生成链接不能改变当前项目或既有任务绑定')
  for (const view of ['library', 'project']) {
    assert.equal(f.store.projectHref('skills', 'project-b', { skillView: view, agentId: 'agent-a', skillId: 'old' }), `/skills?projectId=project-b&skillView=${view}`)
  }
  for (const search of [
    '?skillView=agent&agentId=unknown', '?skillView=agent&agentId=agent-a&agentId=agent-a',
    { skillView: 'agent', agentId: ['agent-a'] },
  ]) assert.equal(f.store.projectHref('skills', 'project-b', search), '/skills?projectId=project-b&skillView=agent')
  for (const search of [
    '?skillView=unknown&agentId=agent-a', '?skillView=agent&skillView=project&agentId=agent-a',
    { skillView: ['agent'], agentId: 'agent-a' }, { agentId: 'agent-a' },
  ]) assert.equal(f.store.projectHref('skills', 'project-b', search), '/skills?projectId=project-b')
  f.setHost({ principal: { id: 'alice' }, projects: [{ id: 'project-b', agents: [{ id: 'agent-b' }] }] })
  assert.equal(f.store.projectHref('skills', 'project-b', oldHref), '/skills?projectId=project-b&skillView=agent')
  assert.throws(() => f.store.projectHref('skills', 'project-a', oldHref), /无权/)
  f.setSearch({ projectId: 'project-a', skillView: 'project' })
  assert.equal(f.store.readProjectId(), '', '失效技能深链不能回退到另一个项目')
})

test('只保存原生聊天路径，拒绝外链、控制页面、路径转义与不安全字符', () => {
  assert.equal(normalizeAutoOpsChatHref('/draft/draft-a'), '/draft/draft-a')
  assert.equal(normalizeAutoOpsChatHref('/env/thread-a?projectId=wrong#tool'), '/env/thread-a')
  assert.equal(normalizeAutoOpsChatHref('/env/thread-a/'), '/env/thread-a')
  for (const value of [
    null, {}, 'https://example.test/env/thread', '//example.test/thread', '/settings/general',
    '/projects/project-a', '/workspaces/version', '/deployments/task', '/skills/skill-a', '/%73kills/skill-a', '/api/delete',
    '/draft', '/env/thread/extra', '/env/..', '/env/%2e%2e', '/env/%2fother', '/env/%5cother',
    '/env/%0athread', '/env/thread\n', '/env\\thread/x', '/env/%zz',
  ]) assert.equal(normalizeAutoOpsChatHref(value), null, String(value))
})

test('会话导航每次核对原生实体归属，禁止持久值篡改、跨项目和失效会话恢复', () => {
  const f = fixture()
  f.chatOwners.set('/env/thread-a', 'project-a')
  f.chatOwners.set('/draft/draft-b', 'project-b')
  f.store.rememberChatLocation('project-a', '/env/thread-a?unsafe=1')
  f.store.rememberChatLocation('project-b', '/draft/draft-b')
  assert.equal(f.store.projectHref('chat', 'project-a'), '/env/thread-a')
  assert.equal(f.store.projectHref('chat', 'project-b'), '/draft/draft-b')
  assert.equal(f.recreate().projectHref('chat', 'project-a'), '/env/thread-a')
  f.chatOwners.delete('/env/thread-a')
  assert.equal(f.store.projectHref('chat', 'project-a'), '/?projectId=project-a')
  f.saved.set('autoops:project-navigation:alice:chat:project-a', '/draft/draft-b')
  assert.equal(f.recreate().projectHref('chat', 'project-a'), '/?projectId=project-a')
  f.saved.set('autoops:project-navigation:alice:chat:project-a', 'https://evil.test/')
  assert.equal(f.recreate().projectHref('chat', 'project-a'), '/?projectId=project-a')
  assert.equal(f.saved.has('autoops:project-navigation:alice:chat:project-a'), false)
})

test('尚未加载的会话只回退项目入口，原生实体恢复后才可恢复已保存路径', () => {
  const f = fixture()
  f.saved.set('autoops:project-navigation:alice:chat:project-a', '/env/thread-a')
  assert.equal(f.store.projectHref('chat', 'project-a'), '/?projectId=project-a')
  f.chatOwners.set('/env/thread-a', 'project-a')
  assert.equal(f.store.projectHref('chat', 'project-a'), '/env/thread-a')
  f.store.rememberChatLocation('project-a', '/draft/unknown')
  f.store.rememberChatLocation('project-b', '/env/thread-a')
  f.store.rememberChatLocation('unavailable-project', '/env/thread-a')
  assert.equal(f.store.projectHref('chat', 'project-a'), '/env/thread-a')
  assert.equal(f.store.projectHref('chat', 'project-b'), '/?projectId=project-b')
})

test('工作区项目 ID 的特殊字符保持完整编码，用户键不会发生拼接冲突', () => {
  const f = fixture()
  f.setHost({ principal: { id: 'a:b' }, projects: [{ id: '项目 A/1' }] })
  f.store.selectProject('项目 A/1')
  assert.equal(f.store.projectHref('deployments', '项目 A/1'), '/deployments?projectId=%E9%A1%B9%E7%9B%AE+A%2F1')
  assert.equal(f.saved.get('autoops:project-navigation:a%3Ab:project'), '项目 A/1')
})


test('我的电脑是独立个人模块，入口和直链共用开关，不依赖当前项目角色', () => {
  const owner = { principal: { id: 'alice' }, customerAgentsEnabled: true, projects: [
    { id: 'project-a', membership: { workspaceAccess: 'external', role: 'external' } },
  ] }
  assert.equal(autoOpsAreaAvailable('devices', owner, 'project-a'), true)
  assert.equal(autoOpsAreaAvailable('devices', owner, 'removed-project'), true)
  assert.equal(autoOpsAreaAvailable('devices', { ...owner, projects: [] }), true)
  assert.equal(autoOpsAreaAvailable('devices', { ...owner, customerAgentsEnabled: false }), false)
  assert.equal(autoOpsAreaAvailable('devices', undefined), false)
  assert.equal(autoOpsAreaAvailable('deployments', owner, 'project-a'), false)
  assert.equal(autoOpsAreaAvailable('deployments', { ...owner, projects: [{ id: 'project-a', capabilities: { 'deployment.read': true }, membership: { workspaceAccess: 'internal', role: 'project_admin' } }] }, 'project-a'), true)
  assert.equal(autoOpsAreaFromPath('/devices'), 'devices')
  assert.equal(normalizeAutoOpsChatHref('/devices/other'), null)
  const definition = AUTOOPS_AREAS.find(area => area.id === 'devices')
  assert.equal(definition.scope, 'global')
  assert.equal(definition.common, false)
  assert.equal(definition.sidebar, true)
})

test('电脑模块切项目只更新返回上下文，不保留资源命令或改绑已有对话', () => {
  const f = fixture()
  f.chatOwners.set('/env/thread-a', 'project-a')
  f.store.rememberChatLocation('project-a', '/env/thread-a')
  assert.equal(f.store.projectHref('devices', 'project-a', { deviceId: 'other', action: 'revoke' }), '/devices?projectId=project-a')
  f.store.selectProject('project-b')
  assert.equal(f.store.projectHref('devices', 'project-b'), '/devices?projectId=project-b')
  assert.equal(f.store.projectHref('chat', 'project-a'), '/env/thread-a')
  assert.equal(f.store.projectHref('chat', 'project-b'), '/?projectId=project-b')
})

test('工作区与部署入口只使用服务端能力，角色和缺失投影不能自行放权', () => {
  const host = { principal: { id: 'alice', role: 'admin' }, projects: [
    { id: 'project-a', membership: { workspaceAccess: 'internal', role: 'project_admin' } },
  ] }
  assert.equal(autoOpsAreaAvailable('workspaces', host, 'project-a'), false)
  assert.equal(autoOpsAreaAvailable('deployments', host, 'project-a'), false)
  const project = host.projects[0]
  for (const area of ['workspaces', 'deployments']) {
    const capability = area === 'workspaces' ? 'workspace.read' : 'deployment.read'
    assert.equal(autoOpsAreaAvailable(area, { ...host, projects: [{ ...project, capabilities: { [capability]: false } }] }, 'project-a'), false)
    assert.equal(autoOpsAreaAvailable(area, { ...host, projects: [{ ...project, capabilities: { [capability]: true } }] }, 'project-a'), true)
    assert.equal(autoOpsAreaAvailable(area, { ...host, projects: [{ ...project, capabilities: { [capability]: true } }] }, 'removed'), false)
  }
})

test('项目目录是已认证用户的全局模块，创建与设置仍由服务端独立授权', () => {
  assert.equal(autoOpsAreaAvailable('projects', { principal: { id: 'internal' }, projects: [] }), true)
  assert.equal(autoOpsAreaAvailable('projects', undefined), false)
  assert.equal(autoOpsAreaFromPath('/projects'), 'projects')
  assert.equal(normalizeAutoOpsChatHref('/projects'), null)
})
