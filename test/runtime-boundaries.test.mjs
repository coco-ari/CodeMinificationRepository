import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { assertRuntimeCoverage, runtimeRoots } from '../scripts/check-runtime-boundaries.mjs'

const script = fileURLToPath(new URL('../scripts/check-runtime-boundaries.mjs', import.meta.url))
const web = 'vendor/t3code/apps/web/src/autoops'
const server = 'vendor/t3code/apps/server/src/autoops'

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoops-runtime-boundaries-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const write = async (file, content) => {
    const target = path.join(directory, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  for (const root of runtimeRoots)
    await write(`${root}/index.ts`, 'export type Identity = string\n')
  const run = () => {
    const process = spawnSync(globalThis.process.execPath, [script, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { ...process, result: process.stdout?.trim() ? JSON.parse(process.stdout) : undefined }
  }
  return { directory, write, run }
}

test('运行门禁真实解析新增嵌套模块、类型导入和 T3 路径别名', async (t) => {
  const f = await fixture(t)
  await f.write(`${web}/deployment/contract.ts`, 'export type Release = string\n')
  await f.write(`${web}/deployment/index.ts`, "export type { Release } from './contract.ts'\n")
  await f.write(
    `${web}/DeploymentsPanel.tsx`,
    "import type { Release } from '~/autoops/deployment/index'; export type Selection = Release\n",
  )
  await f.write(
    'agent-demo/t3-adapters/new-module/nested/service.mjs',
    'export const ready = true\n',
  )
  const result = f.run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.result.sourceFiles, runtimeRoots.length + 4)
  assert.deepEqual(result.result.violations, [])
})

test('运行账号与共享身份只能使用公开入口，不能穿透存储及密码内部文件', async (t) => {
  const f = await fixture(t)
  await f.write('agent-demo/t3-adapters/accounts/schema.ts', 'export const schema = true\n')
  await f.write('autoops/server/modules/identity/secrets.ts', 'export const secret = true\n')
  await f.write(
    'agent-demo/t3-adapters/invalid.ts',
    "import {schema} from './accounts/schema.ts'; import {secret} from '../../autoops/server/modules/identity/secrets.ts'; export const invalid = [schema,secret]\n",
  )
  const rejected = f.run()
  assert.equal(rejected.status, 1, rejected.stderr)
  assert.ok(
    rejected.result.violations.some((row) => row.rule.name === '账号存储只通过公开入口被调用'),
  )
  assert.ok(
    rejected.result.violations.some((row) => row.rule.name === '共享身份能力只通过公开入口被调用'),
  )
  await f.write('agent-demo/t3-adapters/accounts/index.ts', "export {schema} from './schema.ts'\n")
  await f.write('autoops/server/modules/identity/index.ts', "export {secret} from './secrets.ts'\n")
  await f.write(
    'agent-demo/t3-adapters/invalid.ts',
    "import {schema} from './accounts/index.ts'; import {secret} from '../../autoops/server/modules/identity/index.ts'; export const valid = [schema,secret]\n",
  )
  assert.equal(f.run().status, 0)
})

test('部署模块深层类型导入、别名和动态导入不能绕过公开入口', async (t) => {
  const f = await fixture(t)
  await f.write(
    `${web}/deployment/private.ts`,
    'export type Release = string; export const read = () => true\n',
  )
  await f.write(
    `${web}/DeploymentsPanel.tsx`,
    "import type { Release } from '~/autoops/deployment/private'; export type Selection = Release; export const load = () => import('./deployment/private.ts')\n",
  )
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  assert.ok(
    result.result.violations.some((row) => row.rule.name === '部署展示只通过公开入口被调用'),
  )
})

test('运行门禁拒绝跨前后端及业务层反向依赖', async (t) => {
  const f = await fixture(t)
  await f.write(
    `${web}/identity.ts`,
    "import type { Identity } from '../../../server/src/autoops/index.ts'; import fs from 'node:fs'; export type Name = Identity; export const read = fs.readFileSync\n",
  )
  await f.write(
    'agent-demo/t3-adapters/business.mjs',
    "import '../../vendor/t3code/apps/server/src/autoops/index.ts'\n",
  )
  await f.write('src/reverse.ts', "import '../agent-demo/t3-adapters/business.mjs'\n")
  await f.write(`${server}/reverse.ts`, "import '../../../web/src/autoops/index.ts'\n")
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  const rules = new Set(result.result.violations.map((row) => row.rule.name))
  for (const name of [
    '前端不能导入服务端实现',
    '前端不能使用Node运行能力',
    '业务服务不能反向依赖T3入口',
    '后端不能导入前端组件',
    '执行引擎不能反向依赖工作台',
  ])
    assert.ok(rules.has(name), `${name}\n${result.stdout}`)
})

test('共享请求层及部署内部组件不反向依赖页面', async (t) => {
  const f = await fixture(t)
  await f.write(`${web}/DeploymentsPage.tsx`, 'export const page = true\n')
  await f.write(`${web}/deployment/index.ts`, "export { page } from '../DeploymentsPage.tsx'\n")
  await f.write(`${web}/apiClient.ts`, "export { page } from './DeploymentsPage.tsx'\n")
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  const rules = result.result.violations.map((row) => row.rule.name)
  assert.ok(rules.includes('部署展示不能反向依赖页面'))
  assert.ok(rules.includes('共享请求边界不能依赖业务界面'))
})

test('客户执行不能带入平台业务，循环及缺失依赖直接失败', async (t) => {
  const f = await fixture(t)
  await f.write('agent-demo/t3-adapters/a.mjs', "export { b } from './b.mjs'; export const a = 1\n")
  await f.write('agent-demo/t3-adapters/b.mjs', "export { a } from './a.mjs'; export const b = 2\n")
  await f.write(
    'agent-demo/customer-agent/unsafe.ts',
    "import '../t3-adapters/a.mjs'; import './missing.ts'\n",
  )
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  const rules = result.result.violations.map((row) => row.rule.name)
  assert.ok(rules.includes('客户执行不能引入平台存储及业务'))
  assert.ok(rules.includes('运行模块禁止循环依赖'))
  assert.ok(rules.includes('运行模块禁止未解析依赖'))
})

test('共享合同保持前后端可用，不能反向引用身份服务或Node能力', async (t) => {
  const f = await fixture(t)
  await f.write('autoops/contracts/runtime.ts', 'export type Device = { id: string }\n')
  await f.write(
    `${web}/client.ts`,
    "import type { Device } from '../../../../../../autoops/contracts/runtime.ts'; export type Response = Device\n",
  )
  assert.equal(f.run().status, 0)
  await f.write(
    'autoops/contracts/runtime.ts',
    "import fs from 'node:fs'; import '../../agent-demo/index.ts'; export type Device = typeof fs\n",
  )
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  const rules = result.result.violations.map((row) => row.rule.name)
  assert.ok(rules.includes('公共合同不能反向依赖运行实现'))
  assert.ok(rules.includes('公共合同不能使用Node运行能力'))
})

test('HTTP子模块通过入口装配，直接穿透及反向依赖都会失败', async (t) => {
  const f = await fixture(t)
  await f.write(server + '/http/context.ts', 'export type Context = string\n')
  await f.write(
    server + '/http/skills.ts',
    "import type { Context } from './context.ts'; export type Input = Context\n",
  )
  await f.write(server + '/http.ts', "export type { Input } from './http/skills.ts'\n")
  await f.write(server + '/rpc.ts', "export type { Input } from './http.ts'\n")
  assert.equal(f.run().status, 0)
  await f.write(server + '/rpc.ts', "export type { Input } from './http/skills.ts'\n")
  await f.write(server + '/http/skills.ts', "export type { Input } from '../rpc.ts'\n")
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  const rules = result.result.violations.map((row) => row.rule.name)
  assert.ok(rules.includes('HTTP内部模块只由公开入口装配'))
  assert.ok(rules.includes('HTTP内部模块不能反向依赖入口'))
})

test('目录没有源码、解析漏扫或停止遍历源码时不能报通过', async (t) => {
  const f = await fixture(t)
  await rm(path.join(f.directory, 'agent/index.ts'))
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /没有找到源文件：agent/)
  assert.throws(() => assertRuntimeCoverage(['agent/entry.mjs'], []), /漏扫文件/)
  assert.throws(
    () =>
      assertRuntimeCoverage(
        ['agent/entry.mjs'],
        [{ source: 'agent/entry.mjs', matchesDoNotFollow: true }],
      ),
    /漏扫文件/,
  )
})

test('工作区公开服务允许跨模块协作，内部实现不能被穿透', async (t) => {
  const f = await fixture(t)
  await f.write('agent-demo/t3-adapters/workspace-files.mjs', 'export const read = () => true\n')
  await f.write(
    'agent-demo/t3-adapters/workspaces.mjs',
    "export { read } from './workspace-files.mjs'\n",
  )
  await f.write(
    'agent-demo/t3-adapters/deployments.mjs',
    "export { read } from './workspaces.mjs'\n",
  )
  assert.equal(f.run().status, 0)
  await f.write(
    'agent-demo/t3-adapters/deployments.mjs',
    "export const load = () => import('./workspace-files.mjs')\n",
  )
  const result = f.run()
  assert.equal(result.status, 1)
  assert.ok(
    result.result.violations.some((row) => row.rule.name === '工作区内部只能由工作区服务调用'),
  )
})

test('部署存储内部通过引擎公开入口，跨模块穿透被拒绝', async (t) => {
  const f = await fixture(t)
  await f.write('src/deployment-projects.mjs', 'export const create = () => true\n')
  await f.write('src/deployment.mjs', "export { create } from './deployment-projects.mjs'\n")
  await f.write(
    'agent-demo/t3-adapters/deployments.mjs',
    "export { create } from '../../src/deployment.mjs'\n",
  )
  assert.equal(f.run().status, 0)
  await f.write(
    'agent-demo/t3-adapters/deployments.mjs',
    "export { create } from '../../src/deployment-projects.mjs'\n",
  )
  const result = f.run()
  assert.equal(result.status, 1)
  assert.ok(
    result.result.violations.some((row) => row.rule.name === '部署项目存储只由部署引擎调用'),
  )
})

test('页面内部控制器可由所有者组合，其他页面的别名导入被拒绝', async (t) => {
  const f = await fixture(t)
  await f.write(web + '/WorkspaceFileBrowser.tsx', 'export type Browser = string\n')
  await f.write(web + '/useSkillLibraryCatalog.ts', 'export type Catalog = string\n')
  await f.write(
    web + '/WorkspacesPage.tsx',
    "export type { Browser } from './WorkspaceFileBrowser'\n",
  )
  await f.write(
    web + '/SkillLibraryPage.tsx',
    "export type { Catalog } from './useSkillLibraryCatalog'\n",
  )
  assert.equal(f.run().status, 0)
  await f.write(
    web + '/DeploymentsPage.tsx',
    "export type { Browser } from '~/autoops/WorkspaceFileBrowser'; export type { Catalog } from './useSkillLibraryCatalog'\n",
  )
  const result = f.run()
  assert.equal(result.status, 1)
  const rules = result.result.violations.map((row) => row.rule.name)
  assert.ok(rules.includes('工作区文件浏览内部只由工作区页面调用'))
  assert.ok(rules.includes('技能目录控制器只由技能目录页面调用'))
})

test('请求层依赖纯宿主快照，会话客户端使用请求层而不能反向', async (t) => {
  const f = await fixture(t)
  await f.write(web + '/hostSnapshot.ts', 'export const host = {}\n')
  await f.write(web + '/apiClient.ts', "export { host } from './hostSnapshot'\n")
  await f.write(web + '/threadScopes.ts', "export { host } from './apiClient'\n")
  assert.equal(f.run().status, 0)
  await f.write(web + '/hostSnapshot.ts', "export { host } from './threadScopes'\n")
  const result = f.run()
  assert.equal(result.status, 1)
  assert.ok(
    result.result.violations.some(
      (row) => row.rule.name === '宿主快照不能反向依赖会话或业务客户端',
    ),
  )
})

test('业务复用授权门面，不能直接穿透身份存储与项目授权内部', async (t) => {
  const f = await fixture(t)
  await f.write(
    'agent-demo/t3-adapters/access-identity.mjs',
    'export const authorize = () => true\n',
  )
  await f.write('agent-demo/t3-adapters/project-access.mjs', 'export const check = () => true\n')
  await f.write(
    'agent-demo/t3-adapters/access-service.mjs',
    "import './project-access.mjs'; export { authorize } from './access-identity.mjs'\n",
  )
  await f.write(
    'agent-demo/t3-adapters/access.mjs',
    "export { authorize } from './access-service.mjs'\n",
  )
  await f.write('agent-demo/t3-adapters/skills.mjs', "export { authorize } from './access.mjs'\n")
  assert.equal(f.run().status, 0)
  await f.write(
    'agent-demo/t3-adapters/skills.mjs',
    "export { authorize } from './access-identity.mjs'\n",
  )
  const result = f.run()
  assert.equal(result.status, 1)
  assert.ok(
    result.result.violations.some((row) => row.rule.name === '身份授权内部只能由授权门面装配'),
  )
})

test('工作区内部共享阅读偏好，其他模块不能读取内部状态', async (t) => {
  const f = await fixture(t)
  await f.write(web + '/workspaceViewState.ts', 'export const read = () => true\n')
  await f.write(web + '/WorkspaceFileBrowser.tsx', "export { read } from './workspaceViewState'\n")
  await f.write(
    web + '/WorkspacesPage.tsx',
    "import './WorkspaceFileBrowser'; export { read } from './workspaceViewState'\n",
  )
  assert.equal(f.run().status, 0)
  await f.write(web + '/SkillLibraryPage.tsx', "export { read } from './workspaceViewState'\n")
  const result = f.run()
  assert.equal(result.status, 1)
  assert.ok(
    result.result.violations.some((row) => row.rule.name === '工作区阅读偏好只由工作区模块使用'),
  )
})

test('客户程序允许纯合同，但不能穿透独立后端的公开服务', async (t) => {
  const f = await fixture(t)
  await f.write('autoops/contracts/device.ts', 'export type Device = string\n')
  await f.write('autoops/server/modules/identity/index.ts', 'export const session = () => true\n')
  await f.write(
    'agent-demo/customer-agent/client.ts',
    "export type { Device } from '../../autoops/contracts/device.ts'\n",
  )
  assert.equal(f.run().status, 0)
  await f.write(
    'agent-demo/customer-agent/client.ts',
    "export { session } from '../../autoops/server/modules/identity/index.ts'\n",
  )
  const result = f.run()
  assert.equal(result.status, 1)
  assert.ok(
    result.result.violations.some((row) => row.rule.name === '客户执行不能引入平台存储及业务'),
  )
})

test('当前资料公开入口允许协作，外部调用方不能穿透事务存储', async (t) => {
  const f = await fixture(t)
  const base = 'agent-demo/t3-adapters/'
  await f.write(base + 'workspace-authoring/storage.ts', 'export const state = () => true\n')
  await f.write(base + 'workspace-authoring/index.ts', "export { state } from './storage.ts'\n")
  await f.write(
    base + 'workspace-management.ts',
    "export { state } from './workspace-authoring/index.ts'\n",
  )
  assert.equal(f.run().status, 0)
  await f.write(
    base + 'workspace-management.ts',
    "export { state } from './workspace-authoring/storage.ts'\n",
  )
  const result = f.run()
  assert.equal(result.status, 1)
  assert.ok(
    result.result.violations.some((row) => row.rule.name === '当前资料存储只通过公开入口被调用'),
  )
})

test('定期资料更新从公开入口装配，HTTP 不能直接改写计划存储', async (t) => {
  const f = await fixture(t)
  await f.write(
    'agent-demo/t3-adapters/workspace-updates/storage.ts',
    'export const save = () => true\n',
  )
  await f.write(
    'agent-demo/t3-adapters/workspace-updates/index.ts',
    "export { save } from './storage.ts'\n",
  )
  await f.write(
    'agent-demo/t3-adapters/workspace-update-runtime.ts',
    "import { save } from './workspace-updates/index.ts'; export const start = save\n",
  )
  let result = f.run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  await f.write(
    `${server}/workspaceUpdateHttp.ts`,
    "import { save } from '../../../../../../agent-demo/t3-adapters/workspace-updates/storage.ts'; export const update = save\n",
  )
  result = f.run()
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.ok(
    result.result.violations.some(
      (row) => row.rule.name === '定期资料更新存储只通过公开入口被调用',
    ),
  )
})
