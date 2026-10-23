import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { join, extname, sep } from 'node:path'

const MAX_FILES = 12000
const MAX_BYTES = 64 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const CACHE_NAMES = new Set(['node_modules', '.cache', '.next', 'dist', 'coverage', '__pycache__', '.DS_Store'])
const sha = (value) => createHash('sha256').update(value).digest('hex')
export class WorkspaceError extends Error {
  constructor(status, code, message) { super(message); this.name = 'WorkspaceError'; this.status = status; this.code = code }
}
const fail = (status, code, message) => { throw new WorkspaceError(status, code, message) }
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
      if (bytes > MAX_BYTES || count > MAX_FILES) fail(413, 'WORKSPACE_TOO_LARGE', 'Git 导入超过演示大小上限，已中止以保护可用存储')
    }
  }
  visit(directory)
  entryInfo(directory)
}
function scan(root, { skipGit = false, skipCaches = false } = {}) {
  let size = 0, removedGitEntries = 0
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
      if (details.size > MAX_FILE_BYTES || size > MAX_BYTES || files.length >= MAX_FILES) fail(413, 'WORKSPACE_TOO_LARGE', '工作区超过演示上限：12,000 个文件、64 MiB 总量、单文件 8 MiB')
      const bytes = readFileSync(absolute)
      files.push({ path, name: entry.name, size: bytes.length, mime: mimeFor(path), sha256: sha(bytes), binary: textOf(bytes) === null, executable: Boolean(details.mode & 0o111) })
    }
  }
  visit(root, '')
  return { files, removedGitEntries, contentHash: sha(JSON.stringify(files.map(({ path, sha256 }) => [path, sha256]))), byteLength: size }
}

export { MAX_FILES, MAX_BYTES, MAX_FILE_BYTES, sha, safePath, textOf, checkedFile, checkImportFiles, scan }
