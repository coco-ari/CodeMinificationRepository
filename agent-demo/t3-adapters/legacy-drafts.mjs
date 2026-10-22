import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export function readImportedDrafts(access, principal, dataDirectory) {
  access.refresh(principal)
  const db = new DatabaseSync(join(dataDirectory, 't3-autoops.sqlite'), { readOnly: true })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='t3_legacy_import_records'").get()) return []
    const rows = db.prepare("SELECT legacy_id,thread_id,body_json FROM t3_legacy_import_records WHERE kind='draft' AND owner_id=? ORDER BY legacy_id").all(principal.id)
    return rows.filter((row) => access.canSeeThread(principal, row.thread_id)).map((row) => {
      const body = JSON.parse(row.body_json)
      const attachments = (body.attachmentIds || []).map((id) => {
        const file = access.requireAttachment(principal, id, row.thread_id)
        return { id: file.id, type: file.type || (file.mimeType?.startsWith('image/') ? 'image' : 'file'), name: file.name || id, mimeType: file.mimeType || 'application/octet-stream', sizeBytes: file.sizeBytes || 0 }
      })
      return { id: row.legacy_id, threadId: row.thread_id, text: body.text || '', attachments }
    })
  } finally { db.close() }
}
