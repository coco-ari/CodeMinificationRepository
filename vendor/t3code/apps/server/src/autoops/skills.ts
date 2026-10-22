import { parseDocument } from 'yaml'
import {
  BUSINESS_SKILL_TOOLS,
  businessSkillsRevision,
  readBusinessSkillRegistry,
  type BusinessSkill,
} from '../../../../../../agent-demo/t3-adapters/skills.mjs'
import { AutoOpsAccessError } from '../../../../../../agent-demo/t3-adapters/access.mjs'

const invalid = (message: string): never => {
  throw new AutoOpsAccessError(400, 'INVALID_SKILL', message)
}

export function parseBusinessSkillMarkdown(contents: unknown): BusinessSkill {
  if (
    typeof contents !== 'string' ||
    Buffer.byteLength(contents) > 48 * 1024 ||
    contents.includes('\0')
  )
    return invalid('SKILL.md 必须是小于 48 KiB 的文本文件')
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(contents)
  if (!match) return invalid('SKILL.md 需要以 YAML 头部开头，包含 name 和 description')
  const document = parseDocument(match[1]!, { uniqueKeys: true })
  if (document.errors.length) return invalid('技能 YAML 头部格式无效')
  let header: unknown
  try {
    header = document.toJS({ maxAliasCount: 0 })
  } catch {
    return invalid('技能 YAML 不支持别名')
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header))
    return invalid('技能 YAML 头部需要是对象')
  const fields = header as Record<string, unknown>
  const name = typeof fields.name === 'string' ? fields.name.replace(/^autoops-/, '') : ''
  if (!/^[a-z][a-z0-9-]{0,56}$/u.test(name))
    return invalid('name 仅支持小写英文字母、数字和连字符，最多 57 个字符')
  const description = fields.description
  if (typeof description !== 'string' || !description.trim() || description.length > 500)
    return invalid('description 需要是 1–500 个字符的说明')
  const instructions = match[2]!.trim()
  if (!instructions || Buffer.byteLength(instructions) > 32 * 1024)
    return invalid('技能正文不能为空且不能超过 32 KiB')
  const metadata =
    typeof fields.metadata === 'object' && fields.metadata !== null
      ? (fields.metadata as Record<string, unknown>)
      : {}
  const displayName = typeof metadata['display-name'] === 'string' ? metadata['display-name'] : name
  if (!displayName.trim() || displayName.length > 80) return invalid('技能显示名称最多 80 个字符')
  const requested = fields['allowed-tools']
  const tools =
    requested === undefined
      ? [...BUSINESS_SKILL_TOOLS]
      : typeof requested === 'string'
        ? requested.split(/[\s,]+/u).filter(Boolean)
        : Array.isArray(requested) && requested.every((tool) => typeof tool === 'string')
          ? (requested as string[])
          : []
  if (!tools.length || tools.some((tool) => !BUSINESS_SKILL_TOOLS.includes(tool)))
    return invalid('allowed-tools 只能使用工作台已有的资料、环境查询、提问与会话报告工具')
  return {
    name,
    displayName,
    description: description.trim(),
    instructions,
    tools: [...new Set(tools)],
  }
}

export function businessSkillsResponse(dataDirectory: string, canManage: boolean) {
  const registry = readBusinessSkillRegistry(dataDirectory)
  return {
    revision: businessSkillsRevision(registry),
    canManage,
    skills: registry.skills.map((skill) => ({
      name: `autoops-${skill.name}`,
      displayName: skill.displayName ?? skill.name,
      description: skill.description,
      enabled: skill.enabled,
      builtin: skill.builtin === true,
    })),
  }
}
