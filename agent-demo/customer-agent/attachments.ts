import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  customerMessageAttachments,
  type CustomerAttachment,
  type CustomerAttachmentManifest,
} from '../../vendor/t3code/packages/contracts/src/customerAttachments.ts'
import type { CustomerAgentCommand } from '../../vendor/t3code/packages/contracts/src/autoopsRemote.ts'
import { ConnectorError } from './store.ts'

export type AttachmentDownload = (
  commandId: string,
  attachmentId: string,
  signal: AbortSignal,
) => AsyncIterable<Uint8Array>
const failed = () =>
  new ConnectorError('attachment_transfer_failed', '附件未能传到这台电脑，请重新发送')
type AttachmentIdentity = {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly type: string
}
const identity = (attachment: AttachmentIdentity) =>
  JSON.stringify([
    attachment.id,
    attachment.name,
    attachment.mimeType,
    attachment.sizeBytes,
    attachment.type,
  ])

export class CustomerAttachmentCache {
  private readonly files = new Map<string, Map<string, { identity: string; path: string }>>()
  private pending = Promise.resolve()
  private readonly directory: string
  private readonly download: AttachmentDownload
  private readonly maxBytes: number
  constructor(directory: string, download: AttachmentDownload, maxBytes = 1024 * 1024 * 1024) {
    this.directory = directory
    this.download = download
    this.maxBytes = maxBytes
  }

  resolve(sessionId: string, attachment: AttachmentIdentity): string | null {
    const file = this.files.get(sessionId)?.get(attachment.id)
    return file?.identity === identity(attachment) ? file.path : null
  }

  // 传输串行、总量受限；缓存不写入客户项目，运行中的会话仍引用的文件不被清理。
  async prepare(
    command: CustomerAgentCommand,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<void> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(45000)])
    const task = this.pending.then(async () => {
      signal.throwIfAborted()
      assertCurrent()
      const attachments = customerMessageAttachments(command.input)
      const manifest = command.attachments ?? []
      if (
        manifest.length !== attachments.length ||
        new Set(manifest.map((item) => item.id)).size !== manifest.length
      )
        throw failed()
      if (!attachments.length) return
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const directoryStat = await lstat(this.directory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failed()
      if (process.platform !== 'win32') await chmod(this.directory, 0o700)
      const staged: Array<{ attachment: CustomerAttachment; path: string }> = []
      for (const attachment of attachments) {
        signal.throwIfAborted()
        assertCurrent()
        const expected = manifest.find((item) => item.id === attachment.id)
        if (
          !expected ||
          expected.sizeBytes !== attachment.sizeBytes ||
          !/^[a-f0-9]{64}$/.test(expected.sha256)
        )
          throw failed()
        const extension = extname(attachment.name).toLowerCase()
        const path = join(
          this.directory,
          `${expected.sha256}${/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin'}`,
        )
        if (!(await this.valid(path, expected))) {
          await this.reserve(attachment.sizeBytes)
          await this.receive(command.commandId, attachment.id, path, expected, signal)
        }
        staged.push({ attachment, path })
      }
      signal.throwIfAborted()
      assertCurrent()
      const files = this.files.get(command.sessionId) ?? new Map()
      for (const { attachment, path } of staged)
        files.set(attachment.id, { identity: identity(attachment), path })
      this.files.set(command.sessionId, files)
    })
    this.pending = task.catch(() => {})
    try {
      await task
    } catch (cause) {
      if (cause instanceof ConnectorError) throw cause
      throw failed()
    }
  }

  private async valid(path: string, expected: CustomerAttachmentManifest): Promise<boolean> {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== expected.sizeBytes) return false
        const hash = createHash('sha256')
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
        return hash.digest('hex') === expected.sha256
      } finally {
        await file.close()
      }
    } catch {
      return false
    }
  }

  private async reserve(bytes: number): Promise<void> {
    const protectedPaths = new Set(
      [...this.files.values()].flatMap((files) => [...files.values()].map((file) => file.path)),
    )
    const entries = []
    let total = bytes
    for (const name of await readdir(this.directory)) {
      const path = join(this.directory, name),
        stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw failed()
      total += stat.size
      if (!protectedPaths.has(path)) entries.push({ path, size: stat.size, time: stat.mtimeMs })
    }
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (total <= this.maxBytes && entry.time > Date.now() - 7 * 24 * 60 * 60 * 1000) break
      await unlink(entry.path)
      total -= entry.size
    }
    if (total > this.maxBytes)
      throw new ConnectorError(
        'attachment_cache_full',
        '这台电脑的附件缓存已满，请结束闲置对话并重启连接程序后重试',
      )
  }

  private async receive(
    commandId: string,
    attachmentId: string,
    path: string,
    expected: CustomerAttachmentManifest,
    signal: AbortSignal,
  ) {
    const temporary = join(this.directory, `${randomUUID()}.part`)
    const file = await open(temporary, 'wx', 0o600)
    try {
      let size = 0
      const hash = createHash('sha256')
      for await (const chunk of this.download(commandId, attachmentId, signal)) {
        signal.throwIfAborted()
        size += chunk.byteLength
        if (size > expected.sizeBytes) throw failed()
        hash.update(chunk)
        await file.writeFile(chunk)
      }
      if (size !== expected.sizeBytes || hash.digest('hex') !== expected.sha256) throw failed()
      await file.sync()
      await file.close()
      signal.throwIfAborted()
      await rename(temporary, path)
    } finally {
      await file.close().catch(() => {})
      await unlink(temporary).catch(() => {})
    }
  }
}
