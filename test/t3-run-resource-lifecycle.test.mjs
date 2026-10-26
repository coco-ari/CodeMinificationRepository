import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createAutoOpsAccess,
  initializeAutoOpsAccessSchema,
} from '../agent-demo/t3-adapters/access.mjs'
import { createRunResourceLifecycle } from '../agent-demo/t3-adapters/run-resource-lifecycle.ts'
import { createNativeSubagentBindings } from '../agent-demo/t3-adapters/subagents.mjs'
import { createEnvironmentMcp } from '../agent-demo/t3-adapters/environment-mcp/index.ts'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'
import { environmentRunScope } from '../agent-demo/t3-adapters/environment-run-inputs.ts'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 't3-run-resources-'))
  const sessions = new DatabaseSync(':memory:'),
    bindings = new DatabaseSync(join(directory, 't3-autoops.sqlite'))
  initializeAutoOpsAccessSchema(bindings)
  sessions.exec(
    'CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)',
  )
  sessions
    .prepare('INSERT INTO sessions VALUES(?,?,?,?)')
    .run(createHash('sha256').update('actual-caller').digest('hex'), 'actual-caller', 'csrf', 60000)
  const member = {
    userId: 'actual-caller',
    role: 'reader',
    workspaceAccess: 'internal',
    environmentIds: ['test'],
    status: 'active',
    canAdjustChat: true,
  }
  const access = createAutoOpsAccess({
    sessionDb: sessions,
    bindingDb: bindings,
    now: () => 1000,
    catalog: {
      users: [{ id: 'actual-caller', name: '调用者', role: 'member' }],
      projects: [
        {
          id: 'project',
          name: '项目',
          documents: [],
          resources: [],
          environments: [{ id: 'test', name: '测试' }],
          memberIds: ['actual-caller'],
          memberships: [member],
        },
      ],
      agents: [{ id: 'a-project', name: '助手', projectIds: ['project'] }],
    },
  })
  const actor = access.authenticateCookie('demo_session=actual-caller')
  access.bindThread(actor, {
    threadId: 'thread',
    projectId: 'project',
    environmentId: 'test',
    agentId: 'a-project',
    workspaceType: 'internal',
    visibility: 'project',
  })
  access.bindRunInput('thread', 'run', 'input', 'actual-caller', 'actual-caller')
  t.after(() => {
    sessions.close()
    bindings.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { access, bindings, member, directory }
}

test('可信终态释放读取原持久调用者，成员撤回不继承管理员身份或阻止已结束引用清理', (t) => {
  const f = fixture(t),
    scopes = []
  const coordinator = createRunResourceLifecycle(f.access, {
    releaseRun(scope) {
      scopes.push(scope)
      return { status: 'released' }
    },
  })
  const [reference] = coordinator.references('thread', 'run')
  assert.deepEqual(coordinator.references('other-thread', 'run'), [])
  assert.deepEqual(coordinator.references('thread', 'other-run'), [])
  f.member.status = 'disabled'
  assert.throws(() => f.access.requireToolThread('thread', 'actual-caller'))
  assert.deepEqual(coordinator.releaseAfterNativeTerminal(reference), { released: true })
  assert.deepEqual(scopes, [
    {
      actorId: 'actual-caller',
      projectId: 'project',
      environmentId: 'test',
      threadId: 'thread',
      runId: 'run',
    },
  ])
  assert.equal(f.access.getRunInput('thread', 'run').inputId, 'input')
})

test('未核验身份或核验后持久身份变化时不释放，原任务未取得MCP输入不临时造目录', (t) => {
  const f = fixture(t),
    scopes = []
  const coordinator = createRunResourceLifecycle(f.access, {
    releaseRun(scope) {
      scopes.push(scope)
      throw Object.assign(new Error('缺少原环境输入'), { code: 'ENVIRONMENT_MCP_RUN_MISSING' })
    },
  })
  const [reference] = coordinator.references('thread', 'run')
  f.bindings.prepare('UPDATE t3_thread_inputs SET actor_verified=0').run()
  assert.throws(() => coordinator.releaseAfterNativeTerminal(reference), {
    code: 'RUN_RESOURCE_IDENTITY_CHANGED',
  })
  f.bindings.prepare('UPDATE t3_thread_inputs SET actor_verified=1,actor_id=?').run('other')
  assert.throws(() => coordinator.releaseAfterNativeTerminal(reference), {
    code: 'RUN_RESOURCE_IDENTITY_CHANGED',
  })
  assert.deepEqual(scopes, [])
  f.bindings.prepare('UPDATE t3_thread_inputs SET actor_id=?').run('actual-caller')
  assert.deepEqual(coordinator.releaseAfterNativeTerminal(reference), { released: false })
  assert.equal(scopes.length, 1)
})

test('真实子任务登记仍引用原父轮时保留MCP输入，深层工具读原件且不阻止无关后来轮次释放', async (t) => {
  const f = fixture(t)
  const native = createNativeSubagentBindings(f.directory, f.access)
  const credentials = createProjectCredentialService({
    databasePath: join(f.directory, 'credentials.sqlite'),
    keyPath: join(f.directory, 'credentials.key'),
    initializeKeyIfNew: true,
    authorize: (actor, project, action) => f.access.requireCredentialActor(actor, project, action),
  })
  const mcp = createEnvironmentMcp({
    dataDir: f.directory,
    credentials,
    authorizeManage: (actor, project, environment) => {
      const member = f.access.requireProjectActionForActor(actor, project, 'project.manage')
      assert.ok(member.environmentIds.includes(environment))
    },
    authorizeQuery: (actor, project, environment) =>
      f.access.requireEnvironmentQueryForActor(actor, project, environment),
    // 只读驱动端口受控；此回归验证实际所有者与子任务调用链，不作为远端业务验收。
    drivers: {
      redis: {
        test: async () => ({ actions: ['redis.read'] }),
        execute: async (configuration, operation, credential) => {
          assert.equal(configuration.database, 0)
          assert.equal(operation.key, 'test:original')
          assert.equal(credential, undefined)
          return { data: { value: '原轮只读结果' }, truncated: false }
        },
        close() {},
      },
    },
  })
  try {
    f.member.role = 'project_admin'
    const connection = mcp.save(
      'project',
      'test',
      {
        requestId: 'save-connection',
        expectedRevision: 0,
        value: {
          type: 'redis',
          name: '原轮连接',
          host: 'fixture.invalid',
          port: 6379,
          database: 0,
          tls: 'disabled',
          keyPatterns: ['test:*'],
        },
      },
      'actual-caller',
    )
    await mcp.testConnection(
      'project',
      'test',
      connection.id,
      { requestId: 'test-connection', expectedRevision: connection.revision },
      'actual-caller',
    )
    mcp.setEnabled(
      'project',
      'test',
      connection.id,
      { requestId: 'enable-connection', expectedRevision: connection.revision, enabled: true },
      'actual-caller',
    )
    f.member.role = 'reader'
    const coordinator = createRunResourceLifecycle(f.access, mcp)
    const scope = environmentRunScope(f.access, 'thread', 'run')
    mcp.prepareRun(scope)
    native.register('thread', 'child', 'native-child', 'run')
    native.register('child', 'grandchild', 'native-grandchild', 'run')
    const [reference] = coordinator.references('thread', 'run')
    // 子任务的原生终态尚未有可信投影，父轮终态不能代替它们完成。
    assert.deepEqual(coordinator.releaseAfterNativeTerminal(reference), { released: false })
    for (const threadId of ['child', 'grandchild']) {
      const childScope = environmentRunScope(f.access, threadId, 'run')
      assert.deepEqual(childScope, scope)
      assert.equal(f.access.requireRunInput(threadId, 'input', 'run').actorId, 'actual-caller')
      assert.equal(mcp.readRun(childScope).status, 'active')
      assert.deepEqual(
        (
          await mcp.invoke(childScope, {
            connectionId: connection.id,
            action: 'redis.read',
            key: 'test:original',
          })
        ).data,
        { value: '原轮只读结果' },
      )
    }
    // 原登记事件重放不移除引用，也不能把原输入换成父会话的后来轮次。
    native.register('thread', 'child', 'native-child', 'run')
    f.access.bindRunInput('thread', 'later-run', 'later-input', 'actual-caller', 'actual-caller')
    const laterScope = environmentRunScope(f.access, 'thread', 'later-run')
    mcp.prepareRun(laterScope)
    assert.deepEqual(
      coordinator.releaseAfterNativeTerminal(coordinator.references('thread', 'later-run')[0]),
      { released: true },
    )
    assert.equal(mcp.readRun(laterScope).status, 'released')
    await assert.rejects(
      mcp.invoke(laterScope, {
        connectionId: connection.id,
        action: 'redis.read',
        key: 'test:original',
      }),
      { code: 'ENVIRONMENT_MCP_RUN_RELEASED' },
    )
    assert.equal(mcp.readRun(environmentRunScope(f.access, 'grandchild', 'run')).status, 'active')
    const original=mcp.readRun(scope)
    assert.deepEqual(coordinator.releaseAfterNativeTreeTerminal(reference),{released:true})
    assert.equal(mcp.readRun(scope).status,'released')
    f.member.role='project_admin'
    const changed=mcp.save('project','test',{requestId:'change-after-child-terminal',expectedRevision:mcp.list('project','test','actual-caller')[0].revision,value:{type:'redis',name:'下一轮连接',host:'other-fixture.invalid',port:6380,database:1,tls:'disabled',keyPatterns:['test:*']}},'actual-caller',connection.id)
    await mcp.testConnection('project','test',connection.id,{requestId:'test-next-configuration',expectedRevision:changed.revision},'actual-caller')
    mcp.setEnabled('project','test',connection.id,{requestId:'enable-next-configuration',expectedRevision:changed.revision,enabled:true},'actual-caller')
    f.member.role='reader'
    f.access.recordNativeInputTurn('grandchild','new-native-child-turn')
    const restored=mcp.retainRunAfterNativeReference(environmentRunScope(f.access,'grandchild','run'))
    assert.deepEqual(restored.connections,original.connections)
    assert.equal(restored.status,'active')
    // 驱动仍断言旧 database=0；不能因当前连接改为 database=1 而更换执行位置。
    assert.deepEqual((await mcp.invoke(scope,{connectionId:connection.id,action:'redis.read',key:'test:original'})).data,{value:'原轮只读结果'})
    assert.throws(()=>mcp.retainRunAfterNativeReference({...scope,environmentId:'other'}),{status:403})
    f.member.status='disabled'
    assert.throws(()=>mcp.retainRunAfterNativeReference(scope),{status:404,code:'PROJECT_NOT_FOUND'})
    f.member.status='active';f.member.role='project_admin'
    mcp.setEnabled('project','test',connection.id,{requestId:'disable-restored-original',expectedRevision:mcp.list('project','test','actual-caller')[0].revision,enabled:false},'actual-caller')
    f.member.role='reader'
    await assert.rejects(mcp.invoke(scope,{connectionId:connection.id,action:'redis.read',key:'test:original'}),{code:'ENVIRONMENT_MCP_DISABLED'})
  } finally {
    await mcp.close()
    credentials.close()
    native.close()
  }
})

test('读取子任务持久引用失败时保留原输入，不将未知状态当作没有引用', (t) => {
  const f = fixture(t),
    released = []
  const coordinator = createRunResourceLifecycle(f.access, {
    releaseRun: (scope) => released.push(scope),
  })
  const [reference] = coordinator.references('thread', 'run')
  f.bindings.exec('DROP TABLE t3_native_subagent_bindings')
  assert.throws(() => coordinator.releaseAfterNativeTerminal(reference), /no such table/u)
  assert.deepEqual(released, [])
})
