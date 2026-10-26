import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, statfsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { WorkspaceError, MAX_FILES, MAX_BYTES, sha, safePath, textOf, checkedFile, checkImportFiles, scan } from './workspace-files.mjs'
import { createWorkspaceJobs } from './workspace-jobs.mjs'
import { buildWorkspacePackages } from './workspace-packages.mjs'
export { WorkspaceError } from './workspace-files.mjs'
import { validateBranch } from '../../src/archive.mjs'

// 输入均以不可变版本保存；目录仅是存储布局，授权仍由网关与资料适配器完成。
const SCHEMA_VERSION = 1
const RULES_VERSION = 'autoops-secrets-v1'
const PROCESS_INSTANCE_ID = randomUUID()
const MAX_READ_BYTES = 64 * 1024
const STORAGE_RESERVE = 32 * 1024 * 1024
const PACKAGE_RETENTION_MS = 7 * 86400000
const SUPPORTED_HOSTS = new Set(['github.com', 'gitlab.com', 'gitee.com', 'codeberg.org'])
const now = () => new Date().toISOString()
const clone = (value) => structuredClone(value)
const packageTerminal = (task) => task?.type === 'packages' && ['completed', 'failed', 'interrupted'].includes(task.status)

const fail = (status, code, message) => { throw new WorkspaceError(status, code, message) }
const missing = () => fail(404, 'WORKSPACE_NOT_FOUND', '工作区版本不存在或尚未发布')
function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) missing()
  return value
}
function atom(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}
function publicVersion(value) {
  const { files: _files, directory: _directory, packageUsedAt: _packageUsedAt, ...rest } = value
  return clone(rest)
}
function publicTask(value) {
  const { fingerprint: _fingerprint, ownerPid: _ownerPid, ownerInstanceId: _ownerInstanceId, actorId: _actorId, sourceVersionId: _sourceVersionId, captureId: _captureId, ...rest } = value
  return clone(rest)
}
function livePid(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function taskOwnerAlive(task) {
  // 同进程的多个存储共享实例标记，进程号复用不能让旧任务伪装成当前队列。
  return livePid(task.ownerPid) && (task.ownerPid !== process.pid || task.ownerInstanceId === PROCESS_INSTANCE_ID)
}
function checkFree(directory, required = STORAGE_RESERVE) {
  const stats = statfsSync(directory)
  if (Number(stats.bavail) * Number(stats.bsize) < required) fail(507, 'WORKSPACE_STORAGE_LOW', '可用磁盘不足，请清理空间后重试；原有已发布版本仍可使用')
}
function checkImportBudget(directory) {
  checkFree(directory)
  checkImportFiles(directory)
}

function checkCompleteSource(root) {
  const indexed = scan(root)
  for (const file of indexed.files.filter((entry) => !entry.path.split('/').includes('.git'))) {
    const bytes = readFileSync(checkedFile(root, file.path))
    if (bytes.subarray(0, 100).toString().startsWith('version https://git-lfs.github.com/spec/v1')) fail(422, 'WORKSPACE_LFS_UNSUPPORTED', '该仓库包含未下载的 Git LFS 文件，不能将指针当作完整源码发布')
  }
}

function redact(text, rules) {
  let replacements = 0
  const replace = (pattern, value) => { text = text.replace(pattern, (...args) => { replacements++; return typeof value === 'function' ? value(...args) : value }) }
  // 先应用项目映射，再以凭据规则检查最终输出，避免自定义替换重新带入敏感值。
  for (const rule of rules) {
    if (!text.includes(rule.find)) continue
    const parts = text.split(rule.find); replacements += parts.length - 1; text = parts.join(rule.replace)
  }
  replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/g, '[私钥已脱敏]')
  replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, (_match, protocol) => `${protocol}[凭据已脱敏]@`)
  // 保留字段名及代码结构，不将任何命中的原文写入报告。
  replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret(?:[_-]?key)?|password|passwd|token|authorization|database[_-]?url|redis[_-]?url)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi, (_match, field) => `${field}"[已脱敏]"`)
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[凭据已脱敏]')
  replace(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g, '[内部地址已脱敏]')
  replace(/\/(?:Users|home)\/[^\s"'`<>]+/g, '[内部路径已脱敏]')
  return { text, replacements }
}
function validateRules(rules = []) {
  if (!Array.isArray(rules) || rules.length > 100) fail(400, 'WORKSPACE_RULE_INVALID', '最多设置 100 条项目替换规则')
  return rules.map((rule) => {
    if (!rule || typeof rule.find !== 'string' || !rule.find || rule.find.length > 1000 || typeof rule.replace !== 'string' || rule.replace.length > 1000)
      fail(400, 'WORKSPACE_RULE_INVALID', '替换规则必须填写要查找的文字与替换内容')
    return { find: rule.find, replace: rule.replace }
  })
}
function validateRepository(repositoryUrl) {
  let url
  try { url = new URL(repositoryUrl) } catch { fail(400, 'WORKSPACE_REPOSITORY_INVALID', '请填写 HTTPS Git 仓库地址') }
  if (url.protocol !== 'https:' || !SUPPORTED_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/.test(url.pathname) || url.pathname.split('/').some((part) => part === '.' || part === '..'))
    fail(400, 'WORKSPACE_REPOSITORY_INVALID', '仅支持 GitHub、GitLab.com、Gitee、Codeberg 的公开 HTTPS 仓库；地址不能含凭据、端口或参数')
  return url.toString()
}
async function git(args, cwd, signal, { budgetRoot } = {}) {
  return new Promise((resolvePromise, reject) => {
    const budgetController = new AbortController()
    let budgetError, processError, timer
    const effectiveSignal = signal ? AbortSignal.any([signal, budgetController.signal]) : budgetController.signal
    const child = spawn('git', ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', ...args], {
      cwd, signal: effectiveSignal, windowsHide: true,
      env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ALLOW_PROTOCOL: 'https' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (bytes) => { output += bytes.toString(); if (output.length > 1024 * 1024) child.kill() })
    child.stderr.resume() // 远端及 Git 错误可能包含凭据，绝不回传原文。
    if (budgetRoot) timer = setInterval(() => {
      try { checkImportBudget(budgetRoot) } catch (error) { budgetError = error instanceof WorkspaceError ? error : new WorkspaceError(507, 'WORKSPACE_STORAGE_CHECK_FAILED', '无法检查导入存储，任务已停止'); budgetController.abort() }
    }, 200)
    // 错误发生后仍等子进程关闭，避免中止时清理仍在写入的临时目录。
    child.on('error', (error) => { processError = error })
    child.on('close', (code) => { clearInterval(timer); if (budgetError || processError) reject(budgetError || processError); else if (code === 0) resolvePromise(output.trim()); else reject(new WorkspaceError(502, 'WORKSPACE_GIT_FAILED', 'Git 操作失败，请检查公开仓库地址、分支、网络与 Git 安装')) })
  })
}

export function createWorkspaceStore({ dataDir, taskLimits, onTaskDiagnostic, authorizeTask }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required')
  const base = resolve(dataDir, 'project-workspaces'), initializing = new Map()
  const failedPersistenceTasks = new Set()
  const runningPackages = new Set()
  const jobs = createWorkspaceJobs({ ...taskLimits, onFailure(event) {
    failedPersistenceTasks.add(event.taskId)
    if (onTaskDiagnostic) onTaskDiagnostic(event)
    else console.error(JSON.stringify(event))
  } })
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const projectRoot = (id) => join(base, safeId(id))
  const stateFile = (id) => join(projectRoot(id), 'state.json')
  function load(id) {
    const file = stateFile(id)
    if (!existsSync(file)) missing()
    const state = JSON.parse(readFileSync(file, 'utf8'))
    let changed = false
    for (const task of state.tasks) if (['queued', 'running'].includes(task.status) && (!taskOwnerAlive(task) || failedPersistenceTasks.has(task.id))) {
      task.status = 'interrupted'; task.stage = 'interrupted'; task.message = failedPersistenceTasks.has(task.id) ? '任务状态保存失败，任务已中断，原有已发布版本仍可使用' : '服务重启中断了任务，原有已发布版本仍可使用'; changed = true
      if (task.type === 'packages') task.finishedAt = now()
    }
    for (const task of state.tasks) if (packageTerminal(task) && !runningPackages.has(task.id) && state.protectedReferences?.[`task:${task.id}`]) {
      // 只归还本模块打包任务的输入；交付包和调用方持有的其他引用继续保护原件。
      const version = state.versions.find(value => value.id === state.protectedReferences[`task:${task.id}`])
      if (version?.cachePurpose === 'deployment') {
        const finishedAt = task.finishedAt ?? now()
        if (!version.packageUsedAt || Date.parse(finishedAt) > Date.parse(version.packageUsedAt)) version.packageUsedAt = finishedAt
        task.sourceVersionId ??= version.id
      }
      delete state.protectedReferences[`task:${task.id}`]; changed = true
    }
    if (changed) { atom(file, state); for (const task of state.tasks) if (task.status === 'interrupted') failedPersistenceTasks.delete(task.id) }
    return state
  }
  function save(id, state) { atom(stateFile(id), state) }
  function versionRecord(id, versionId, allowPending = false) {
    safeId(versionId)
    const state = load(id), version = state.versions.find((entry) => entry.id === versionId)
    if (!version || (!allowPending && version.status !== 'published')) missing()
    return version
  }
  const versionRoot = (id, version) => join(projectRoot(id), 'versions', safeId(version.id), 'files')
  function updateTask(id, taskId, changes) {
    const state = load(id), task = state.tasks.find((entry) => entry.id === taskId)
    if (!task) missing()
    Object.assign(task, changes)
    if (packageTerminal(task)) task.finishedAt ??= now()
    save(id, state)
    return task
  }
  function authorize(actorId, projectId, type) {
    if (typeof authorizeTask !== 'function') fail(503, 'WORKSPACE_AUTHORIZATION_REQUIRED', '工作区任务尚未配置授权检查')
    const decision = authorizeTask({ actorId, projectId, type })
    if (decision?.then) {
      Promise.resolve(decision).catch(() => {})
      fail(503, 'WORKSPACE_AUTHORIZATION_REQUIRED', '工作区授权端口必须同步返回当前权限')
    }
  }
  function requestTask(id, type, input, actorId) {
    const state = load(id)
    const requestId = input.requestId
    if (typeof requestId !== 'string' || !requestId || requestId.length > 160 || /[\x00-\x1f]/.test(requestId)) fail(400, 'WORKSPACE_REQUEST_ID_INVALID', '任务需要有效的幂等请求标识')
    authorize(actorId, id, type)
    const fingerprint = sha(JSON.stringify({ ...input, requestId: undefined, actorId }))
    const previous = state.tasks.find((task) => task.type === type && task.requestId === requestId)
    if (previous && previous.fingerprint !== fingerprint) fail(409, 'WORKSPACE_REQUEST_CONFLICT', '该请求标识已用于其他参数，请刷新后重试')
    return { state, requestId, fingerprint, previous }
  }
  function start(id, type, input, run, actorId) {
    const { state, requestId, fingerprint, previous } = requestTask(id, type, input, actorId)
    if (previous) return publicTask(previous)
    jobs.assertCapacity()
    const task = { id: randomUUID(), type, actorId, status: 'queued', stage: 'queued', message: '任务已排队', createdAt: now(), requestId, fingerprint, ownerPid: process.pid, ownerInstanceId: PROCESS_INSTANCE_ID,...(type==='external'?{sourceVersionId:input.sourceVersionId}:{}),...(['snapshot','sync','input'].includes(type)&&input.captureId?{captureId:input.captureId}:{}) }
    state.tasks.unshift(task); save(id, state)
    jobs.submit(task.id, async (signal) => {
      if (type === 'packages') runningPackages.add(task.id)
      const temporary = join(projectRoot(id), 'staging', task.id)
      const progress = (stage, message, changes = {}) => {
        if (signal.aborted) throw new WorkspaceError(409, 'WORKSPACE_TASK_CANCELLED', '任务已取消')
        updateTask(id, task.id, { status: 'running', stage, message, ...changes })
      }
      let authorized = false
      try {
        // 领取时使用当前成员事实重查，持久任务不沿用浏览器会话或提交时的角色快照。
        authorize(task.actorId, id, task.type)
        authorized = true
        progress('preparing', '正在固定输入版本')
        checkFree(projectRoot(id))
        await mkdir(temporary, { recursive: true, mode: 0o700 })
        await run({ task, temporary, progress, signal })
      } catch (error) {
        const cancelled = signal.aborted, revoked = !authorized && [401, 403, 404].includes(error?.status)
        const message = cancelled ? '任务已取消，原有已发布版本仍可使用' : revoked ? '操作人权限已失效，工作区任务未执行' : error instanceof WorkspaceError ? error.message : '处理失败，请检查来源、Git 与可用存储后重试'
        updateTask(id, task.id, { status: cancelled || revoked ? 'interrupted' : 'failed', stage: cancelled ? 'cancelled' : revoked ? 'interrupted' : 'failed', message, error: message, ...(typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? { failureCode: error.code } : {}) })
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => {})
        if (type === 'packages') {
          try {
            const state = load(id), saved = state.tasks.find(value => value.id === task.id)
            if (packageTerminal(saved)) { saved.finishedAt = now(); save(id, state) }
          } finally { runningPackages.delete(task.id) }
          load(id)
        }
      }
    })
    return publicTask(task)
  }
  function source(id, sourceVersionId) {
    const value = versionRecord(id, sourceVersionId)
    if (value.type !== 'internal') fail(400, 'WORKSPACE_SOURCE_INVALID', '请选择内部原始版本作为来源')
    return value
  }
  async function persistVersion(id, root, record, taskId, signal) {
    if (signal?.aborted) throw new Error('cancelled')
    const indexed = scan(root)
    const version = { ...record, fileCount: indexed.files.length, byteLength: indexed.byteLength, source: { ...record.source, contentHash: indexed.contentHash }, files: indexed.files }
    const destination = join(projectRoot(id), 'versions', version.id)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await rename(dirname(root), destination)
    if (signal?.aborted) { await rm(destination, { recursive: true, force: true }); throw new Error('cancelled') }
    const state = load(id)
    state.versions.unshift(version)
    if (taskId && record.cachePurpose) { state.protectedReferences ??= {}; state.protectedReferences[`task:${taskId}`] = version.id }
    if (taskId) {
      const task = state.tasks.find((entry) => entry.id === taskId)
      Object.assign(task, { status: 'completed', stage: 'completed', versionId: version.id, message: version.status === 'pending_review' ? '脱敏完成，有文件需要确认后发布' : '工作区版本已发布' })
    }
    save(id, state)
    return version
  }
  async function writeFiles(root, entries) {
    for (const [path, content] of Object.entries(entries)) {
      safePath(path); await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 }); await writeFile(join(root, path), content, { mode: 0o600 })
    }
  }
  function readVersionFile(id, versionId, path, allowPending) {
    safePath(path)
    const version = versionRecord(id, versionId, allowPending), file = version.files.find((entry) => entry.path === path)
    if (!file) missing()
    let bytes
    try { bytes = readFileSync(checkedFile(versionRoot(id, version), path)) } catch (error) { if (error instanceof WorkspaceError) throw error; missing() }
    if (sha(bytes) !== file.sha256) fail(409, 'WORKSPACE_CONTENT_CHANGED', '版本文件校验失败，请重新生成版本')
    return { bytes, name: file.name, mime: file.mime }
  }
  function checkedSource(id, parent) {
    const root = versionRoot(id, parent), indexed = scan(root)
    if (indexed.contentHash !== parent.source.contentHash) fail(409, 'WORKSPACE_CONTENT_CHANGED', '内部固定版本校验失败，请重新导入来源')
    return root
  }
  function versionTree(id, versionId, directory = '', allowPending = false) {
    safePath(directory, true)
    const version = versionRecord(id, versionId, allowPending), prefix = directory ? `${directory}/` : '', entries = new Map()
    for (const file of version.files) {
      if (!file.path.startsWith(prefix)) continue
      const rest = file.path.slice(prefix.length), part = rest.split('/')[0]
      if (!part) continue
      const path = prefix + part
      entries.set(path, rest.includes('/') ? { path, name: part, kind: 'directory', size: 0 } : { path, name: part, kind: 'file', size: file.size })
    }
    if (directory && !entries.size && !version.files.some((entry) => entry.path.startsWith(prefix))) missing()
    const result = [...entries.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
    return { entries: result.slice(0, 500), truncated: result.length > 500 }
  }
  function versionText(id, versionId, path, allowPending = false) {
    const { bytes, name, mime } = readVersionFile(id, versionId, path, allowPending)
    const text = textOf(bytes)
    if (text === null) fail(415, 'WORKSPACE_NOT_TEXT', '该文件为二进制内容，请下载原件后确认保留或排除')
    const truncated = bytes.length > MAX_READ_BYTES
    const contents = truncated ? new TextDecoder().decode(bytes.subarray(0, MAX_READ_BYTES)) : text
    return { path, name, mime, contents, byteLength: bytes.length, truncated }
  }
  async function ensureProject(project, options = {}) {
    jobs.assertAccepting()
    const id = safeId(project.id)
    if (existsSync(stateFile(id))) return
    if (initializing.has(id)) return initializing.get(id)
    const work = (async () => {
      const root = projectRoot(id), lock = join(root, '.initialize-lock')
      await mkdir(root, { recursive: true, mode: 0o700 })
      try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        for (let attempt = 0; attempt < 100; attempt++) {
          if (existsSync(stateFile(id))) return
          await new Promise((done) => setTimeout(done, 100))
        }
        fail(503, 'WORKSPACE_INITIALIZING', '工作区正在初始化，请稍后重试')
      }
      const versionId = randomUUID(), staging = join(root, 'staging', `seed-${versionId}`), files = join(staging, 'files')
      try {
        if (existsSync(stateFile(id))) return
        if (options.initialContent !== 'example') {
          save(id, { schemaVersion: SCHEMA_VERSION, projectId: id, versions: [], releases: [], tasks: [] })
          return
        }
        await mkdir(files, { recursive: true, mode: 0o700 })
        const entries = {
          'WORKSPACE.md': `# ${project.name}：示例工作区\n\n本目录是用于验证流程的最小示例，不是项目实际源码。内部与外部版本均只读。\n\n- frontend/：前端源码与 Git 历史\n- backend/：后端源码与 Git 历史\n- docs/：需求、设计与项目资料\n- prototypes/：原型与需要确认的图片\n\n外部版本单向生成并固定内容；前后端部署包从内部版本生成。示例中的账号、密钥及内部地址均为虚构测试数据。\n`,
          'frontend/package.json': JSON.stringify({ name: 'autoops-workspace-example-frontend', private: true, type: 'module', scripts: { build: 'node build.mjs' } }, null, 2),
          'frontend/package-lock.json': JSON.stringify({ name: 'autoops-workspace-example-frontend', lockfileVersion: 3, packages: { '': { name: 'autoops-workspace-example-frontend' } } }, null, 2),
          'frontend/build.mjs': "import { mkdirSync, copyFileSync } from 'node:fs'\nmkdirSync('dist', { recursive: true }); copyFileSync('index.html', 'dist/index.html')\n",
          'frontend/index.html': '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>工作区示例</title><h1>AutoOps 工作区示例</h1><p>这是可独立构建的前端部署包。</p></html>\n',
          'frontend/.gitignore': 'dist/\nnode_modules/\n',
          'backend/package.json': JSON.stringify({ name: 'autoops-workspace-example-backend', private: true, type: 'module', scripts: { start: 'node server.mjs', build: 'node --check server.mjs' } }, null, 2),
          'backend/package-lock.json': JSON.stringify({ name: 'autoops-workspace-example-backend', lockfileVersion: 3, packages: { '': { name: 'autoops-workspace-example-backend' } } }, null, 2),
          'backend/server.mjs': "import { createServer } from 'node:http'\nconst port = Number(process.env.PORT || 3000)\ncreateServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, source: 'workspace-example' })) }).listen(port, '127.0.0.1')\n",
          'backend/.env.example': '# 虚构测试值，仅用于验证脱敏\nAPI_KEY=sk-example-workspace-not-real-1234567890\nPASSWORD=example-password-not-real\nSERVICE_HOST=192.168.99.10\n',
          'backend/.gitignore': 'node_modules/\n.env\n',
          'docs/需求说明.md': '# 项目需求\n\n此示例验证两个工作区与前后端部署包。项目代号：INTERNAL-DEMO。内部示例服务地址：192.168.99.10。\n\n所有凭据均为虚构内容，不能连接真实服务。\n',
          'prototypes/页面原型.html': '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>示例原型</title><main><h1>项目工作区</h1><button>内部工作区</button><button>外部工作区</button><button>部署发布</button></main></html>',
          'prototypes/示例图片.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=', 'base64'),
        }
        for (const document of project.documents || []) entries[`docs/${String(document.name || document.id).replace(/[\\/\x00-\x1f:]/g, '_')}`] = String(document.content || '')
        await writeFiles(files, entries)
        const repositories = []
        for (const service of ['frontend', 'backend']) {
          const cwd = join(files, service)
          await git(['init', '--initial-branch=main'], cwd)
          await git(['add', '.'], cwd)
          await git(['-c', 'user.name=AutoOps 示例', '-c', 'user.email=workspace-example@invalid.local', 'commit', '-m', '初始化示例工作区'], cwd)
          repositories.push({ path: service, commit: await git(['rev-parse', 'HEAD'], cwd) })
        }
        save(id, { schemaVersion: SCHEMA_VERSION, projectId: id, versions: [], releases: [], tasks: [] })
        await persistVersion(id, files, { id: versionId, name: '内部示例 v001', type: 'internal', status: 'published', createdAt: now(), source: { repositories }, isExample: true })
      } catch (error) {
        if (existsSync(stateFile(id)) && load(id).versions.length === 0) rmSync(stateFile(id), { force: true })
        throw error
      } finally { await rm(staging, { recursive: true, force: true }); await rm(lock, { recursive: true, force: true }) }
    })()
    initializing.set(id, work)
    try { await work } finally { initializing.delete(id) }
  }

  async function packageSource(id, parent, input, { task, temporary, progress, signal }) {
    const services = input.services
        const releaseId = randomUUID(), output = join(temporary, 'release'), root = versionRoot(id, parent)
        await mkdir(output, { recursive: true, mode: 0o700 })
        progress('packaging', '正在按服务构建上下文生成源码 ZIP')
        const { artifacts, contexts } = await buildWorkspacePackages({ root, parent, services, output, contexts: input.contexts }, signal)
        progress('verifying', '正在校验部署包与固定来源')
        const manifest = { schemaVersion: 1, projectId: id, releaseId, sourceVersionId: parent.id, source: publicVersion(parent).source, createdAt: now(), configurationRef: '由部署目标环境配置提供；源码包不注入平台凭据', services: artifacts.map((entry) => ({ ...entry, context: contexts.find((item) => item.service === entry.service) })), status: 'packaged', notice: '已生成源码交付包，尚未在目标服务器部署；构建、健康检查与回退由部署任务独立执行' }
        await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
        const destination = join(projectRoot(id), 'packages', releaseId)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await rename(output, destination)
        if (signal.aborted) { await rm(destination, { recursive: true, force: true }); throw new Error('cancelled') }
        const state = load(id), release = { id: releaseId, name: `源码发布 ${state.releases.length + 1}`, sourceVersionId: parent.id, createdAt: manifest.createdAt, services: artifacts, manifest }
        state.releases.unshift(release)
        Object.assign(state.tasks.find((entry) => entry.id === task.id), { status: 'completed', stage: 'completed', message: '源码部署包已生成并通过校验', releaseId, sourceVersionId: parent.id, finishedAt: now() })
        save(id, state)
  }

  function packageProjects(references) {
    if (!Array.isArray(references) || references.some(value => !value || typeof value.projectId !== 'string' || ['requestId', 'packageId', 'versionId'].some(key => value[key] !== undefined && typeof value[key] !== 'string'))) fail(503, 'WORKSPACE_PACKAGE_REFERENCES_UNAVAILABLE', '部署引用核对未完成，保留临时源码')
    return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(entry.name) && existsSync(stateFile(entry.name))).map(entry => entry.name)
  }
  const expiredPackage = value => Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) >= PACKAGE_RETENTION_MS
  const packageProtected = (references, task, release, versionId) => references.some(value => (release && value.packageId === release.id) || (versionId && value.versionId === versionId) || (value.requestId && value.requestId === task.requestId))
  const packagesActive = state => state.tasks.some(task => ['queued', 'running'].includes(task.status) || runningPackages.has(task.id))
  function packageCleanupCandidates(references) {
    const candidates = []
    for (const projectId of packageProjects(references)) {
      const state = load(projectId)
      if (packagesActive(state)) continue
      const protectedByDeployment = references.filter(value => value.projectId === projectId)
      for (const task of state.tasks) {
        if (!packageTerminal(task) || typeof task.actorId !== 'string' || typeof task.requestId !== 'string' || !expiredPackage(task.finishedAt || task.createdAt)) continue
        const release = state.releases.find(value => value.id === task.releaseId), sourceVersionId = task.sourceVersionId || release?.sourceVersionId
        if (!sourceVersionId || packageProtected(protectedByDeployment, task, release, sourceVersionId)) continue
        if (!state.versions.some(version => version.id === sourceVersionId && version.cachePurpose === 'deployment')) continue
        candidates.push({ projectId, requestId: task.requestId, actorId: task.actorId, taskId: task.id, sourceVersionId })
      }
    }
    return candidates
  }
  function cleanupPackages(references) {
    const removed = [], errors = []
    for (const id of packageProjects(references)) {
      try {
        const state = load(id)
        if (packagesActive(state)) continue
        const protectedByDeployment = references.filter(value => value.projectId === id)
        const cleared = []
        for (const release of state.releases) {
          const task = state.tasks.find(value => value.type === 'packages' && value.releaseId === release.id)
          if (release.clearedAt || !task || !packageTerminal(task) || !expiredPackage(task.finishedAt || release.createdAt)) continue
          if (packageProtected(protectedByDeployment, task, release, release.sourceVersionId)) continue
          release.clearedAt = now(); cleared.push(release.id)
        }
        const protectedIds = new Set([...Object.values(state.protectedReferences ?? {}), ...protectedByDeployment.flatMap(value => value.versionId ? [value.versionId] : [])])
        for (const release of state.releases) if (!release.clearedAt) protectedIds.add(release.sourceVersionId)
        for (const version of state.versions) if (version.sourceVersionId) protectedIds.add(version.sourceVersionId)
        const retired = state.versions.filter(version => version.cachePurpose === 'deployment' && !protectedIds.has(version.id) && expiredPackage(version.packageUsedAt || version.createdAt))
        state.retiredPackageVersions ??= []
        for (const version of retired) state.retiredPackageVersions.push({ id: version.id, clearedAt: now() })
        if (retired.length) state.versions = state.versions.filter(version => !retired.includes(version))
        // 先关闭读取并保存原任务与清单；物理删除失败时按同一收据继续，不重建新包。
        if (cleared.length || retired.length) save(id, state)
        const pending = [
          ...state.releases.filter(release => release.clearedAt && !release.purgedAt).map(value => ({ value, directory: 'packages' })),
          ...state.retiredPackageVersions.filter(value => !value.purgedAt).map(value => ({ value, directory: 'versions' })),
        ]
        let purged = false
        for (const { value, directory } of pending) {
          try { rmSync(join(projectRoot(id), directory, safeId(value.id)), { recursive: true, force: true }); value.purgedAt = now(); purged = true }
          catch (error) { errors.push(error) }
        }
        if (purged) save(id, state)
        removed.push({ projectId: id, packages: cleared, versions: retired.map(value => value.id) })
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, '部分临时源码清理未完成，将在下次维护时重试')
    return removed
  }

  return {
    ensureProject,
    deletionReferences(id, environmentId) {
      if (environmentId !== undefined) return []
      const values = []
      if (initializing.has(id)) values.push({kind:'workspace-initializing',count:1,message:'工作区正在初始化'})
      if (!existsSync(stateFile(id))) return values
      const state = load(id)
      for (const [kind, count, message] of [
        ['workspace-tasks',state.tasks.filter(task => ['queued','running'].includes(task.status)).length,'工作区仍有活动任务'],
        ['workspace-versions',state.versions.length,'工作区仍有当前资料或历史版本'],
        ['workspace-packages',state.releases.filter(value => !value.clearedAt || !value.purgedAt).length,'工作区仍有源码包'],
        ['workspace-retired-packages',(state.retiredPackageVersions ?? []).filter(value => !value.purgedAt).length,'工作区仍有待完成回收的源码目录'],
        ['workspace-retired-inputs',(state.retiredWorkspaceVersions ?? []).filter(value => !value.purgedAt).length,'工作区仍有待完成回收的历史资料目录'],
        ['workspace-protection',Object.keys(state.protectedReferences ?? {}).length,'工作区仍有活动或未知输入保护'],
      ]) if (count) values.push({kind,count,message})
      return values
    },
    packageCleanupCandidates,
    cleanupPackages,
    stopAccepting: jobs.stopAccepting,
    async whenIdle() { await Promise.allSettled([...initializing.values()]); await jobs.whenIdle() },
    async close(options) { jobs.stopAccepting(); await Promise.all([Promise.allSettled([...initializing.values()]), jobs.close(options)]) },
    overview(id) {
      const state = load(id)
      return { projectId: id, internalVersions: state.versions.filter((entry) => entry.type === 'internal' && !entry.cachePurpose).map(publicVersion), externalVersions: state.versions.filter((entry) => entry.type === 'external').map(publicVersion), releases: clone(state.releases.filter(release => !release.clearedAt)), tasks: state.tasks.map(publicTask), import: { supported: true, hosts: [...SUPPORTED_HOSTS], maxBytes: MAX_BYTES, maxFiles: MAX_FILES } }
    },
    getVersion(id, versionId) { return publicVersion(versionRecord(id, versionId)) },
    verifyInputVersion(id, versionId) {
      const version=versionRecord(id,versionId)
      for(const file of version.files) readVersionFile(id,versionId,file.path,false)
      return publicVersion(version)
    },
    collectUnusedWorkspaceVersions(id,retention) {
      if(!retention||!Array.isArray(retention.current)||!Array.isArray(retention.versions)||retention.current.length>1000||retention.versions.length>2000) fail(400,'WORKSPACE_RETENTION_INVALID','当前资料保护快照无效')
      const state=load(id)
      if(state.tasks.some(task=>['queued','running'].includes(task.status))) return {removed:[],pending:[]}
      const expected=new Map()
      for(const value of retention.current) {
        safeId(value.sourceId);safeId(value.versionId)
        const version=state.versions.find(version=>version.id===value.versionId&&version.status==='published')
        if(!version||!version.source.repositories?.some(repository=>repository.sourceId===value.sourceId)) fail(409,'WORKSPACE_CURRENT_IDENTITY_UNKNOWN','当前资料来源无法核验，继续保护原件')
        expected.set(`current:${value.sourceId}`,value.versionId)
      }
      state.protectedReferences??={}
      for(const reference of Object.keys(state.protectedReferences)) if(reference.startsWith('current:')&&!expected.has(reference)) delete state.protectedReferences[reference]
      for(const [reference,versionId] of expected) state.protectedReferences[reference]=versionId
      const protectedIds=new Set([...Object.values(state.protectedReferences),...retention.versions])
      for(const versionId of retention.versions) {safeId(versionId);if(!state.versions.some(version=>version.id===versionId)) fail(409,'WORKSPACE_INPUT_IDENTITY_UNKNOWN','资料引用原件无法核验，停止回收')}
      for(const release of state.releases) if(!release.clearedAt) protectedIds.add(release.sourceVersionId)
      const latest=type=>state.versions.filter(version=>version.type===type&&version.status==='published'&&!version.cachePurpose).sort((a,b)=>(b.publishedAt??b.createdAt).localeCompare(a.publishedAt??a.createdAt))[0]
      for(const type of ['internal','external']) {const version=latest(type);if(version) protectedIds.add(version.id)}
      for(const version of state.versions) if(version.status!=='published'||version.cachePurpose==='deployment') protectedIds.add(version.id)
      for(let changed=true;changed;) {
        changed=false
        for(const version of state.versions) if(protectedIds.has(version.id)&&version.sourceVersionId&&!protectedIds.has(version.sourceVersionId)) {protectedIds.add(version.sourceVersionId);changed=true}
      }
      const removed=state.versions.filter(version=>!protectedIds.has(version.id)).map(version=>version.id)
      state.retiredWorkspaceVersions??=[]
      for(const versionId of removed) state.retiredWorkspaceVersions.push({id:versionId,clearedAt:now()})
      state.versions=state.versions.filter(version=>!removed.includes(version.id))
      // 先提交不可访问事实；失败目录仍有收据并由后续维护重试，不能回到可读版本。
      save(id,state)
      for(const retired of state.retiredWorkspaceVersions.filter(value=>!value.purgedAt)) {
        try {rmSync(join(projectRoot(id),'versions',safeId(retired.id)),{recursive:true,force:true});retired.purgedAt=now();save(id,state)} catch { /* 保留物理回收收据；未知失败不伪造已删除。 */ }
      }
      return {removed,pending:state.retiredWorkspaceVersions.filter(value=>!value.purgedAt).map(value=>value.id)}
    },
    findSourceCache(id, cacheKey) {
      const version = load(id).versions.find(entry => entry.cacheKey === cacheKey && entry.status === 'published')
      return version ? publicVersion(version) : undefined
    },
    retainVersion(id, versionId, reference) {
      if (typeof reference !== 'string' || !reference || reference.length > 240) fail(400, 'WORKSPACE_REFERENCE_INVALID', '资料保护引用无效')
      versionRecord(id, versionId)
      const state = load(id)
      state.protectedReferences ??= {}
      state.protectedReferences[reference] = versionId
      save(id, state)
    },
    releaseVersion(id, reference) {
      const state = load(id)
      if (state.protectedReferences?.[reference]) { delete state.protectedReferences[reference]; save(id, state) }
    },
    planCleanupVersions(id, versionIds, actorId, additionalReferences = []) {
      authorize(actorId, id, 'cleanup')
      const state = load(id)
      if (!Array.isArray(versionIds) || versionIds.length > 500 || versionIds.some(value => typeof value !== 'string') || !Array.isArray(additionalReferences)) fail(400, 'WORKSPACE_CLEANUP_INVALID', '清理目标无效')
      const protectedIds = new Set([...Object.values(state.protectedReferences ?? {}), ...additionalReferences])
      for (const release of state.releases) if (!release.clearedAt) protectedIds.add(release.sourceVersionId)
      for (const version of state.versions) if (!versionIds.includes(version.id) && version.sourceVersionId) protectedIds.add(version.sourceVersionId)
      const reasons = Object.fromEntries(versionIds.map(versionId => {
        const values = Object.entries(state.protectedReferences ?? {}).filter(([, value]) => value === versionId).map(([reference]) => ({ kind: reference.startsWith('task:') ? 'unknown-task' : reference.split(':')[0], reference }))
        if (additionalReferences.includes(versionId)) values.push({ kind: 'current-or-session', reference: '当前资料或会话授权引用' })
        for (const release of state.releases) if (!release.clearedAt && release.sourceVersionId === versionId) values.push({ kind: 'package', reference: release.id })
        for (const version of state.versions) if (!versionIds.includes(version.id) && version.sourceVersionId === versionId) values.push({ kind: 'derived-version', reference: version.id })
        return [versionId, values]
      }))
      return { activeTasks: state.tasks.filter(task => ['queued', 'running'].includes(task.status)).map(task => task.id), protected: versionIds.filter(value => protectedIds.has(value)), removable: state.versions.filter(value => versionIds.includes(value.id) && !protectedIds.has(value.id)).map(value => value.id), reasons }
    },
    pruneVersions(id, versionIds, actorId, additionalReferences = []) {
      authorize(actorId, id, 'cleanup')
      jobs.assertAccepting()
      const state = load(id)
      if (state.tasks.some(task => ['queued', 'running'].includes(task.status))) fail(409, 'WORKSPACE_TASK_ACTIVE', '工作区任务仍在运行，不能清理历史资料')
      if (!Array.isArray(versionIds) || versionIds.length > 500 || versionIds.some(value => typeof value !== 'string')) fail(400, 'WORKSPACE_CLEANUP_INVALID', '清理目标无效')
      const protectedIds = new Set([...Object.values(state.protectedReferences ?? {}), ...additionalReferences])
      for (const release of state.releases) if (!release.clearedAt) protectedIds.add(release.sourceVersionId)
      for (const version of state.versions) if (!versionIds.includes(version.id) && version.sourceVersionId) protectedIds.add(version.sourceVersionId)
      if (versionIds.some(value => protectedIds.has(value))) fail(409, 'WORKSPACE_VERSION_IN_USE', '资料仍被当前工作区、执行输入或交付物引用，不能清理')
      const removed = state.versions.filter(version => versionIds.includes(version.id)).map(version => version.id)
      state.versions = state.versions.filter(version => !removed.includes(version.id))
      // 先持久化不可访问状态；删除失败仅留下不可见文件，不能让已删除数据再次变成可读版本。
      save(id, state)
      for (const versionId of removed) rmSync(join(projectRoot(id), 'versions', safeId(versionId)), { recursive: true, force: true })
      return { removed }
    },
    taskForRequest(id, type, requestId, actorId) {
      authorize(actorId, id, type)
      const task = load(id).tasks.find(task => task.type === type && task.requestId === requestId)
      if (task && task.actorId !== actorId) fail(409, 'WORKSPACE_REQUEST_CONFLICT', '该请求标识属于另一位操作人')
      return task ? publicTask(task) : undefined
    },
    taskForMaintenance(id,type,requestId,actorId) {
      const task=load(id).tasks.find(value=>value.type===type&&value.requestId===requestId)
      if(!task) return undefined
      if(task.actorId!==actorId) fail(409,'WORKSPACE_REQUEST_CONFLICT','维护候选不属于原任务操作人')
      return {...publicTask(task),actorId:task.actorId,...(task.sourceVersionId?{sourceVersionId:task.sourceVersionId}:{}),...(task.captureId?{captureId:task.captureId}:{})}
    },
    files(id, versionId) { return clone(versionRecord(id, versionId).files.map(({ binary: _binary, executable: _executable, ...file }) => file)) },
    tree(id, versionId, directory = '') { return versionTree(id, versionId, directory) },
    managementTree(id, versionId, directory = '') { return versionTree(id, versionId, directory, true) },
    managementSearch(id, versionId, query = '', limit = 200) {
      if (typeof query !== 'string' || query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, 'WORKSPACE_SEARCH_INVALID', '搜索文字或结果数量无效')
      const version = versionRecord(id, versionId, true), entries = new Map(), needle = query.toLocaleLowerCase()
      for (const file of version.files) {
        entries.set(file.path, { path: file.path, kind: 'file' })
        const parts = file.path.split('/')
        for (let index = 1; index < parts.length; index++) { const path = parts.slice(0, index).join('/'); entries.set(path, { path, kind: 'directory' }) }
      }
      const matches = [...entries.values()].filter((entry) => entry.path.toLocaleLowerCase().includes(needle)).sort((a, b) => a.path.localeCompare(b.path))
      return { entries: matches.slice(0, limit), truncated: matches.length > limit }
    },
    read(id, versionId, path) { return versionText(id, versionId, path) },
    managementRead(id, versionId, path) { return versionText(id, versionId, path, true) },
    readBytes(id, versionId, path) { return readVersionFile(id, versionId, path, false).bytes },
    versionFile(id, versionId, path) { return readVersionFile(id, versionId, path, true) },
    startExternal(id, input, actorId) {
      const rules = validateRules(input.rules),request=requestTask(id,'external',{...input,rules},actorId)
      if(request.previous) return publicTask(request.previous)
      const parent = source(id, input.sourceVersionId)
      return start(id, 'external', { ...input, rules }, async ({ task, temporary, progress, signal }) => {
        const sourceRoot = checkedSource(id, parent), sourceIndex = scan(sourceRoot, { skipGit: true, skipCaches: true }), root = join(temporary, 'version', 'files')
        await mkdir(root, { recursive: true, mode: 0o700 })
        progress('remove_git', '正在移除全部 Git 元数据')
        let replacements = 0
        const pendingFiles = []
        progress('redacting', '正在脱敏源码、文档和原型')
        for (const file of sourceIndex.files) {
          if (signal.aborted) throw new Error('cancelled')
          if (redact(file.path, rules).text !== file.path) fail(422, 'WORKSPACE_SENSITIVE_PATH', '来源文件名包含需要脱敏的文字，请先调整文件名再生成外部版本')
          const bytes = readFileSync(checkedFile(sourceRoot, file.path)), text = textOf(bytes)
          const output = text === null ? bytes : (() => { const result = redact(text, rules); replacements += result.replacements; return Buffer.from(result.text) })()
          if (text === null) pendingFiles.push({ path: file.path, reason: '无法可靠检查的二进制文件，需要明确确认保留或排除' })
          await mkdir(dirname(join(root, file.path)), { recursive: true, mode: 0o700 }); await writeFile(join(root, file.path), output, { mode: file.executable ? 0o700 : 0o600 })
        }
        progress('checking', '正在校验脱敏结果与版本身份')
        const versionId = randomUUID(), count = load(id).versions.filter((entry) => entry.type === 'external').length + 1
        const report = { removedGitEntries: sourceIndex.removedGitEntries, replacements, pendingFiles, excludedFiles: [], rulesVersion: RULES_VERSION, customRules: rules.length }
        // source 只保存提交与相对路径；自定义匹配原文从不进入可见元数据。
        await persistVersion(id, root, { id: versionId, name: `外部脱敏 v${String(count).padStart(3, '0')}`, type: 'external', status: pendingFiles.length ? 'pending_review' : 'published', sourceVersionId: parent.id, createdAt: now(), source: { repositories: parent.source.repositories.map(({ path, commit }) => ({ path, commit })) }, report, isExample: parent.isExample }, task.id, signal)
      }, actorId)
    },
    confirmExternal(id, versionId, input) {
      jobs.assertAccepting()
      const state = load(id), version = state.versions.find((entry) => entry.id === safeId(versionId))
      if (!version || version.type !== 'external') missing()
      if (version.status === 'published') return publicVersion(version)
      if (version.status !== 'pending_review') missing()
      const confirmed = input.confirmedPaths, excluded = input.excludedPaths
      if (!Array.isArray(confirmed) || !Array.isArray(excluded) || [...confirmed, ...excluded].some((path) => typeof path !== 'string')) fail(400, 'WORKSPACE_REVIEW_INVALID', '请为所有待确认文件选择保留或排除')
      const pending = new Set(version.report.pendingFiles.map((entry) => entry.path)), answers = [...confirmed, ...excluded]
      if (new Set(answers).size !== answers.length || answers.some((path) => !pending.has(path)) || answers.length !== pending.size) fail(400, 'WORKSPACE_REVIEW_INCOMPLETE', '每个待确认文件必须明确选择保留或排除，不能重复或遗漏')
      const root = versionRoot(id, version)
      const indexed = scan(root, { skipGit: true })
      if (indexed.contentHash !== version.source.contentHash) fail(409, 'WORKSPACE_CONTENT_CHANGED', '待确认版本校验失败，请重新生成外部版本')
      // 保留受控原件，仅原子更新发布索引；元数据写入失败不会先破坏待复核内容。
      version.files = indexed.files.filter((file) => !excluded.includes(file.path)); version.fileCount = version.files.length; version.byteLength = version.files.reduce((sum, file) => sum + file.size, 0); version.source.contentHash = sha(JSON.stringify(version.files.map(({ path, sha256 }) => [path, sha256])))
      version.report.excludedFiles = excluded; version.report.reviewedFiles = confirmed; version.report.pendingFiles = []; version.status = 'published'; version.publishedAt = now()
      save(id, state)
      return publicVersion(version)
    },
    startPackages(id, input, actorId) {
      const { previous } = requestTask(id, 'packages', input, actorId)
      if (previous) return publicTask(previous)
      const parent = source(id, input.sourceVersionId), services = input.services
      if (!Array.isArray(services) || !services.length || services.length > 2 || new Set(services).size !== services.length || services.some((entry) => !['frontend', 'backend'].includes(entry))) fail(400, 'WORKSPACE_SERVICES_INVALID', '请选择前端、后端或两者')
      if (parent.source.authoringRevision !== undefined && input.contexts === undefined) fail(400, 'WORKSPACE_BUILD_CONTEXT_REQUIRED', '请明确选择各服务的构建上下文与构建目录')
      if (input.contexts !== undefined) {
        if (!Array.isArray(input.contexts) || input.contexts.length !== services.length || new Set(input.contexts.map((entry) => entry?.service)).size !== services.length)
          fail(400, 'WORKSPACE_BUILD_CONTEXT_INVALID', '每项服务必须指定唯一构建上下文')
        for (const entry of input.contexts) {
          if (!entry || !services.includes(entry.service) || typeof entry.root !== 'string' || typeof entry.workingDirectory !== 'string') fail(400, 'WORKSPACE_BUILD_CONTEXT_INVALID', '构建上下文无效')
          if (entry.root !== '.') safePath(entry.root)
          if (entry.workingDirectory !== '.') safePath(entry.workingDirectory)
        }
      }
      return start(id, 'packages', input, context => packageSource(id, parent, input, context), actorId)
    },
    startSourcePackages(id, input, prepare, actorId) {
      return start(id, 'packages', input, async context => {
        const { temporary, signal, progress } = context
        const prepared = await prepare({ signal, progress, materializeCache: async (cacheInput, materialize) => {
          authorize(actorId, id, 'packages')
          const previous = load(id).versions.find(version => version.cacheKey === cacheInput.cacheKey && version.status === 'published')
          if (previous) { const state = load(id); state.protectedReferences ??= {}; state.protectedReferences[`task:${context.task.id}`] = previous.id; state.tasks.find(task => task.id === context.task.id).sourceVersionId = previous.id; save(id, state); return publicVersion(previous) }
          const root = join(temporary, 'source-cache', 'files')
          await mkdir(root, { recursive: true, mode: 0o700 })
          await materialize({ root, signal, progress, checkBudget: () => checkImportBudget(temporary) })
          checkCompleteSource(root)
          authorize(actorId, id, 'packages')
          const version = publicVersion(await persistVersion(id, root, { id: randomUUID(), name: '部署源码输入', type: 'internal', status: 'published', createdAt: now(), source: cacheInput.source, cacheKey: cacheInput.cacheKey, cachePurpose: 'deployment', isExample: false }, undefined, signal))
          const state = load(id); state.protectedReferences ??= {}; state.protectedReferences[`task:${context.task.id}`] = version.id; state.tasks.find(task => task.id === context.task.id).sourceVersionId = version.id; save(id, state)
          return version
        } })
        authorize(actorId, id, 'packages')
        const parent = source(id, prepared.sourceVersionId)
        if (parent.cachePurpose !== 'deployment' || parent.source.documents?.length) fail(409, 'WORKSPACE_DEPLOYMENT_SOURCE_INVALID', '部署只允许使用独立源码输入')
        await packageSource(id, parent, { ...input, services: prepared.contexts.map(value => value.service), contexts: prepared.contexts }, context)
      }, actorId)
    },
    packageFile(id, releaseId, service) {
      safeId(releaseId)
      const release = load(id).releases.find((entry) => entry.id === releaseId)
      if (!release) missing()
      if (service === 'manifest') return { bytes: Buffer.from(JSON.stringify(release.manifest, null, 2)), name: 'manifest.json', mime: 'application/json' }
      if (release.clearedAt) fail(410, 'WORKSPACE_PACKAGE_EXPIRED', '临时源码包已到期清理，请重新选择提交生成；原任务记录仍保留')
      const entry = release.services.find((item) => item.service === service)
      if (!entry) missing()
      const bytes = readFileSync(checkedFile(join(projectRoot(id), 'packages', release.id), entry.name))
      if (sha(bytes) !== entry.sha256) fail(409, 'WORKSPACE_PACKAGE_CHANGED', '部署包校验失败，请重新生成')
      return { bytes, name: entry.name, mime: 'application/zip' }
    },
    startSnapshot(id, input, materialize, actorId) {
      if (typeof materialize !== 'function') fail(503, 'WORKSPACE_SNAPSHOT_UNAVAILABLE', '工作区来源读取尚未就绪')
      const taskType = input.taskType ?? 'snapshot'
      if (!['snapshot', 'sync', 'input'].includes(taskType)) fail(400, 'WORKSPACE_TASK_INVALID', '资料任务类型无效')
      return start(id, taskType, input, async ({ task, temporary, progress, signal }) => {
        if (input.cacheKey) {
          const cached = load(id).versions.find(version => version.cacheKey === input.cacheKey && version.status === 'published')
          if (cached) { const state = load(id); state.protectedReferences ??= {}; state.protectedReferences[`task:${task.id}`] = cached.id; save(id, state); updateTask(id, task.id, { status: 'completed', stage: 'completed', versionId: cached.id, message: '源码提交未变化，已复用固定输入' }); return }
        }
        const root = join(temporary, 'version', 'files')
        await mkdir(root, { recursive: true, mode: 0o700 })
        await materialize({ root, signal, progress, checkBudget: () => checkImportBudget(temporary) })
        checkCompleteSource(root)
        progress('publishing', '正在校验源码和资料并保存固定版本')
        const count = load(id).versions.filter((entry) => entry.type === 'internal').length + 1
        await persistVersion(id, root, { id: randomUUID(), name: `内部版本 v${String(count).padStart(3, '0')}`, type: 'internal', status: 'published', createdAt: now(), source: input.source, isExample: false, ...(input.cacheKey ? { cacheKey: input.cacheKey, cachePurpose: input.cachePurpose ?? 'source' } : {}) }, task.id, signal)
      }, actorId)
    },
    startImport(id, input, actorId) {
      const repositoryUrl = validateRepository(input.repositoryUrl)
      let branch
      try { branch = validateBranch(input.branch || 'main') } catch { fail(400, 'WORKSPACE_BRANCH_INVALID', '分支名称无效，请填写明确的分支名') }
      return start(id, 'import', { ...input, repositoryUrl, branch }, async ({ task, temporary, progress, signal }) => {
        const versionId = randomUUID(), root = join(temporary, 'version', 'files')
        progress('fetching', '正在拉取公开仓库及 Git 历史')
        checkFree(temporary, MAX_BYTES + STORAGE_RESERVE)
        const timeout = AbortSignal.timeout(180000), mergedSignal = AbortSignal.any([signal, timeout])
        await mkdir(dirname(root), { recursive: true, mode: 0o700 })
        await git(['clone', '--no-checkout', '--no-hardlinks', '--single-branch', '--branch', branch, '--', repositoryUrl, root], temporary, mergedSignal, { budgetRoot: temporary })
        const commit = await git(['rev-parse', '--verify', 'HEAD^{commit}'], root, mergedSignal)
        const entries = await git(['ls-tree', '-r', commit], root, mergedSignal)
        if (/^160000 /m.test(entries)) fail(422, 'WORKSPACE_SUBMODULE_UNSUPPORTED', '该仓库包含子模块，请先将所需源码整合为普通文件')
        if (/^120000 /m.test(entries)) fail(422, 'WORKSPACE_LINK_UNSUPPORTED', '该仓库包含符号链接，请先将所需源码整合为普通文件')
        progress('checkout', '正在检出固定提交并检查文件')
        await git(['checkout', '--detach', commit], root, mergedSignal)
        checkCompleteSource(root)
        progress('publishing', '正在保存内部固定版本')
        const count = load(id).versions.filter((entry) => entry.type === 'internal').length + 1
        await persistVersion(id, root, { id: versionId, name: `内部导入 v${String(count).padStart(3, '0')}`, type: 'internal', status: 'published', createdAt: now(), source: { repositories: [{ path: '.', commit }], repositoryHost: new URL(repositoryUrl).hostname, branch }, isExample: false }, task.id, signal)
      }, actorId)
    },
    cancelTask(id, taskId) {
      const state = load(id), task = state.tasks.find((entry) => entry.id === safeId(taskId))
      if (!task) missing()
      if (!['queued', 'running'].includes(task.status)) return publicTask(task)
      if (!jobs.cancel(task.id)) fail(409, 'WORKSPACE_TASK_OWNER', '任务正在另一个服务进程中执行，请稍后查看状态')
      try { return publicTask(updateTask(id, task.id, { status: 'interrupted', stage: 'cancelled', message: '任务已取消，原有已发布版本仍可使用' })) }
      catch (error) { failedPersistenceTasks.add(task.id); throw error }
    },
  }
}

let configured, configuredStopped = false
export function stopConfiguredWorkspaceStore() { configuredStopped = true; configured?.store.stopAccepting() }
export async function closeConfiguredWorkspaceStore(options) { stopConfiguredWorkspaceStore(); await configured?.store.close(options) }
export function configuredWorkspaceStore({ authorizeTask } = {}) {
  if (configuredStopped) fail(503, 'WORKSPACE_STOPPING', '工作区服务正在停止，请稍后重试')
  const dataDir = process.env.AUTOOPS_T3_DATA_DIR
  if (!dataDir) return undefined
  if (!configured || configured.dataDir !== dataDir) {
    const instance = { dataDir, authorizeTask }
    instance.store = createWorkspaceStore({ dataDir, authorizeTask(input) {
      if (!instance.authorizeTask) fail(503, 'WORKSPACE_AUTHORIZATION_REQUIRED', '工作区任务尚未配置授权检查')
      return instance.authorizeTask(input)
    } })
    configured = instance
  }
  if (authorizeTask) configured.authorizeTask = authorizeTask
  return configured.store
}
