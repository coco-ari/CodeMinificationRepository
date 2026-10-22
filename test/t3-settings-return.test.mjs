import assert from 'node:assert/strict'
import test from 'node:test'
import {
  captureAutoOpsMainLocation,
  resolveAutoOpsSettingsReturnHref,
} from '../vendor/t3code/apps/web/src/components/sidebar/mainAppLocation.logic.ts'
import { createAutoOpsProjectNavigation } from '../vendor/t3code/apps/web/src/autoops/projectNavigation.logic.ts'

function fixture() {
  const projects = [
    { id: 'a', agents: [{ id: 'agent-a' }], membership: { workspaceAccess: 'internal', role: 'manager' } },
    { id: 'b', agents: [{ id: 'agent-b' }], membership: { workspaceAccess: 'internal', role: 'manager' } },
    { id: 'member', membership: { workspaceAccess: 'internal', role: 'member' } },
    { id: 'external', membership: { workspaceAccess: 'external', role: 'manager' } },
  ]
  const chatOwners = new Map([['/env/thread-a', 'a'], ['/draft/draft-b', 'b']])
  const navigation = createAutoOpsProjectNavigation({
    readHost: () => ({ principal: { id: 'user' }, projects }),
    readStorage: () => undefined,
    readRouteSearch: () => ({}),
    ownsChatHref: (projectId, href) => chatOwners.get(href) === projectId,
  })
  navigation.rememberChatLocation('a', '/env/thread-a')
  navigation.rememberChatLocation('b', '/draft/draft-b')
  const resolve = (href, previousProjectId, projectId, overrides = {}) => resolveAutoOpsSettingsReturnHref({
    location: captureAutoOpsMainLocation(href, previousProjectId, projects),
    projectId, projects, projectHref: navigation.projectHref,
    chatProjectId: (href) => chatOwners.get(href.split('?')[0]) ?? '',
    ...overrides,
  })
  return { projects, chatOwners, navigation, resolve }
}

test('设置返回识别真实模块，同项目保留完整工作区、部署与会话位置', () => {
  const f = fixture()
  for (const [href, area] of [
    ['/workspaces?projectId=a&versionId=version-1', 'workspaces'],
    ['/deployments?projectId=a&sourceVersionId=version-1', 'deployments'],
    ['/skills?projectId=a&skillView=agent&agentId=agent-a', 'skills'],
    ['/env/thread-a?view=files', 'chat'],
  ]) {
    assert.equal(captureAutoOpsMainLocation(href, 'a', f.projects)?.area, area)
    assert.equal(f.resolve(href, 'a', 'a'), href)
  }
})

test('技能设置返回保留当前视图，切项目只携带仍授权的全局助手', () => {
  const f = fixture()
  const href = '/skills?projectId=a&skillView=agent&agentId=agent-a&skillId=old&versionId=v1'
  assert.equal(f.resolve(href, 'a', 'b'), '/skills?projectId=b&skillView=agent&agentId=agent-a')
  assert.equal(f.resolve('/skills?projectId=a&skillView=project&skillId=old', 'a', 'b'), '/skills?projectId=b&skillView=project')
  assert.equal(f.resolve('/skills?projectId=a&skillView=library', 'a', 'member'), '/skills?projectId=member&skillView=library')
  assert.equal(f.resolve('/skills?projectId=a&skillView=library', 'a', 'external'), '/skills?projectId=external&skillView=library')
  assert.equal(f.resolve('/skills?projectId=a&skillView=unknown&agentId=agent-a', 'a', 'b'), '/skills?projectId=b')
  const snapshot = captureAutoOpsMainLocation(href, 'a', f.projects)
  f.projects.splice(0, 1)
  assert.equal(f.resolve('/settings/general', 'a', 'b', { location: snapshot }), '/skills?projectId=b&skillView=agent')
  assert.equal(f.resolve('/settings/general', 'a', 'removed', { location: snapshot }), '/')
})

test('设置内换项目后返回原模块下新项目恢复位置，不拼接旧会话的项目查询', () => {
  const f = fixture()
  assert.equal(f.resolve('/workspaces?projectId=a&versionId=old', 'a', 'b'), '/workspaces?projectId=b')
  assert.equal(f.resolve('/deployments?projectId=a&sourceVersionId=old', 'a', 'b'), '/deployments?projectId=b')
  assert.equal(f.resolve('/env/thread-a?view=files', 'a', 'b'), '/draft/draft-b')
  assert.equal(f.resolve('/env/thread-a', 'a', 'member'), '/?projectId=member')
})

test('部署权限按返回时项目检查，成员与外部项目返回工作区', () => {
  const f = fixture()
  assert.equal(f.resolve('/deployments?projectId=a', 'a', 'member'), '/workspaces?projectId=member')
  assert.equal(f.resolve('/deployments?projectId=a', 'a', 'external'), '/workspaces?projectId=external')
  f.projects[0].membership.role = 'member'
  assert.equal(f.resolve('/deployments?projectId=a', 'a', 'a'), '/workspaces?projectId=a')
  assert.equal(f.resolve('/workspaces?projectId=a', 'a', 'removed-project'), '/')
})

test('拒绝外部地址、控制页、错误项目查询和篡改的区域元数据', () => {
  const f = fixture()
  for (const href of [
    'https://evil.test/workspaces?projectId=a', '//evil.test/thread', '/settings/general',
    '/api/delete', '/workspaces?projectId=b', '/workspaces?projectId=a&projectId=a',
    '/skills?projectId=b', '/skills?projectId=a&projectId=a', '/skills/skill-a',
    '/env/%2fthread', '/env/thread-a\n',
  ]) {
    assert.equal(captureAutoOpsMainLocation(href, 'a', f.projects), null, href)
    assert.equal(f.resolve(href, 'a', 'b'), '/draft/draft-b', href)
  }
  assert.equal(f.resolve('/env/thread-a', 'a', 'b', {
    location: { projectId: 'a', area: 'deployments', href: '/env/thread-a' },
  }), '/draft/draft-b')
})

test('原会话删除、归属变化或尚未加载时回合法项目入口，不恢复无效资源', () => {
  const f = fixture()
  f.chatOwners.delete('/env/thread-a')
  assert.equal(f.resolve('/env/thread-a', 'a', 'a'), '/?projectId=a')
  f.chatOwners.set('/env/thread-a', 'b')
  assert.equal(f.resolve('/env/thread-a', 'a', 'a'), '/?projectId=a')
  f.chatOwners.set('/env/thread-a', 'a')
  assert.equal(f.resolve('/env/thread-a', 'a', 'a'), '/env/thread-a')
})

test('直接进入设置或原项目已撤权时，仍只返回当前授权项目', () => {
  const f = fixture()
  assert.equal(f.resolve('/settings/general', 'a', 'b'), '/draft/draft-b')
  const snapshot = captureAutoOpsMainLocation('/deployments?projectId=a', 'a', f.projects)
  f.projects.splice(0, 1)
  assert.equal(f.resolve('/settings/general', 'a', 'b', { location: snapshot }), '/deployments?projectId=b')
})
