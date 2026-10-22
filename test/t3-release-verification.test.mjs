import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { zipSync } from 'fflate'
import { verifyT3Release, verifyCustomerAgentBundle } from '../scripts/verify-t3-release.mjs'
import { addCustomerAgentBundle, packageT3Release } from '../scripts/package-t3-release.mjs'

const commit = 'fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92'
const nativePath = 'vendor/t3code/apps/server/node_modules'
const hash = (text) => createHash('sha256').update(text).digest('hex')
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 't3-release-verify-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const release = join(base, 'release'), source = join(base, 'official/t3-0.1.1-linux-x64/node_modules')
  const files = [
    ['app.mjs', 'export const release = true\n'],
    ['vendor/t3code/.autoops-source/manifest.json', JSON.stringify({ commit, upstreamVersion: 'v0.1.1' })],
    ['node_modules/.store/example/index.mjs', 'export const dep = true\n'],
  ]
  for (const [name, content] of files) put(join(release, name), content)
  symlinkSync('.store/example', join(release, 'node_modules/example'))
  const manifest = { sourceCommit: commit, files: files.map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: hash(content) })), symlinks: [{ path: 'node_modules/example', target: 'node_modules/.store/example' }] }
  put(join(release, 'release-manifest.json'), JSON.stringify(manifest))
  put(join(source, '.package-map.json'), JSON.stringify({ packages: { example: { url: './example' } } }))
  put(join(source, 'example/package.json'), JSON.stringify({ name: 'example', version: '1.2.3' }))
  put(join(source, 'example/index.node'), 'native-binary-contents')
  mkdirSync(join(source, '.bin'))
  symlinkSync('../example/index.node', join(source, '.bin/example'))
  put(join(dirname(source), 't3'), 'official-release-identity')
  const native = join(release, nativePath)
  mkdirSync(dirname(native), { recursive: true })
  cpSync(source, native, { recursive: true, verbatimSymlinks: true })
  return { base, release, source, native, manifest, record: join(release, 'native-dependencies-manifest.json') }
}

function customerBundle(f, mutate = () => {}, name = 'customer-agent.zip') {
  const payload = {
    'autoops-customer-agent.mjs': 'import "./runner.mjs";\n',
    'runner.mjs': 'export const runner = true;\n',
    'README.md': 'Node.js 24.10+ and a local Codex installation are required.\n',
    'LICENSE-T3-Code': 'MIT\n',
    'THIRD-PARTY-NOTICES.txt': 'example: MIT\n',
    'third-party-licenses.json': JSON.stringify({ entries: [{ name: 'example', license: 'MIT' }] }),
    'dependency-audit.json': JSON.stringify({ schemaVersion: 1, entry: 'agent-demo/customer-agent/cli.ts', sourceModules: 2, auditedAllChunks: true, prohibitedPlatformDependencies: [], bundledThirdPartyNotices: 1 }),
  }
  const manifest = { schemaVersion: 1, connectorVersion: '0.1.0', protocolVersion: 1, node: '>=24.10', files: Object.fromEntries(Object.entries(payload).map(([path, contents]) => [path, { bytes: Buffer.byteLength(contents), sha256: hash(contents) }])) }
  const entries = Object.fromEntries(Object.entries(payload).map(([path, contents]) => [`customer-agent/${path}`, Buffer.from(contents)]))
  mutate({ entries, manifest })
  entries['customer-agent/manifest.json'] = Buffer.from(JSON.stringify(manifest))
  const archive = zipSync(entries), path = join(f.base, name)
  put(path, archive)
  put(`${path}.sha256`, `${hash(archive)}  ${name}\n`)
  return path
}

function recordCustomer(f, bundlePath, { metadata = true } = {}) {
  const result = addCustomerAgentBundle(f.release, bundlePath)
  for (const path of [result.path, result.checksumPath]) {
    const contents = readFileSync(join(f.release, path))
    f.manifest.files.push({ path, bytes: contents.length, sha256: hash(contents) })
  }
  if (metadata) f.manifest.customerAgent = result
  put(join(f.release, 'release-manifest.json'), JSON.stringify(f.manifest))
  return result
}

test('records only a matching independent official tree, then verifies without rewriting the record', (t) => {
  const f = fixture(t)
  const first = verifyT3Release(f.release, { nativeSource: f.source })
  assert.equal(first.recorded, true)
  assert.equal(first.releaseFiles, 3)
  assert.equal(first.releaseSymlinks, 1)
  assert.equal(first.nativeFiles, 3)
  assert.equal(first.nativeSymlinks, 1)
  const original = readFileSync(f.record, 'utf8'), record = JSON.parse(original)
  assert.deepEqual(record.packages.map(({ name, version }) => ({ name, version })), [{ name: 'example', version: '1.2.3' }])
  assert.equal(record.sourceIdentity.executableSha256, hash('official-release-identity'))
  assert.equal(verifyT3Release(f.release).recorded, false)
  assert.equal(verifyT3Release(f.release, { nativeSource: f.source }).recorded, false)
  assert.equal(readFileSync(f.record, 'utf8'), original)
})

test('never blesses native dependencies when the recorded baseline is missing', (t) => {
  const f = fixture(t)
  assert.throws(() => verifyT3Release(f.release), /缺少原生依赖清单/)
  assert.equal(existsSync(f.record), false)
})

test('rejects missing, altered and unlisted release files', (t) => {
  const f = fixture(t)
  put(join(f.release, 'app.mjs'), 'changed')
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /哈希不符/)
  put(join(f.release, 'app.mjs'), 'export const release = true\n')
  put(join(f.release, '._app.mjs'), 'archive metadata')
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /清单外文件/)
  rmSync(join(f.release, '._app.mjs')); rmSync(join(f.release, 'app.mjs'))
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /文件缺失/)
  assert.equal(existsSync(f.record), false)
})

test('checks release link identity and refuses absolute or escaping links', (t) => {
  const f = fixture(t), link = join(f.release, 'node_modules/example')
  rmSync(link); symlinkSync('../app.mjs', link)
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /链接目标不符/)
  rmSync(link); symlinkSync(join(f.release, 'app.mjs'), link)
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /不是相对链接/)
  rmSync(link); put(join(f.base, 'outside'), 'outside'); symlinkSync('../../outside', link)
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /链接越界/)
})

test('compares every native file before recording, including extra files', (t) => {
  const f = fixture(t)
  put(join(f.native, 'unexpected.node'), 'different')
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /官方目录.*不一致/)
  rmSync(join(f.native, 'unexpected.node'))
  put(join(f.native, 'example/index.node'), 'tampered')
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /官方目录.*不一致/)
  assert.equal(existsSync(f.record), false)
})

test('requires exact relative native links, even if a changed link resolves to the same target', (t) => {
  const f = fixture(t), link = join(f.native, '.bin/example')
  rmSync(link); symlinkSync('../example/../example/index.node', link)
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /官方目录.*不一致/)
})

test('does not refresh a saved baseline even if both native copies are changed together', (t) => {
  const f = fixture(t)
  verifyT3Release(f.release, { nativeSource: f.source })
  const original = readFileSync(f.record, 'utf8')
  put(join(f.native, 'example/index.node'), 'new-binary')
  put(join(f.source, 'example/index.node'), 'new-binary')
  assert.throws(() => verifyT3Release(f.release), /拒绝重新登记变化/)
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /拒绝重新登记变化/)
  assert.equal(readFileSync(f.record, 'utf8'), original)
})

test('binds the native record to the exact release manifest', (t) => {
  const f = fixture(t)
  verifyT3Release(f.release, { nativeSource: f.source })
  put(join(f.release, 'release-manifest.json'), JSON.stringify({ ...f.manifest, rebuilt: true }))
  assert.throws(() => verifyT3Release(f.release), /与本发布包身份不符/)
})

test('rejects path traversal and duplicate manifest identities', (t) => {
  const f = fixture(t)
  put(join(f.release, 'release-manifest.json'), JSON.stringify({ ...f.manifest, files: [...f.manifest.files, { path: '../outside', bytes: 0, sha256: hash('') }] }))
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /不安全的相对路径/)
  put(join(f.release, 'release-manifest.json'), JSON.stringify({ ...f.manifest, files: [...f.manifest.files, f.manifest.files[0]] }))
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /清单重复/)
})

test('does not accept a native root symlink or use the target as its own baseline', (t) => {
  const f = fixture(t)
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.native }), /必须独立/)
  rmSync(f.native, { recursive: true }); symlinkSync(f.source, f.native)
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /实际目录/)
})

test('customer bundle is opt-in even when a complete local ZIP exists, without changing feature flags', (t) => {
  const f = fixture(t)
  customerBundle(f)
  const flag = process.env.AUTOOPS_CUSTOMER_AGENTS
  assert.equal(addCustomerAgentBundle(f.release), undefined)
  assert.equal(existsSync(join(f.release, 'dist/customer-agent.zip')), false)
  assert.equal(process.env.AUTOOPS_CUSTOMER_AGENTS, flag)
  const result = verifyT3Release(f.release, { nativeSource: f.source })
  assert.equal(Object.hasOwn(result, 'customerAgent'), false)
})

test('explicit customer artifact is fully verified, copied under a stable name and bound into release identity', (t) => {
  const f = fixture(t), path = customerBundle(f, undefined, 'custom-release.zip')
  const metadata = recordCustomer(f, path)
  assert.equal(readFileSync(join(f.release, metadata.checksumPath), 'utf8'), `${metadata.sha256}  customer-agent.zip\n`)
  const result = verifyT3Release(f.release, { nativeSource: f.source })
  assert.deepEqual(result.customerAgent, metadata)
  assert.equal(verifyT3Release(f.release).recorded, false)
  assert.equal(readFileSync(path).equals(readFileSync(join(f.release, metadata.path))), true)
})

test('explicit missing or invalid ZIP fails before creating a release directory', (t) => {
  const f = fixture(t), target = join(f.base, 'new-release')
  assert.throws(() => packageT3Release(target, { customerAgentBundle: join(f.base, 'absent.zip') }), /ENOENT/)
  assert.equal(existsSync(target), false)
  const path = customerBundle(f)
  put(`${path}.sha256`, `${'0'.repeat(64)}  customer-agent.zip\n`)
  assert.throws(() => packageT3Release(target, { customerAgentBundle: path }), /SHA-256/)
  assert.equal(existsSync(target), false)
  assert.throws(() => addCustomerAgentBundle(f.release, path), /SHA-256/)
  assert.equal(existsSync(join(f.release, 'dist/customer-agent.zip')), false)
})

test('customer ZIP requires sidecar identity, actual files and no symlink source', (t) => {
  const f = fixture(t), path = customerBundle(f)
  put(`${path}.sha256`, `${hash(readFileSync(path))}  wrong.zip\n`)
  assert.throws(() => verifyCustomerAgentBundle(path), /SHA-256/)
  rmSync(`${path}.sha256`)
  assert.throws(() => verifyCustomerAgentBundle(path), /ENOENT/)
  const alias = join(f.base, 'alias.zip')
  symlinkSync('customer-agent.zip', alias)
  assert.throws(() => verifyCustomerAgentBundle(alias), /常规文件/)
})

test('customer ZIP rejects missing chunks, tampered payload and unlisted files even with a valid archive hash', (t) => {
  const f = fixture(t)
  let path = customerBundle(f, ({ entries }) => { delete entries['customer-agent/runner.mjs'] })
  assert.throws(() => verifyCustomerAgentBundle(path), /清单文件缺失/)
  path = customerBundle(f, ({ entries }) => { entries['customer-agent/runner.mjs'] = Buffer.from('changed') })
  assert.throws(() => verifyCustomerAgentBundle(path), /清单或哈希不符/)
  path = customerBundle(f, ({ entries }) => { entries['customer-agent/extra.txt'] = Buffer.from('unlisted') })
  assert.throws(() => verifyCustomerAgentBundle(path), /清单或哈希不符/)
  path = customerBundle(f, ({ entries, manifest }) => { delete entries['customer-agent/LICENSE-T3-Code']; delete manifest.files['LICENSE-T3-Code'] })
  assert.throws(() => verifyCustomerAgentBundle(path), /缺少文件.*LICENSE/)
})

test('customer ZIP rejects path traversal, nested modules and source maps before expansion', (t) => {
  const f = fixture(t)
  for (const name of ['../outside', '/absolute', 'customer-agent/../outside', 'customer-agent/node_modules/secret.txt', 'customer-agent/runner.mjs.map', 'customer-agent/C:secret']) {
    const path = customerBundle(f, ({ entries }) => { entries[name] = Buffer.from('unexpected') })
    assert.throws(() => verifyCustomerAgentBundle(path), /文件路径/)
  }
})

test('customer ZIP requires supported protocol and complete dependency isolation evidence', (t) => {
  const f = fixture(t)
  let path = customerBundle(f, ({ manifest }) => { manifest.protocolVersion = 2 })
  assert.throws(() => verifyCustomerAgentBundle(path), /清单版本或格式/)
  path = customerBundle(f, ({ entries, manifest }) => {
    const name = 'dependency-audit.json'
    const value = JSON.parse(entries[`customer-agent/${name}`].toString())
    value.prohibitedPlatformDependencies = ['platform/secrets.ts']
    const contents = Buffer.from(JSON.stringify(value))
    entries[`customer-agent/${name}`] = contents
    manifest.files[name] = { bytes: contents.length, sha256: hash(contents) }
  })
  assert.throws(() => verifyCustomerAgentBundle(path), /依赖审计/)
})

test('release verifier refuses unregistered customer ZIP and incorrect module metadata', (t) => {
  const f = fixture(t), path = customerBundle(f)
  const metadata = recordCustomer(f, path, { metadata: false })
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /缺少模块清单/)
  f.manifest.customerAgent = { ...metadata, connectorVersion: '9.9.9' }
  put(join(f.release, 'release-manifest.json'), JSON.stringify(f.manifest))
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /发布模块清单不符/)
  f.manifest.customerAgent = { ...metadata, path: '../customer-agent.zip' }
  put(join(f.release, 'release-manifest.json'), JSON.stringify(f.manifest))
  assert.throws(() => verifyT3Release(f.release, { nativeSource: f.source }), /发布路径/)
  assert.equal(existsSync(f.record), false)
})
