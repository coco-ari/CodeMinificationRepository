import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// 仅用于 Dockerfile.web；基础发行已先验证，保持非网页条目及原生依赖清单。
const root = '/app'
for (const name of ['FRONTEND_SOURCE_SHA', 'FRONTEND_ARCHIVE_SHA']) {
  if (!/^[a-f0-9]{64}$/.test(process.env[name] ?? '')) throw new Error('缺少固定网页产物摘要')
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const manifestPath = join(root, 'release-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.files = manifest.files.filter((file) => !file.path.startsWith('dist/web/'))
function inventory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) inventory(path)
    else if (entry.isFile()) {
      const bytes = readFileSync(path)
      manifest.files.push({ path: relative(root, path), bytes: bytes.length, sha256: hash(bytes) })
    } else throw new Error('网页发行不允许符号链接或特殊文件')
  }
}
inventory(join(root, 'dist/web'))
manifest.frontendUpdate = {
  createdAt: new Date().toISOString(),
  sourceSha256: process.env.FRONTEND_SOURCE_SHA,
  archiveSha256: process.env.FRONTEND_ARCHIVE_SHA,
}
const bytes = JSON.stringify(manifest, null, 2) + '\n'
writeFileSync(manifestPath, bytes)
const nativePath = join(root, 'native-dependencies-manifest.json')
const native = JSON.parse(readFileSync(nativePath, 'utf8'))
native.releaseManifestSha256 = hash(bytes)
writeFileSync(nativePath, JSON.stringify(native, null, 2) + '\n')
