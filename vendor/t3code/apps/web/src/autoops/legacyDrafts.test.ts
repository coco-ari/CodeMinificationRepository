import { describe, it, expect, vi } from 'vite-plus/test'
import { EnvironmentId } from '@t3tools/contracts'
import { recoverLegacyDrafts } from './legacyDrafts'
import type { PromptStashEntry } from '~/promptStashStore'
const draft = { id: 'legacy-1', threadId: 'thread-1', text: 'old draft', attachments: [] }
const entry = (id: string): PromptStashEntry => ({
  id,
  createdAt: '2026-10-21T00:00:00.000Z',
  prompt: 'existing',
  attachments: [],
  droppedImageNames: [],
})
describe('legacy draft recovery through native stash', () => {
  it('keeps existing drafts and only marks durable complete imports', async () => {
    const entries = [entry('current')],
      marked = new Set<string>()
    const result = await recoverLegacyDrafts({
      drafts: [draft],
      environmentId: EnvironmentId.make('env'),
      entries: () => entries,
      stash: (item) => {
        entries.unshift(item)
        return { written: true, durable: true }
      },
      alreadyImported: (id) => marked.has(id),
      markImported: (id) => {
        marked.add(id)
      },
      readImage: async () => {
        throw new Error('unused')
      },
    })
    expect(result).toEqual({ imported: 1, remaining: 0 })
    expect(entries[1]?.id).toBe('current')
    expect(marked.has(draft.id)).toBe(true)
    expect(entries[0]?.createdAt).toBeTruthy()
  })
  it.each([
    { written: false, durable: false },
    { written: true, durable: false },
  ])('does not acknowledge a non durable write %j', async (write) => {
    const markImported = vi.fn()
    const result = await recoverLegacyDrafts({
      drafts: [draft],
      environmentId: EnvironmentId.make('env'),
      entries: () => [],
      stash: () => write,
      alreadyImported: () => false,
      markImported,
      readImage: async () => {
        throw new Error('unused')
      },
    })
    expect(result).toEqual({ imported: 0, remaining: 1 })
    expect(markImported).not.toHaveBeenCalled()
  })
  it('does not evict full stashes or partially save unreadable images', async () => {
    const stash = vi.fn(() => ({ written: true, durable: true })),
      markImported = vi.fn()
    const input = {
      drafts: [draft],
      environmentId: EnvironmentId.make('env'),
      entries: () => Array.from({ length: 20 }, (_, i) => entry(String(i))),
      stash,
      alreadyImported: () => false,
      markImported,
      readImage: async () => {
        throw new Error('image unauthorized')
      },
    }
    expect(await recoverLegacyDrafts(input)).toEqual({ imported: 0, remaining: 1 })
    expect(stash).not.toHaveBeenCalled()
    expect(
      await recoverLegacyDrafts({
        ...input,
        entries: () => [],
        drafts: [
          {
            ...draft,
            attachments: [
              { type: 'image', id: 'img', name: 'photo.png', mimeType: 'image/png', sizeBytes: 12 },
            ],
          },
        ],
      }),
    ).toEqual({ imported: 0, remaining: 1 })
    expect(stash).not.toHaveBeenCalled()
    expect(markImported).not.toHaveBeenCalled()
  })
  it('rechecks capacity after image preparation and does not duplicate a persisted id', async () => {
    const entries: PromptStashEntry[] = []
    const stash = vi.fn(() => ({ written: true, durable: true }))
    const input = {
      drafts: [
        {
          ...draft,
          attachments: [
            {
              type: 'image' as const,
              id: 'img',
              name: 'p.png',
              mimeType: 'image/png',
              sizeBytes: 1,
            },
          ],
        },
      ],
      environmentId: EnvironmentId.make('env'),
      entries: () => entries,
      stash,
      alreadyImported: () => false,
      markImported: vi.fn(),
      readImage: async () => {
        entries.push(...Array.from({ length: 20 }, (_, i) => entry(String(i))))
        return {
          id: 'img',
          name: 'p.png',
          mimeType: 'image/png',
          sizeBytes: 1,
          dataUrl: 'data:image/png;base64,AA==',
        }
      },
    }
    expect(await recoverLegacyDrafts(input)).toEqual({ imported: 0, remaining: 1 })
    expect(stash).not.toHaveBeenCalled()
    expect(
      await recoverLegacyDrafts({
        ...input,
        entries: () => [entry('autoops-legacy-draft:legacy-1')],
      }),
    ).toEqual({ imported: 0, remaining: 0 })
    expect(stash).not.toHaveBeenCalled()
  })
})

it('imports the one substantive draft in the real seven-row legacy shape without empty placeholders', async () => {
  const entries: PromptStashEntry[] = [],
    marked = new Set<string>()
  const drafts = Array.from({ length: 7 }, (_, i) => ({
    id: `legacy-${i}`,
    threadId: `thread-${i}`,
    text: i === 0 ? '一份确实需要保留的历史草稿' : '',
    attachments: [],
  }))
  const result = await recoverLegacyDrafts({
    drafts,
    environmentId: EnvironmentId.make('env'),
    entries: () => entries,
    stash: (item) => {
      entries.unshift(item)
      return { written: true, durable: true }
    },
    alreadyImported: (id) => marked.has(id),
    markImported: (id) => {
      marked.add(id)
    },
    readImage: async () => {
      throw new Error('unused')
    },
  })
  expect(result).toEqual({ imported: 1, remaining: 0 })
  expect(entries).toHaveLength(1)
  expect(marked.size).toBe(7)
})
