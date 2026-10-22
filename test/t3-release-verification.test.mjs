import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { verifyT3Release } from '../scripts/verify-t3-release.mjs'

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
