import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'autoops-empty-workspace-'))
  const store = createWorkspaceStore({ dataDir, authorizeTask() { assert.fail('初始化不能提交业务任务') } })
  t.after(async () => { await store.close(); rmSync(dataDir, {recursive:true,force:true}) })
  return {store,dataDir,project:{id:'fresh-project',name:'空业务项目',documents:[]}}
}

test('新业务项目首次访问保持空资料，不从项目名称或目录文档推断示例', async t => {
  const {store,project,dataDir} = await fixture(t)
  await store.ensureProject(project)
  assert.deepEqual(store.overview(project.id).internalVersions, [])
  assert.deepEqual(store.overview(project.id).externalVersions, [])
  assert.deepEqual(store.overview(project.id).releases, [])
  assert.deepEqual(store.overview(project.id).tasks, [])
  assert.deepEqual(readdirSync(join(dataDir,'project-workspaces',project.id)), ['state.json'])
  await store.ensureProject({id:'different-project',name:'验证项目',documents:[{id:'old-doc',name:'目录历史资料.md',content:'不应自动迁入当前工作区'}]})
  assert.deepEqual(store.overview('different-project').internalVersions, [])
})

test('并发空初始化不启动 Git 或其他子进程，不生成暂存和示例文件', async t => {
  const {store,project,dataDir} = await fixture(t)
  const spawn = t.mock.method(childProcess,'spawn',() => { assert.fail('空初始化不得启动 Git、远端访问或种子进程') })
  syncBuiltinESMExports()
  try {
    await Promise.all(Array.from({length:8},() => store.ensureProject(project)))
    assert.deepEqual(store.overview(project.id).internalVersions, [])
    assert.equal(spawn.mock.callCount(),0)
    assert.deepEqual(readdirSync(join(dataDir,'project-workspaces',project.id)), ['state.json'])
    const second = createWorkspaceStore({dataDir})
    try {
      const shared = {...project,id:'cross-store'}
      await Promise.all([store.ensureProject(shared),second.ensureProject(shared)])
      assert.deepEqual(second.overview(shared.id),store.overview(shared.id))
      assert.deepEqual(second.overview(shared.id).internalVersions,[])
      assert.deepEqual(readdirSync(join(dataDir,'project-workspaces',shared.id)), ['state.json'])
    } finally { await second.close() }
    assert.equal(spawn.mock.callCount(),0)
  } finally { spawn.mock.restore(); syncBuiltinESMExports() }
})

test('显式示例保留旧测试能力，已有示例和空状态均不被后续初始化覆盖', async t => {
  const {store,project,dataDir} = await fixture(t)
  await store.ensureProject(project,{initialContent:'example'})
  const version = store.overview(project.id).internalVersions[0]
  assert.equal(version.isExample,true)
  assert.equal(version.source.repositories.length,2)
  assert.match(store.read(project.id,version.id,'frontend/index.html').contents,/AutoOps/)
  const statePath = join(dataDir,'project-workspaces',project.id,'state.json'), original = readFileSync(statePath)
  await store.ensureProject({...project,name:'不应覆盖',documents:[{id:'new',name:'新稿.md',content:'不得写入存量'}]})
  assert.deepEqual(readFileSync(statePath),original)
  await store.ensureProject({id:'empty-existing',name:'已有空资料'})
  const emptyPath = join(dataDir,'project-workspaces','empty-existing','state.json'), empty = readFileSync(emptyPath)
  await store.ensureProject({id:'empty-existing',name:'不能后来灌入示例'},{initialContent:'example'})
  assert.deepEqual(readFileSync(emptyPath),empty)
})

test('初始化发布失败不留下有效半状态，恢复后可用原项目身份再次完成空初始化', async t => {
  const {store,project,dataDir} = await fixture(t)
  const statePath = join(dataDir,'project-workspaces',project.id,'state.json')
  const originalRename = fs.renameSync
  const rename = t.mock.method(fs,'renameSync',(source,target) => {
    if (target === statePath) throw Object.assign(new Error('隔离磁盘发布失败'),{code:'EIO'})
    return originalRename(source,target)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(store.ensureProject(project),/隔离磁盘发布失败/)
    assert.equal(existsSync(statePath),false)
    assert.deepEqual(readdirSync(join(dataDir,'project-workspaces',project.id)),[])
  } finally { rename.mock.restore(); syncBuiltinESMExports() }
  await store.ensureProject(project)
  assert.deepEqual(store.overview(project.id).internalVersions,[])
})
