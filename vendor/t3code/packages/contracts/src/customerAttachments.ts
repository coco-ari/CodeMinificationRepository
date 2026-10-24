import * as Schema from 'effect/Schema'
import {
  ChatFileAttachment,
  ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from './chatAttachment.ts'

export const CUSTOMER_ATTACHMENT_LIMITS = {
  maxFileBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  maxTotalBytes: 100 * 1024 * 1024,
  maxCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} as const
export const CustomerAttachment = Schema.Union([ChatFileAttachment, ChatImageAttachment])
export type CustomerAttachment = typeof CustomerAttachment.Type
export const CustomerAttachmentManifest = Schema.Struct({
  id: ChatFileAttachment.fields.id,
  sizeBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(CUSTOMER_ATTACHMENT_LIMITS.maxFileBytes),
  ),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type CustomerAttachmentManifest = typeof CustomerAttachmentManifest.Type

export function customerMessageAttachments(input: unknown): readonly CustomerAttachment[] {
  const message = (input as { message?: { attachments?: unknown } } | null)?.message
  const attachments = Schema.decodeUnknownSync(Schema.Array(CustomerAttachment))(
    message?.attachments ?? [],
  )
  if (
    attachments.length > CUSTOMER_ATTACHMENT_LIMITS.maxCount ||
    attachments.reduce((total, item) => total + item.sizeBytes, 0) >
      CUSTOMER_ATTACHMENT_LIMITS.maxTotalBytes ||
    new Set(attachments.map((item) => item.id)).size !== attachments.length
  ) {
    throw new Error('附件过多或总大小超过 100 MB，请减少后发送')
  }
  return attachments
}
