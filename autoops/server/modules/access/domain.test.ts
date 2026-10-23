import { test } from 'node:test'
import assert from 'node:assert/strict'
import { permitted } from './domain.ts'
import type { Action, Grant, Resource, User } from '../../../contracts/index.ts'

const member: User = {
  id: 'member',
  username: 'member',
  name: '开发成员',
  kind: 'internal',
  platformAdmin: false,
  enabled: true,
}
const grant = (role: Grant['role'], environmentId: string | null): Grant => ({
  id: role + environmentId,
  userId: member.id,
  projectId: 'project',
  role,
  environmentId,
})
const grants = [grant('release_operator', 'test'), grant('reader', 'production')]
const cases: readonly { name: string; action: Action; resource: Resource; allowed: boolean }[] = [
  {
    name: '测试环境发布授权有效',
    action: 'deployment.execute',
    resource: { projectId: 'project', environmentId: 'test' },
    allowed: true,
  },
  {
    name: '不能拼接测试发布权与生产阅读权',
    action: 'deployment.execute',
    resource: { projectId: 'project', environmentId: 'production' },
    allowed: false,
  },
  {
    name: '生产环境仅阅读',
    action: 'environment.read',
    resource: { projectId: 'project', environmentId: 'production' },
    allowed: true,
  },
  {
    name: '新环境不自动获得权限',
    action: 'environment.read',
    resource: { projectId: 'project', environmentId: 'new' },
    allowed: false,
  },
  {
    name: '同名环境不能越过项目',
    action: 'deployment.execute',
    resource: { projectId: 'other', environmentId: 'test' },
    allowed: false,
  },
  {
    name: '项目阅读不代表成员管理',
    action: 'project.members.manage',
    resource: { projectId: 'project' },
    allowed: false,
  },
]
for (const item of cases)
  test(item.name, () =>
    assert.equal(permitted(member, item.action, item.resource, grants, true), item.allowed),
  )
test('全局管理员无他人私有内容与本机特权', () => {
  const admin = { ...member, platformAdmin: true }
  assert.equal(
    permitted(
      admin,
      'conversation.read',
      { projectId: 'project', ownerId: 'other', visibility: 'private' },
      [],
      false,
    ),
    false,
  )
  assert.equal(permitted(admin, 'device.execute', { ownerId: 'other' }, [], false), false)
  assert.equal(
    permitted(admin, 'project.members.manage', { projectId: 'project' }, [], false),
    true,
  )
})
test('外部范围及失效成员不因旧授权获得访问', () => {
  const external = { ...member, kind: 'external' as const }
  const own = [grant('external', null)]
  assert.equal(
    permitted(
      external,
      'workspace.read',
      { projectId: 'project', audience: 'internal' },
      own,
      true,
    ),
    false,
  )
  assert.equal(
    permitted(
      external,
      'workspace.read',
      { projectId: 'project', audience: 'external' },
      own,
      true,
    ),
    true,
  )
  assert.equal(
    permitted(
      external,
      'workspace.read',
      { projectId: 'project', audience: 'external' },
      own,
      false,
    ),
    false,
  )
  assert.equal(permitted(external, 'cabinet.operate', {}, [], false), false)
  assert.equal(permitted({ ...member, enabled: false }, 'project.create', {}, [], false), false)
})
