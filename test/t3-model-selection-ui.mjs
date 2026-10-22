import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

const origin=process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887'
const production=new URL(origin).port==='8787'
if(production&&process.env.T3_PRODUCTION_SMOKE!=='1')throw Error('须显式授权正式入口验证')
const output=path.resolve(process.env.T3_MODELS_OUTPUT||'.test-artifacts/t3-models/stage-ui')
await mkdir(output,{recursive:true})
const client=new T3LiveClient(origin),owned=new Set(),report={origin,steps:[],pageErrors:[],ownedThreads:[]}
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'}),page=await context.newPage()
page.on('pageerror',e=>report.pageErrors.push(e.message))
const terminal=r=>['completed','failed','interrupted','cancelled','rolled_back'].includes(r.status)
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2))
async function until(fn,timeout=150000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,400))}throw Error('等待真实状态超时')}
async function step(name,fn){const row={name};report.steps.push(row);try{row.result=await fn();row.status='passed'}catch(e){row.status='failed';row.error=e.stack;await page.screenshot({path:path.join(output,name+'-failed.png')}).catch(()=>{});throw e}finally{await save();console.log(JSON.stringify({name,status:row.status,error:row.error}))}}
const editor=()=>page.getByTestId('composer-editor')
const picker=()=>page.locator('button[data-chat-provider-model-picker="true"]:visible').first()
const traits=()=>page.locator('button[data-composer-shortcut="composer.effort"]:visible').first()
async function chooseModel(id,label){await picker().click();const search=page.getByPlaceholder('搜索模型…',{exact:true});await search.fill(label);await page.getByRole('option').filter({has:page.getByText(label,{exact:true})}).first().click();await until(async()=> (await picker().innerText()).includes(label))}
async function chooseEffort(label){await traits().click();await page.getByRole('menuitemradio',{name:new RegExp('^'+label+'(?:默认)?$')}).click();await until(async()=> (await traits().innerText()).includes(label))}
async function sendFromUi(text,expectedModel,expectedEffort){await editor().fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.waitForURL(url=>!url.hash.includes('/draft/')&&url.hash.split('/').length>=3,{timeout:60000});const id=new URL(page.url()).hash.split('/')[2];assert(id);owned.add(id);report.ownedThreads=[...owned];const p=await until(async()=>{const v=await client.projection(id);return v.runs.length&&v.runs.every(terminal)?v:null});assert(p.runs.every(r=>r.status==='completed'),JSON.stringify(p.runs.map(r=>({status:r.status,error:r.error}))));assert.equal(p.thread.modelSelection.model,expectedModel);assert(p.thread.modelSelection.options?.some(o=>o.id==='reasoningEffort'&&o.value===expectedEffort));return {id,projection:p}}
try{
 await client.login();await client.connect();report.environmentId=(await client.http('/.well-known/t3/environment')).environmentId
 await step('real-native-model-catalog',async()=>{
  assert.equal(client.bootstrap.modelSelectionEnabled,true)
  const shell=await client.http('/api/orchestration/shell'),project=shell.projects.find(p=>p.id==='p-autoops'),catalog=await client.rpc('server.refreshProviders',{instanceId:'codex',cwd:project.workspaceRoot,fresh:true},{timeout:60000}),models=catalog.providers.find(p=>p.instanceId==='codex')?.models
  assert(models?.length>=12);assert(!models.some(m=>m.slug.startsWith('grok-imagine-')))
  const levels=model=>model.capabilities.optionDescriptors.find(d=>d.id==='reasoningEffort').options.map(o=>o.id)
  assert.deepEqual(levels(models.find(m=>m.slug==='grok-4.6')),['low','medium','high','xhigh']);assert.deepEqual(levels(models.find(m=>m.slug==='grok-3-mini')),['low','medium','high']);report.catalog=models.map(m=>({slug:m.slug,levels:levels(m)}));return {count:models.length,modelSpecificLevels:true}
 })
 await step('native-picker-and-draft-persistence',async()=>{
  await page.goto(origin+'/agent-demo.html');await page.getByRole('textbox',{name:'用户名'}).fill('admin');await page.getByLabel('密码',{exact:true}).fill(process.env.AGENT_DEMO_TEST_PASSWORD||'Demo123!');await page.getByRole('button',{name:'登录',exact:true}).click();await editor().waitFor({timeout:60000});await picker().waitFor({timeout:60000})
  await editor().fill('/model');await page.getByRole('option').filter({hasText:'/model'}).first().click();await page.getByPlaceholder('搜索模型…',{exact:true}).waitFor();await page.keyboard.press('Escape');await editor().fill('')
  await chooseModel('grok-4.6','Grok 4.6');await chooseEffort('很高');await editor().fill('模型草稿保留验证');await page.reload();await editor().waitFor();await until(async()=> (await traits().innerText()).includes('很高'));assert((await editor().innerText()).includes('模型草稿保留验证'));await picker().click();assert.equal(await page.getByRole('button',{name:'Claude Code',exact:true}).count(),0);await page.screenshot({path:path.join(output,'model-picker.png')});await page.keyboard.press('Escape');await traits().click();await page.screenshot({path:path.join(output,'reasoning-picker.png')});await page.keyboard.press('Escape');return {draftAndEffortPersist:true,slashModelWorks:true,unconfiguredRunnersHidden:true}
 })
 let activeId
 await step('grok46-xhigh-real-ui-round',async()=>{
  const {id,projection:p}=await sendFromUi('仅回复 AO_MODEL_XHIGH_OK，不使用任何工具。','grok-4.6','xhigh');activeId=id;await page.locator('.messages-timeline-scroll').getByText('AO_MODEL_XHIGH_OK',{exact:false}).first().waitFor({timeout:30000});await page.screenshot({path:path.join(output,'grok46-xhigh.png')});report.nativeThreadIds=p.providerThreads.map(t=>t.nativeThreadRef?.nativeId).filter(Boolean);return {threadId:id,model:p.thread.modelSelection.model,options:p.thread.modelSelection.options,nativeThreadPresent:report.nativeThreadIds.length>0}
 })
 await step('same-thread-model-and-effort-switch-with-skill',async()=>{
  await chooseModel('grok-3-mini','Grok 3 Mini');await traits().click();assert.equal(await page.getByRole('menuitemradio',{name:'很高',exact:true}).count(),0);await page.keyboard.press('Escape');await chooseEffort('高')
  const before=(await client.projection(activeId)).runs.length
  await editor().fill('$autoops-environment-check 上一轮已结束，本轮必须实际调用 query_environment 获取环境快照，再回答这次工具返回的采集时间、来源和 API CPU；无法调用就明确失败，不得用目录或记忆替代。最后附 AO_MODEL_SWITCH_OK，不生成报告。');await page.getByRole('button',{name:'发送消息',exact:true}).click()
  const p=await until(async()=>{const v=await client.projection(activeId);return v.runs.length>before&&v.runs.every(terminal)?v:null});assert(p.runs.every(r=>r.status==='completed'),JSON.stringify(p.runs.map(r=>({status:r.status,error:r.error}))));assert.equal(p.thread.modelSelection.model,'grok-3-mini');assert(p.thread.modelSelection.options.some(o=>o.id==='reasoningEffort'&&o.value==='high'));assert(p.turnItems.some(i=>i.type==='dynamic_tool'&&i.toolName==='t3-code.query_environment'&&i.status==='completed'));await page.locator('.messages-timeline-scroll').getByText('AO_MODEL_SWITCH_OK',{exact:false}).first().waitFor({timeout:30000});await page.screenshot({path:path.join(output,'grok3mini-skill.png')});return {threadId:activeId,model:p.thread.modelSelection.model,options:p.thread.modelSelection.options,actualBusinessTool:true}
 })
 await step('invalid-options-rejected-before-run',async()=>{
  const before=(await client.projection(activeId)).runs.length
  for(const modelSelection of [{instanceId:'codex',model:'grok-imagine-image'},{instanceId:'codex',model:'unknown-model'},{instanceId:'codex',model:'grok-3-mini',options:[{id:'reasoningEffort',value:'xhigh'}]}])await assert.rejects(()=>client.rpc('orchestration.dispatchCommand',{type:'message.dispatch',createdBy:'user',creationSource:'web',commandId:randomUUID(),threadId:activeId,messageId:randomUUID(),text:'不得执行的校验',attachments:[],modelSelection,dispatchMode:{type:'start_immediately'}}))
  assert.equal((await client.projection(activeId)).runs.length,before);report.nativeThreadIds=(await client.projection(activeId)).providerThreads.map(t=>t.nativeThreadRef?.nativeId).filter(Boolean);return {invalidModelAndEffortDenied:true,noRunCreated:true}
 })
 await step('chinese-native-controls-dark-and-390px',async()=>{
  await page.goto(origin+'/agent-demo.html#/settings/appearance');await page.getByRole('button',{name:'使用深色模式',exact:true}).click();await page.goto(origin+'/agent-demo.html#/'+report.environmentId+'/'+activeId);await picker().waitFor();await traits().click();await page.screenshot({path:path.join(output,'reasoning-dark.png')});await page.keyboard.press('Escape');await page.setViewportSize({width:390,height:844});await picker().click();await page.getByPlaceholder('搜索模型…',{exact:true}).waitFor();await page.screenshot({path:path.join(output,'models-mobile.png')});await page.keyboard.press('Escape');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));return {nativeMenusChinese:true,darkAnd390px:true}
 })
 assert.deepEqual(report.pageErrors,[])
}catch(e){report.fatal=e.stack;process.exitCode=1}
finally{
 for(const id of owned)try{let p=await client.projection(id);if(p.runs.some(r=>!terminal(r)))await client.rpc('orchestration.dispatchCommand',{type:'thread.stop',threadId:id,commandId:randomUUID()});await until(async()=> (await client.projection(id)).runs.every(terminal),45000);await client.rpc('orchestration.dispatchCommand',{type:'thread.delete',threadId:id,commandId:randomUUID()})}catch(e){(report.cleanupErrors??=[]).push(e.message)}
 report.testThreadsDeleted=!report.cleanupErrors?.length;report.finishedAt=new Date().toISOString();await save();client.close();await browser.close()
}
