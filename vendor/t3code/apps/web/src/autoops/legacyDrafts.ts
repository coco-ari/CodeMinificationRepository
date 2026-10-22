import type { ChatAttachment, EnvironmentId } from '@t3tools/contracts'
import type {
  PersistedComposerFileAttachment,
  PersistedComposerImageAttachment,
} from '~/composerDraftStore'
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  type PromptStashEntry,
} from '~/promptStashStore'
export interface LegacyDraft {
  id: string
  threadId: string
  text: string
  createdAt?: string
  attachments: ReadonlyArray<ChatAttachment>
}
/** Import through the original stash, never merge into or replace a live composer. */
export async function recoverLegacyDrafts(input: {
  drafts: ReadonlyArray<LegacyDraft>
  environmentId: EnvironmentId
  entries: () => ReadonlyArray<PromptStashEntry>
  stash: (entry: PromptStashEntry) => { written: boolean; durable: boolean }
  alreadyImported: (id: string) => boolean
  markImported: (id: string) => void
  readImage: (attachment: ChatAttachment) => Promise<PersistedComposerImageAttachment>
}) {
  let imported = 0,
    remaining = 0
  for (const draft of input.drafts) {
    if (input.alreadyImported(draft.id)) continue
    // Legacy autosave retained an empty row after successful sends. These are
    // not user drafts; acknowledge them locally without occupying native stash.
    if (!draft.text.trim() && draft.attachments.length === 0) {
      try {
        input.markImported(draft.id)
      } catch {
        remaining++
      }
      continue
    }
    const id = `autoops-legacy-draft:${draft.id}`
    // A successful stash write followed by failed marker persistence is still a single entry.
    if (input.entries().some((entry) => entry.id === id)) continue
    if (input.entries().length >= MAX_STASH_ENTRIES) {
      remaining++
      continue
    }
    try {
      const attachments: PersistedComposerImageAttachment[] = []
      const files: PersistedComposerFileAttachment[] = []
      for (const file of draft.attachments) {
        if (file.type === 'image') attachments.push(await input.readImage(file))
        else
          files.push({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            attachmentId: file.id,
            environmentId: input.environmentId,
          })
      }
      if (partitionStashAttachments(attachments).droppedNames.length) {
        remaining++
        continue
      }
      // Recheck after asynchronous image reads: another tab/action may have filled the stash.
      if (input.entries().length >= MAX_STASH_ENTRIES) {
        remaining++
        continue
      }
      const result = input.stash({
        id,
        createdAt: draft.createdAt ?? new Date().toISOString(),
        prompt: draft.text,
        attachments,
        files,
        droppedImageNames: [],
        unreadableImageNames: [],
      })
      if (!result.written || !result.durable) {
        remaining++
        continue
      }
      input.markImported(draft.id)
      imported++
    } catch {
      remaining++
    }
  }
  return { imported, remaining }
}
