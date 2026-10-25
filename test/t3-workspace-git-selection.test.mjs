import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createWorkspaceGit } from '../agent-demo/t3-adapters/workspace-git.ts'
import { createWorkspaceManagement } from '../agent-demo/t3-adapters/workspace-management.ts'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'

const exec = promisify(execFile)
const source = { id: 'repo', name: '隔离仓库', role: 'backend', url: 'https://github.com/example/fixture.git', refKind: 'default', ref: '', mountPath: 'backend' }
const publicLookup = async () => [{ address: '140.82.114.4', family: 4 }]
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function root(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoops-git-selection-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('真实 Git 分支、附注标签和中文提交历史最多返回 100 条，临时查询不检出或遗留缓存', async t => {
  const directory = await root(t), repository = path.join(directory, 'repository')
  await mkdir(repository)
  const git = async (...args) => (await exec('git', ['-c', 'user.name=隔离测试', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout.trim()
  await git('init', '-b', 'main', repository)
  await writeFile(path.join(repository, 'README.md'), '查询不检出这个文件')
  await git('-C', repository, 'add', '.')
  await git('-C', repository, 'commit', '-m', '首次中文提交')
  const first = await git('-C', repository, 'rev-parse', 'HEAD')
  await git('-C', repository, 'tag', '-a', 'v1', '-m', '中文标签')
  for (let index = 1; index <= 101; index++) await git('-C', repository, 'commit', '--allow-empty', '-m', `中文提交 ${index}`)
  const latest = await git('-C', repository, 'rev-parse', 'HEAD')
  await git('-C', repository, 'branch', 'release/example')
  const paths = [], calls = []
  const adapter = createWorkspaceGit({ lookupHost: publicLookup, spawnGit(args, options) {
    calls.push([...args])
    const index = args.indexOf('-C'); if (index >= 0) paths.push(args[index + 1])
    // 测试只在进程端口把已通过来源策略的传输替成隔离仓库；生产不开放本地协议。
    const localArgs = [...args].map(value => value === source.url ? repository : value === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : value)
    return spawn('git', localArgs, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'https:file' } })
  } })
  const refs = await adapter.repositoryRefs(source)
  assert.equal(refs.defaultRef, 'main')
  assert.deepEqual(refs.branches.map(entry => entry.name), ['main', 'release/example'])
  assert.deepEqual(refs.tags, [{ name: 'v1', commit: first }])
  const history = await adapter.repositoryHistory(source)
  assert.equal(history.commit, latest); assert.equal(history.commits.length, 100); assert.equal(history.truncated, true)
  assert.equal(history.commits[0].subject, '中文提交 101')
  assert.match(history.commits[0].authoredAt, /^\d{4}-/)
  const tag = await adapter.repositoryHistory({ ...source, refKind: 'tag', ref: 'v1' })
  assert.equal(tag.commit, first); assert.equal(tag.commits[0].subject, '首次中文提交'); assert.equal(tag.truncated, false)
  assert.ok(paths.every(directory => !existsSync(directory)))
  assert.equal(calls.some(args => args.includes('checkout')), false)
})

test('Git 引用恶意输入、超时、撤权与远端错误都不暴露凭证', async t => {
  const directory = await root(t), script = path.join(directory, 'git.mjs')
  await writeFile(script, "process.stderr.write(process.env.CMR_GIT_PASSWORD); if (process.env.FIXTURE_FAIL) process.exit(1); else setInterval(() => {}, 1000)")
  let spawned = 0, closed = 0, fail = false
  const git = createWorkspaceGit({ lookupHost: publicLookup, resolveTimeoutMs: 100, fetchTimeoutMs: 1000, spawnGit(args, options) {
    spawned++
    const child = spawn(process.execPath, [script], { ...options, env: { ...options.env, FIXTURE_FAIL: fail ? 'yes' : '' } })
    child.on('close', () => closed++)
    return child
  } })
  const secret = { username: 'fixture', password: 'fixture-secret-do-not-return' }
  await assert.rejects(git.repositoryHistory({ ...source, refKind: 'branch', ref: '--upload-pack=evil' }, secret), error => error.code === 'WORKSPACE_REF_INVALID')
  assert.equal(spawned, 0)
  await assert.rejects(git.repositoryRefs(source, secret), error => error.code === 'WORKSPACE_GIT_TIMEOUT' && !error.message.includes(secret.password))
  let checks = 0
  await assert.rejects(git.repositoryHistory(source, secret, undefined, () => { if (++checks > 1) throw Object.assign(new Error('读取权限已撤回'), { status: 403 }) }), error => error.status === 403)
  fail = true
  await assert.rejects(git.repositoryRefs(source, secret), error => error.code === 'WORKSPACE_GIT_FAILED' && !error.message.includes(secret.password))
  assert.equal(closed, spawned)
})

async function management(t, overrides = {}) {
  const directory = await root(t), state = { allowed: true, current: { ...source } }
  const requireActor = () => { if (!state.allowed) throw Object.assign(new Error('读取权限已撤回'), { status: 403, code: 'FIXTURE_REVOKED' }) }
  const credentials = createProjectCredentialService({ databasePath: path.join(directory, 'credentials.sqlite'), keyPath: path.join(directory, 'master.key'), initializeKeyIfNew: true, authorize: requireActor })
  const credential = credentials.create('owner', 'p-test', { name: '隔离凭证', username: 'fixture', password: 'fixture-secret', requestId: randomUUID() })
  state.current.credentialId = credential.id
  const service = createWorkspaceManagement({ access: { requireWorkspaceActor: requireActor, requireWorkspaceReader: requireActor, requireProjectActionForActor: requireActor }, credentials,
    authoring: { overview: () => ({ sources: [state.current], entries: [], revision: 1 }), close: async () => {} },
    store: { whenIdle: async () => {} }, git: { validateRepositorySource: value => value, ...overrides } })
  t.after(() => service.close())
  return { service, state, credentials, credential }
}

test('来源查询复用固定凭证，迟到结果在撤权、凭证撤销和来源更新后拒绝', async t => {
  for (const change of ['actor', 'credential', 'source']) {
    const gate = deferred(), entered = deferred()
    const f = await management(t, { repositoryRefs: async (_source, secret) => { assert.equal(secret.password, 'fixture-secret'); entered.resolve(); return gate.promise } })
    const reading = f.service.repositoryRefs('p-test', source.id, 'owner')
    await entered.promise
    if (change === 'actor') f.state.allowed = false
    if (change === 'credential') f.credentials.revoke('owner', 'p-test', f.credential.id, { requestId: randomUUID(), expectedRevision: f.credential.revision })
    if (change === 'source') f.state.current = { ...f.state.current, url: 'https://github.com/example/other.git' }
    gate.resolve({ branches: [] })
    await assert.rejects(reading, error => [403, 409, 410].includes(error.status))
    f.state.allowed = true
  }
})

test('Git 查询最多两个并发，宿主关闭取消查询并等待回收', async t => {
  const entered = []
  const f = await management(t, { repositoryRefs: async (_source, _secret, signal) => new Promise((resolve, reject) => { entered.push(signal); signal.addEventListener('abort', () => reject(Object.assign(new Error('已取消'), { status: 499 })), { once: true }) }) })
  const first = f.service.repositoryRefs('p-test', source.id, 'owner'), second = f.service.repositoryRefs('p-test', source.id, 'owner')
  await assert.rejects(f.service.repositoryRefs('p-test', source.id, 'owner'), error => error.code === 'WORKSPACE_GIT_QUERY_BUSY')
  const results = Promise.allSettled([first, second])
  await f.service.close()
  assert.ok(entered.every(signal => signal.aborted)); assert.equal((await results).every(result => result.status === 'rejected'), true)
  await assert.rejects(f.service.repositoryRefs('p-test', source.id, 'owner'), error => error.code === 'WORKSPACE_STOPPING')
})

test('中文提交跨进程输出分片时仍保持完整 UTF-8', async t => {
  const directory = await root(t), script = path.join(directory, 'chunked-git.mjs'), revision = 'a'.repeat(40)
  await writeFile(script, `
const args = process.argv.slice(2), revision = '${revision}';
if (args.includes('ls-remote')) process.stdout.write('ref: refs/heads/main\\tHEAD\\n' + revision + '\\tHEAD\\n');
else if (args.includes('rev-parse')) process.stdout.write(revision);
else if (args.includes('log')) { process.stdout.write(revision + '\\0'); for (const byte of Buffer.from('中文提交')) { process.stdout.write(Buffer.from([byte])); await new Promise(resolve => setTimeout(resolve, 5)); } process.stdout.write('\\0' + '2026-10-25T00:00:00+00:00' + '\\0'); }
`)
  const adapter = createWorkspaceGit({ lookupHost: publicLookup, spawnGit: (args, options) => spawn(process.execPath, [script, ...args], options) })
  const history = await adapter.repositoryHistory(source)
  assert.equal(history.commits[0].subject, '中文提交')
})
