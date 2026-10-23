import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeCpaModels, synchronizeBusinessModels, readBusinessModels, assertBusinessModelSelection } from '../agent-demo/t3-adapters/models.mjs'
import { prepareBusinessNativePolicy, assertBusinessNativeConfig } from '../agent-demo/t3-adapters/native-catalog.mjs'
import { prepareAutoOpsCodexRequest } from '../agent-demo/t3-adapters/codex-policy.mjs'
import { authorizeAutoOpsRpc } from '../agent-demo/t3-adapters/rpc-policy.mjs'

const entry=(slug,levels=['low','medium','high','xhigh'])=>({slug,display_name:slug,visibility:'list',supported_reasoning_levels:levels.map(effort=>({effort})),default_reasoning_level:'medium',input_modalities:['text','image'],context_window:500000,base_instructions:'NEVER_IMPORT_CPA_INSTRUCTIONS'})
const inventory={models:[entry('grok-4.6'),entry('grok-3-mini',['low','medium','high']),entry('grok-imagine-video-1.5'),{...entry('hidden-model'),visibility:'hide'}]}
function fixture(t){const data=mkdtempSync(join(tmpdir(),'autoops-models-'));t.after(()=>rmSync(data,{recursive:true,force:true}));const key=join(data,'key');writeFileSync(key,'test-cpa-key-only',{mode:0o600});return {data,env:{DATA_DIR:data,AUTOOPS_T3_DATA_DIR:data,AUTOOPS_T3_MODEL:'grok-4.6',AGENT_DEMO_MODEL:'grok-4.6',AGENT_DEMO_CPA_BASE_URL:'https://provider.example/v1',AGENT_DEMO_CPA_API_KEY_FILE:key,AUTOOPS_DEMO_PROFILE:'project-assistant-lite-v1'}}}
const fetchCatalog=async()=>new Response(JSON.stringify(inventory),{status:200})

test('真实目录保留各模型思考档位，过滤媒体与隐藏模型，不信任远端系统指令',()=>{
 const models=normalizeCpaModels(inventory)
 assert.deepEqual(models.map(m=>m.id),['grok-4.6','grok-3-mini'])
 assert.deepEqual(models[1].reasoningLevels,['low','medium','high'])
 assert(!JSON.stringify(models).includes('NEVER_IMPORT'))
 assert.throws(()=>normalizeCpaModels({models:[entry('bad\nmodel')]}),/无效/)
 assert.throws(()=>normalizeCpaModels({models:[entry('m'),entry('m')]}),/重复/)
})
test('同步使用现有密钥且缓存不含密钥；临时故障只回用同源已验证目录',async t=>{
 const {data,env}=fixture(t);let called=false
 await synchronizeBusinessModels(env,async(url,options)=>{called=true;assert.equal(url,'https://provider.example/v1/models?client_version=0.159.2');assert.equal(options.headers.Authorization,'Bearer test-cpa-key-only');return fetchCatalog()})
 assert(called);const file=join(data,'t3/models-catalog.json');assert.equal(statSync(file).mode&0o777,0o600);assert(!readFileSync(file,'utf8').includes('test-cpa-key-only'))
 const cached=await synchronizeBusinessModels(env,async()=>{throw Error('offline')});assert.equal(cached.models.length,2)
 await assert.rejects(()=>synchronizeBusinessModels({...env,AGENT_DEMO_CPA_BASE_URL:'https://other.example/v1'},async()=>{throw Error('offline')}),/不匹配/)
 const empty=fixture(t);await assert.rejects(()=>synchronizeBusinessModels(empty.env,async()=>new Response('{}',{status:503})),/无法读取/)
})
test('模型与思考选项双层校验；原生请求保留所选值、拒绝越界并保持业务权限',async t=>{
 const {env,data}=fixture(t);await synchronizeBusinessModels(env,fetchCatalog)
 const previous={...process.env};Object.assign(process.env,env)
 t.after(()=>{for(const key of Object.keys(env))if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]})
 const selection={instanceId:'codex',model:'grok-3-mini',options:[{id:'reasoningEffort',value:'high'}]}
 assert.doesNotThrow(()=>assertBusinessModelSelection(selection,env))
 assert.throws(()=>assertBusinessModelSelection({...selection,options:[{id:'reasoningEffort',value:'xhigh'}]},env),/思考/)
 assert.throws(()=>assertBusinessModelSelection({...selection,model:'grok-imagine-video-1.5'},env),/模型/)
 assert.throws(()=>assertBusinessModelSelection({...selection,options:[{id:'serviceTier',value:'priority'}]},env),/思考/)
 const binding={threadId:'t',projectId:'p',compatibilityReadOnly:false},access={refresh(){},requireThread(){return binding},requireReference(){}}
 assert.doesNotThrow(()=>authorizeAutoOpsRpc(access,{},'orchestration.dispatchCommand',{type:'thread.model-selection.set',threadId:'t',modelSelection:selection}))
 assert.throws(()=>authorizeAutoOpsRpc(access,{},'orchestration.dispatchCommand',{type:'thread.model-selection.set',threadId:'t',modelSelection:{...selection,model:'unregistered'}}),/模型/)
 const result=prepareAutoOpsCodexRequest('turn/start',{model:'grok-3-mini',effort:'high',sandboxPolicy:{type:'dangerFullAccess'}})
 assert.equal(result.model,'grok-3-mini');assert.equal(result.effort,'high');assert.equal(result.permissions,'agent_demo');assert.equal(result.sandboxPolicy,undefined)
 assert.throws(()=>prepareAutoOpsCodexRequest('turn/start',{model:'grok-3-mini',effort:'xhigh'}),/思考/)
 assert.throws(()=>prepareAutoOpsCodexRequest('turn/start',{model:'grok-3-mini',collaborationMode:{settings:{model:'grok-4.6'}}}),/不一致/)
 const home=join(data,'t3/codex-home'),{policy}=prepareBusinessNativePolicy(data,home,'grok-4.6',env),catalog=JSON.parse(readFileSync(policy.model_catalog_json,'utf8'))
 assert.equal(catalog.models.length,2);assert.equal(catalog.models[1].supported_reasoning_levels.length,3);assert(!JSON.stringify(catalog).includes('NEVER_IMPORT'))
 const response={config:{permissions:{agent_demo:{filesystem:{':root':'deny'}}},model:'grok-4.6',model_catalog_json:policy.model_catalog_json,features:{multi_agent:false},agents:{enabled:false,max_depth:1,default_subagent_model:'grok-4.6',...Object.fromEntries(['default','explorer','worker'].map(role=>[role,policy['agents.'+role]]))}}}
 assert.doesNotThrow(()=>assertBusinessNativeConfig(response,env))
 catalog.models[0].supported_reasoning_levels.push({effort:'ultra',description:''});writeFileSync(policy.model_catalog_json,JSON.stringify(catalog));assert.throws(()=>assertBusinessNativeConfig(response,env),/CPA 能力目录/)
 assert.equal(readBusinessModels(data,'grok-4.6').models.length,2)
})
