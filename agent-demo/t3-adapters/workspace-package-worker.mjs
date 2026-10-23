import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { inspectZip } from '../../agent/archive.mjs'
import { WorkspaceError, MAX_BYTES, MAX_FILES, MAX_FILE_BYTES, sha, checkedFile, scan } from './workspace-files.mjs'

const fail = (status, code, message) => { throw new WorkspaceError(status, code, message) }
try {
  const { root, parent, services, output } = workerData
  if (scan(root).contentHash !== parent.source.contentHash) fail(409, 'WORKSPACE_CONTENT_CHANGED', '内部固定版本校验失败，请重新导入来源')
  const indexed = scan(root, { skipGit: true, skipCaches: true })
  const artifacts = [], contexts = []
  for (const service of services) {
    const serviceHasPackage = indexed.files.some((entry) => entry.path === `${service}/package.json`)
    const packageText = serviceHasPackage ? readFileSync(checkedFile(root, `${service}/package.json`), 'utf8') : ''
    const rootBuildFiles = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'turbo.json', 'Cargo.toml', 'go.work'])
    const sharedContext = indexed.files.some((entry) => rootBuildFiles.has(entry.path) || /^(?:shared|packages|libs)\//.test(entry.path)) || /(?:file:|link:)?\.\.\//.test(packageText) || /workspace:/.test(packageText)
    const standalone = serviceHasPackage && parent.source.repositories.some((entry) => entry.path === service) && !sharedContext
    // 只有独立仓库才截取服务目录。单仓/monorepo 保留整个根上下文，避免丢失共享依赖和锁文件。
    const prefix = standalone ? `${service}/` : ''
    const chosen = indexed.files.filter((entry) => entry.path.startsWith(prefix))
    if (!chosen.length) fail(422, 'WORKSPACE_BUILD_CONTEXT_MISSING', `没有可用于${service === 'frontend' ? '前端' : '后端'}打包的源码`)
    const entries = Object.create(null)
    for (const file of chosen) entries[file.path.slice(prefix.length)] = [new Uint8Array(readFileSync(checkedFile(root, file.path))), { mtime: new Date('2026-01-01T00:00:00Z'), attrs: (file.executable ? 0o100755 : 0o100644) << 16 }]
    const bytes = zipSync(entries, { level: 6 }), name = `${service}.zip`
    inspectZip(Buffer.from(bytes), { maxBytes: MAX_BYTES, maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES })
    writeFileSync(join(output, name), bytes, { mode: 0o600 })
    artifacts.push({ service, name, size: bytes.length, sha256: sha(bytes) })
    contexts.push({ service, root: prefix ? service : '.', reason: standalone ? '独立仓库构建上下文' : '保留完整仓库及共享依赖', workingDirectory: standalone ? '.' : indexed.files.some((entry) => entry.path === `${service}/package.json`) ? service : '.' })
  }

  parentPort.postMessage({ value: { artifacts, contexts } })
} catch (error) {
  parentPort.postMessage({ error: error instanceof WorkspaceError ? { status: error.status, code: error.code, message: error.message } : { status: 503, code: 'WORKSPACE_PACKAGE_FAILED', message: '源码打包失败，请检查来源与可用存储' } })
}
