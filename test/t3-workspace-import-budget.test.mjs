import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkImportFiles, scan, MAX_BYTES } from '../agent-demo/t3-adapters/workspace-files.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'autoops-import-budget-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(join(root, 'README'), '固定来源')
  return root
}
function intercept(t, method, implementation, run) {
  t.mock.method(fs, method, implementation)
  syncBuiltinESMExports()
  try { run() } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}

test('Git 临时文件在列目录后消失不误报预算失败，固定文件仍被检查', t => {
  const root = fixture(t), temporary = join(root, 'tmp_pack'), original = fs.readdirSync
  fs.writeFileSync(temporary, '临时对象')
  let observed = false
  intercept(t, 'readdirSync', (directory, options) => {
    const entries = original(directory, options)
    if (directory === root && !observed) { observed = true; fs.unlinkSync(temporary) }
    return entries
  }, () => {
    assert.doesNotThrow(() => checkImportFiles(root))
    const large = join(root, '超限文件')
    fs.writeFileSync(large, '')
    fs.truncateSync(large, MAX_BYTES + 1)
    assert.throws(() => checkImportFiles(root), { code: 'WORKSPACE_TOO_LARGE' })
  })
  assert.equal(observed, true)
  assert.equal(fs.readFileSync(join(root, 'README'), 'utf8'), '固定来源')
})

test('Git 临时目录在开始遍历前消失不误报预算失败', t => {
  const root = fixture(t), temporary = join(root, '临时目录'), original = fs.readdirSync
  fs.mkdirSync(temporary)
  let observed = false
  intercept(t, 'readdirSync', (directory, options) => {
    if (directory === temporary && !observed) { observed = true; fs.rmdirSync(temporary) }
    return original(directory, options)
  }, () => assert.doesNotThrow(() => checkImportFiles(root)))
  assert.equal(observed, true)
})

test('跳过已消失项后继续检查同次遍历中的超限文件', t => {
  const root = fixture(t), temporary = join(root, '临时对象'), large = join(root, '超限文件'), original = fs.readdirSync
  fs.writeFileSync(temporary, '临时对象')
  fs.writeFileSync(large, '')
  fs.truncateSync(large, MAX_BYTES + 1)
  intercept(t, 'readdirSync', (directory, options) => {
    const entries = original(directory, options)
    if (directory === root) {
      fs.unlinkSync(temporary)
      entries.sort((left, right) => Number(right.name === '临时对象') - Number(left.name === '临时对象'))
    }
    return entries
  }, () => assert.throws(() => checkImportFiles(root), { code: 'WORKSPACE_TOO_LARGE' }))
})

test('目录在父级检查后被换成符号链接时拒绝继续遍历', t => {
  const root = fixture(t), directory = join(root, '目录'), outside = fs.mkdtempSync(join(tmpdir(), 'autoops-import-outside-')), original = fs.lstatSync
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.mkdirSync(directory)
  fs.writeFileSync(join(outside, '不能读入的文件'), '外部资料')
  let replaced = false
  intercept(t, 'lstatSync', path => {
    const info = original(path)
    if (path === directory && !replaced) {
      replaced = true
      fs.rmdirSync(directory)
      fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
    }
    return info
  }, () => assert.throws(() => checkImportFiles(root), { code: 'WORKSPACE_LINK_UNSUPPORTED' }))
  assert.equal(replaced, true)
})

test('预算检查不忽略权限或其他 I/O 错误', t => {
  const root = fixture(t), file = join(root, 'README'), original = fs.lstatSync
  for (const code of ['EACCES', 'EIO']) {
    intercept(t, 'lstatSync', path => {
      if (path === file) throw Object.assign(new Error('合成读取失败'), { code })
      return original(path)
    }, () => assert.throws(() => checkImportFiles(root), { code }))
  }
  const directory = join(root, '拒绝读取'), originalRead = fs.readdirSync
  fs.mkdirSync(directory)
  intercept(t, 'readdirSync', (path, options) => {
    if (path === directory) throw Object.assign(new Error('合成目录权限失败'), { code: 'EACCES' })
    return originalRead(path, options)
  }, () => assert.throws(() => checkImportFiles(root), { code: 'EACCES' }))
})

test('预算检查仍拒绝超限文件和符号链接，不跟随到工作区外', t => {
  const root = fixture(t), large = join(root, '超限文件')
  fs.writeFileSync(large, '')
  fs.truncateSync(large, MAX_BYTES + 1)
  assert.throws(() => checkImportFiles(root), { code: 'WORKSPACE_TOO_LARGE', status: 413 })
  fs.unlinkSync(large)
  const outside = fs.mkdtempSync(join(tmpdir(), 'autoops-import-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.symlinkSync(outside, join(root, '目录链接'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => checkImportFiles(root), { code: 'WORKSPACE_LINK_UNSUPPORTED', status: 422 })
})

test('导入根目录消失仍拒绝，发布固定快照的扫描也不容忍文件消失', t => {
  const root = fixture(t), temporary = join(root, 'README'), original = fs.readdirSync
  intercept(t, 'readdirSync', (directory, options) => {
    const entries = original(directory, options)
    if (directory === root) fs.unlinkSync(temporary)
    return entries
  }, () => assert.throws(() => scan(root), { code: 'ENOENT' }))
  fs.rmdirSync(root)
  assert.throws(() => checkImportFiles(root), { code: 'ENOENT' })
})

test('任务暂存根目录在遍历途中消失不能被当成普通临时文件忽略', t => {
  const root = fixture(t), original = fs.readdirSync
  intercept(t, 'readdirSync', (directory, options) => {
    const entries = original(directory, options)
    if (directory === root) fs.rmSync(root, { recursive: true })
    return entries
  }, () => assert.throws(() => checkImportFiles(root), { code: 'ENOENT' }))
})

test('预算采样后继续增长的文件仍被发布前固定扫描拒绝', t => {
  const root = fixture(t), file = join(root, 'README')
  assert.doesNotThrow(() => checkImportFiles(root))
  fs.truncateSync(file, MAX_BYTES + 1)
  assert.throws(() => scan(root), { code: 'WORKSPACE_TOO_LARGE' })
})
