import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWorkspaceGit } from '../agent-demo/t3-adapters/workspace-git.ts'

const commit = '1234567890abcdef1234567890abcdef12345678'
const otherCommit = 'abcdef1234567890abcdef1234567890abcdef12'
const source = (overrides = {}) => ({ id: 'frontend', name: '前端仓库', role: 'frontend', url: 'https://github.com/example/fixture.git', refKind: 'branch', ref: 'main', mountPath: 'frontend', ...overrides })
const publicLookup = async () => [{ address: '140.82.114.4', family: 4 }]
const code = value => error => error?.code === value
const exec = promisify(execFile)
async function fakeGit(t, mode = 'refs', settings = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'autoops-git-test-')), script = path.join(root, 'fake-git.mjs')
  await writeFile(script, `
const args = process.argv.slice(2), mode = process.env.FIXTURE_GIT_MODE;
if (mode === 'hold') { process.on('SIGTERM', () => setTimeout(() => process.exit(0), 90)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000); }
else if (mode === 'output') process.stdout.write('x'.repeat(4096));
else if (mode === 'stderr') process.stderr.write('x'.repeat(4096));
else if (mode === 'error') { process.stderr.write('fixture-secret-only'); process.exitCode = 1; }
else if (args.includes('ls-remote')) process.stdout.write(process.env.FIXTURE_REFS);
else if (args.includes('rev-parse')) process.stdout.write(process.env.FIXTURE_COMMIT + '\\n');
else if (args.includes('cat-file')) process.stdout.write('tree\\n');
else if (args.includes('ls-tree')) process.stdout.write(mode === 'submodule' ? '160000\\n' : mode === 'symlink' ? '120000\\n' : '100644\\n');
`)
  const calls = [], children = [], closed = []
  const git = createWorkspaceGit({ lookupHost: publicLookup,
    spawnGit(args, options) {
      const child = spawn(process.execPath, [script, ...args], { ...options, env: { ...options.env, FIXTURE_GIT_MODE: mode,
        FIXTURE_COMMIT: settings.actualCommit ?? commit,
        FIXTURE_REFS: settings.refs ?? `ref: refs/heads/main\tHEAD\n${commit}\tHEAD\n${commit}\trefs/heads/main\n${otherCommit}\trefs/tags/v1\n${commit}\trefs/tags/v1^{}\n` } })
      calls.push({ args: [...args], env: options.env }); children.push(child); child.on('close', () => closed.push(child.pid))
      settings.onSpawn?.(child)
      return child
    }, ...settings.options })
  t.after(async () => { for (const child of children) { if (child.exitCode === null && !child.killed) child.kill('SIGKILL') } await rm(root, { recursive: true, force: true }) })
  return { root, git, calls, closed }
}

test('仓库入口只允许HTTPS白名单，拒绝凭据、重定向式路径、协议与引用注入', () => {
  const git = createWorkspaceGit()
  assert.equal(git.validateRepositorySource(source()).url, source().url)
  for (const url of ['http://github.com/a/b', 'file:///tmp/repository', 'ext::sh -c touch', 'https://user:secret@github.com/a/b',
    'https://github.com.evil.test/a/b', 'https://127.0.0.1/a/b', 'https://github.com:8443/a/b', 'https://github.com/a/b?token=x',
    'https://github.com/a/b#fragment', 'https://github.com/a/../b/c', 'https://github.com/a/%2e%2e/b', 'https://github.com/a\\b/c'])
    assert.throws(() => git.validateRepositorySource(source({ url })), code('WORKSPACE_REPOSITORY_INVALID'))
  for (const ref of ['--upload-pack=evil', 'main~1', 'main^{tree}', 'x\nother', 'a..b', 'a/.git'])
    assert.throws(() => git.validateRepositorySource(source({ ref })), code('WORKSPACE_REF_INVALID'))
  for (const sourcePath of ['../secret', '/tmp', '.git', 'a/.git/config'])
    assert.throws(() => git.validateRepositorySource(source({ sourcePath })), code('WORKSPACE_SOURCE_PATH_INVALID'))
})

test('默认分支及附注标签解析到完整提交，固定commit不重新解析分支', async t => {
  const f = await fakeGit(t)
  assert.deepEqual(await f.git.resolveRepositoryRef(source({ refKind: 'default', ref: '' })), { sourceId: 'frontend', commit, refKind: 'default', ref: 'main', defaultRef: 'main' })
  assert.equal((await f.git.resolveRepositoryRef(source({ refKind: 'tag', ref: 'v1' }))).commit, commit)
  const before = f.calls.length
  assert.equal((await f.git.resolveRepositoryRef(source({ refKind: 'commit', ref: commit }))).commit, commit)
  assert.equal(f.calls.length, before)
  await assert.rejects(f.git.resolveRepositoryRef(source({ ref: 'missing' })), code('WORKSPACE_GIT_REF_NOT_FOUND'))
})

test('Git命令禁用helper/重定向/本地协议/外部协议/钩子，固定DNS且ASKPASS不写秘密', async t => {
  const f = await fakeGit(t), credential = { username: 'fixture-user', password: 'fixture-secret-only' }
  await f.git.resolveRepositoryRef(source(), credential)
  const { args, env } = f.calls[0]
  for (const setting of ['credential.helper=', 'http.followRedirects=false', 'protocol.file.allow=never', 'protocol.ext.allow=never', 'submodule.recurse=false', 'protocol.allow=never', 'protocol.https.allow=always']) assert.ok(args.includes(setting))
  assert.ok(args.includes('http.curloptResolve=github.com:443:140.82.114.4'))
  assert.equal(args.join(' ').includes(credential.password), false)
  assert.equal(env.CMR_GIT_PASSWORD, credential.password); assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_CONFIG_COUNT, undefined); assert.equal(env.HTTP_PROXY, undefined)
  assert.equal(existsSync(env.GIT_ASKPASS), false)
  const other = await fakeGit(t, 'hold', { onSpawn(child) {
    child.stdout.once('data', async () => {
      const content = await readFile(other.calls[0].env.GIT_ASKPASS, 'utf8')
      assert.equal(content.includes(credential.password), false); controller.abort()
    })
  } })
  const controller = new AbortController()
  await assert.rejects(other.git.resolveRepositoryRef(source(), credential, controller.signal), code('WORKSPACE_GIT_ABORTED'))
})

test('公共来源DNS落到私网会被拒绝，自建来源必须逐origin显式授权', async t => {
  const deny = createWorkspaceGit({ lookupHost: async () => [{ address: '127.0.0.1', family: 4 }], spawnGit: () => assert.fail('不能启动Git') })
  await assert.rejects(deny.resolveRepositoryRef(source()), code('WORKSPACE_GIT_ADDRESS_DENIED'))
  const f = await fakeGit(t, 'refs', { options: { allowedOrigins: ['https://git.internal.example:8443'], lookupHost: async () => [{ address: '192.168.31.9', family: 4 }] } })
  assert.equal((await f.git.resolveRepositoryRef(source({ url: 'https://git.internal.example:8443/team/repo.git' }))).commit, commit)
  assert.ok(f.calls[0].args.includes('http.curloptResolve=git.internal.example:8443:192.168.31.9'))
  assert.throws(() => f.git.validateRepositorySource(source({ url: 'https://git.internal.example/team/repo.git' })), code('WORKSPACE_REPOSITORY_INVALID'))
})

test('拉取只使用固定完整提交，终态核对；失败只清理本次新目录', async t => {
  const f = await fakeGit(t), destination = path.join(f.root, 'checkout')
  await f.git.fetchRepositoryAt(source(), commit, destination)
  const fetch = f.calls.find(call => call.args.includes('fetch')).args
  assert.equal(fetch.at(-1), commit); assert.ok(fetch.includes('--no-recurse-submodules')); assert.equal(fetch.includes('main'), false)
  assert.equal(existsSync(destination), true)
  await writeFile(path.join(destination, 'keep.txt'), '保留已有文件')
  await assert.rejects(f.git.fetchRepositoryAt(source(), commit, destination), error => error.code === 'EEXIST')
  assert.equal(await readFile(path.join(destination, 'keep.txt'), 'utf8'), '保留已有文件')
  const mismatch = await fakeGit(t, 'refs', { actualCommit: otherCommit }), failed = path.join(mismatch.root, 'checkout')
  await assert.rejects(mismatch.git.fetchRepositoryAt(source(), commit, failed), code('WORKSPACE_GIT_COMMIT_MISMATCH'))
  assert.equal(existsSync(failed), false)
})

test('子模块拒绝隐式获取其他仓库', async t => {
  const f = await fakeGit(t, 'submodule'), destination = path.join(f.root, 'checkout')
  await assert.rejects(f.git.fetchRepositoryAt(source(), commit, destination), code('WORKSPACE_GIT_SUBMODULE_UNSUPPORTED'))
  assert.equal(existsSync(destination), false)
  const linked = await fakeGit(t, 'symlink'), linkedDestination = path.join(linked.root, 'checkout')
  await assert.rejects(linked.git.fetchRepositoryAt(source(), commit, linkedDestination), code('WORKSPACE_GIT_LINK_UNSUPPORTED'))
  assert.equal(existsSync(linkedDestination), false)
})

test('取消必须等子进程close后返回；超时和双输出预算均终止进程', async t => {
  const controller = new AbortController()
  const f = await fakeGit(t, 'hold', { onSpawn(child) { child.stdout.once('data', () => controller.abort()) } })
  await assert.rejects(f.git.resolveRepositoryRef(source(), undefined, controller.signal), code('WORKSPACE_GIT_ABORTED'))
  assert.equal(f.closed.length, 1); assert.equal(existsSync(f.calls[0].env.HOME), false)
  const timeout = await fakeGit(t, 'hold', { options: { resolveTimeoutMs: 100 } })
  await assert.rejects(timeout.git.resolveRepositoryRef(source()), code('WORKSPACE_GIT_TIMEOUT')); assert.equal(timeout.closed.length, 1)
  for (const mode of ['output', 'stderr']) {
    const overflow = await fakeGit(t, mode, { options: { maxOutputBytes: 32, maxErrorBytes: 32 } })
    await assert.rejects(overflow.git.resolveRepositoryRef(source()), code('WORKSPACE_GIT_OUTPUT_LIMIT'))
    assert.equal(overflow.closed.length, 1)
  }
})

test('存储预算失效时等待Git退出并清理目录，错误不包含远端原文', async t => {
  const f = await fakeGit(t, 'hold'), destination = path.join(f.root, 'checkout')
  let checks = 0
  await assert.rejects(f.git.fetchRepositoryAt(source(), commit, destination, undefined, undefined, () => { if (++checks > 1) throw Object.assign(new Error('测试存储预算不足'), { code: 'FIXTURE_BUDGET' }) }), code('FIXTURE_BUDGET'))
  assert.equal(f.closed.length, 1); assert.equal(existsSync(destination), false)
  const failed = await fakeGit(t, 'error')
  await assert.rejects(failed.git.resolveRepositoryRef(source()), error => error.code === 'WORKSPACE_GIT_FAILED' && !String(error).includes('fixture-secret-only'))
})

test('真实Git本地受控端口验证完整历史、固定提交和非扁平化目录检出', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'autoops-git-native-test-')), repository = path.join(root, 'repository')
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = async (...args) => (await exec('git', ['-c', 'user.name=隔离测试', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout.trim()
  await mkdir(repository); await git('init', repository)
  await mkdir(path.join(repository, 'packages', 'frontend'), { recursive: true }); await mkdir(path.join(repository, 'packages', 'backend'))
  await writeFile(path.join(repository, 'README.md'), '根文件')
  await writeFile(path.join(repository, 'packages', 'frontend', 'index.ts'), '固定前端版本')
  await writeFile(path.join(repository, 'packages', 'backend', 'index.ts'), '后端文件')
  await git('-C', repository, 'add', '.'); await git('-C', repository, 'commit', '-m', '创建隔离测试版本')
  const fixed = await git('-C', repository, 'rev-parse', 'HEAD')
  await writeFile(path.join(repository, 'packages', 'frontend', 'index.ts'), '后续前端版本')
  await git('-C', repository, 'commit', '-am', '新增后续测试版本')
  const latest = await git('-C', repository, 'rev-parse', 'HEAD')
  const adapter = createWorkspaceGit({ lookupHost: publicLookup, spawnGit(args, options) {
    // 仅此测试进程端口将网络传输替为隔离本地仓库，生产白名单与固定提交参数仍先被校验。
    const localArgs = [...args], remote = localArgs.indexOf(source().url)
    if (remote >= 0) localArgs[remote] = repository
    return spawn('git', ['-c', 'protocol.file.allow=always', ...localArgs.map(value => value === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : value)], { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'https:file' } })
  } })
  const selected = path.join(root, 'selected')
  await adapter.fetchRepositoryAt(source({ sourcePath: 'packages/frontend' }), fixed, selected)
  assert.equal(await readFile(path.join(selected, 'packages', 'frontend', 'index.ts'), 'utf8'), '固定前端版本')
  assert.equal(existsSync(path.join(selected, 'README.md')), false); assert.equal(existsSync(path.join(selected, 'packages', 'backend')), false)
  assert.equal(existsSync(path.join(selected, '.git')), true)
  assert.equal(await git('-C', selected, 'rev-parse', 'HEAD'), fixed)
  assert.equal(await git('-C', selected, 'remote', 'get-url', 'origin'), repository)
  const full = path.join(root, 'full')
  await adapter.fetchRepositoryAt(source(), latest, full)
  assert.equal(await git('-C', full, 'rev-list', '--count', 'HEAD'), '2')
  assert.equal(await git('-C', full, 'show', `${fixed}:packages/frontend/index.ts`), '固定前端版本')
  assert.equal(existsSync(path.join(full, 'README.md')), true)
  const bad = path.join(root, 'bad')
  await assert.rejects(adapter.fetchRepositoryAt(source({ sourcePath: 'README.md' }), fixed, bad), code('WORKSPACE_GIT_SOURCE_PATH_INVALID'))
  assert.equal(existsSync(bad), false)
  assert.ok((await readdir(full)).includes('.git'))
})
