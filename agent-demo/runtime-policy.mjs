// Shared AutoOps business policy extracted from the existing, verified bridge.
// It has no RPC client, scheduler or server side effects.
const policyFailure = (code, message, status = 400) => {
  throw Object.assign(new Error(message), { code, status })
}

// 权限作用于模型工具；鉴权和模型请求仍由 app-server 自己处理。
export const RUNNER_CONFIG = {
  'features.shell_tool': false,
  'features.shell_snapshot': false,
  'features.apps': false,
  'features.plugins': false,
  'features.memories': false,
  'features.multi_agent': false,
  'features.request_permissions_tool': false,
  'features.skill_mcp_dependency_install': false,
  'features.code_mode.enabled': false,
  'agents.enabled': false,
  'skills.bundled.enabled': false,
  'skills.include_instructions': false,
  web_search: 'disabled',
  mcp_servers: {},
  hooks: {},
  allow_login_shell: false,
  'permissions.agent_demo.filesystem': { ':root': 'deny' },
  'permissions.agent_demo.network.enabled': false,
  default_permissions: 'agent_demo',
  approval_policy: 'never',
  check_for_update_on_startup: false,
  'analytics.enabled': false,
  project_doc_max_bytes: 0,
}

export function buildRunnerConfig(options = {}, reject = policyFailure) {
  if (!options.provider || options.provider === 'codex') return { ...RUNNER_CONFIG }
  if (options.provider !== 'cpa') reject('INVALID_PROVIDER', '只支持 codex 或 cpa 运行器配置')
  let url
  try {
    url = new URL(options.providerBaseUrl)
  } catch {
    reject('INVALID_PROVIDER_URL', 'CPA 需要显式配置 HTTPS API 地址')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    reject('INVALID_PROVIDER_URL', 'CPA 地址必须是没有鉴权信息、查询参数和片段的 HTTPS URL')
  }
  return {
    ...RUNNER_CONFIG,
    model_provider: 'cpa',
    model: options.model,
    cli_auth_credentials_store: 'ephemeral',
    'shell_environment_policy.inherit': 'none',
    'model_providers.cpa': {
      name: 'CPA',
      base_url: url.toString().replace(/\/$/, ''),
      env_key: 'CPA_API_KEY',
      wire_api: 'responses',
      requires_openai_auth: false,
      supports_websockets: false,
      request_max_retries: 2,
      stream_max_retries: 1,
      stream_idle_timeout_ms: 300000,
    },
  }
}
