import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import test from 'node:test'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { handleDeploymentRequest } from '../agent-demo/t3-adapters/deployment-http.mjs'

function fixture(t) {
  const sessionDb = new DatabaseSync(':memory:')
  const bindingDb = new DatabaseSync(':memory:')
  t.after(() => { bindingDb.close(); sessionDb.close() })
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('isolated-session').digest('hex'), 'operator', 'csrf', Date.now() + 60_000)
  const membership = { userId: 'operator', workspaceAccess: 'internal', role: 'manager', environmentIds: ['test'], status: 'active' }
  const user = { id: 'operator', name: '隔离管理者', role: 'admin', status: 'active' }
  const project = { id: 'project', name: '隔离项目', memberIds: ['operator'], memberships: [membership], environments: [{ id: 'test', name: '同名环境' }, { id: 'production', name: '同名环境' }], documents: [], resources: [] }
  const access = createAutoOpsAccess({ sessionDb, bindingDb, catalog: { users: [user], projects: [project], agents: [] }, deploymentEnabled: () => true })
  const principal = access.authenticateCookie('demo_session=isolated-session')
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  let delayed, reads = 0
  const secret = { marker: '仅授权范围可见' }
  const read = async (operation) => {
    reads++
    if (delayed === operation) { entered.resolve(); await gate.promise }
    return secret
  }
  const store = {
    ensureProject: () => delayed === 'initialize' ? read('initialize') : Promise.resolve(),
    overview: () => secret,
    availableServers: () => [secret],
    taskScope: (_projectId, id) => ({ environmentId: id === 'production-task' ? 'production' : 'test' }),
    targetScope: (_projectId, id) => ({ environmentId: id === 'production-target' ? 'production' : 'test' }),
    taskDetails: () => read('logs'),
    repositoryRefs: () => read('refs'),
    repositoryHistory: () => read('history'),
    releaseSource: () => read('source'),
  }
  const request = (suffix) => handleDeploymentRequest({ access, store, principal, method: 'GET', url: new URL(`http://localhost/autoops/projects/project/deployments${suffix}`) })
  return { access, membership, user, sessionDb, secret, request, delay(operation) { delayed = operation }, entered: entered.promise, release: gate.resolve, reads: () => reads }
}

for (const [name, route, operation, revoke, code] of [
  ['概览等待初始化期间撤销环境', '?environmentId=test', 'initialize', f => { f.membership.environmentIds = [] }, 'ENVIRONMENT_FORBIDDEN'],
  ['概览等待初始化期间撤销成员', '', 'initialize', f => { f.membership.status = 'disabled' }, 'PROJECT_NOT_FOUND'],
  ['日志返回前撤销环境', '/tasks/test-task', 'logs', f => { f.membership.environmentIds = [] }, 'ENVIRONMENT_FORBIDDEN'],
  ['日志返回前撤销管理角色', '/tasks/test-task', 'logs', f => { f.membership.role = 'member' }, 'WORKSPACE_MANAGEMENT_FORBIDDEN'],
  ['Git 分支返回前停用账号', '/repositories/repo/refs', 'refs', f => { f.user.status = 'disabled' }, 'UNAUTHENTICATED'],
  ['Git 历史返回前注销会话', '/repositories/repo/history', 'history', f => { f.sessionDb.exec('DELETE FROM sessions') }, 'UNAUTHENTICATED'],
  ['源码下载返回前撤销环境', '/targets/test-target/releases/release/source', 'source', f => { f.membership.environmentIds = [] }, 'ENVIRONMENT_FORBIDDEN'],
  ['服务器列表初始化期间撤销环境', '/servers?environmentId=test', 'initialize', f => { f.membership.environmentIds = [] }, 'ENVIRONMENT_FORBIDDEN'],
]) {
  test(`部署异步读取：${name}后拒绝迟到内容`, async t => {
    const f = fixture(t)
    f.delay(operation)
    const pending = f.request(route)
    await f.entered
    revoke(f)
    const rejected = assert.rejects(pending, { code })
    f.release()
    await rejected
  })
}

test('部署日志以真实任务环境裁决，伪造查询范围不能读取同名生产环境', async t => {
  const f = fixture(t)
  await assert.rejects(f.request('/tasks/production-task?environmentId=test'), { code: 'ENVIRONMENT_FORBIDDEN' })
  await assert.rejects(f.request('/targets/production-target/releases/release/source?environmentId=test'), { code: 'ENVIRONMENT_FORBIDDEN' })
  assert.equal(f.reads(), 0)
})

test('部署日志读取被拒绝后可按原资源恢复，不触发写入或替换任务身份', async t => {
  const f = fixture(t)
  f.delay('logs')
  const pending = f.request('/tasks/test-task?after=7')
  await f.entered
  f.membership.environmentIds = []
  const rejected = assert.rejects(pending, { code: 'ENVIRONMENT_FORBIDDEN' })
  f.release()
  await rejected
  f.membership.environmentIds = ['test']
  assert.deepEqual((await f.request('/tasks/test-task?after=7')).body, f.secret)
  assert.equal(f.reads(), 2)
})

test('真实 HTTP 不发送撤权后的日志字节，恢复权限后原地址可以继续补读', async t => {
  const f = fixture(t)
  f.delay('logs')
  const server = createServer(async (req, res) => {
    try {
      f.access.authenticateCookie(req.headers.cookie)
      const result = await f.request(req.url)
      res.writeHead(result.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result.body))
    } catch (error) {
      res.writeHead(error.status || 500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: error.code }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const url = `http://127.0.0.1:${server.address().port}/tasks/test-task?after=7`
  const headers = { Cookie: 'demo_session=isolated-session' }
  const pending = fetch(url, { headers })
  await f.entered
  f.membership.environmentIds = []
  f.release()
  const denied = await pending
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), { code: 'ENVIRONMENT_FORBIDDEN' })
  f.membership.environmentIds = ['test']
  const restored = await fetch(url, { headers })
  assert.equal(restored.status, 200)
  assert.deepEqual(await restored.json(), f.secret)
})
