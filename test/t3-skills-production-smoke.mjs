import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {chromium} from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
if(process.env.T3_PRODUCTION_SMOKE!=='1')throw Error('须显式启用正式入口验证；仅创建并清理本次私有测试会话')
const origin=process.env.AGENT_DEMO_URL||'http://172.29.22.6:8787',output=path.resolve('.test-artifacts/t3-lite/skills-production')
await mkdir(output,{recursive:true})
const client=new T3LiveClient(origin),report={origin,steps:[],pageErrors:[],existingDataMutated:false},browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'}),page=await context.newPage()
page.on('pageerror',e=>report.pageErrors.push(e.message))
let owned
const terminal=r=>['completed','failed','interrupted','cancelled','rolled_back'].includes(r.status)
async function step(name,fn){const row={name};report.steps.push(row);try{row.result=await fn();row.status='passed'}catch(e){row.status='failed';row.error=e.stack;await page.screenshot({path:path.join(output,name+'-failed.png')}).catch(()=>{});throw e}finally{await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name,status:row.status,error:row.error}))}}
async function until(fn,timeout=150000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,400))}throw Error('等待真实结果超时')}
try{
  await client.login();await client.connect();report.environmentId=(await client.http('/.well-known/t3/environment')).environmentId
  const original=await client.http('/api/orchestration/shell')
  await step('default-skills-and-native-catalog',async()=>{
    const catalog=await client.http('/autoops/skills');for(const name of ['project-brief','environment-check','release-readiness'])assert(catalog.skills.some(s=>s.name==='autoops-'+name&&s.enabled))
    const p=original.projects.find(p=>p.id==='p-autoops'),native=await client.rpc('server.refreshProviders',{instanceId:'codex',cwd:p.workspaceRoot,fresh:true},{timeout:60000})
    const names=native.providers.flatMap(p=>p.workspaceSnapshots?.flatMap(s=>s.skills.map(s=>s.name))??[]);for(const name of ['project-brief','environment-check','release-readiness'])assert(names.includes('autoops-'+name))
    return {nativeSkills:names,model:client.bootstrap.fixedModel.model}
  })
  await step('zerotier-login-and-general',async()=>{
    await page.goto(origin+'/agent-demo.html');await page.getByRole('textbox',{name:'用户名'}).fill('admin');await page.getByLabel('密码',{exact:true}).fill(process.env.AGENT_DEMO_TEST_PASSWORD||'Demo123!');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByTestId('composer-editor').waitFor({timeout:60000})
    assert.equal(await page.getByLabel('切换对话详情面板',{exact:true}).count(),0)
    await page.goto(origin+'/agent-demo.html#/settings/general');await page.getByRole('button',{name:'导入技能',exact:true}).waitFor();for(const name of ['项目资料解读','环境健康检查','发布准备报告'])await page.getByRole('heading',{name:new RegExp('^'+name)}).waitFor();await page.screenshot({path:path.join(output,'skills-general.png')})
    return {threeBuiltinSkillsVisible:true,ordinaryChatHasNoEmptyDetails:true}
  })
  await step('configured-grok-actual-skill-and-ui-answer',async()=>{
    const {threadId}=await client.createThread('$autoops-environment-check 请检查当前环境，简短给出来源、采集时间和结论，不生成报告。',{title:'技能发布验证（自动清理）'});owned=threadId;report.ownedThread=threadId
    const p=await until(async()=>{const p=await client.projection(threadId);return p.runs.length&&p.runs.every(terminal)?p:null});assert(p.runs.every(r=>r.status==='completed'));assert(p.turnItems.some(i=>i.type==='dynamic_tool'&&i.toolName==='t3-code.query_environment'&&i.status==='completed'))
    await page.goto(origin+'/agent-demo.html#/'+report.environmentId+'/'+threadId);await page.locator('.messages-timeline-scroll').getByText(/演示/).first().waitFor({timeout:30000});assert.equal(await page.getByRole('heading',{name:'T3 Code',exact:true}).count(),0);await page.screenshot({path:path.join(output,'live-skill-chat.png')})
    return {threadId,actualTools:p.turnItems.filter(i=>i.type==='dynamic_tool').map(i=>({toolName:i.toolName,status:i.status})),nativeThreadPresent:p.providerThreads.some(t=>t.nativeThreadRef?.nativeId),replyVisible:true}
  })
  if(process.env.T3_READONLY_THREAD)await step('existing-readonly-history',async()=>{
    await page.goto(origin+'/agent-demo.html#/'+report.environmentId+'/'+process.env.T3_READONLY_THREAD);await page.getByText('此历史对话仅支持查看。',{exact:true}).first().waitFor({timeout:30000});assert.equal(await page.getByTestId('composer-editor').count(),0);assert.equal(await page.getByRole('button',{name:'添加文件',exact:true}).count(),0);await page.screenshot({path:path.join(output,'readonly-history.png')});return {historyReadable:true,deadComposerHidden:true}
  })
  const ids=new Set(original.threads.map(t=>t.id)),related=original.threads.find(t=>ids.has(t.forkedFrom?.threadId)||ids.has(t.lineage?.parentThreadId))
  if(related)await step('existing-related-history-panel',async()=>{
    await page.goto(origin+'/agent-demo.html#/'+report.environmentId+'/'+related.id);const toggle=page.getByLabel('切换对话详情面板',{exact:true});await toggle.waitFor({timeout:30000});if(await toggle.getAttribute('aria-pressed')!=='true')await toggle.click();await page.getByText('关联对话',{exact:true}).first().waitFor({timeout:15000});return {threadId:related.id,actualRelationsRetained:true}
  })
  assert.deepEqual(report.pageErrors,[])
}catch(e){report.fatal=e.stack;process.exitCode=1}
finally{
  if(owned)try{let p=await client.projection(owned);if(p.runs.some(r=>!terminal(r)))await client.rpc('orchestration.dispatchCommand',{type:'thread.stop',threadId:owned,commandId:randomUUID()});await until(async()=> (await client.projection(owned)).runs.every(terminal),45000);await client.rpc('orchestration.dispatchCommand',{type:'thread.delete',threadId:owned,commandId:randomUUID()});report.testThreadDeleted=true}catch(e){report.cleanupError=e.message}
  report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));client.close();await browser.close()
}
