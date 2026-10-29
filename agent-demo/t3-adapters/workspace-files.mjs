import { createHash } from 'node:crypto'
import { openSync, closeSync, readSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { join, extname, sep } from 'node:path'

function configuredLimit(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value))
    throw new Error(`${name} 必须配置为正整数字节数或文件数`)
  return value
}
const MAX_FILES = configuredLimit('AUTOOPS_WORKSPACE_MAX_FILES', 100000)
const MAX_BYTES = configuredLimit('AUTOOPS_WORKSPACE_MAX_BYTES', 1024 * 1024 * 1024)
const MAX_FILE_BYTES = configuredLimit('AUTOOPS_WORKSPACE_MAX_FILE_BYTES', 64 * 1024 * 1024)
const MAX_IMPORT_BYTES = configuredLimit('AUTOOPS_WORKSPACE_GIT_MAX_BYTES', 4 * 1024 * 1024 * 1024)
const MAX_IMPORT_FILES = configuredLimit('AUTOOPS_WORKSPACE_GIT_MAX_FILES', 200000)
if (MAX_FILE_BYTES > MAX_BYTES || MAX_BYTES > MAX_IMPORT_BYTES || MAX_FILES > MAX_IMPORT_FILES)
  throw new Error('工作区容量配置无效：单文件不得超过源码总量，源码额度不得超过 Git 导入额度')
const CACHE_NAMES = new Set(['node_modules', '.cache', '.next', 'dist', 'coverage', '__pycache__', '.DS_Store'])
const sha = (value) => createHash('sha256').update(value).digest('hex')
export class WorkspaceError extends Error {
  constructor(status, code, message) { super(message); this.name = 'WorkspaceError'; this.status = status; this.code = code }
}
const fail = (status, code, message) => { throw new WorkspaceError(status, code, message) }
const volume = (bytes) => `${(bytes / 1024 / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} MiB（${bytes.toLocaleString('zh-CN')} 字节）`
function assertCapacity(scope, bytes, count, maxBytes, maxFiles) {
  if (bytes > maxBytes) fail(413, 'WORKSPACE_TOO_LARGE', `${scope}总大小超限：已扫描 ${volume(bytes)}，上限 ${volume(maxBytes)}`)
  if (count > maxFiles) fail(413, 'WORKSPACE_TOO_LARGE', `${scope}文件数超限：已扫描 ${count.toLocaleString('zh-CN')} 个，上限 ${maxFiles.toLocaleString('zh-CN')} 个`)
}
function safePath(value, allowEmpty = false) {
  if (allowEmpty && value === '') return value
  if (typeof value !== 'string' || value.length > 800 || /[\\\x00-\x1f:\x7f]/.test(value) || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..'))
    fail(400, 'WORKSPACE_PATH_INVALID', '请选择工作区内的有效相对路径')
  return value
}
function mimeFor(path) {
  const documents = { '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet', '.odp': 'application/vnd.oasis.opendocument.presentation' }
  if (documents[extname(path).toLowerCase()]) return documents[extname(path).toLowerCase()]
  return ({ '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.zip': 'application/zip', '.yml': 'text/yaml', '.yaml': 'text/yaml', '.xml': 'application/xml' })[extname(path).toLowerCase()] || 'text/plain'
}
function textOf(bytes) {
  if (bytes.includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
}
function sameOrWithin(root, target) { return target === root || target.startsWith(root + sep) }
function inspectFile(path, buffer) {
  // 大型 Git 对象包分块校验，不能随导入额度提高而整包占用内存。
  const descriptor = openSync(path, 'r')
  const digest = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0, binary = false
  try {
    for (;;) {
      const length = readSync(descriptor, buffer, 0, buffer.length, null)
      if (!length) break
      const chunk = buffer.subarray(0, length)
      size += length
      digest.update(chunk)
      if (!binary) {
        if (chunk.includes(0)) binary = true
        else try { decoder.decode(chunk, { stream: true }) } catch { binary = true }
      }
    }
    if (!binary) try { decoder.decode() } catch { binary = true }
    return { size, sha256: digest.digest('hex'), binary }
  } finally { closeSync(descriptor) }
}
function checkedFile(root, path) {
  safePath(path)
  let cursor = root
  const rootReal = realpathSync(root)
  for (const part of path.split('/')) {
    cursor = join(cursor, part)
    const details = lstatSync(cursor)
    if (details.isSymbolicLink() || !sameOrWithin(rootReal, realpathSync(cursor))) fail(422, 'WORKSPACE_LINK_UNSUPPORTED', '工作区不允许符号链接或跨目录读取')
  }
  if (!lstatSync(cursor).isFile()) fail(400, 'WORKSPACE_NOT_FILE', '请选择文件进行预览')
  return cursor
}
function checkImportFiles(directory) {
  let bytes = 0, count = 0
  const rootReal = realpathSync(directory)
  function entryInfo(path) {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !sameOrWithin(rootReal, realpathSync(path))) fail(422, 'WORKSPACE_LINK_UNSUPPORTED', '来源包含不支持的符号链接')
    return info
  }
  function visit(root, allowMissing = false) {
    let entries
    try { entryInfo(root); entries = readdirSync(root, { withFileTypes: true }) }
    catch (error) { if (allowMissing && error?.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const path = join(root, entry.name)
      let info
      // Git 会重命名或删除正在生成的临时对象；这里只容忍已消失项，发布前仍严格扫描固定目录。
      try { info = entryInfo(path) }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error }
      if (info.isDirectory()) visit(path, true)
      else if (info.isFile()) { bytes += info.size; count++ }
      assertCapacity('Git 导入（含历史与临时文件）', bytes, count, MAX_IMPORT_BYTES, MAX_IMPORT_FILES)
    }
  }
  visit(directory)
  entryInfo(directory)
}
function scan(root, { skipGit = false, skipCaches = false } = {}) {
  let size = 0, removedGitEntries = 0, sourceBytes = 0, sourceFiles = 0
  const readBuffer = Buffer.allocUnsafe(1024 * 1024)
  const files = []
  const rootReal = realpathSync(root)
  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      safePath(path)
      if (skipGit && entry.name === '.git') { removedGitEntries++; continue }
      if (skipCaches && CACHE_NAMES.has(entry.name)) continue
      const absolute = join(directory, entry.name), details = lstatSync(absolute)
      if (details.isSymbolicLink() || !sameOrWithin(rootReal, realpathSync(absolute))) fail(422, 'WORKSPACE_LINK_UNSUPPORTED', '来源包含符号链接；请将需要的内容保存为普通文件后重新导入')
      if (details.isDirectory()) { visit(absolute, path); continue }
      if (!details.isFile()) fail(422, 'WORKSPACE_FILE_UNSUPPORTED', '来源包含不支持的特殊文件')
      size += details.size
      assertCapacity('Git 快照（含历史）', size, files.length + 1, MAX_IMPORT_BYTES, MAX_IMPORT_FILES)
      // Git 对象包受整体导入预算约束，不占用检出源码的单文件和总量额度。
      if (!path.split('/').includes('.git')) {
        sourceBytes += details.size
        sourceFiles++
        if (details.size > MAX_FILE_BYTES)
          fail(413, 'WORKSPACE_TOO_LARGE', `源码单文件大小超限：${volume(details.size)}，上限 ${volume(MAX_FILE_BYTES)}`)
        assertCapacity('工作区源码', sourceBytes, sourceFiles, MAX_BYTES, MAX_FILES)
      }
      files.push({ path, name: entry.name, mime: mimeFor(path), ...inspectFile(absolute, readBuffer), executable: Boolean(details.mode & 0o111) })
    }
  }
  visit(root, '')
  return { files, removedGitEntries, contentHash: sha(JSON.stringify(files.map(({ path, sha256 }) => [path, sha256]))), byteLength: size }
}

export { MAX_FILES, MAX_BYTES, MAX_FILE_BYTES, MAX_IMPORT_BYTES, MAX_IMPORT_FILES, sha, safePath, textOf, checkedFile, checkImportFiles, scan }
