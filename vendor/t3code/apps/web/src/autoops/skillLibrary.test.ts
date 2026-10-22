import { describe, expect, it } from 'vite-plus/test'
import { skillFileSource, type LibrarySkill, type SkillVersion } from './skillLibrary'

const version: SkillVersion = {
  id: 'fixed-version',
  createdAt: '2026-10-22T00:00:00Z',
  fileCount: 3,
  readiness: 'ready',
  reason: null,
  contentHash: 'fixed-content',
  byteLength: 30,
  source: { type: 'archive' },
  files: ['SKILL.md', 'references/资料 文件.md', 'references/nested/detail.md'].map((path) => ({
    path,
    size: 10,
    sha256: 'file-hash',
    mime: 'text/markdown',
    binary: false,
  })),
}
const skill: LibrarySkill = {
  id: 'test-skill',
  name: 'test-skill',
  displayName: '测试技能',
  description: '测试',
  enabled: true,
  versions: [version],
  latestVersionId: version.id,
}

describe('技能文件浏览的范围内链接', () => {
  it('根文档与嵌套文档按各自目录解析，保留中文与空格', () => {
    const source = skillFileSource(skill, version)
    expect(
      source.resolveLink?.('SKILL.md', 'references/%E8%B5%84%E6%96%99%20%E6%96%87%E4%BB%B6.md'),
    ).toEqual({ path: 'references/资料 文件.md', kind: 'file' })
    expect(source.resolveLink?.('references/nested/detail.md', '../../SKILL.md#header')).toEqual({
      path: 'SKILL.md',
      kind: 'file',
    })
    expect(source.resolveLink?.('references/nested/detail.md', '../')).toEqual({
      path: 'references',
      kind: 'directory',
    })
  })
  it('不能跳出包根、猜测其他版本或转入工作区的绝对路径', () => {
    const source = skillFileSource(skill, version)
    for (const href of [
      '../SKILL.md',
      '%2E%2E/secret.md',
      '/autoops/other-project/secret.md',
      'references/missing.md',
      'references/%00hidden.md',
      'references/%not-valid',
    ]) {
      expect(source.resolveLink?.('SKILL.md', href)).toHaveProperty('error')
    }
  })
  it('外部链接与当前文档锚点保留原生处理，文件树仍只有包内文件', async () => {
    const source = skillFileSource(skill, version)
    expect(source.resolveLink?.('SKILL.md', 'https://example.com/reference')).toBeNull()
    expect(source.resolveLink?.('SKILL.md', '#section')).toBeNull()
    expect((await source.list('')).entries).toEqual([
      { path: 'references', kind: 'directory' },
      { path: 'SKILL.md', kind: 'file' },
    ])
    expect((await source.search('资料', 20)).entries).toEqual([
      { path: 'references/资料 文件.md', kind: 'file' },
    ])
  })
})
