import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCustomerAgentBundle } from './verify-t3-release.mjs'
import { DEPLOYMENT_AGENT_BUNDLE_PATH, verifyDeploymentAgentBundle } from './deployment-agent-bundle.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function addDeploymentAgentBundle(destination, bundlePath, sourceDirectory = join(destination, 'agent')) {
  const metadata = verifyDeploymentAgentBundle(bundlePath, sourceDirectory)
  const target = join(destination, metadata.path)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(bundlePath, target)
  return verifyDeploymentAgentBundle(target, sourceDirectory)
}

export function addCustomerAgentBundle(destination, bundlePath) {
  if (bundlePath === undefined) return undefined
  const metadata = verifyCustomerAgentBundle(bundlePath)
  const target = join(destination, metadata.path)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(bundlePath, target)
  writeFileSync(join(destination, metadata.checksumPath), `${metadata.sha256}  customer-agent.zip\n`, { mode: 0o600 })
  // Revalidate the copied bytes rather than trusting a source that might change
  // between verification and copying. Never emit a manifest for a partial ZIP.
  verifyCustomerAgentBundle(target)
  return metadata
}

export function packageT3Release(destination, { customerAgentBundle } = {}) {
destination = resolve(destination)
if (existsSync(destination)) throw new Error('发布目录已存在，请选择新的发布目录；不会覆盖')
if (customerAgentBundle !== undefined) verifyCustomerAgentBundle(customerAgentBundle)
verifyDeploymentAgentBundle(join(root, DEPLOYMENT_AGENT_BUNDLE_PATH), join(root, 'agent'))
mkdirSync(destination, { recursive: true, mode: 0o700 })
destination = realpathSync(destination)
for (const path of ['agent-demo', 'agent', 'src', 'autoops/contracts', 'autoops/server/platform/database.ts', 'autoops/server/platform/ports.ts', 'autoops/server/platform/errors.ts', 'autoops/server/modules/identity', 'dist/web', 'vendor/t3code/apps/server/dist', 'vendor/t3code/.autoops-source', 'vendor/t3code/LICENSE', 'vendor/t3code/package.json', 'vendor/t3code/pnpm-lock.yaml', 'vendor/t3code/pnpm-workspace.yaml', 'vendor/t3code/patches', 'vendor/skills-manager', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/start-t3-worker.mjs', 'scripts/initialize-runtime-accounts.mjs', 'scripts/t3-migrate-data.mjs', 'scripts/t3-recovery-data.mjs', 'scripts/t3-storage-audit.mjs', 'scripts/verify-t3-release.mjs', 'scripts/deployment-agent-bundle.mjs', 'scripts/verify-t3-workspace-release.mjs']) {
  cpSync(join(root, path), join(destination, path), { recursive: true, verbatimSymlinks: true, filter: (source) => !/\/(?:data|node_modules|\.DS_Store)(?:\/|$)/.test(relative(root, source)) })
}
// Redis 发布包未附许可证文件，随同版上游原文和网页许可证清单一起分发。
cpSync(join(root, 'vendor/t3code/third-party-notices'), join(destination, 'vendor/t3code/third-party-notices'), {recursive: true})
// Preserve pnpm's real dependency graph, including duplicate versions. Only
// dynamic business workers need root packages; UI and T3 are already bundled.
const store = realpathSync(join(root, 'node_modules/.pnpm'))
const targetStore = join(destination, 'node_modules/.pnpm')
mkdirSync(targetStore, { recursive: true })
const copied = new Set()
function collect(target) {
  const real = realpathSync(target)
  const path = relative(store, real)
  if (path.startsWith('..') || path.startsWith('/')) throw new Error('运行依赖越过已锁定 pnpm 目录')
  const name = path.split('/')[0]
  if (copied.has(name)) return
  copied.add(name)
  const directory = join(store, name)
  cpSync(directory, join(targetStore, name), { recursive: true, verbatimSymlinks: true })
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name)
      if (entry.isSymbolicLink()) collect(file)
      else if (entry.isDirectory()) walk(file)
    }
  }
  walk(directory)
}
for (const name of ['officeparser', 'pdfkit', 'fflate', 'pdfjs-dist', 'effect', 'mysql2', 'redis', 'ssh2', 'node-sql-parser']) {
  const source = join(root, 'node_modules', name)
  collect(source)
  const link = join(destination, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(relative(dirname(link), join(targetStore, relative(store, realpathSync(source)))), link)
}
// YAML is a pure JS leaf dependency; preserve its complete locked package.
const yamlPackage = realpathSync(join(root, 'node_modules/yaml'))
cpSync(yamlPackage, join(destination, 'node_modules/yaml'), { recursive: true })
copied.add(`yaml@${JSON.parse(readFileSync(join(yamlPackage, 'package.json'), 'utf8')).version}`)
const customerAgent = addCustomerAgentBundle(destination, customerAgentBundle)
const deploymentAgent = addDeploymentAgentBundle(destination, join(root, DEPLOYMENT_AGENT_BUNDLE_PATH))
const manifest = { sourceCommit: 'fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92', createdAt: new Date().toISOString(), nativeDependencies: 'Attach Linux x64 external packages from the same official T3 0.1.1 release; validate package identities before startup.', dynamicBusinessPackages: [...copied].sort(), deploymentAgent, ...(customerAgent ? { customerAgent } : {}), files: [], symlinks: [] }
function inventory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) inventory(path)
    else if (entry.isFile()) manifest.files.push({ path: relative(destination, path), bytes: lstatSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
    else if (entry.isSymbolicLink()) {
      const target=realpathSync(path)
      if(!target.startsWith(destination+'/'))throw new Error('发布依赖符号链接越过发布目录')
      manifest.symlinks.push({path:relative(destination,path),target:relative(destination,target)})
    }
  }
}
inventory(destination)
writeFileSync(join(destination, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
return { destination, files: manifest.files.length, dynamicPackages: copied.size, deploymentAgent, ...(customerAgent ? { customerAgent } : {}) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [destination = join(root, '.deployment/t3-release'), ...args] = process.argv.slice(2)
    if (destination.startsWith('--') || (args.length !== 0 && (args.length !== 2 || args[0] !== '--customer-agent-bundle' || args[1].startsWith('--')))) throw new Error('用法：node scripts/package-t3-release.mjs [DESTINATION] [--customer-agent-bundle PATH.zip]')
    console.log(JSON.stringify(packageT3Release(destination, args.length ? { customerAgentBundle: args[1] } : {})))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
