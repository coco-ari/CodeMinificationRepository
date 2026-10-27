import { describe, expect, it } from 'vite-plus/test'
import {
  currentWorkspaceFileReference,
  legacyPreviewPathAllowed,
  workspacePreviewPathAllowed,
} from './materialPreviewScope'

it('当前别名只解析原线程和文件身份，拒绝跨项目或畸形路径', () => {
  const root = 'autoops/p-one/current-input-files/source-thread/old-input/revision-2/'
  expect(currentWorkspaceFileReference(root + 'docs/说明.md', 'p-one')).toEqual({
    threadId: 'source-thread',
    inputId: 'old-input',
    path: 'docs/说明.md',
  })
  for (const path of [
    root,
    root + '../secret',
    root + 'docs//file.md',
    root + 'docs/./file.md',
    root + 'docs\\file.md',
    root + 'docs/说明\n.md',
    root.replace('source-thread', 'source.thread') + 'docs/说明.md',
    root.replace('p-one', 'p-other') + 'docs/说明.md',
    'autoops/p-one/inputs/old-input/docs/说明.md',
  ])
    expect(currentWorkspaceFileReference(path, 'p-one')).toBeNull()
})

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
