/** Skills Manager (MIT, Tianliang Zhang), commit 7a2219219287f4ef4c543fc169ebcc5b0bff085c.
 * Server port of installer::PreparedSource/copy_skill_dir, skill_metadata and
 * content_hash's sorted content scope. See vendor/skills-manager/README.md.
 * AutoOps adds immutable versions, scoped assignments and verified publication.
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync, statfsSync } from 'node:fs'
import { join, resolve, dirname, extname, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { parseDocument } from 'yaml'
import { DatabaseSync } from 'node:sqlite'
import { inspectZip, crc32 } from '../../agent/archive.mjs'
import { BUILTIN_BUSINESS_SKILLS } from './builtin-skills.mjs'

const MAX_FILES = 512, MAX_BYTES = 16 * 1024 * 1024, MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_SKILLS = 256
const MAX_READ_BYTES = 256 * 1024
const IGNORED = new Set(['.git', '.DS_Store', 'Thumbs.db', '.gitignore', '__pycache__'])
const HOSTS = new Set(['github.com', 'gitlab.com', 'gitee.com', 'codeberg.org'])
const TOOL_NAMES = new Set(['list_project_materials', 'read_project_document', 'read_project_material', 'read_attachment', 'query_environment', 'read_environment', 'ask_user', 'create_report'])
const sha = value => createHash('sha256').update(value).digest('hex')
const now = () => new Date().toISOString()
const clone = value => structuredClone(value)
export class SkillLibraryError extends Error {
  constructor(status, code, message) { super(message); this.name = 'SkillLibraryError'; this.status = status; this.code = code }
}
const fail = (status, code, message) => { throw new SkillLibraryError(status, code, message) }
const missing = () => fail(404, 'SKILL_NOT_FOUND', '技能或版本不存在，或无权访问')
function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) missing()
  return value
}
function safePath(value, allowEmpty = false) {
  if (allowEmpty && value === '') return value
  if (typeof value !== 'string' || value.length > 800 || /[\\\x00-\x1f:\x7f]/.test(value) || value.startsWith('/') || value.split('/').length > 24 || value.split('/').some(part => !part || part === '.' || part === '..'))
    fail(400, 'SKILL_PATH_INVALID', '请选择技能包内的有效相对路径')
  return value
}
function normalDirectory(path) {
  if (!existsSync(path)) { normalDirectory(dirname(path)); mkdirSync(path, { mode: 0o700 }) }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) fail(409, 'SKILL_STORAGE_INVALID', '技能存储目录必须是普通目录')
}
function checkedFile(root, path) {
  safePath(path)
  let cursor = root
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) missing()
  const realRoot = realpathSync(root)
  for (const part of path.split('/')) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) missing()
    const info = lstatSync(cursor), actual = realpathSync(cursor)
    if (info.isSymbolicLink() || !(actual === realRoot || actual.startsWith(realRoot + sep))) fail(403, 'SKILL_PATH_INVALID', '技能包不允许符号链接或跨目录读取')
  }
  if (!lstatSync(cursor).isFile()) missing()
  return cursor
}
function atom(file, value) {
  normalDirectory(dirname(file))
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) fail(409, 'SKILL_STORAGE_INVALID', '技能索引必须是普通文件')
  const encoded = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) fail(413, 'SKILL_LIBRARY_FULL', '技能索引达到容量上限，请联系管理员归档历史数据')
  const tmp = `${file}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, encoded); fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(tmp, file)
    const dirFd = openSync(dirname(file), 'r'); try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
  } finally { if (fd !== undefined) closeSync(fd); rmSync(tmp, { force: true }) }
}
function withLock(root, run) {
  // SQLite provides an OS-backed cross-process lease, released on process death.
  // It holds no library data: index.json remains the atomically published source.
  const path = join(root, 'write-lock.sqlite')
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) fail(409, 'SKILL_STORAGE_INVALID', '技能锁必须是普通文件')
  const db = new DatabaseSync(path)
  let locked = false
  try {
    db.exec('PRAGMA busy_timeout = 0')
    try { db.exec('BEGIN IMMEDIATE'); locked = true } catch (error) {
      if (/locked|busy/i.test(error.message)) fail(409, 'SKILL_LIBRARY_BUSY', '技能仓库正在更新，请稍后重试')
      throw error
    }
    const result = run()
    db.exec('COMMIT'); locked = false
    return result
  } finally {
    if (locked) { try { db.exec('ROLLBACK') } catch {} }
    db.close()
  }
}
function textOf(bytes) { if (bytes.includes(0)) return null; try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null } }
const mimeFor = path => ({ '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.py': 'text/plain', '.js': 'text/javascript', '.mjs': 'text/javascript', '.sh': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.svg': 'image/svg+xml' })[extname(path).toLowerCase()] || 'application/octet-stream'
const ignored = path => path.split('/').some(name => IGNORED.has(name) || name.endsWith('.pyc'))
function metadata(contents) {
  const match = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(contents)
  if (!match) fail(400, 'SKILL_METADATA_INVALID', 'SKILL.md 必须包含 name 与 description 的 YAML 头部')
  let data
  try { const doc = parseDocument(match[1], { uniqueKeys: true }); if (doc.errors.length) throw doc.errors[0]; data = doc.toJS({ maxAliasCount: 20 }) } catch { fail(400, 'SKILL_METADATA_INVALID', '技能 YAML 头部无效，请检查字段与缩进') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'SKILL_METADATA_INVALID', '技能 YAML 头部必须是对象')
  const name = typeof data.name === 'string' ? data.name.replace(/^autoops-/, '') : ''
  if (!/^[a-z][a-z0-9-]{0,56}$/.test(name)) fail(400, 'SKILL_NAME_INVALID', 'name 必须以小写字母开头，仅包含小写字母、数字和连字符，最多 57 个字符')
  if (typeof data.description !== 'string' || !data.description.trim() || data.description.length > 1000 || !match[2].trim()) fail(400, 'SKILL_METADATA_INVALID', '技能必须包含说明和非空指令正文')
  const tools = data['allowed-tools'] ?? data.tools
  const displayName = data['display-name'] ?? data.metadata?.['display-name']
  return { name, description: data.description.trim(), displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 80) : name, body: match[2], tools, data }
}
function validateFiles(files) {
  if (!(files instanceof Map) || !files.size || files.size > MAX_FILES) fail(413, 'SKILL_TOO_LARGE', '技能包最多 512 个文件')
  let total = 0
  const names = new Set()
  for (const [path, value] of files) {
    safePath(path)
    const key = path.normalize('NFC').toLocaleLowerCase('en-US')
    if (names.has(key)) fail(400, 'SKILL_PATH_CONFLICT', '技能包包含大小写或 Unicode 规范化冲突的文件名')
    names.add(key)
    total += value.bytes.length
    if (value.bytes.length > MAX_FILE_BYTES || total > MAX_BYTES) fail(413, 'SKILL_TOO_LARGE', '技能包最多 16 MiB，单文件最多 4 MiB')
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) if (files.has(parent)) fail(400, 'SKILL_PATH_CONFLICT', '技能包包含文件与目录冲突')
  }
}
function prepareFiles(rawFiles) {
  const files = new Map([...rawFiles].filter(([path]) => !ignored(path)))
  validateFiles(files)
  const markers = [...files.keys()].filter(path => /(?:^|\/)(?:SKILL|skill)\.md$/.test(path))
  const rootMarker = markers.find(path => path === 'SKILL.md' || path === 'skill.md')
  if (markers.length !== 1) fail(400, 'SKILL_PACKAGE_AMBIGUOUS', '请提供单个技能目录；包内须有唯一的 SKILL.md，多技能仓库请指定子目录')
  const marker = rootMarker || markers[0]
  const prefix = dirname(marker) === '.' ? '' : dirname(marker) + '/'
  const selected = new Map([...files].filter(([path]) => path.startsWith(prefix)).map(([path, value]) => [path.slice(prefix.length), value]))
  const raw = selected.get(marker.slice(prefix.length))
  const contents = textOf(raw.bytes)
  if (contents === null || raw.bytes.length > 128 * 1024) fail(400, 'SKILL_METADATA_INVALID', 'SKILL.md 必须是 UTF-8 文本且不超过 128 KiB')
  const meta = metadata(contents)
  // Preserve every source byte. Runtime adapts only the native frontmatter name in its scoped copy.
  if (marker.slice(prefix.length) !== 'SKILL.md') { selected.delete('skill.md'); selected.set('SKILL.md', raw) }
  const manifest = [...selected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, entry]) => ({ path, size: entry.bytes.length, sha256: sha(entry.bytes), executable: !!entry.executable, mime: mimeFor(path), binary: textOf(entry.bytes) === null }))
  const contentHash = sha(JSON.stringify(manifest.map(({ path, size, sha256, executable }) => [path, size, sha256, executable])))
  const blockedFiles = manifest.filter(file => /(?:^|\/)(?:scripts|node_modules|\.venv|venv)(?:\/|$)|\.(?:py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|ps1|bat|cmd|exe|dll|so|dylib|jar|wasm)$|(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|Pipfile|poetry\.lock|uv\.lock|Cargo\.toml|Gemfile|Dockerfile)$/.test(file.path) || file.executable)
  const requestedTools = Array.isArray(meta.tools) ? meta.tools : typeof meta.tools === 'string' ? meta.tools.split(/[ ,]+/).filter(Boolean) : []
  const unsupportedTools = requestedTools.filter(tool => !TOOL_NAMES.has(tool))
  const commandInstructions = /^\s*(?:`{3,}|~{3,})(?:bash|sh|shell|zsh|powershell|ps1|console|terminal|python|python3)\b/im.test(meta.body)
    || /(?:\b(?:run|execute|invoke|install)\b|运行|执行|安装)[^\n]{0,100}(?:\b(?:bash|sh|zsh|python3?|node|npm|npx|pip3?|uvx|pwsh|[a-z][a-z0-9-]*-cli)\b|scripts\/)/i.test(meta.body)
  const restricted = blockedFiles.length || unsupportedTools.length || commandInstructions || ['dependencies', 'requires', 'requirements', 'setup', 'install'].some(key => meta.data[key] != null)
  const reason = !restricted ? null : commandInstructions
    ? '技能指令需要当前运行器未开放的命令执行。包已完整保存，可预览；当前不能分配和调用，需适配受控执行环境后重新检查。'
    : '技能包含脚本、依赖或当前运行器未开放的工具。包已完整保存，可预览；当前不能分配和调用，需适配受控执行环境后重新检查。'
  return { files: selected, meta, manifest, contentHash, byteLength: manifest.reduce((sum, file) => sum + file.size, 0), readiness: restricted ? 'restricted' : 'ready', reason }
}
function scanDirectory(root) {
  const files = new Map(); let bytes = 0, entries = 0
  function visit(directory, prefix, depth) {
    if (depth > 24) fail(413, 'SKILL_TOO_LARGE', '技能目录层级过深')
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name
      if (ignored(path)) continue
      safePath(path)
      const file = join(directory, item.name), info = lstatSync(file)
      if (info.isSymbolicLink()) fail(422, 'SKILL_LINK_UNSUPPORTED', '技能包包含符号链接，请转换为普通文件再导入')
      if (++entries > MAX_FILES * 2) fail(413, 'SKILL_TOO_LARGE', '技能目录条目过多')
      if (info.isDirectory()) visit(file, path, depth + 1)
      else if (info.isFile()) {
        bytes += info.size
        if (bytes > MAX_BYTES || info.size > MAX_FILE_BYTES || files.size >= MAX_FILES) fail(413, 'SKILL_TOO_LARGE', '技能包超过文件数量或大小上限')
        files.set(path, { bytes: readFileSync(file), executable: !!(info.mode & 0o111) })
      } else fail(422, 'SKILL_FILE_UNSUPPORTED', '技能包包含特殊文件')
    }
  }
  visit(root, '', 0); return files
}
function legacySkills(dataDirectory) {
  const root = join(dataDirectory, 't3'), path = ['skills-library.json', 'skills-registry.json'].map(name => join(root, name)).find(existsSync)
  if (!path) return BUILTIN_BUSINESS_SKILLS.map(skill => ({ ...skill }))
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) fail(409, 'SKILL_LEGACY_INVALID', '原有技能目录无法安全迁移')
  const registry = JSON.parse(readFileSync(path, 'utf8'))
  if (registry.version !== 1 || !Array.isArray(registry.skills) || registry.skills.length > 32) fail(409, 'SKILL_LEGACY_INVALID', '原有技能目录版本无效')
  return registry.skills.map(skill => {
    if (!/^[a-z][a-z0-9-]{0,56}$/.test(skill.name) || typeof skill.description !== 'string' || typeof skill.instructions !== 'string' || !Array.isArray(skill.tools) || skill.tools.some(tool => !TOOL_NAMES.has(tool))) fail(409, 'SKILL_LEGACY_INVALID', '原有技能内容无法安全迁移')
    return skill
  })
}
function checkFree(root, bytes = MAX_BYTES) {
  const info = statfsSync(root)
  if (Number(info.bavail) * Number(info.bsize) < bytes + 32 * 1024 * 1024) fail(507, 'SKILL_STORAGE_LOW', '磁盘可用空间不足，原有技能仍可使用')
}
function publishVersion(root, state, prepared, source, skillId) {
  let skill = skillId ? state.skills.find(entry => entry.id === safeId(skillId) && !entry.deletedAt) : undefined
  if (skillId && !skill) missing()
  if (skill && skill.name !== prepared.meta.name) fail(409, 'SKILL_NAME_MISMATCH', '更新包的 name 与原技能不一致')
  if (!skill && state.skills.some(entry => !entry.deletedAt && entry.name === prepared.meta.name)) fail(409, 'SKILL_ALREADY_EXISTS', '该技能已存在，请从技能详情导入新版本')
  if (!skill && state.skills.filter(entry => !entry.deletedAt).length >= MAX_SKILLS) fail(413, 'SKILL_LIBRARY_FULL', '技能库已达到 256 项上限')
  if (!skill) {
    skill = { id: randomUUID(), name: prepared.meta.name, displayName: prepared.meta.displayName, description: prepared.meta.description, enabled: true, createdAt: now(), latestVersionId: '', versions: [] }
    state.skills.push(skill)
  }
  const previous = skill.versions.find(version => version.contentHash === prepared.contentHash)
  if (previous) { skill.latestVersionId = previous.id; return skill }
  checkFree(root, prepared.byteLength)
  const id = randomUUID(), versions = join(root, 'versions', skill.id), directory = join(versions, id), staging = join(root, 'staging', randomUUID())
  normalDirectory(staging)
  try {
    for (const [path, entry] of prepared.files) { const output = join(staging, path); normalDirectory(dirname(output)); writeFileSync(output, entry.bytes, { mode: entry.executable ? 0o700 : 0o600, flag: 'wx' }) }
    const verified = prepareFiles(scanDirectory(staging))
    if (verified.contentHash !== prepared.contentHash) fail(409, 'SKILL_VERIFY_FAILED', '技能包写入校验失败，原有版本保持不变')
    normalDirectory(versions); renameSync(staging, directory)
    const version = { id, createdAt: now(), description: prepared.meta.description, displayName: prepared.meta.displayName, fileCount: prepared.manifest.length, byteLength: prepared.byteLength, contentHash: prepared.contentHash, readiness: prepared.readiness, reason: prepared.reason, source: clone(source), files: prepared.manifest }
    skill.versions.push(version); skill.latestVersionId = id; skill.description = version.description; skill.displayName = version.displayName
    return skill
  } finally { rmSync(staging, { recursive: true, force: true }) }
}
function loadState(root) {
  const path = join(root, 'index.json')
  if (!existsSync(path)) missing()
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) fail(409, 'SKILL_STORAGE_INVALID', '技能索引不可读')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  if (state.version !== 2 || !Array.isArray(state.skills) || !Array.isArray(state.assignments)) fail(409, 'SKILL_STORAGE_INVALID', '技能索引版本无效')
  return state
}
export const skillLibraryRevision = state => sha(JSON.stringify(state))
function libraryRoot(dataDirectory) {
  if (typeof dataDirectory !== 'string' || !dataDirectory) throw new TypeError('dataDirectory is required')
  const root = resolve(dataDirectory, 't3', 'skill-library-v2')
  normalDirectory(root)
  if (!existsSync(join(root, 'index.json'))) withLock(root, () => {
    if (existsSync(join(root, 'index.json'))) return
    const state = { version: 2, createdAt: now(), skills: [], assignments: [] }
    for (const original of legacySkills(dataDirectory)) {
      const contents = `---\nname: ${original.name}\ndescription: ${JSON.stringify(original.description)}\ndisplay-name: ${JSON.stringify(original.displayName || original.name)}\nallowed-tools: ${JSON.stringify(original.tools)}\n---\n\n# 适用范围\n仅使用当前会话已经授予的业务工具。此技能不会扩大任何权限。\n\n${original.instructions}\n`
      const skill = publishVersion(root, state, prepareFiles(new Map([['SKILL.md', { bytes: Buffer.from(contents), executable: false }]])), { type: original.builtin ? 'builtin' : 'legacy' })
      skill.enabled = original.enabled !== false; skill.builtin = !!original.builtin
      for (const agentId of ['a-project', 'a-report']) state.assignments.push({ id: randomUUID(), targetType: 'agent', targetId: agentId, skillId: skill.id, versionId: skill.latestVersionId, workspaceTypes: original.builtin ? ['internal', 'external'] : ['internal'], enabled: true, createdAt: now() })
    }
    atom(join(root, 'index.json'), state)
  })
  return root
}
export function readSkillLibrary(dataDirectory) { const root = libraryRoot(dataDirectory); return clone(loadState(root)) }
export function projectSkillDeletionReferences(dataDirectory, projectId, environmentId) {
  if (environmentId !== undefined) return []
  const root = resolve(dataDirectory,'t3','skill-library-v2')
  if (!existsSync(join(root,'index.json'))) return []
  const count = loadState(root).assignments.filter(value => value.targetType === 'project' && value.targetId === projectId).length
  return count ? [{kind:'project-skills',count,message:'项目仍有技能分配'}] : []
}
function getVersion(state, skillId, versionId) {
  const skill = state.skills.find(entry => entry.id === safeId(skillId)), version = skill?.versions.find(entry => entry.id === safeId(versionId))
  if (!skill || !version) missing()
  return { skill, version }
}
function resolvedVersion(root, skill, version) {
  const packageRoot = join(root, 'versions', safeId(skill.id), safeId(version.id))
  return { id: skill.id, skillId: skill.id, name: `autoops-${skill.name}`, versionId: version.id, contentHash: version.contentHash, packageRoot, path: join(packageRoot, 'SKILL.md'), description: version.description, displayName: version.displayName, enabled: skill.enabled && !skill.deletedAt, readiness: version.readiness, reason: version.reason, files: clone(version.files) }
}
export function readSkillLibraryVersion(dataDirectory, skillId, versionId) {
  const root = libraryRoot(dataDirectory), { skill, version } = getVersion(loadState(root), skillId, versionId)
  const result = resolvedVersion(root, skill, version)
  const file = checkedFile(result.packageRoot, 'SKILL.md'), bytes = readFileSync(file), expected = version.files.find(entry => entry.path === 'SKILL.md')
  if (!expected || sha(bytes) !== expected.sha256) fail(409, 'SKILL_CONTENT_CHANGED', '技能内容已变化，请重新导入并检查')
  return { ...result, instructions: bytes.toString('utf8') }
}
export function resolveSkillLibrary(dataDirectory, scope) {
  if (!scope || !scope.projectId || !scope.agentId || !['internal', 'external'].includes(scope.workspaceType)) return []
  const root = libraryRoot(dataDirectory), state = loadState(root)
  const result = []
  const selected = scope.skillIds ?? scope.question?.configuration.skillIds
  for (const skill of state.skills) {
    if (!skill.enabled || skill.deletedAt || (selected !== undefined && !selected.includes(skill.id))) continue
    // Project assignment wins even when disabled or excluding this workspace.
    const assignment = state.assignments.find(entry => entry.skillId === skill.id && entry.targetType === 'project' && entry.targetId === scope.projectId)
      ?? state.assignments.find(entry => entry.skillId === skill.id && entry.targetType === 'agent' && entry.targetId === scope.agentId)
    if (!assignment?.enabled || !assignment.workspaceTypes.includes(scope.workspaceType)) continue
    const version = skill.versions.find(entry => entry.id === assignment.versionId)
    if (version?.readiness !== 'ready') continue
    result.push(resolvedVersion(root, skill, version))
  }
  return result
}
function validateRepository(value) {
  let url
  try { url = new URL(value) } catch { fail(400, 'SKILL_REPOSITORY_INVALID', '请填写公开 HTTPS Git 仓库地址') }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/.test(url.pathname) || url.pathname.split('/').some(part => part === '.' || part === '..')) fail(400, 'SKILL_REPOSITORY_INVALID', '仅支持 GitHub、GitLab.com、Gitee、Codeberg 的公开 HTTPS 仓库，不能包含凭据、端口或参数')
  return url.toString()
}
async function git(args, cwd, budgetRoot, deadline) {
  return new Promise((resolvePromise, reject) => {
    const controller = new AbortController(); let budgetError, output = '', done = false
    const child = spawn('git', ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', ...args], { cwd, signal: controller.signal, windowsHide: true, env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ALLOW_PROTOCOL: 'https' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => { budgetError = new SkillLibraryError(504, 'SKILL_GIT_TIMEOUT', 'Git 导入超时，请稍后重试'); controller.abort() }, Math.max(1, deadline - Date.now()))
    const budget = setInterval(() => {
      try {
        checkFree(budgetRoot)
        let bytes = 0, count = 0
        const visit = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name), info = lstatSync(path); if (info.isSymbolicLink()) continue; if (info.isDirectory()) visit(path); else bytes += info.size; if (++count > 10000 || bytes > 64 * 1024 * 1024) fail(413, 'SKILL_GIT_TOO_LARGE', 'Git 导入超过 64 MiB 暂存上限') } }
        visit(budgetRoot)
      } catch (error) { budgetError = error; controller.abort() }
    }, 200)
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 1024 * 1024) { budgetError = new SkillLibraryError(413, 'SKILL_GIT_TOO_LARGE', 'Git 返回数据过大'); controller.abort() } })
    child.stderr.resume()
    const finish = (error) => { if (done) return; done = true; clearTimeout(timeout); clearInterval(budget); if (error) reject(budgetError || error); else resolvePromise(output.trim()) }
    child.on('error', () => finish(new SkillLibraryError(502, 'SKILL_GIT_FAILED', 'Git 操作失败，请检查安装与网络')))
    child.on('close', code => finish(code === 0 && !budgetError ? undefined : new SkillLibraryError(502, 'SKILL_GIT_FAILED', 'Git 操作失败，请检查公开仓库及固定提交号')))
  })
}
export function createSkillLibrary(dataDirectory) {
  const root = libraryRoot(dataDirectory)
  const catalog = () => { const state = loadState(root); return { revision: skillLibraryRevision(state), skills: clone(state.skills.filter(skill => !skill.deletedAt)), assignments: clone(state.assignments) } }
  const mutate = (input, fn) => withLock(root, () => {
    const state = loadState(root)
    if (input.revision !== skillLibraryRevision(state)) fail(409, 'SKILL_REVISION_CONFLICT', '技能仓库已更新，请刷新后重试')
    fn(state); atom(join(root, 'index.json'), state); return catalog()
  })
  const importPrepared = (input, files, source) => { const prepared = prepareFiles(files); return mutate(input, state => publishVersion(root, state, prepared, source, input.skillId)) }
  return {
    catalog,
    importMarkdown(input) {
      if (typeof input.contents !== 'string' || Buffer.byteLength(input.contents) > 128 * 1024) fail(413, 'SKILL_TOO_LARGE', 'SKILL.md 正文最多 128 KiB')
      return importPrepared(input, new Map([['SKILL.md', { bytes: Buffer.from(input.contents), executable: false }]]), { type: 'markdown' })
    },
    importArchive(input) {
      if (typeof input.archiveBase64 !== 'string' || input.archiveBase64.length > Math.ceil(MAX_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.archiveBase64) || input.archiveBase64.length % 4) fail(413, 'SKILL_ARCHIVE_INVALID', '请上传不超过 16 MiB 的 ZIP 技能包')
      const data = Buffer.from(input.archiveBase64, 'base64'), files = new Map()
      let entries
      try { entries = inspectZip(data, { maxBytes: MAX_BYTES, maxFiles: MAX_FILES * 2, maxFileBytes: MAX_FILE_BYTES }) } catch { fail(400, 'SKILL_ARCHIVE_INVALID', 'ZIP 包格式、路径或体积无效，不允许符号链接与特殊文件') }
      for (const entry of entries) {
        safePath(entry.name)
        if (entry.directory || ignored(entry.name)) continue
        const compressed = data.subarray(entry.body, entry.body + entry.packed)
        let bytes
        try { bytes = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) }) } catch { fail(400, 'SKILL_ARCHIVE_INVALID', 'ZIP 文件解压失败') }
        if (bytes.length !== entry.size || crc32(bytes) !== entry.expectedCrc) fail(400, 'SKILL_ARCHIVE_INVALID', 'ZIP 文件内容校验失败')
        files.set(entry.name, { bytes, executable: !!(entry.mode & 0o111) })
      }
      return importPrepared(input, files, { type: 'archive', fileName: typeof input.fileName === 'string' ? input.fileName.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200) : 'skill.zip' })
    },
    async importGit(input) {
      const url = validateRepository(input.url), commit = typeof input.ref === 'string' ? input.ref.toLowerCase() : ''
      if (!/^[a-f0-9]{40}$/.test(commit)) fail(400, 'SKILL_COMMIT_REQUIRED', '请填写完整的 40 位 Git 提交号，确保导入内容可复现')
      const subdirectory = safePath(input.subdirectory || '', true)
      if (input.revision !== catalog().revision) fail(409, 'SKILL_REVISION_CONFLICT', '技能仓库已更新，请刷新后重试')
      const staging = join(root, 'git-staging', randomUUID()), deadline = Date.now() + 90_000; normalDirectory(staging)
      try {
        await git(['init', '--quiet'], staging, staging, deadline)
        await git(['remote', 'add', 'origin', url], staging, staging, deadline)
        await git(['config', 'remote.origin.promisor', 'true'], staging, staging, deadline)
        await git(['config', 'remote.origin.partialclonefilter', 'blob:none'], staging, staging, deadline)
        await git(['fetch', '--depth=1', '--no-tags', '--filter=blob:none', 'origin', commit], staging, staging, deadline)
        const actual = await git(['rev-parse', 'FETCH_HEAD'], staging, staging, deadline)
        if (actual !== commit) fail(409, 'SKILL_COMMIT_MISMATCH', '远端返回的提交与指定版本不一致')
        if (subdirectory) {
          await git(['sparse-checkout', 'init', '--no-cone'], staging, staging, deadline)
          await git(['sparse-checkout', 'set', '--no-cone', '--', `/${subdirectory}/`], staging, staging, deadline)
        }
        await git(['checkout', '--detach', '--quiet', 'FETCH_HEAD'], staging, staging, deadline)
        let source = staging
        for (const part of subdirectory.split('/').filter(Boolean)) { source = join(source, part); if (!existsSync(source) || lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory()) fail(400, 'SKILL_DIRECTORY_INVALID', 'Git 仓库中不存在该普通技能目录') }
        return importPrepared(input, scanDirectory(source), { type: 'git', url, commit, subdirectory })
      } finally { rmSync(staging, { recursive: true, force: true }) }
    },
    setEnabled(input) { return mutate(input, state => { const skill = state.skills.find(entry => entry.id === input.skillId && !entry.deletedAt); if (!skill) missing(); if (typeof input.enabled !== 'boolean') fail(400, 'SKILL_INPUT_INVALID', '启用状态无效'); skill.enabled = input.enabled }) },
    assign(input) { return mutate(input, state => {
      const { skill, version } = getVersion(state, input.skillId, input.versionId)
      if (skill.deletedAt) missing()
      if (version.readiness !== 'ready') fail(409, 'SKILL_NOT_READY', '此版本运行条件尚未就绪，当前不能分配或调用')
      if (!['agent', 'project'].includes(input.targetType) || typeof input.targetId !== 'string' || !input.targetId || input.targetId.length > 120 || !Array.isArray(input.workspaceTypes) || !input.workspaceTypes.length || input.workspaceTypes.some(type => !['internal', 'external'].includes(type)) || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) fail(400, 'SKILL_ASSIGNMENT_INVALID', '请选择有效的范围、工作区与版本')
      const previous = state.assignments.find(entry => entry.skillId === input.skillId && entry.targetType === input.targetType && entry.targetId === input.targetId)
      const value = { id: previous?.id || randomUUID(), skillId: input.skillId, versionId: input.versionId, targetType: input.targetType, targetId: input.targetId, workspaceTypes: [...new Set(input.workspaceTypes)], enabled: input.enabled !== false, createdAt: previous?.createdAt || now(), updatedAt: now() }
      if (previous) Object.assign(previous, value); else state.assignments.push(value)
    }) },
    unassign(input) { return mutate(input, state => { const assignment = state.assignments.find(entry => entry.id === input.assignmentId); if (!assignment) missing(); state.assignments = state.assignments.filter(entry => entry.id !== input.assignmentId) }) },
    remove(input) { return mutate(input, state => { const skill = state.skills.find(entry => entry.id === input.skillId && !entry.deletedAt); if (!skill) missing(); if (state.assignments.some(entry => entry.skillId === input.skillId)) fail(409, 'SKILL_STILL_ASSIGNED', '请先移除所有范围分配，再从技能仓库移除'); skill.enabled = false; skill.deletedAt = now() }) },
    verify(input) { return mutate(input, state => {
      const { skill, version } = getVersion(state, input.skillId, input.versionId)
      const actual = prepareFiles(scanDirectory(join(root, 'versions', skill.id, version.id)))
      if (actual.contentHash !== version.contentHash) fail(409, 'SKILL_CONTENT_CHANGED', '技能包内容或权限已变化，请重新导入；原有版本不能修改')
      version.readiness = actual.readiness; version.reason = actual.reason; version.verifiedAt = now()
    }) },
    readFile(skillId, versionId, path, raw = false) {
      const { skill, version } = getVersion(loadState(root), skillId, versionId), entry = version.files.find(file => file.path === safePath(path))
      if (!entry) missing()
      const bytes = readFileSync(checkedFile(join(root, 'versions', skill.id, version.id), path))
      if (sha(bytes) !== entry.sha256 || bytes.length !== entry.size) fail(409, 'SKILL_CONTENT_CHANGED', '技能文件校验失败，请重新导入')
      if (raw) return { name: path.split('/').at(-1), mime: entry.mime, bytes }
      const contents = entry.size <= MAX_READ_BYTES ? textOf(bytes) : null
      return { path, contents, encoding: contents === null ? 'binary' : 'utf8', size: entry.size, mime: entry.mime, ...(entry.size > MAX_READ_BYTES ? { reason: '文件超过 256 KiB，请下载查看完整内容' } : {}) }
    },
  }
}
