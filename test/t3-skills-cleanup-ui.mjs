import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {chromium} from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
import {BUILTIN_BUSINESS_SKILLS} from '../agent-demo/t3-adapters/builtin-skills.mjs'

const origin=new URL(process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887').origin
if(new URL(origin).port!=='18887')throw Error('此验证会管理技能，仅允许隔离验收服务')
const output=path.resolve(process.env.T3_SKILLS_OUTPUT||'.test-artifacts/t3-lite/skills-stage')
await mkdir(output,{recursive:true})
const report={origin,startedAt:new Date().toISOString(),steps:[],pageErrors:[],ownedThreads:[],addedSkills:[]}
const client=new T3LiveClient(origin),owned=new Set()
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'}),page=await context.newPage()
page.on('pageerror',error=>report.pageErrors.push(error.message))
const save=()=>writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2))
const terminal=run=>['completed','failed','cancelled','interrupted','rolled_back'].includes(run.status)
const until=async(fn,timeout=120000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,350))}throw Error('等待实际状态超时')}
async function step(name,fn){const item={name};report.steps.push(item);try{item.result=await fn();item.status='passed'}catch(error){item.status='failed';item.error=error.stack;await page.screenshot({path:path.join(output,name+'-failed.png')}).catch(()=>{});throw error}finally{await save();console.log(JSON.stringify({name,status:item.status,error:item.status==='failed'?item.error:undefined}))}}
async function completed(id){const p=await until(async()=>{const p=await client.projection(id);return p.runs.length&&p.runs.every(terminal)?p:null});assert(p.runs.every(r=>r.status==='completed'),JSON.stringify(p.runs.map(r=>({status:r.status,error:r.error}))));return p}
const editor=()=>page.getByTestId('composer-editor')
async function openThread(id){await page.goto(origin+'/agent-demo.html#/'+report.environmentId+'/'+id);await editor().waitFor({state:'visible',timeout:30000})}
async function choose(name){await editor().fill('$');await page.getByRole('option').filter({hasText:name}).first().click();await page.getByRole('button',{name:`技能 ${name}，查看详情`,exact:true}).waitFor()}

try{
  await client.login();await client.connect();report.environmentId=(await client.http('/.well-known/t3/environment')).environmentId
  await step('prepare-stage-skills-preserving-existing',async()=>{
    let catalog=await client.http('/autoops/skills');report.originalSkillNames=catalog.skills.map(s=>s.name)
    for(const skill of BUILTIN_BUSINESS_SKILLS)if(!catalog.skills.some(s=>s.name==='autoops-'+skill.name)){
      const contents=`---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\nmetadata:\n  display-name: ${JSON.stringify(skill.displayName)}\nallowed-tools: ${JSON.stringify(skill.tools)}\n---\n\n${skill.instructions}`
      catalog=await client.http('/autoops/skills','POST',{action:'import',revision:catalog.revision,contents});report.addedSkills.push('autoops-'+skill.name)
    }
    const shell=await client.http('/api/orchestration/shell'),project=shell.projects.find(p=>p.id==='p-autoops');assert(project)
    const native=await client.rpc('server.refreshProviders',{instanceId:'codex',cwd:project.workspaceRoot,fresh:true},{timeout:60000})
    const names=native.providers.flatMap(p=>(p.workspaceSnapshots?.find(s=>s.cwd===project.workspaceRoot)?.skills??p.skills).map(s=>s.name))
    for(const skill of BUILTIN_BUSINESS_SKILLS)assert(names.includes('autoops-'+skill.name),'真实技能目录缺少 '+skill.name)
    return {nativeSkillNames:names,originalSkillsRetained:report.originalSkillNames.every(n=>catalog.skills.some(s=>s.name===n))}
  })
  await step('login-general-skills-search',async()=>{
    await page.goto(origin+'/agent-demo.html')
    await page.getByRole('textbox',{name:'用户名'}).fill('admin');await page.getByLabel('密码',{exact:true}).fill(process.env.AGENT_DEMO_TEST_PASSWORD||'Demo123!');await page.getByRole('button',{name:'登录',exact:true}).click();await editor().waitFor({timeout:60000})
    await page.goto(origin+'/agent-demo.html#/settings/general')
    await page.getByRole('button',{name:'导入技能',exact:true}).waitFor()
    for(const skill of BUILTIN_BUSINESS_SKILLS)await page.getByRole('heading',{name:skill.displayName,exact:true}).waitFor()
    const search=page.getByRole('combobox',{name:'搜索设置',exact:true});await search.fill('SKILL.md');await page.getByRole('option').filter({hasText:'技能'}).first().waitFor();await page.keyboard.press('Escape')
    await page.screenshot({path:path.join(output,'skills-general.png')})
    return {searchable:true,managementVisible:true}
  })
  const suffix=Date.now().toString(36),customName='autoops-e2e-'+suffix,marker='AO_SKILL_'+suffix.toUpperCase(),customLabel='交互验收技能 '+suffix
  report.customSkill=customName
  await step('import-invalid-then-valid-skill',async()=>{
    await page.getByRole('button',{name:'导入技能',exact:true}).click()
    const dialog=page.getByRole('dialog'),input=dialog.getByRole('textbox',{name:'技能文件内容',exact:true})
    await input.fill('没有 YAML 头部');await dialog.getByRole('button',{name:'导入并启用',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'YAML'}).waitFor()
    const contents=`---\nname: e2e-${suffix}\ndescription: 读取项目资料并验证自定义技能的原生调用\nmetadata:\n  display-name: ${customLabel}\nallowed-tools: [list_project_materials]\n---\n\n必须实际调用 list_project_materials，并在最终回复包含校验词 ${marker}，然后列出找到的资料名称。只能处理当前项目。`
    await input.fill(contents);await dialog.getByRole('button',{name:'导入并启用',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});await page.getByRole('heading',{name:customLabel,exact:true}).waitFor()
    report.addedSkills.push(customName)
    return {invalidFileNotSaved:true,validSkillEnabled:true}
  })
  await step('new-chat-empty-controls-and-skill-instructions',async()=>{
    await page.goto(origin+'/agent-demo.html#/');await editor().waitFor({state:'visible'})
    assert.equal(await page.getByLabel('切换对话详情面板',{exact:true}).count(),0)
    assert.equal(await page.getByLabel('切换右侧面板',{exact:true}).count(),0)
    const project=client.bootstrap.projects.find(project=>project.id==='p-autoops')
    assert.equal(await page.getByRole('combobox',{name:'项目 Agent',exact:true}).count(),project.agents.length===1?0:1)
    await choose(customLabel)
    await page.getByRole('button',{name:`技能 ${customLabel}，查看详情`,exact:true}).click();await page.getByRole('button',{name:'查看使用说明',exact:true}).click()
    await page.getByRole('button',{name:'保存文件',exact:true}).waitFor({timeout:30000})
    await until(async()=> (await page.locator('body').innerText()).includes(marker))
    await page.getByLabel('切换右侧面板',{exact:true}).first().click()
    await page.reload();await page.getByRole('button',{name:`技能 ${customLabel}，查看详情`,exact:true}).waitFor()
    return {emptyControlsHidden:true,instructionsActuallyLoaded:true,skillDraftPersists:true}
  })
  await step('custom-skill-actual-ui-grok-round',async()=>{
    await editor().press('End');await editor().pressSequentially(' 请按这个技能完成检查，简短回复。')
    await page.getByRole('button',{name:'发送消息',exact:true}).click()
    await page.waitForURL(url=>!url.hash.includes('/draft/')&&url.hash.split('/').length>=3,{timeout:60000})
    const id=new URL(page.url()).hash.split('/')[2];assert(id);owned.add(id);report.ownedThreads.push(id)
    const p=await completed(id),text=p.messages.filter(m=>m.role==='assistant').map(m=>m.text).join('\n')
    assert(text.includes(marker),'回复缺少技能正文的实际校验词');assert(p.turnItems.some(item=>item.type==='dynamic_tool'&&item.toolName==='t3-code.list_project_materials'&&item.status==='completed'),'没有实际完成的业务工具调用')
    await page.locator('.messages-timeline-scroll').getByText(marker,{exact:false}).first().waitFor({timeout:30000})
    await page.screenshot({path:path.join(output,'custom-skill-chat.png')})
    return {threadId:id,markerSeen:true,actualTool:'list_project_materials',model:client.bootstrap.fixedModel.model}
  })
  await step('disable-skill-and-reject-stale-call',async()=>{
    await page.goto(origin+'/agent-demo.html#/settings/general');const toggle=page.getByRole('switch',{name:`停用技能：${customLabel}`,exact:true});await toggle.click();const disabled=page.getByRole('switch',{name:`启用技能：${customLabel}`,exact:true});await disabled.waitFor();await until(()=>disabled.isEnabled(),60000)
    const id=[...owned][0],before=(await client.projection(id)).runs.length
    await assert.rejects(()=>client.send(id,`$${customName} 再检查一次`))
    assert.equal((await client.projection(id)).runs.length,before)
    await openThread(id);await editor().fill('$');await until(async()=>await page.getByRole('option').filter({hasText:customLabel}).count()===0,15000);await editor().fill('')
    return {removedFromPicker:true,noRunCreatedForDisabledSkill:true}
  })
  await step('member-permissions-and-csrf',async()=>{
    const member=new T3LiveClient(origin);await member.login('lin');const catalog=await member.http('/autoops/skills');assert.equal(catalog.canManage,false)
    await assert.rejects(()=>member.http('/autoops/skills','POST',{action:'toggle',revision:catalog.revision,name:'autoops-project-brief',enabled:false}),e=>e.status===403)
    const response=await fetch(origin+'/api/agent-demo/t3/autoops/skills',{method:'POST',headers:{cookie:client.cookie,origin,'content-type':'application/json'},body:JSON.stringify({action:'toggle',revision:catalog.revision,name:'autoops-project-brief',enabled:false})});assert.equal(response.status,403);member.close()
    return {memberCannotManage:true,missingCsrfRejected:true}
  })
  await step('builtin-report-actual-generation-preview-download',async()=>{
    const {threadId:id}=await client.createThread('$autoops-release-readiness 请生成极简 Markdown 发布准备报告，不提问。缺少的材料直接标为未确认；必须交付真实报告链接。',{title:'技能迁移验收：报告'});owned.add(id);report.ownedThreads.push(id)
    const p=await completed(id);assert(p.turnItems.some(item=>item.type==='dynamic_tool'&&item.toolName==='t3-code.create_report'&&item.status==='completed'),'没有实际完成的报告工具调用')
    await openThread(id);const link=page.locator('a[href*="/autoops/files/"]').first();await link.waitFor({timeout:30000});await link.click();await page.getByRole('button',{name:'保存文件',exact:true}).waitFor({timeout:30000})
    const pending=page.waitForEvent('download');await page.getByRole('button',{name:'保存文件',exact:true}).click();const download=await pending;await download.saveAs(path.join(output,download.suggestedFilename()));assert.equal(await download.failure(),null)
    await page.screenshot({path:path.join(output,'skill-report-preview.png')})
    return {threadId:id,actualReportTool:true,previewAndDownload:true,filename:download.suggestedFilename()}
  })
  if(process.env.T3_READONLY_THREAD)await step('readonly-history-has-no-dead-composer',async()=>{
    await page.goto(origin+'/agent-demo.html#/'+report.environmentId+'/'+process.env.T3_READONLY_THREAD);await page.getByText('此历史对话仅支持查看。',{exact:true}).first().waitFor({timeout:30000});assert.equal(await editor().count(),0);assert.equal(await page.getByRole('button',{name:'添加文件',exact:true}).count(),0);await page.getByRole('button',{name:'新建对话',exact:true}).last().waitFor()
    return {historyReadable:true,composerHidden:true,newConversationAvailable:true}
  })
  await step('chinese-menus-palette-and-appearance',async()=>{
    await openThread([...owned][0]);await page.getByRole('button',{name:/对话操作：/}).click();await page.getByRole('button',{name:'重命名对话',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'复制',exact:true}).count(),0);await page.keyboard.press('Escape')
    await editor().fill('菜单审查草稿');await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');assert.equal(await page.getByRole('option').filter({hasText:'复制提示词链接'}).count(),0);assert.equal(await page.getByRole('option').filter({hasText:'复制对话 ID'}).count(),0);await page.keyboard.press('Escape');await editor().fill('')
    await page.goto(origin+'/agent-demo.html#/settings/appearance');await page.getByRole('heading',{name:'字体排版',exact:true}).waitFor();const text=await page.locator('body').innerText();assert(!text.includes('Frontend Design'));assert(!text.includes('surface.test.ts'));assert(!text.includes('代码块、差异'))
    await page.getByRole('button',{name:'使用深色模式',exact:true}).click();await page.screenshot({path:path.join(output,'appearance-dark.png')});await page.getByRole('button',{name:'使用浅色模式',exact:true}).click();await page.screenshot({path:path.join(output,'appearance-light.png')})
    await page.setViewportSize({width:390,height:844});await page.goto(origin+'/agent-demo.html#/settings/general');await page.getByRole('heading',{name:'技能',exact:true}).waitFor();await page.getByRole('heading',{name:'发布准备报告',exact:true}).waitFor();await page.getByRole('heading',{name:'技能',exact:true}).scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));await page.screenshot({path:path.join(output,'skills-mobile.png')})
    return {menuChinese:true,unsupportedCopyActionsHidden:true,previewsAdapted:true,darkLightAnd390px:true}
  })
  assert.deepEqual(report.pageErrors,[])
}catch(error){report.fatal=error.stack;process.exitCode=1}
finally{
  for(const id of owned)try{let p=await client.projection(id);if(p.runs.some(r=>!terminal(r)))await client.rpc('orchestration.dispatchCommand',{type:'thread.stop',threadId:id,commandId:randomUUID()});await until(async()=> (await client.projection(id)).runs.every(terminal),45000);await client.rpc('orchestration.dispatchCommand',{type:'thread.delete',threadId:id,commandId:randomUUID()})}catch(error){(report.cleanupErrors??=[]).push({threadId:id,error:error.message})}
  report.testThreadsDeleted=!report.cleanupErrors?.length;report.finishedAt=new Date().toISOString();await save();client.close();await browser.close()
}
