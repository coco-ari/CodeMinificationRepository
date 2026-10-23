// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Git 进程使用独立 Node 运行边界，超时与关闭由适配器管理。
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateBranch, validateRevision } from '../../src/archive.mjs'
import type { WorkspaceRepositorySource, WorkspaceResolvedRepository } from '../../autoops/contracts/workspace-authoring.ts'
import type { GitCredential } from './credentials.ts'

export class WorkspaceGitError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.name = 'WorkspaceGitError'; this.status = status; this.code = code }
}
export interface WorkspaceGitOptions {
  allowedOrigins?: readonly string[]
  resolveTimeoutMs?: number
  fetchTimeoutMs?: number
  maxOutputBytes?: number
  maxErrorBytes?: number
  // 测试只替换进程和名称解析端口，生产地址策略与命令构造仍走同一实现。
  spawnGit?: (args: readonly string[], options: SpawnOptions) => ChildProcess
  lookupHost?: (hostname: string) => Promise<readonly { address: string; family: number }[]>
}
type BudgetCheck = () => void | Promise<void>
type ResolvedRepository = Omit<WorkspaceResolvedRepository, 'credentialVersion'>
const PUBLIC_ORIGINS = ['https://github.com', 'https://gitlab.com', 'https://gitee.com', 'https://codeberg.org']
const fail = (status: number, code: string, message: string): never => { throw new WorkspaceGitError(status, code, message) }
const abortError = () => new WorkspaceGitError(499, 'WORKSPACE_GIT_ABORTED', 'Git 操作已取消')
function validCommit(value: unknown): string {
  try { return validateRevision(value) as string } catch { return fail(400, 'WORKSPACE_GIT_COMMIT_INVALID', '必须使用完整、固定的 Git 提交标识') }
}
function relativePath(value: unknown, label: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > 1024 || /[\\\x00-\x1f\x7f:*?<>|]/.test(value)
    || value.startsWith('/') || value.split('/').some(part => part === '.' || part === '..' || part.toLowerCase() === '.git' || (part && (part.endsWith('.') || part.endsWith(' '))))
    || (value !== '' && value.split('/').some(part => !part))) return fail(400, 'WORKSPACE_SOURCE_PATH_INVALID', `${label}必须是仓库内的安全相对路径`)
  return value
}
function configuredOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { return fail(500, 'WORKSPACE_GIT_ORIGIN_INVALID', 'Git HTTPS 来源配置无效') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return fail(500, 'WORKSPACE_GIT_ORIGIN_INVALID', 'Git 来源配置必须是完整 HTTPS origin')
  return url.origin
}
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)
      || (a === 192 && b === 88 && c === 99))
  }
  // 公共 IPv6 单播位于 2000::/3；额外排除嵌入 IPv4 的转换与隧道保留范围。
  const lowered = address.toLowerCase()
  return isIP(address) === 6 && /^[23]/.test(lowered) && !lowered.startsWith('2002:') && !/^2001:(?:0*:|db8:|10:|20:)/.test(lowered)
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function numberOption(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) return fail(500, 'WORKSPACE_GIT_LIMIT_INVALID', 'Git 资源限制配置无效')
  return selected
}

export function createWorkspaceGit(options: WorkspaceGitOptions = {}) {
  const explicitOrigins = new Set((options.allowedOrigins ?? []).map(configuredOrigin))
  const allowedOrigins = new Set([...PUBLIC_ORIGINS, ...explicitOrigins])
  const resolveTimeout = numberOption(options.resolveTimeoutMs, 15_000, 60_000)
  const fetchTimeout = numberOption(options.fetchTimeoutMs, 180_000, 600_000)
  const maxOutput = numberOption(options.maxOutputBytes, 1024 * 1024, 8 * 1024 * 1024)
  const maxError = numberOption(options.maxErrorBytes, 4 * 1024 * 1024, 8 * 1024 * 1024)
  const spawnGit = options.spawnGit ?? ((args: readonly string[], settings: SpawnOptions) => spawn('git', [...args], settings))
  const lookupHost = options.lookupHost ?? (hostname => lookup(hostname, { all: true, verbatim: true }))

  function validateRepositorySource(source: WorkspaceRepositorySource): WorkspaceRepositorySource {
    if (!source || typeof source !== 'object') return fail(400, 'WORKSPACE_SOURCE_INVALID', '仓库来源无效')
    let url: URL
    try { url = new URL(source.url) } catch { return fail(400, 'WORKSPACE_REPOSITORY_INVALID', '请填写允许的 HTTPS Git 仓库地址') }
    if (typeof source.url !== 'string' || source.url.length > 2048 || /[\\\x00-\x20\x7f%]/.test(source.url)
      || url.protocol !== 'https:' || !allowedOrigins.has(url.origin) || url.username || url.password || url.search || url.hash
      || !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/.test(url.pathname)
      || source.url.split('/').some(part => part === '.' || part === '..'))
      return fail(400, 'WORKSPACE_REPOSITORY_INVALID', '仅支持已允许的 HTTPS Git 仓库；地址不能包含凭据、参数或路径跳转')
    if (typeof source.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(source.id)
      || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 200 || /[\x00-\x1f\x7f]/.test(source.name)
      || !['frontend', 'backend', 'shared', 'documentation', 'other'].includes(source.role)) return fail(400, 'WORKSPACE_SOURCE_INVALID', '仓库来源标识、名称或用途无效')
    if (typeof source.ref !== 'string' || !['default', 'branch', 'tag', 'commit'].includes(source.refKind)) return fail(400, 'WORKSPACE_REF_INVALID', '请选择有效的 Git 分支、标签或提交')
    if (source.refKind === 'default') { if (source.ref !== '') fail(400, 'WORKSPACE_REF_INVALID', '默认分支不能同时指定其他引用') }
    else if (source.refKind === 'commit') validCommit(source.ref)
    else { try { validateBranch(source.ref) } catch { fail(400, 'WORKSPACE_REF_INVALID', 'Git 分支或标签名称无效') } }
    relativePath(source.mountPath, '工作区挂载目录', true)
    if (source.sourcePath !== undefined) relativePath(source.sourcePath, '仓库子目录', true)
    if (source.credentialId !== undefined && (typeof source.credentialId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(source.credentialId))) fail(400, 'WORKSPACE_CREDENTIAL_INVALID', '凭证引用无效')
    return { ...source, url: url.toString() }
  }
  async function run(args: string[], environment: NodeJS.ProcessEnv, signal: AbortSignal, budgetCheck?: BudgetCheck): Promise<string> {
    if (signal.aborted) throw abortError()
    if (budgetCheck) await budgetCheck()
    if (signal.aborted) throw abortError()
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess
      try { child = spawnGit(args, { env: environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch { reject(new WorkspaceGitError(502, 'WORKSPACE_GIT_START_FAILED', '无法启动 Git，请检查服务端安装')); return }
      let failure: unknown, outputBytes = 0, errorBytes = 0, output = '', closed = false
      let forceKill: ReturnType<typeof setTimeout> | undefined
      let budgetTimer: ReturnType<typeof setInterval> | undefined
      let checking: Promise<void> | undefined
      const kill = (force = false) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
          else child.kill(force ? 'SIGKILL' : 'SIGTERM')
        } catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* 子进程可能已退出，统一等待 close。 */ } }
      }
      const stop = (error: unknown) => {
        if (failure) return
        failure = error
        if (closed) return
        kill()
        forceKill = setTimeout(() => kill(true), 1000)
      }
      const abort = () => stop(abortError())
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      child.stdout?.on('data', (bytes: Buffer) => {
        outputBytes += bytes.length
        if (outputBytes > maxOutput) stop(new WorkspaceGitError(502, 'WORKSPACE_GIT_OUTPUT_LIMIT', 'Git 输出超过允许大小'))
        else output += bytes.toString('utf8')
      })
      // 错误原文可能包含远端回显的秘密，仅计数和消费，绝不拼进错误、日志或任务。
      child.stderr?.on('data', (bytes: Buffer) => { errorBytes += bytes.length; if (errorBytes > maxError) stop(new WorkspaceGitError(502, 'WORKSPACE_GIT_OUTPUT_LIMIT', 'Git 错误输出超过允许大小')) })
      child.on('error', () => stop(new WorkspaceGitError(502, 'WORKSPACE_GIT_START_FAILED', 'Git 进程不可用')))
      if (budgetCheck) budgetTimer = setInterval(() => {
        if (checking || closed || failure) return
        checking = Promise.resolve().then(budgetCheck).catch(error => stop(error)).finally(() => { checking = undefined })
      }, 200)
      child.on('close', (code) => {
        closed = true; clearTimeout(forceKill); clearInterval(budgetTimer); signal.removeEventListener('abort', abort)
        // 检查和进程都已退出后才让调用方清理目录，避免取消与仍在写入的 Git 竞争。
        void Promise.resolve(checking).then(() => {
          if (failure) reject(failure)
          else if (code !== 0) reject(new WorkspaceGitError(502, 'WORKSPACE_GIT_FAILED', 'Git 操作失败，请检查仓库地址、凭证和网络'))
          else resolve(output.trim())
        })
      })
    })
  }
  async function session<T>(source: WorkspaceRepositorySource, credential: GitCredential | undefined, signal: AbortSignal | undefined, timeoutMs: number, operation: (git: (args: string[], budget?: BudgetCheck) => Promise<string>) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw abortError()
    if (credential && (typeof credential.username !== 'string' || typeof credential.password !== 'string'
      || !credential.username || !credential.password || /[\x00-\x1f\x7f]/.test(credential.username + credential.password))) fail(400, 'WORKSPACE_CREDENTIAL_INVALID', 'Git 凭证无效')
    const timeout = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const url = new URL(source.url), hostname = url.hostname.replace(/^\[|\]$/g, '')
    let addresses: readonly { address: string; family: number }[]
    try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await bounded(lookupHost(hostname), combined) }
    catch (error) {
      if (combined.aborted) throw new WorkspaceGitError(signal?.aborted ? 499 : 504, signal?.aborted ? 'WORKSPACE_GIT_ABORTED' : 'WORKSPACE_GIT_TIMEOUT', signal?.aborted ? 'Git 操作已取消' : 'Git 操作超时')
      if (error instanceof WorkspaceGitError) throw error
      return fail(502, 'WORKSPACE_GIT_DNS_FAILED', '无法解析 Git 仓库地址')
    }
    if (!addresses.length || addresses.some(item => !isIP(item.address)) || (!explicitOrigins.has(url.origin) && addresses.some(item => !publicAddress(item.address)))) fail(400, 'WORKSPACE_GIT_ADDRESS_DENIED', '公共 Git 来源不能解析到本机、内网或保留地址')
    const selected = addresses.find(item => item.family === 4) ?? addresses[0]!
    const dnsAddress = selected.family === 6 ? `[${selected.address}]` : selected.address
    const temporary = await mkdtemp(path.join(tmpdir(), 'autoops-workspace-git-'))
    const askpass = path.join(temporary, 'askpass.sh'), config = path.join(temporary, 'empty.gitconfig'), hooks = path.join(temporary, 'empty-hooks')
    try {
      await mkdir(hooks, { mode: 0o700 }); await writeFile(config, '', { mode: 0o600 })
      // 沿用部署归档的 ASKPASS 机制；脚本只读环境变量，本身不含任何秘密。
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$CMR_GIT_USERNAME" ;;\n  *) printf "%s\\n" "$CMR_GIT_PASSWORD" ;;\nesac\n', { mode: 0o700 })
      const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        HOME: temporary, XDG_CONFIG_HOME: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary, LANG: 'C.UTF-8', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass.replaceAll('\\', '/'),
        GIT_LFS_SKIP_SMUDGE: '1', GIT_ALLOW_PROTOCOL: 'https', GIT_PROTOCOL_FROM_USER: '0',
        CMR_GIT_USERNAME: credential?.username ?? '', CMR_GIT_PASSWORD: credential?.password ?? '' }
      const flags = ['-c', 'credential.helper=', '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false',
        '-c', `http.curloptResolve=${url.hostname}:${url.port || '443'}:${dnsAddress}`, '-c', 'http.proxy=',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
        '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false',
        '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', '-c', `init.templateDir=${hooks}`]
      return await operation((args, budget) => run([...flags, ...args], environment, combined, budget))
    } catch (error) {
      if (combined.aborted) throw new WorkspaceGitError(signal?.aborted ? 499 : 504, signal?.aborted ? 'WORKSPACE_GIT_ABORTED' : 'WORKSPACE_GIT_TIMEOUT', signal?.aborted ? 'Git 操作已取消' : 'Git 操作超时')
      throw error
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  async function resolveRepositoryRef(input: WorkspaceRepositorySource, credential?: GitCredential, signal?: AbortSignal): Promise<ResolvedRepository> {
    const source = validateRepositorySource(input)
    if (signal?.aborted) throw abortError()
    if (source.refKind === 'commit') return { sourceId: source.id, commit: validCommit(source.ref), refKind: 'commit', ref: source.ref, defaultRef: null }
    return session(source, credential, signal, resolveTimeout, async git => {
      const ref = source.refKind === 'default' ? 'HEAD' : `refs/${source.refKind === 'branch' ? 'heads' : 'tags'}/${source.ref}`
      const output = await git(['ls-remote', '--symref', '--', source.url, 'HEAD', ref, ...(source.refKind === 'tag' ? [`${ref}^{}`] : [])])
      let defaultRef: string | null = null
      const commits = new Map<string, string>()
      for (const line of output.split('\n')) {
        const symbolic = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line)
        if (symbolic) { try { defaultRef = validateBranch(symbolic[1]) as string } catch { fail(502, 'WORKSPACE_GIT_RESPONSE_INVALID', '仓库返回的默认分支无效') } }
        const record = /^([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(line)
        if (record) {
          const name = record[2]!, commit = record[1]!
          if (commits.has(name) && commits.get(name) !== commit) fail(502, 'WORKSPACE_GIT_RESPONSE_INVALID', '仓库返回了冲突的 Git 引用')
          commits.set(name, commit)
        }
      }
      const commit = commits.get(`${ref}^{}`) ?? commits.get(ref)
      if (!commit || (source.refKind === 'default' && !defaultRef)) return fail(404, 'WORKSPACE_GIT_REF_NOT_FOUND', '仓库中没有所选引用或可用默认分支')
      return { sourceId: source.id, commit: validCommit(commit), refKind: source.refKind, ref: source.refKind === 'default' ? defaultRef! : source.ref, defaultRef }
    })
  }
  async function fetchRepositoryAt(input: WorkspaceRepositorySource, revision: string, destination: string, credential?: GitCredential, signal?: AbortSignal, budgetCheck?: BudgetCheck): Promise<void> {
    const source = validateRepositorySource(input), commit = validCommit(revision)
    if (source.refKind === 'commit' && source.ref !== commit) fail(409, 'WORKSPACE_GIT_COMMIT_MISMATCH', '固定提交与仓库来源不一致')
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) fail(400, 'WORKSPACE_GIT_DESTINATION_INVALID', 'Git 目标必须是服务端绝对目录')
    let created = false
    try {
      await session(source, credential, signal, fetchTimeout, async git => {
        // 目标必须全新，失败只移除此调用拥有的目录，绝不覆盖已有工作区或用户文件。
        await mkdir(destination, { mode: 0o700 }); created = true
        await git(['init', `--object-format=${commit.length === 64 ? 'sha256' : 'sha1'}`, '--', destination], budgetCheck)
        await git(['-C', destination, 'remote', 'add', '--', 'origin', source.url], budgetCheck)
        await git(['-C', destination, 'fetch', '--no-tags', '--no-recurse-submodules', '--', source.url, commit], budgetCheck)
        const fetched = await git(['-C', destination, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], budgetCheck)
        if (fetched !== commit) fail(502, 'WORKSPACE_GIT_COMMIT_MISMATCH', '远端未返回固定提交，拒绝使用其他版本')
        const tree = await git(['-C', destination, 'ls-tree', '-r', '--format=%(objectmode)', commit, '--', ...(source.sourcePath ? [source.sourcePath] : [])], budgetCheck)
        if (tree.split('\n').includes('160000')) fail(422, 'WORKSPACE_GIT_SUBMODULE_UNSUPPORTED', '该提交包含子模块，当前导入不支持隐式获取其他仓库')
        if (tree.split('\n').includes('120000')) fail(422, 'WORKSPACE_GIT_LINK_UNSUPPORTED', '所选目录包含符号链接，请先整合为普通文件')
        if (source.sourcePath) {
          const kind = await git(['-C', destination, 'cat-file', '-t', `${commit}:${source.sourcePath}`], budgetCheck)
          if (kind !== 'tree') fail(422, 'WORKSPACE_GIT_SOURCE_PATH_INVALID', '固定提交中的所选来源必须是目录')
          // 精确目录模式保留原始层级，不把兄弟目录或仓库根文件带入工作区。
          const pattern = `/${source.sourcePath.replace(/[\[\]#!]/g, '\\$&')}/`
          await git(['-C', destination, 'sparse-checkout', 'set', '--no-cone', '--', pattern], budgetCheck)
        }
        await git(['-C', destination, 'checkout', '--detach', '--force', commit, '--'], budgetCheck)
        const actual = await git(['-C', destination, 'rev-parse', '--verify', 'HEAD'], budgetCheck)
        if (actual !== commit) fail(502, 'WORKSPACE_GIT_COMMIT_MISMATCH', '检出结果与固定提交不一致')
        // 内部工作区保留完整 Git 身份与历史；来源子目录仅限定检出范围，不是仓库授权边界。
        if (budgetCheck) await budgetCheck()
      })
    } catch (error) { if (created) await rm(destination, { recursive: true, force: true }); throw error }
  }
  return { validateRepositorySource, resolveRepositoryRef, fetchRepositoryAt }
}
const defaultGit = createWorkspaceGit()
export const validateRepositorySource = defaultGit.validateRepositorySource
export const resolveRepositoryRef = defaultGit.resolveRepositoryRef
export const fetchRepositoryAt = defaultGit.fetchRepositoryAt
