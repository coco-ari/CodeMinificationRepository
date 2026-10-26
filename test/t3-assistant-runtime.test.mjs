import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 整个子进程只使用本测试创建的数据；不连接模型或服务器，不修改存量成员。
test('实际组合根将默认助手准入接到项目成员保存，权限变化后仍可核对原收据', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'assistant-runtime-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = new DatabaseSync(join(dataDir, 'demo.sqlite'))
  db.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)'); db.close()
  mkdirSync(join(dataDir, 't3'))
  writeFileSync(join(dataDir, 't3/models-catalog.json'), JSON.stringify({ version: 1, source: 'https://catalog.example/models', models: [{ id: 'runtime-model', name: '组合测试模型', reasoningLevels: ['high'], defaultReasoning: 'high', inputModalities: ['text'] }] }))
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { configuredAutoOpsAccess, configuredAutoOpsAssistantDirectory, configuredAutoOpsProjectDirectory } from './agent-demo/t3-adapters/access.mjs'
    import { createBusinessRuntime } from './agent-demo/t3-adapters/business-runtime.mjs'
    const runtime = createBusinessRuntime()
    try {
      await runtime.initialize()
      const access = configuredAutoOpsAccess(), projects = configuredAutoOpsProjectDirectory(), assistants = configuredAutoOpsAssistantDirectory()
      const lin = projects.settings('u-admin', 'p-autoops').members.find(member => member.userId === 'u-lin')
      assert.equal(lin.authorizationPending, true)
      const command = { requestId: 'isolated-member', expectedRevision: lin.revision, value: { userId: 'u-lin', role: 'reader', environmentIds: ['env-test'], environmentRoles: {}, canAdjustChat: false, status: 'active' } }
      assert.throws(() => projects.saveMember('u-admin', 'p-autoops', command), { code: 'PROJECT_DEFAULT_ASSISTANT_REQUIRED' })
      assert.equal(projects.settings('u-admin', 'p-autoops').members.find(member => member.userId === 'u-lin').authorizationPending, true)
      const value = { name: '隔离测试助手', description: '', instructions: '', enabled: true, configuration: { agentId: 'a-project', executionBinding: { kind: 'platform' }, environmentId: 'env-test', workspaceType: 'internal', visibility: 'private', model: { instanceId: 'codex', model: 'runtime-model', reasoningEffort: 'high' }, skillIds: [] } }
      const preset = assistants.save('u-admin', 'p-autoops', null, { requestId: 'isolated-preset', expectedRevision: 0, value })
      assistants.assign('u-admin', 'p-autoops', { requestId: 'isolated-allocation', expectedRevision: 0, target: { kind: 'member', id: 'u-lin' }, assistantIds: [preset.id], defaultAssistantId: preset.id })
      const saved = projects.saveMember('u-admin', 'p-autoops', command)
      assert.equal(saved.authorizationPending, false)
      assert.equal(access.requireProjectActionForActor('u-lin', 'p-autoops', 'chat.use').canAdjustChat, false)
      assert.throws(() => projects.saveMember('u-admin', 'p-autoops', { ...command, requestId: 'isolated-shrink', expectedRevision: saved.revision, value: { ...command.value, environmentIds: [] } }), { code: 'PROJECT_DEFAULT_ASSISTANT_REQUIRED' })
      assistants.save('u-admin', 'p-autoops', preset.id, { requestId: 'isolated-disable', expectedRevision: 1, value: { ...value, enabled: false } })
      assert.deepEqual(projects.saveMember('u-admin', 'p-autoops', command), saved)
      assert.equal(assistants.catalog('u-lin', 'p-autoops').ready, false)
      console.log(JSON.stringify({ preservedPending: true, guardedScopeChange: true, originalReceipt: true }))
    } finally { await runtime.close() }
  `], { cwd: process.cwd(), env: { PATH: process.env.PATH, DEMO_PASSWORD: 'isolated-assistant-password', AUTOOPS_T3_DATA_DIR: dataDir, AUTOOPS_T3_MODEL: 'runtime-model', AUTOOPS_DEPLOYMENT_ENABLED: '0' }, encoding: 'utf8', timeout: 30000 })
  assert.deepEqual(JSON.parse(output.trim()), { preservedPending: true, guardedScopeChange: true, originalReceipt: true })
})
