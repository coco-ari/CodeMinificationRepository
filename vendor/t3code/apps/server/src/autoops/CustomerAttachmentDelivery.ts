// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolveAttachmentPathById } from '../attachmentStore.ts'
import {
  customerMessageAttachments,
  type CustomerAttachment,
  type CustomerAttachmentManifest,
} from '../../../../packages/contracts/src/customerAttachments.ts'
import {
  AutoOpsAccessError,
  type AutoOpsAccess,
} from '../../../../../../agent-demo/t3-adapters/access.mjs'
import type { TransportSession } from '../../../../../../agent-demo/t3-adapters/customer-transport.mjs'

const unavailable = () =>
  new AutoOpsAccessError(409, 'CUSTOMER_ATTACHMENT_UNAVAILABLE', '附件未能传到电脑，请重新发送')

// 附件内容仍由 T3 存储拥有；设备只能读取原命令已固定、已归属该私有会话的附件。
export class CustomerAttachmentDelivery {
  private readers = 0
  private readonly access: AutoOpsAccess
  private readonly attachmentsDir: string
  constructor(access: AutoOpsAccess, attachmentsDir: string) {
    this.access = access
    this.attachmentsDir = attachmentsDir
  }

  async read(
    session: TransportSession,
    attachment: CustomerAttachment,
    expected?: CustomerAttachmentManifest,
  ) {
    const metadata = this.access.requireCustomerAttachment(
      session.ownerId,
      session.threadId,
      attachment.id,
    )
    if (
      metadata.sizeBytes !== attachment.sizeBytes ||
      metadata.name !== attachment.name ||
      metadata.mimeType !== attachment.mimeType
    )
      throw unavailable()
    const path = resolveAttachmentPathById({
      attachmentsDir: this.attachmentsDir,
      attachmentId: attachment.id,
    })
    if (!path) throw unavailable()
    if (this.readers >= 2)
      throw new AutoOpsAccessError(503, 'CUSTOMER_ATTACHMENT_BUSY', '附件传输繁忙，请稍后重试')
    this.readers++
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== attachment.sizeBytes) throw unavailable()
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          size += chunk.length
          if (size > attachment.sizeBytes) throw unavailable()
          chunks.push(chunk)
        }
        if (size !== attachment.sizeBytes) throw unavailable()
        const bytes = Buffer.concat(chunks, size)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (
          expected &&
          (expected.id !== attachment.id ||
            expected.sizeBytes !== size ||
            expected.sha256 !== sha256)
        )
          throw unavailable()
        this.access.requireCustomerAttachment(session.ownerId, session.threadId, attachment.id)
        return { bytes, manifest: { id: attachment.id, sizeBytes: size, sha256 } }
      } finally {
        await file.close()
      }
    } catch (cause) {
      if (cause instanceof AutoOpsAccessError) throw cause
      throw unavailable()
    } finally {
      this.readers--
    }
  }

  async prepare(session: TransportSession, input: unknown) {
    const attachments = customerMessageAttachments(input)
    const manifest: CustomerAttachmentManifest[] = []
    for (const attachment of attachments)
      manifest.push((await this.read(session, attachment)).manifest)
    return manifest
  }
}
