import { resolveProductProfile } from './product-profile.mjs'
import { existsSync, lstatSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readBusinessSkills, prepareBusinessSkills, businessSkillRules } from './skills.mjs'
import { readBusinessModels } from './models.mjs'

// Port of the schema/default shape in Codex rust-v0.159.2
// models-manager/src/model_info.rs::model_info_from_slug. This is a runtime
// compatibility descriptor, not a statement of the CPA model's token capacity.
export function fixedNativeModelCatalog(model) {
  if (typeof model !== 'string' || !model.trim() || model.length>128 || /[\r\n\0]/.test(model)) throw new Error('内置模型标识无效')
  return {models:[{
    slug:model,display_name:model,description:'管理员固定的 CPA 模型；容量和价格未由提供方报告',
    base_instructions:'你是 AutoOps 内置项目助手，只使用当前会话实际授予的业务工具，遵守项目、环境和资料权限，保留真实来源。',
    supported_reasoning_levels:[],shell_type:'disabled',visibility:'list',supported_in_api:true,priority:0,
    additional_speed_tiers:[],service_tiers:[],availability_nux:null,upgrade:null,
    include_skills_usage_instructions:true,include_plugin_usage_instructions:false,include_apps_usage_instructions:false,
    supports_reasoning_summary_parameter:true,default_reasoning_summary:'auto',support_verbosity:false,default_verbosity:null,
    apply_patch_tool_type:null,web_search_tool_type:'text',truncation_policy:{mode:'bytes',limit:10000},
    supports_image_detail_original:false,context_window:null,max_context_window:null,auto_compact_token_limit:null,
    effective_context_window_percent:95,experimental_supported_tools:[],input_modalities:['text','image'],
    supports_search_tool:false,supports_experimental_context:false,use_responses_lite:false,
    supports_reasoning_effort_updates:false,node_repl_disabled:true,multi_agent_version:'v1',
  }]}
}

export function businessNativeModelCatalog(dataDirectory, defaultModel) {
  const catalog = readBusinessModels(dataDirectory, defaultModel)
  return { models: catalog.models.map(model => ({
    ...fixedNativeModelCatalog(model.id).models[0],
    display_name: model.name,
    description: 'CPA 提供的项目助手模型；思考档位与上下文容量来自 CPA 能力目录。',
    supported_reasoning_levels: model.reasoningLevels.map(effort => ({ effort, description: '' })),
    ...(model.defaultReasoning ? { default_reasoning_level: model.defaultReasoning } : {}),
    supports_reasoning_effort_updates: model.supportsReasoningEffortUpdates,
    input_modalities: model.inputModalities,
    context_window: model.contextWindow,
  })) }
}

export function businessNativePolicy(dataDirectory,codexHome,model,env=process.env) {
  const subagents=resolveProductProfile(env).capabilities.subagents
  const root=join(dataDirectory,'t3','native-policy')
  const skillPaths=readBusinessSkills(dataDirectory).map(skill=>join(codexHome,'skills',skill.name,'SKILL.md'))
  const role={description:'在同一项目、环境和权限范围内完成只读分析，继承父会话业务工具。',config_file:join(root,'readonly-agent.toml')}
  return {
    model_catalog_json:join(root,'models.json'),
    'features.multi_agent':subagents,'agents.enabled':subagents,
    'agents.max_threads':2,'agents.max_depth':1,
    'agents.default':role,'agents.explorer':role,'agents.worker':role,
    'agents.default_subagent_model':model,
    'skills.include_instructions':skillPaths.length>0,
    'skills.bundled.enabled':false,
    'skills.config':businessSkillRules(dataDirectory,codexHome),
    'permissions.agent_demo.filesystem':{':root':'deny',[join(codexHome,'skills')]:'read',...Object.fromEntries(skillPaths.map(path=>[path,'read']))},
  }
}

export function prepareBusinessNativePolicy(dataDirectory,codexHome,model,env=process.env) {
  resolveProductProfile(env)
  const root=join(dataDirectory,'t3','native-policy')
  mkdirSync(root,{recursive:true,mode:0o700})
  if(lstatSync(root).isSymbolicLink())throw new Error('原生策略目录不能是符号链接')
  const write=(name,value)=>{const path=join(root,name);if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('原生策略文件不能是符号链接');writeFileSync(path,value,{mode:0o600})}
  write('models.json',JSON.stringify(businessNativeModelCatalog(dataDirectory,model),null,2)+'\n')
  // All built-in roles use the same fixed model; otherwise the native explorer
  // role could choose a different model after the spawn argument validation.
  write('readonly-agent.toml',`model = ${JSON.stringify(model)}\n[features]\nshell_tool = false\napps = false\nplugins = false\nmemories = false\nrequest_permissions_tool = false\n`)
  const skills=prepareBusinessSkills(dataDirectory,codexHome)
  return {policy:businessNativePolicy(dataDirectory,codexHome,model,env),skills}
}

export function configuredBusinessNativePolicy(env=process.env) {
  if(!env.AUTOOPS_T3_DATA_DIR)return {}
  const model=env.AUTOOPS_T3_MODEL || env.AGENT_DEMO_MODEL
  if(!model)throw new Error('原生策略缺少固定模型')
  return businessNativePolicy(env.AUTOOPS_T3_DATA_DIR,env.AUTOOPS_T3_CODEX_HOME || join(env.AUTOOPS_T3_DATA_DIR,'t3','codex-home'),model,env)
}

export function refreshBusinessSkillLaunchArgs(launchArgs,env=process.env) {
  if(!env.AUTOOPS_T3_DATA_DIR)return launchArgs
  const policy=configuredBusinessNativePolicy(env)
  const toml=value=>typeof value==='string'?JSON.stringify(value):typeof value==='boolean'||typeof value==='number'?String(value):Array.isArray(value)?`[${value.map(toml).join(',')}]`:`{${Object.entries(value).map(([key,entry])=>`${JSON.stringify(key)}=${toml(entry)}`).join(',')}}`
  const quote=value=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"'
  return [launchArgs,...['skills.config','skills.include_instructions','permissions.agent_demo.filesystem'].flatMap(key=>['-c',quote(`${key}=${toml(policy[key])}`)])].join(' ')
}

/** Validate the effective native configuration before any model request.
 * Custom roles can change model after spawn's catalog check, so unexpected
 * inherited roles must fail closed instead of silently expanding this boundary.
 */
export function assertBusinessNativeConfig(response,env=process.env) {
  if(!env.AUTOOPS_T3_DATA_DIR)return
  const model=env.AUTOOPS_T3_MODEL||env.AGENT_DEMO_MODEL
  const root=join(env.AUTOOPS_T3_DATA_DIR,'t3','native-policy')
  const canonical=path=>typeof path==='string'&&(existsSync(path)?realpathSync(path):resolve(path))
  const config=response?.config
  if(!config||config.model!==model||canonical(config.model_catalog_json)!==canonical(join(root,'models.json')))throw new Error('原生模型配置未匹配管理员固定目录')
  const catalog=JSON.parse(readFileSync(join(root,'models.json'),'utf8'))
  if(JSON.stringify(catalog)!==JSON.stringify(businessNativeModelCatalog(env.AUTOOPS_T3_DATA_DIR,model)))throw new Error('原生模型目录未匹配当前 CPA 能力目录')
  const subagents=resolveProductProfile(env).capabilities.subagents
  const agents=config.agents
  if(config.features?.multi_agent!==subagents)throw new Error('原生子任务功能开关未匹配产品配置')
  const controls=new Set(['enabled','max_threads','max_concurrent_threads_per_session','max_depth','default_subagent_model','default_subagent_reasoning_effort','job_max_runtime_seconds','interrupt_message'])
  const roles=['default','explorer','worker']
  if(!agents||agents.enabled!==subagents||agents.max_depth!==1||agents.default_subagent_model!==model)throw new Error('原生子任务配置不符合管理员限制')
  if(Object.keys(agents).some(key=>!controls.has(key)&&!roles.includes(key)))throw new Error('原生配置包含未注册的子任务角色')
  const expected=join(root,'readonly-agent.toml')
  for(const role of roles)if(canonical(agents[role]?.config_file)!==canonical(expected))throw new Error('原生子任务角色未使用固定模型配置')
  const expectedText=`model = ${JSON.stringify(model)}\n[features]\nshell_tool = false\napps = false\nplugins = false\nmemories = false\nrequest_permissions_tool = false\n`
  if(readFileSync(expected,'utf8')!==expectedText)throw new Error('原生子任务角色配置已改变')
}
