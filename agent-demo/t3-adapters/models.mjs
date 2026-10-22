import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const modelId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)
const cachePath = directory => join(directory, 't3', 'models-catalog.json')

/** CPA's Codex-compatible catalog supplies capabilities; never copy its system
 * instructions, tool configuration, or approval settings into the runtime. */
export function normalizeCpaModels(value) {
  if (!Array.isArray(value?.models) || value.models.length > 512) throw new Error('CPA 未返回有效的模型能力目录')
  const seen = new Set()
  const models = []
  for (const item of value.models) {
    if (!modelId(item.slug) || seen.has(item.slug)) throw new Error('CPA 模型标识无效或重复')
    seen.add(item.slug)
    // These are media-generation endpoints, even when a generic catalog marks
    // them as visible. They cannot complete this workbench's text/tool turns.
    if (item.visibility === 'hide' || item.supported_in_api === false || /^grok-imagine-/i.test(item.slug)) continue
    const levels = item.supported_reasoning_levels ?? []
    if (!Array.isArray(levels) || levels.some(level => !efforts.has(level.effort))) throw new Error('CPA 返回了运行器尚不支持的思考档位')
    const reasoningLevels = [...new Set(levels.map(level => level.effort))]
    const modalities = (item.input_modalities ?? ['text']).filter(value => ['text', 'image'].includes(value))
    if (!modalities.includes('text')) continue
    if (reasoningLevels.length && !reasoningLevels.includes(item.default_reasoning_level)) throw new Error('CPA 默认思考档位不在支持范围内')
    models.push({
      id: item.slug,
      name: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.slice(0, 128) : item.slug,
      reasoningLevels,
      defaultReasoning: reasoningLevels.length ? item.default_reasoning_level : null,
      inputModalities: [...new Set(modalities)],
      contextWindow: Number.isSafeInteger(item.context_window) && item.context_window > 0 ? item.context_window : null,
      supportsReasoningEffortUpdates: item.supports_reasoning_effort_updates === true,
    })
  }
  if (!models.length || models.length > 128) throw new Error('CPA 没有可用于项目助手的对话模型')
  return models
}

export function readBusinessModels(directory, defaultModel, expectedSource) {
  if (!modelId(defaultModel)) throw new Error('默认模型标识无效')
  const path = directory && cachePath(directory)
  if (!path || !existsSync(path)) return {
    discovered: false, models: [{ id: defaultModel, name: defaultModel, reasoningLevels: [], defaultReasoning: null, inputModalities: ['text', 'image'], contextWindow: null, supportsReasoningEffortUpdates: false }],
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('模型能力缓存必须是有效的普通文件')
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (saved.version !== 1 || typeof saved.source !== 'string' || !Array.isArray(saved.models) || !saved.models.length || saved.models.length > 128 || (expectedSource && saved.source !== expectedSource)) throw new Error('模型能力缓存与当前 CPA 不匹配')
  const normalized = normalizeCpaModels({ models: saved.models.map(model => ({
    slug: model.id, display_name: model.name, supported_reasoning_levels: model.reasoningLevels?.map(effort => ({ effort })),
    default_reasoning_level: model.defaultReasoning, input_modalities: model.inputModalities,
    context_window: model.contextWindow, supports_reasoning_effort_updates: model.supportsReasoningEffortUpdates,
  })) })
  if (!normalized.some(model => model.id === defaultModel)) throw new Error('默认模型已不在 CPA 模型目录中，请更新管理员配置')
  return { discovered: true, source: saved.source, fetchedAt: saved.fetchedAt, models: normalized }
}

export function configuredBusinessModels(env = process.env) {
  return readBusinessModels(env.AUTOOPS_T3_DATA_DIR || env.DATA_DIR, env.AUTOOPS_T3_MODEL || env.AGENT_DEMO_MODEL)
}

export function requireBusinessModel(model, env = process.env) {
  const catalog = configuredBusinessModels(env)
  const selected = catalog.models.find(entry => entry.id === model)
  if (!selected) throw new Error('所选模型不在当前 CPA 对话目录中，请重新选择')
  return selected
}

export function assertBusinessModelSelection(selection, env = process.env) {
  if (selection?.instanceId !== 'codex') throw new Error('请选择工作台已配置的 CPA 模型')
  const model = requireBusinessModel(selection.model, env)
  const options = selection.options ?? []
  if (!Array.isArray(options) || options.length > 1 || options.some(option => option.id !== 'reasoningEffort' || !model.reasoningLevels.includes(option.value))) throw new Error('所选模型不支持这个思考档位，请重新选择')
}

export function cpaModelsUrl(baseUrl) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('CPA 模型目录需要使用已配置的 HTTPS 地址')
  return new URL(base.href.replace(/\/$/, '') + '/models?client_version=0.159.2').href
}

/** Reuse CPA's published discovery protocol at worker startup. Persist only
 * capability metadata; a temporary outage may reuse this same endpoint's cache. */
export async function synchronizeBusinessModels(env = process.env, fetcher = fetch) {
  if ((env.AGENT_DEMO_PROVIDER || 'cpa') !== 'cpa') return
  const directory = resolve(env.DATA_DIR || env.AUTOOPS_T3_DATA_DIR || 'agent-demo/data')
  const defaultModel = env.AGENT_DEMO_MODEL || env.AUTOOPS_T3_MODEL
  const source = cpaModelsUrl(env.AGENT_DEMO_CPA_BASE_URL)
  const keyPath = env.AGENT_DEMO_CPA_API_KEY_FILE
  if (!keyPath) throw new Error('缺少 CPA 专用密钥文件路径')
  const stat = lstatSync(keyPath)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 16384) throw new Error('CPA 密钥文件必须是仅属主可读的常规文件')
  const key = readFileSync(keyPath, 'utf8').trim()
  if (key.length < 8 || /[\r\n\0]/.test(key)) throw new Error('CPA 专用密钥文件格式无效')
  let models
  try {
    const response = await fetcher(source, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(25000), redirect: 'error' })
    if (!response.ok) throw new Error('CPA 模型目录 HTTP ' + response.status)
    const text = await response.text()
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('CPA 模型目录超出大小限制')
    models = normalizeCpaModels(JSON.parse(text))
    if (!models.some(model => model.id === defaultModel)) throw new Error('默认模型已不在 CPA 模型目录中')
  } catch (error) {
    const cached = readBusinessModels(directory, defaultModel, source)
    if (!cached.discovered) throw new Error('无法读取 CPA 模型能力目录，请检查服务后重试', { cause: error })
    console.warn('CPA 模型目录暂不可达，沿用上次成功同步的能力目录。')
    return cached
  }
  const path = cachePath(directory)
  mkdirSync(join(directory, 't3'), { recursive: true, mode: 0o700 })
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('模型能力缓存不能是符号链接')
  const next = { version: 1, source, fetchedAt: new Date().toISOString(), models }
  const temporary = path + `.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
  return { discovered: true, ...next }
}
