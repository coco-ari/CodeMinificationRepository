import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const SOURCE_COMMIT = 'fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92'
const UPSTREAM_VERSION = 'v0.1.1'
const NATIVE_PATH = 'vendor/t3code/apps/server/node_modules'
const NATIVE_MANIFEST = 'native-dependencies-manifest.json'
const CUSTOMER_BUNDLE_PATH = 'dist/customer-agent.zip'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (message) => { throw new Error(message) }
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) }

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) fail('清单包含不安全的相对路径')
  return value
}

function regularFile(root, name) {
  const path = join(root, safeRelative(name))
  if (!lstatSync(path).isFile() || !inside(root, realpathSync(path))) fail(`文件类型或边界不符：${name}`)
  return path
}

function directory(path) {
  if (!lstatSync(path).isDirectory()) fail('依赖根必须是实际目录，不能是符号链接')
  return realpathSync(path)
}

function readJson(root, name) { return JSON.parse(readFileSync(regularFile(root, name), 'utf8')) }

// The customer runner is an explicit, self-contained optional artifact. Its
// presence never enables AUTOOPS_CUSTOMER_AGENTS or configures a download URL.
export function verifyCustomerAgentBundle(bundlePath, checksumPath = `${bundlePath}.sha256`) {
  const archivePath = resolve(bundlePath), hashPath = resolve(checksumPath)
  const stat = lstatSync(archivePath)
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || !lstatSync(hashPath).isFile()) fail('客户安装包和校验文件必须为常规文件，ZIP 不得超过 64 MiB')
  const archive = readFileSync(archivePath), digest = sha256(archive)
  const checksum = readFileSync(hashPath, 'utf8').trim().match(/^([a-f0-9]{64})  ([^/\\\r\n]+)$/)
  if (!checksum || checksum[1] !== digest || checksum[2] !== basename(archivePath)) fail('客户安装包 SHA-256 校验不符')
  const names = new Set()
  let expandedBytes = 0
  const files = unzipSync(archive, { filter: (entry) => {
    // This distribution has only regular, flat files in customer-agent/.
    // Reject duplicate/path entries before extraction or decompression.
    if (!/^customer-agent\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name) || entry.name.endsWith('.map') || names.has(entry.name)) fail('客户安装包包含不安全、重复或不应发布的文件路径')
    names.add(entry.name)
    expandedBytes += entry.originalSize
    if (names.size > 256 || entry.originalSize > 32 * 1024 * 1024 || expandedBytes > 64 * 1024 * 1024) fail('客户安装包展开大小或文件数量超过限制')
    return true
  } })
  const get = (name) => files[`customer-agent/${name}`] ?? fail(`客户安装包缺少文件：${name}`)
  const json = (name) => JSON.parse(Buffer.from(get(name)).toString('utf8'))
  const manifest = json('manifest.json')
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1 || manifest.node !== '>=24.10' || typeof manifest.connectorVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.connectorVersion) || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) fail('客户安装包清单版本或格式不符')
  for (const name of ['autoops-customer-agent.mjs', 'README.md', 'LICENSE-T3-Code', 'THIRD-PARTY-NOTICES.txt', 'third-party-licenses.json', 'dependency-audit.json']) get(name)
  const expected = new Set(Object.keys(manifest.files))
  for (const [path, bytes] of Object.entries(files)) {
    const name = path.slice('customer-agent/'.length)
    if (name === 'manifest.json') continue
    const entry = manifest.files[name]
    if (!expected.delete(name) || !entry || entry.bytes !== bytes.length || entry.sha256 !== sha256(bytes)) fail(`客户安装包文件清单或哈希不符：${name}`)
  }
  if (expected.size) fail(`客户安装包清单文件缺失：${expected.values().next().value}`)
  const audit = json('dependency-audit.json'), notices = json('third-party-licenses.json')
  if (audit.schemaVersion !== 1 || audit.entry !== 'agent-demo/customer-agent/cli.ts' || audit.auditedAllChunks !== true || !Number.isInteger(audit.sourceModules) || audit.sourceModules < 1 || !Array.isArray(audit.prohibitedPlatformDependencies) || audit.prohibitedPlatformDependencies.length !== 0 || !Array.isArray(notices.entries) || notices.entries.length < 1 || audit.bundledThirdPartyNotices !== notices.entries.length) fail('客户安装包缺少有效的全部分块依赖审计或第三方许可清单')
  return { format: 'autoops-customer-agent-v1', path: CUSTOMER_BUNDLE_PATH, checksumPath: `${CUSTOMER_BUNDLE_PATH}.sha256`, sha256: digest, bytes: archive.length, connectorVersion: manifest.connectorVersion, protocolVersion: manifest.protocolVersion, node: manifest.node }
}

function verifyOptionalCustomerBundle(root, manifest) {
  const present = existsSync(join(root, CUSTOMER_BUNDLE_PATH)) || existsSync(join(root, `${CUSTOMER_BUNDLE_PATH}.sha256`))
  if (!Object.hasOwn(manifest, 'customerAgent')) {
    if (present) fail('发布目录包含客户安装包但缺少模块清单')
    return undefined
  }
  const metadata = manifest.customerAgent
  if (!metadata || metadata.path !== CUSTOMER_BUNDLE_PATH || metadata.checksumPath !== `${CUSTOMER_BUNDLE_PATH}.sha256`) fail('客户安装包发布路径或模块清单不符')
  const verified = verifyCustomerAgentBundle(regularFile(root, metadata.path), regularFile(root, metadata.checksumPath))
  if (Object.keys(metadata).length !== Object.keys(verified).length || Object.entries(verified).some(([key, value]) => metadata[key] !== value)) fail('客户安装包与发布模块清单不符')
  return verified
}

// Do not follow directory links. Record both the relative link text and its
// resolved in-tree target, so a different link chain cannot silently pass.
function inventory(root, excluded = new Set()) {
  const result = { directories: [], files: [], symlinks: [] }
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(current, entry.name), name = relative(root, path)
      safeRelative(name)
      if (excluded.has(name)) continue
      const stat = lstatSync(path)
      if (stat.isDirectory()) { result.directories.push(name); walk(path) }
      else if (stat.isFile()) result.files.push({ path: name, bytes: stat.size, sha256: sha256(readFileSync(path)) })
      else if (stat.isSymbolicLink()) {
        const link = readlinkSync(path)
        if (isAbsolute(link) || link.includes('\\') || link.includes('\0') || !inside(root, resolve(dirname(path), link))) fail(`符号链接越界或不是相对链接：${name}`)
        const target = realpathSync(path)
        if (!inside(root, target)) fail(`符号链接目标越界：${name}`)
        result.symlinks.push({ path: name, link, target: relative(root, target) })
      } else fail(`发布目录包含不支持的文件类型：${name}`)
    }
  }
  walk(root)
  for (const key of ['files', 'symlinks']) result[key].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  result.directories.sort((a, b) => a.localeCompare(b, 'en'))
  return result
}

function verifyReleaseFiles(root, manifest) {
  if (manifest.sourceCommit !== SOURCE_COMMIT || !Array.isArray(manifest.files) || !Array.isArray(manifest.symlinks)) fail('发布清单版本或格式不符')
  const expected = new Map()
  for (const kind of ['files', 'symlinks']) for (const entry of manifest[kind]) {
    const name = safeRelative(entry.path)
    if (expected.has(name) || name === NATIVE_MANIFEST || name === 'release-manifest.json' || name === NATIVE_PATH || name.startsWith(NATIVE_PATH + '/')) fail(`清单重复或占用保留路径：${name}`)
    expected.set(name, { ...entry, kind })
  }
  const actual = inventory(root, new Set(['release-manifest.json', NATIVE_MANIFEST, NATIVE_PATH]))
  for (const kind of ['files', 'symlinks']) for (const entry of actual[kind]) {
    const item = expected.get(entry.path)
    if (!item || item.kind !== kind) fail(`发布目录存在清单外文件或类型不符：${entry.path}`)
    if (kind === 'files' && (item.bytes !== entry.bytes || item.sha256 !== entry.sha256)) fail(`发布文件哈希不符：${entry.path}`)
    if (kind === 'symlinks' && safeRelative(item.target) !== entry.target) fail(`发布符号链接目标不符：${entry.path}`)
    expected.delete(entry.path)
  }
  if (expected.size) fail(`发布清单文件缺失：${expected.keys().next().value}`)
  const provenance = readJson(root, 'vendor/t3code/.autoops-source/manifest.json')
  if (provenance.commit !== SOURCE_COMMIT || provenance.upstreamVersion !== UPSTREAM_VERSION) fail('发布包的上游来源身份不符')
  return { files: actual.files.length, symlinks: actual.symlinks.length, customerAgent: verifyOptionalCustomerBundle(root, manifest) }
}

function packageIdentities(root, entries) {
  return entries.files.filter((entry) => basename(entry.path) === 'package.json').flatMap((entry) => {
    const value = readJson(root, entry.path)
    return typeof value.name === 'string' && typeof value.version === 'string'
      ? [{ path: entry.path, name: value.name, version: value.version, sha256: entry.sha256 }] : []
  })
}

function equalInventory(expected, actual, message) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(message)
}

export function verifyT3Release(releaseDirectory, { nativeSource } = {}) {
  const root = directory(resolve(releaseDirectory))
  const releaseManifestPath = regularFile(root, 'release-manifest.json')
  const releaseManifestSha256 = sha256(readFileSync(releaseManifestPath))
  const release = verifyReleaseFiles(root, readJson(root, 'release-manifest.json'))
  const nativeRoot = directory(join(root, NATIVE_PATH))
  if (!inside(root, nativeRoot)) fail('原生依赖目录越过发布边界')
  const actual = inventory(nativeRoot)
  if (!actual.files.length) fail('原生依赖目录为空')
  const identities = packageIdentities(nativeRoot, actual)
  const recordPath = join(root, NATIVE_MANIFEST)
  const existing = existsSync(recordPath) ? readJson(root, NATIVE_MANIFEST) : undefined
  if (existing) {
    if (existing.format !== 'autoops-native-dependencies-v1' || existing.sourceCommit !== SOURCE_COMMIT || existing.upstreamVersion !== UPSTREAM_VERSION || existing.nativePath !== NATIVE_PATH || existing.releaseManifestSha256 !== releaseManifestSha256) fail('原生依赖清单与本发布包身份不符')
    equalInventory(existing.inventory, actual, '原生依赖与已登记清单不符；拒绝重新登记变化')
    equalInventory(existing.packages, identities, '原生包身份与已登记清单不符')
  } else if (!nativeSource) fail('缺少原生依赖清单；必须先用 --native-source 对照指定官方发布目录')

  let recorded = false
  if (nativeSource) {
    const sourceRoot = directory(resolve(nativeSource))
    if (inside(root, sourceRoot) || inside(sourceRoot, nativeRoot)) fail('官方对照目录必须独立于待验证发布目录')
    const sourceRelease = dirname(sourceRoot)
    if (basename(sourceRoot) !== 'node_modules' || basename(sourceRelease) !== 't3-0.1.1-linux-x64') fail('原生对照目录必须属于指定 T3 0.1.1 Linux x64 官方发布目录')
    const binary = regularFile(sourceRelease, 't3')
    const sourceIdentity = { directory: sourceRoot, release: basename(sourceRelease), executableSha256: sha256(readFileSync(binary)), packageMapSha256: sha256(readFileSync(regularFile(sourceRoot, '.package-map.json'))) }
    const sourceInventory = inventory(sourceRoot)
    equalInventory(sourceInventory, actual, '附加原生依赖与指定官方目录的文件、相对链接或目录不一致')
    if (existing) equalInventory(existing.sourceIdentity, sourceIdentity, '官方对照身份与已登记来源不符')
    else {
      writeFileSync(recordPath, JSON.stringify({ format: 'autoops-native-dependencies-v1', verifiedAt: new Date().toISOString(), upstreamVersion: UPSTREAM_VERSION, sourceCommit: SOURCE_COMMIT, nativePath: NATIVE_PATH, releaseManifestSha256, sourceIdentity, verification: 'Byte-for-byte comparison with the operator-specified official release directory; no executable was run.', inventory: actual, packages: identities }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      recorded = true
    }
  }
  return { verified: true, release: root, sourceCommit: SOURCE_COMMIT, releaseManifestSha256, releaseFiles: release.files, releaseSymlinks: release.symlinks, ...(release.customerAgent ? { customerAgent: release.customerAgent } : {}), nativeFiles: actual.files.length, nativeSymlinks: actual.symlinks.length, nativePackages: identities.length, nativeManifestSha256: sha256(readFileSync(regularFile(root, NATIVE_MANIFEST))), recorded }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [release, ...args] = process.argv.slice(2)
    if (!release || (args.length !== 0 && (args.length !== 2 || args[0] !== '--native-source'))) fail('用法：node scripts/verify-t3-release.mjs RELEASE [--native-source OFFICIAL_NODE_MODULES]')
    console.log(JSON.stringify(verifyT3Release(release, args.length ? { nativeSource: args[1] } : {})))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
