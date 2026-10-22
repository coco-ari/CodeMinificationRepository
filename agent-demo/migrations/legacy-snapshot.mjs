import { DatabaseSync, backup } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { once } from 'node:events'

const FORMAT = 'autoops-legacy-demo-snapshot-v1'
const quoteIdentifier = (name) => `"${name.replaceAll('"', '""')}"`
const fileHash = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const inside = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function inventory(root, directory = root) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('恢复包包含符号链接，拒绝继续')
    if (entry.isDirectory()) files.push(...await inventory(root, path))
    else if (entry.isFile()) files.push({
      path: relative(root, path).split('\\').join('/'),
      bytes: (await stat(path)).size,
      sha256: await fileHash(path),
    })
    else throw new Error('恢复包包含不支持的文件类型')
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function exportTable(db, name, output, filesDirectory) {
  const stream = createWriteStream(output, { flags: 'wx', mode: 0o600 })
  // Keep asynchronous write errors observed while synchronous sqlite iteration runs.
  let writeError
  stream.on('error', (error) => { writeError = error })
  let count = 0
  try {
    for (const original of db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).iterate()) {
      if (writeError) throw writeError
      const row = { ...original }
      if (name === 'files' && row.data instanceof Uint8Array) {
        const basename = `${createHash('sha256').update(String(row.id)).digest('hex')}.bin`
        await writeFile(join(filesDirectory, basename), row.data, { flag: 'wx', mode: 0o600 })
        row.contentFile = `files/${basename}`
        row.contentSha256 = createHash('sha256').update(row.data).digest('hex')
        row.contentBytes = row.data.byteLength
        delete row.data
      }
      // Large legacy event tables are streamed, never accumulated as a giant JSON array.
      const line = JSON.stringify(row, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ) + '\n'
      if (!stream.write(line)) await once(stream, 'drain')
      count++
    }
    stream.end()
    await once(stream, 'finish')
    if (writeError) throw writeError
    return count
  } catch (error) {
    stream.destroy()
    throw error
  }
}

/**
 * Read-only source capture. The sqlite backup is the authoritative, internally
 * consistent database; NDJSON/files are import material, not a substitute backup.
 * `quiesced` must be asserted by the cutover coordinator after stopping writers.
 */
export async function createLegacySnapshot({ sourceDb, destination, nativeDirectories = [], quiesced = false }) {
  const source = resolve(sourceDb)
  const target = resolve(destination)
  if (inside(dirname(source), target)) throw new Error('恢复包必须放在源数据库目录之外')
  if ((await lstat(source)).isSymbolicLink()) throw new Error('源数据库不能是符号链接')
  try {
    await lstat(target)
    throw new Error('目标恢复包已存在，拒绝覆盖')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  for (const directory of nativeDirectories) {
    const path = resolve(directory)
    if (inside(path, target) || inside(target, path)) throw new Error('原生状态与恢复包目录不能互相包含')
    // Inventory rejects symlinks instead of following paths outside the requested tree.
    await inventory(path)
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const staging = `${target}.partial-${randomUUID()}`
  await mkdir(staging, { mode: 0o700 })
  let original, snapshot
  try {
    original = new DatabaseSync(source, { readOnly: true })
    await backup(original, join(staging, 'demo.sqlite'))
    original.close()
    original = undefined
    await chmod(join(staging, 'demo.sqlite'), 0o600)
    snapshot = new DatabaseSync(join(staging, 'demo.sqlite'), { readOnly: true })
    const check = snapshot.prepare('PRAGMA quick_check').all()
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('SQLite 快照完整性检查失败')
    await mkdir(join(staging, 'tables'), { mode: 0o700 })
    await mkdir(join(staging, 'files'), { mode: 0o700 })
    const tableNames = snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name)
    if (!tableNames.includes('conversations') || !tableNames.includes('events')) throw new Error('源数据库不是支持的 Agent Demo 数据库')
    const tables = Object.create(null)
    for (const name of tableNames) {
      // Auth and receipt tables remain in the private database backup, not in
      // ordinary import JSON. Do not copy valid sessions into the new runtime.
      if (['sessions', 'requests'].includes(name)) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('源数据库包含不支持的表名')
      tables[name] = await exportTable(snapshot, name, join(staging, 'tables', `${name}.ndjson`), join(staging, 'files'))
    }
    const eventWatermark = Number(snapshot.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq)
    snapshot.close()
    snapshot = undefined
    const native = []
    for (let index = 0; index < nativeDirectories.length; index++) {
      const destination = join(staging, 'native', String(index))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await cp(resolve(nativeDirectories[index]), destination, { recursive: true, dereference: false, errorOnExist: true, force: false })
      // Never expose secret/provider files through a broadly readable backup.
      const secure = async (directory) => {
        await chmod(directory, 0o700)
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const child = join(directory, entry.name)
          if (entry.isDirectory()) await secure(child)
          else if (entry.isFile()) await chmod(child, 0o600)
          else throw new Error('原生恢复包包含不支持的文件类型')
        }
      }
      await secure(destination)
      native.push({ index, path: `native/${index}` })
    }
    const files = await inventory(staging)
    const manifest = { format: FORMAT, createdAt: new Date().toISOString(), quiesced, cutoverEligible: quiesced && native.length > 0, eventWatermark, tables, native, files }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(staging, target)
    return manifest
  } catch (error) {
    original?.close()
    snapshot?.close()
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

export async function verifyLegacySnapshot(directory) {
  const root = resolve(directory)
  if (!(await lstat(root)).isDirectory() || !(await lstat(join(root, 'manifest.json'))).isFile()) throw new Error('恢复包及清单必须是普通目录和文件')
  let manifest
  try { manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) }
  catch { throw new Error('恢复包清单无效') }
  if (manifest.format !== FORMAT || !Array.isArray(manifest.files)) throw new Error('不支持的恢复包格式')
  const seen = new Set()
  for (const file of manifest.files) {
    const path = resolve(root, file.path)
    if (seen.has(file.path) || !inside(root, path) || path === root) throw new Error('恢复包文件路径无效或重复')
    seen.add(file.path)
    if ((await lstat(path)).isSymbolicLink()) throw new Error('恢复包文件不能是符号链接')
    if ((await stat(path)).size !== file.bytes || await fileHash(path) !== file.sha256) throw new Error(`恢复包校验失败：${file.path}`)
  }
  // Reject extra files as well as missing/changed ones, including nested symlinks.
  const actual = await inventory(root)
  if (actual.length !== seen.size + 1 || actual.some((file) => file.path !== 'manifest.json' && !seen.has(file.path))) throw new Error('恢复包文件清单不一致')
  const db = new DatabaseSync(join(root, 'demo.sqlite'), { readOnly: true })
  try {
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw new Error('恢复包数据库完整性检查失败')
    for (const [name, count] of Object.entries(manifest.tables)) {
      if (Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get().count) !== count) throw new Error(`恢复包记录数不一致：${name}`)
    }
  } finally { db.close() }
  return manifest
}
