import { describe, expect, it } from 'vite-plus/test'
import { parseBusinessSkillMarkdown } from './skills.ts'

describe('AutoOps SKILL.md import', () => {
  it('parses standard YAML, Chinese metadata and markdown without executing resources', () => {
    const skill = parseBusinessSkillMarkdown(
      '---\nname: project-check\ndescription: >\n  阅读资料并整理检查项\nmetadata:\n  display-name: 项目检查\nallowed-tools: [read_project_document, create_report]\n---\n\n# 步骤\n读取资料，再生成会话报告。',
    )
    expect(skill).toMatchObject({
      name: 'project-check',
      displayName: '项目检查',
      tools: ['read_project_document', 'create_report'],
    })
    expect(skill.instructions).toBe('# 步骤\n读取资料，再生成会话报告。')
  })
  it.each([
    '没有 YAML 头部',
    '---\nname: ../../outside\ndescription: x\n---\nx',
    '---\nname: duplicate\nname: other\ndescription: x\n---\nx',
    '---\nname: unsafe\ndescription: x\nallowed-tools: [shell]\n---\nx',
    '---\nname: empty\ndescription: x\n---\n',
  ])('rejects invalid or unsupported skill content: %s', (contents) => {
    expect(() => parseBusinessSkillMarkdown(contents)).toThrow()
  })
  it('accepts BOM and Windows line endings and rejects binary or oversized inputs', () => {
    expect(
      parseBusinessSkillMarkdown('\uFEFF---\r\nname: windows\r\ndescription: 文档\r\n---\r\n步骤')
        .name,
    ).toBe('windows')
    expect(() => parseBusinessSkillMarkdown('\0')).toThrow()
    expect(() => parseBusinessSkillMarkdown('x'.repeat(49 * 1024))).toThrow()
  })
})
