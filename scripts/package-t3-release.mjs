import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(process.argv[2] || join(root, '.deployment/t3-release'))
if (existsSync(destination)) throw new Error('发布目录已存在，请选择新的发布目录；不会覆盖')
mkdirSync(destination, { recursive: true, mode: 0o700 })
for (const path of ['agent-demo', 'dist/web', 'vendor/t3code/apps/server/dist', 'vendor/t3code/.autoops-source', 'vendor/t3code/LICENSE', 'vendor/t3code/package.json', 'vendor/t3code/pnpm-lock.yaml', 'vendor/t3code/pnpm-workspace.yaml', 'vendor/t3code/patches', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/start-t3-worker.mjs', 'scripts/t3-migrate-data.mjs', 'scripts/t3-recovery-data.mjs', 'scripts/t3-storage-audit.mjs', 'scripts/verify-t3-release.mjs']) {
  cpSync(join(root, path), join(destination, path), { recursive: true, verbatimSymlinks: true, filter: (source) => !/\/(?:data|node_modules|\.DS_Store)(?:\/|$)/.test(relative(root, source)) })
}
// Preserve pnpm's real dependency graph, including duplicate versions. Only
// dynamic business workers need root packages; UI and T3 are already bundled.
const store = join(root, 'node_modules/.pnpm')
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
for (const name of ['officeparser', 'pdfkit', 'fflate', 'pdfjs-dist']) {
  const source = join(root, 'node_modules', name)
  collect(source)
  const link = join(destination, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(relative(dirname(link), join(targetStore, relative(store, realpathSync(source)))), link)
}
const manifest = { sourceCommit: 'fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92', createdAt: new Date().toISOString(), nativeDependencies: 'Attach Linux x64 external packages from the same official T3 0.1.1 release; validate package identities before startup.', dynamicBusinessPackages: [...copied].sort(), files: [], symlinks: [] }
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
console.log(JSON.stringify({ destination, files: manifest.files.length, dynamicPackages: copied.size }))
