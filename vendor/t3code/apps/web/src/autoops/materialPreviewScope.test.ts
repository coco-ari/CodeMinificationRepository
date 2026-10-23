import { describe, expect, it } from 'vite-plus/test'
import { legacyPreviewPathAllowed, workspacePreviewPathAllowed } from './materialPreviewScope'

describe('conversation material preview boundary', () => {
  it('keeps previews in the exact fixed project and version, including the root directory', () => {
    const root = 'autoops/p-autoops/workspaces/external-1'
    expect(workspacePreviewPathAllowed(root, root)).toBe(true)
    expect(workspacePreviewPathAllowed(root + '/frontend/package.json', root)).toBe(true)
    for (const path of [
      'autoops/p-autoops/workspaces/internal-1/backend/.env',
      'autoops/p-autoops/workspaces/external-10/frontend/package.json',
      'autoops/p-other/workspaces/external-1/frontend/package.json',
      'autoops/p-autoops/documents/doc-1/version/原始资料.md',
    ])
      expect(workspacePreviewPathAllowed(path, root)).toBe(false)
  })

  it('preserves authorized historical files without exposing workspace or host-directory browsing', () => {
    for (const path of [
      'autoops/p-autoops/documents/doc-1/version/设计.md',
      'autoops/p-autoops/threads/thread-1/reports/report-1/报告.md',
      'autoops/p-autoops/threads/thread-1/attachments/file-1/资料.pdf',
    ])
      expect(legacyPreviewPathAllowed(path, 'p-autoops')).toBe(true)
    for (const path of [
      null,
      '/etc/passwd',
      'frontend/package.json',
      'autoops/p-autoops/documents',
      'autoops/p-autoops/workspaces/version-1/frontend/package.json',
      'autoops/p-other/documents/doc-1/version/设计.md',
    ])
      expect(legacyPreviewPathAllowed(path, 'p-autoops')).toBe(false)
  })
})

it('当前预览按同项目输入固定根目录，不能把相邻标识当同一输入', async () => {
  const { workspaceInputRoot } = await import('./materialPreviewScope')
  expect(workspaceInputRoot('autoops/p-one/inputs/input-one/docs/需求.md', 'p-one')).toBe(
    'autoops/p-one/inputs/input-one',
  )
  expect(workspaceInputRoot('autoops/p-two/inputs/input-one/docs/需求.md', 'p-one')).toBeNull()
  expect(
    workspaceInputRoot('autoops/p-one/workspaces/version-one/docs/需求.md', 'p-one'),
  ).toBeNull()
  expect(
    workspacePreviewPathAllowed(
      'autoops/p-one/inputs/input-one-extra/docs/需求.md',
      'autoops/p-one/inputs/input-one',
    ),
  ).toBe(false)
})
