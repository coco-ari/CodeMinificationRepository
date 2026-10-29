import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

export const DEPLOYMENT_AGENT_BUNDLE_PATH = 'dist/agent-bundle.tar.gz'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const program = (name) => /\.(mjs|sh|java)$/.test(name) || /^Dockerfile(?:\.[A-Za-z0-9_-]+)?$/.test(name)
const safePath = (name) => /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(name) && !name.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))

export function deploymentAgentFiles(source) {
  const files = []
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const name = prefix + entry.name
      if (entry.isDirectory()) walk(join(directory, entry.name), name + '/')
      else if (entry.isFile() && program(entry.name)) {
        if (!safePath(name)) throw new Error('部署 Agent 程序路径无效')
        files.push(name)
      }
    }
  }
  walk(source)
  for (const name of ['install.sh', 'Dockerfile', 'main.mjs']) if (!files.includes(name)) throw new Error(`部署 Agent 安装文件不完整：${name}`)
  return files.sort()
}

// 对照同一发行的程序，拒绝缺文件、陈旧包、运行身份、链接和额外归档条目。
export function verifyDeploymentAgentBundle(bundlePath, sourceDirectory) {
  const archive = resolve(bundlePath), source = resolve(sourceDirectory), stat = lstatSync(archive)
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('部署 Agent 安装包必须为不超过 16 MiB 的常规文件')
  const runTar = (args, maxBuffer = 1024 * 1024) => execFileSync('tar', [...args, archive], { timeout: 10000, maxBuffer, windowsHide: true, env: { ...process.env, COPYFILE_DISABLE: '1', LC_ALL: 'C' } })
  const names = runTar(['-tzf']).toString('utf8').trimEnd().split(/\r?\n/)
  if (!names.length || names.length > 256 || names.some((name) => !safePath(name) || !program(basename(name))) || new Set(names).size !== names.length) throw new Error('部署 Agent 安装包含不安全、重复或非程序文件')
  const entries = runTar(['-tvzf']).toString('utf8').trimEnd().split(/\r?\n/)
  if (entries.length !== names.length || entries.some((line) => !line.startsWith('-'))) throw new Error('部署 Agent 安装包只能包含常规程序文件')
  const expected = deploymentAgentFiles(source)
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) throw new Error('部署 Agent 安装包与当前发行的程序文件不一致，请重新构建')
  let total = 0
  for (const name of names) {
    const file = join(source, name), sourceStat = lstatSync(file), rel = relative(realpathSync(source), realpathSync(file))
    if (!sourceStat.isFile() || rel.startsWith('..') || sourceStat.size > 4 * 1024 * 1024 || (total += sourceStat.size) > 64 * 1024 * 1024) throw new Error('部署 Agent 程序大小或目录边界无效')
    const contents = execFileSync('tar', ['-xOf', archive, '--', name], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    if (!contents.equals(readFileSync(file))) throw new Error(`部署 Agent 安装包文件与发行不一致：${name}`)
  }
  const bytes = readFileSync(archive)
  return { format: 'autoops-deployment-agent-v1', path: DEPLOYMENT_AGENT_BUNDLE_PATH, sha256: digest(bytes), bytes: bytes.length, files: names.length }
}
