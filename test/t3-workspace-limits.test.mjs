import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const moduleUrl = new URL('../agent-demo/t3-adapters/workspace-files.mjs', import.meta.url).href
function check(t, files, expression, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autoops-capacity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, value)
  }
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('AUTOOPS_WORKSPACE_')) delete env[name]
  Object.assign(env, {
    AUTOOPS_WORKSPACE_MAX_BYTES: '16', AUTOOPS_WORKSPACE_MAX_FILES: '2',
    AUTOOPS_WORKSPACE_MAX_FILE_BYTES: '8', AUTOOPS_WORKSPACE_GIT_MAX_BYTES: '128',
    AUTOOPS_WORKSPACE_GIT_MAX_FILES: '8', ...overrides,
  })
  const script = `try { const m = await import(${JSON.stringify(moduleUrl)}); const root = ${JSON.stringify(root)}; console.log(JSON.stringify(${expression})); } catch (e) { console.log(JSON.stringify({ code:e.code, message:e.message })); }`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('Git 历史使用独立额度，源码达到边界仍可发布并保留完整摘要', t => {
  const result = check(t, { '.git/objects/pack/a.pack': Buffer.alloc(64), 'a.ts': '12345678', 'b.ts': '12345678' }, 'm.scan(root)')
  assert.equal(result.files.length, 3)
  assert.equal(result.byteLength, 80)
  assert.equal(result.files[0].sha256, createHash('sha256').update(Buffer.alloc(64)).digest('hex'))
  assert.equal(result.files[0].binary, true)
})
test('分别报告源码总量、文件数与单文件上限', t => {
  for (const [files, overrides, message] of [
    [{ a: '12345678', b: '12345678', c: '1' }, { AUTOOPS_WORKSPACE_MAX_FILES: '3' }, /工作区源码总大小超限/],
    [{ a: '1', b: '2', c: '3' }, {}, /已扫描 3 个，上限 2 个/],
    [{ a: '123456789' }, {}, /源码单文件大小超限/],
  ]) {
    const result = check(t, files, 'm.scan(root)', overrides)
    assert.equal(result.code, 'WORKSPACE_TOO_LARGE')
    assert.match(result.message, message)
  }
})
test('导入临时对象仍受磁盘使用量和文件数量预算保护', t => {
  const size = check(t, { '.git/objects/tmp.pack': Buffer.alloc(129) }, 'm.checkImportFiles(root)')
  assert.match(size.message, /Git 导入.*总大小超限/)
  const count = check(t, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`.git/${i}`, ''])), 'm.checkImportFiles(root)')
  assert.match(count.message, /已扫描 9 个，上限 8 个/)
})
test('非法或相互矛盾的启动配置明确拒绝', t => {
  for (const value of ['0', '-1', 'bad', '', '1.5', '9007199254740992'])
    assert.match(check(t, {}, 'm.MAX_BYTES', { AUTOOPS_WORKSPACE_MAX_BYTES: value }).message, /必须配置为正整数/)
  assert.match(check(t, {}, 'm.MAX_BYTES', { AUTOOPS_WORKSPACE_MAX_FILE_BYTES: '17' }).message, /容量配置无效/)
})
test('分块扫描保留跨块中文、无效 UTF8 和空文件判定', t => {
  const bytes = Buffer.concat([Buffer.alloc(1024 * 1024 - 1, 97), Buffer.from('中文')])
  const result = check(t, { '.git/text': bytes, '.git/invalid': Buffer.from([0xff]), '.git/empty': '' }, 'm.scan(root)', { AUTOOPS_WORKSPACE_GIT_MAX_BYTES: '2097152' })
  assert.equal(result.files.find(f => f.name === 'text').binary, false)
  assert.equal(result.files.find(f => f.name === 'text').sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(result.files.find(f => f.name === 'invalid').binary, true)
  assert.equal(result.files.find(f => f.name === 'empty').binary, false)
})
