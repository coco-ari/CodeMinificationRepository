import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {chromium} from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

// Browser launch requires the caller's concrete unsandboxed approval. This is
// entirely read-only except login and isolated-profile native unsent drafts.
// Existing threads are never activated; no resource or model is provisioned.
const base = new URL(process.env.BASE_URL || 'http://172.29.22.6:28887')
assert(['http:','https:'].includes(base.protocol) && base.port === '28887', '只允许独立验证端口 28887')
assert(['172.29.22.6','192.168.31.157','127.0.0.1','localhost'].includes(base.hostname), '只允许已授权的测试主机')
assert(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'BASE_URL 必须是无凭据的验证源站')
const origin = base.origin, projectA = 'p-autoops', api = '/api/agent-demo/t3/autoops'
const artifactRoot = path.resolve('.test-artifacts/project-areas')
const output = path.resolve(process.env.ARTIFACT_DIR || path.join(artifactRoot, `ui-${Date.now()}`))
assert(output.startsWith(artifactRoot + path.sep), '证据只能保存到本 worktree 项目区域验收目录')
const password = process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
await mkdir(output,{recursive:true})
const report = {origin,startedAt:new Date().toISOString(),cases:[],geometry:[],projectRequests:[],blockedRpcMutations:[],blockedHttpMutations:[],blockedExistingThreadReads:[],pageErrors:[],
  nativeMaintenance:{},downloads:[],localToastDismissals:{closed:0,expiredDuringClick:0,exitAnimationWaits:0},cleanup:{},
  coverage:{modelCalls:0,projectFileWrites:0,deploymentsSubmitted:0,existingThreadsActivated:false,syntheticData:false,browser:'Chromium 桌面与触屏模拟；不代表物理手机或 Windows 实机'}}
const sessions=[]
let page, currentSession, fixture
const redact = value => String(value).replaceAll(password,'[已隐藏]').replace(/(Bearer\s+)[A-Za-z0-9_.-]+/gi,'$1[已隐藏]')
const safeProject = value => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value || '')
const projectApi = id => {assert(safeProject(id));return `${api}/projects/${encodeURIComponent(id)}`}
const areaLabels = {chat:'问答',workspaces:'工作区',deployments:'部署发布'}
const root = area => page.getByTestId(area === 'workspaces' ? 'workspace-page' : 'deployments-page')
const navigation = () => page.getByTestId('project-area-navigation').filter({visible:true})
const sidebar = () => page.locator('[data-sidebar="sidebar"]').filter({visible:true}).first()
const picker = () => page.locator('button[aria-label="切换项目"]').filter({visible:true}).first()
const toggle = (label,text) => page.locator(`[aria-label="${label}"] [data-slot="toggle"]`).filter({hasText:text})
const files = () => page.locator('[data-readonly-workspace]').filter({visible:true}).first()
async function until(read,label,timeout=15000) {const end=Date.now()+timeout;while(Date.now()<end){const result=await read();if(result)return result;await new Promise(done=>setTimeout(done,100))}throw new Error(label)}
async function save() {await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2))}
async function run(name,action) {
  const entry={name};report.cases.push(entry)
  try {entry.result=await action();entry.status='passed'}
  catch(error){entry.status='failed';entry.error=redact(error.stack||error.message);if(page)await capture(`${name}-failed`).catch(()=>{});throw error}
  finally{await save();console.log(JSON.stringify({case:name,status:entry.status,error:entry.error}))}
}
function routeState() {
  const url=new URL(page.url());assert.equal(url.origin,origin)
  const hash=new URL(url.hash.slice(1)||'/','http://route.invalid')
  assert(/^\/(?:draft\/[^/]+|workspaces|deployments|settings(?:\/(?:general|appearance))?)?$/.test(hash.pathname),'禁止激活已存在对话')
  if(hash.pathname.startsWith('/draft/')) currentSession.localDraftIds.add(hash.pathname.slice('/draft/'.length))
  return {pathname:hash.pathname,projectId:hash.searchParams.get('projectId'),versionId:hash.searchParams.get('versionId')}
}
async function capture(name) {
  routeState()
  // Preserve the native list's geometry without exporting user conversation
  // titles. The script only inspects row IDs/counts, never their text/content.
  await page.screenshot({path:path.join(output,`${name}.png`),mask:[page.locator('[data-thread-item]'),page.getByTestId('sidebar-draft-row')]})
}
function rpcMutation(method,payload={}) {
  if(!method||!method.includes('.'))return false
  if(method.startsWith('orchestration.'))return !/^orchestration\.(?:get|list|subscribe)/.test(method)
  // Source-audited native capability report, authorized signed URL, and status
  // snapshot refresh. Never broaden these to arbitrary report/create calls.
  if(['preview.reportProfiles','assets.createUrl','server.reportClientActivity','server.reportHostPowerState'].includes(method))return false
  if(method==='server.refreshProviders')return !payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['instanceId','cwd','fresh'].includes(key))||(payload.instanceId!==undefined&&payload.instanceId!=='codex')||(payload.fresh!==undefined&&typeof payload.fresh!=='boolean')
  return !/\.(?:get|list|read|search|subscribe|observe|browse|stat|probe|resolve|inspect|watch|find|toolInfo|routing|summary|detail|checks|activity|diffFileContents|reviewGuide|linkedThreads)/i.test(method)
}
async function guards(context,session) {
  await context.routeWebSocket(url=>url.pathname.endsWith('/api/agent-demo/t3/ws'),socket=>{
    const server=socket.connectToServer()
    socket.onMessage(payload=>{
      let decoded;try{decoded=JSON.parse(String(payload))}catch{server.send(payload);return}
      const messages=Array.isArray(decoded)?decoded:[decoded],allowed=[]
      for(const message of messages){
        const method=message.tag||'',threadId=message.payload?.threadId
        if(threadId&&/^orchestration\.(?:getThread|subscribeThread)/.test(method)&&!session.localDraftIds.has(threadId)&&session.nativeThreadIds.has(threadId)){
          report.blockedExistingThreadReads.push({session:session.name,method});continue
        }
        if(rpcMutation(method,message.payload)){report.blockedRpcMutations.push({session:session.name,method,type:message.payload?.type||null});continue}
        if(['preview.reportProfiles','assets.createUrl','server.refreshProviders'].includes(method))report.nativeMaintenance[method]=(report.nativeMaintenance[method]||0)+1
        allowed.push(message)
      }
      if(allowed.length===messages.length)server.send(payload)
      else if(allowed.length)server.send(JSON.stringify(Array.isArray(decoded)?allowed:allowed[0]))
    })
  })
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    if(!['http:','https:'].includes(url.protocol))return route.continue()
    if(url.origin!==origin){report.blockedHttpMutations.push({session:session.name,method:request.method(),path:'非测试源站'});return route.abort('blockedbyclient')}
    if(['GET','HEAD','OPTIONS'].includes(request.method())){
      const match=/^\/api\/agent-demo\/t3\/autoops\/projects\/([^/]+)\/(workspaces|deployments)(.*)$/.exec(url.pathname)
      if(match)report.projectRequests.push({session:session.name,projectId:decodeURIComponent(match[1]),kind:match[2],path:url.pathname,at:Date.now()})
      return route.continue()
    }
    if(request.method()==='POST'&&url.pathname==='/api/agent-demo/login')return route.continue()
    if(request.method()==='POST'&&url.pathname.endsWith('/api/observability/v1/traces'))return route.fulfill({status:204,body:''})
    report.blockedHttpMutations.push({session:session.name,method:request.method(),path:url.pathname})
    return route.fulfill({status:409,json:{error:'项目区域只读验收禁止消息、部署、工作区及文件写操作。'}})
  })
}
async function dismissToasts() {
  const controls=page.getByRole('button',{name:'关闭通知',exact:true}).filter({visible:true})
  for(let n=0;n<8;n++){
    const count=await controls.count();if(!count)break
    try{await controls.first().click({timeout:1500});report.localToastDismissals.closed++}
    catch(error){if((error.name==='TimeoutError'||/not attached|detached/i.test(error.message))&&await controls.count()===0){report.localToastDismissals.expiredDuringClick++;break}throw error}
    await until(async()=>await controls.count()<count,'通知应完成关闭',2500)
  }
  const notices=page.locator('[data-slot="toast-viewport"] [data-slot="toast-title"], [data-slot="toast-viewport-anchored"] [data-slot="toast-title"], [data-sonner-toast]')
  if(await notices.count())report.localToastDismissals.exitAnimationWaits++
  await until(async()=>await notices.count()===0,'等待 T3 原生通知退出动画',5000)
}
async function sidebarOpen() {
  const item=sidebar()
  return await item.isVisible()&&await item.evaluate(element=>!element.closest('[inert]')&&element.getBoundingClientRect().right>1)
}
async function openSidebar(){if(!await sidebarOpen())await page.getByRole('button',{name:'切换主侧栏',exact:true}).filter({visible:true}).first().click();await until(sidebarOpen,'原生侧栏应展开');await navigation().waitFor()}
async function closeMobile(){if(!currentSession.touch||!await sidebarOpen())return;const own=sidebar().locator('[data-sidebar="trigger"]').filter({visible:true}).first();if(await own.isVisible())await own.click();else await page.keyboard.press('Escape');await until(async()=>!await sidebarOpen(),'移动侧栏关闭后主内容应恢复操作')}
async function get(suffix,status=200,headers) {
  assert(suffix.startsWith('/api/agent-demo/'))
  const response=await page.request.get(origin+suffix,headers?{headers}:undefined)
  assert.equal(response.status(),status,`只读验证接口异常：${suffix}`)
  return response.json()
}
async function login(name,touch=false,username='admin') {
  const profile=await mkdtemp(path.join(os.tmpdir(),'autoops-project-areas-'))
  const session={name,touch,username,profile,localDraftIds:new Set(),nativeThreadIds:new Set(),threads:[]};sessions.push(session);currentSession=session
  const context=session.context=await chromium.launchPersistentContext(profile,{headless:true,locale:'zh-CN',viewport:touch?{width:390,height:844}:{width:1440,height:900},isMobile:touch,hasTouch:touch,...(executablePath?{executablePath}:{})})
  await guards(context,session)
  page=session.page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(15000)
  page.on('pageerror',error=>report.pageErrors.push({session:name,message:redact(error.message),stack:redact(error.stack||'')}))
  const draftId=randomUUID();session.localDraftIds.add(draftId)
  await page.goto(`${origin}/agent-demo.html#/draft/${draftId}`)
  await page.getByRole('textbox',{name:'用户名'}).fill(username)
  await page.getByLabel('密码',{exact:true}).fill(password)
  await page.getByRole('button',{name:'登录',exact:true}).click()
  await page.getByTestId('composer-editor').waitFor({timeout:60000});routeState()
  assert.equal((await page.getByTestId('composer-editor').innerText()).trim(),'')
  const bootstrap=await get(api+'/bootstrap');session.principalId=bootstrap.principal.id;session.projects=bootstrap.projects
  const shell=await get('/api/agent-demo/t3/api/orchestration/shell',200,{'x-t3-orchestration-protocol':'2'})
  session.threads=(shell.threads||[]).map(({id,projectId})=>({id,projectId}));session.nativeThreadIds=new Set(session.threads.map(item=>item.id))
  await dismissToasts();return session
}
async function selectProject(id) {
  const project=currentSession.projects.find(item=>item.id===id);assert(project,'只能选择 API 实际授权的项目')
  await openSidebar();await picker().click()
  const input=page.getByRole('combobox',{name:'搜索项目',exact:true}).filter({visible:true});await input.waitFor();await input.fill(project.name)
  const item=page.getByRole('option').filter({hasText:project.name});assert.equal(await item.count(),1,'真实项目名称应唯一匹配');await item.click()
  await until(async()=>!(await page.getByRole('combobox',{name:'搜索项目',exact:true}).filter({visible:true}).count()),'项目选择弹层应关闭')
  await until(async()=>{
    const state=routeState()
    if(['/workspaces','/deployments'].includes(state.pathname))return state.projectId===id
    return state.pathname.startsWith('/draft/')&&await page.locator('[data-draft-project-trigger]').filter({visible:true}).innerText().then(text=>text.includes(project.name)).catch(()=>false)
  },'统一项目选择必须与当前区域 URL 或原生草稿归属同步')
  await closeMobile();return project
}
async function area(name,id) {
  await dismissToasts();await openSidebar()
  const entry=navigation().locator(`[aria-label="${areaLabels[name]}"]`);await entry.click()
  if(name==='chat'){
    await page.getByTestId('composer-editor').waitFor();await until(async()=>routeState().pathname.startsWith('/draft/'),'问答只能打开本次浏览器的未发送草稿')
    const project=currentSession.projects.find(item=>item.id===id)
    await until(async()=>(await page.locator('[data-draft-project-trigger]').filter({visible:true}).innerText()).includes(project.name),'问答草稿必须绑定所选项目')
    assert.equal((await page.getByTestId('composer-editor').innerText()).trim(),'')
  }else{
    await until(()=>{const state=routeState();return state.pathname==='/'+name&&state.projectId===id},'独立业务页 URL 必须带正确 projectId')
    await root(name).waitFor();await closeMobile()
  }
  return assertArea(name,id)
}
async function assertArea(name,id) {
  await openSidebar()
  assert((await picker().innerText()).includes(currentSession.projects.find(item=>item.id===id).name),'侧栏统一项目选择应保持当前项目')
  assert.equal(await navigation().locator('[aria-label="问答"]').count(),1)
  assert.equal(await navigation().locator('[aria-label="工作区"]').count(),1)
  if(currentSession.username==='admin')assert.equal(await navigation().locator('[aria-label="部署发布"]').count(),1)
  const rows=await page.getByTestId('sidebar-row-slim').count(),cards=await page.getByTestId('sidebar-row-card').count(),search=await page.getByLabel('搜索对话',{exact:true}).count()
  if(name==='chat'){
    assert(search>0,'问答区域应保留原生对话搜索');assert.equal(cards,0,'保持原生紧凑对话列表')
    for(const key of await page.locator('[data-thread-item]').evaluateAll(items=>items.map(item=>item.getAttribute('data-thread-item')))){
      const known=currentSession.threads.find(item=>key?.includes(item.id));if(known)assert.equal(known.projectId,id,'对话列表不得混入其它项目')
    }
  }else{
    assert.equal(search,0,'业务区不应常驻对话搜索');assert.equal(rows,0,'业务区不应挂载对话列表');assert.equal(cards,0)
    assert.equal(await page.getByTestId('sidebar-draft-row').count(),0,'业务区不应挂载原生草稿列表')
    const state=routeState();assert.equal(state.pathname,'/'+name);assert.equal(state.projectId,id)
    assert.equal(await page.getByRole('combobox',{name:'工作区项目',exact:true}).count(),0,'不应再保留第二套页内项目选择器')
  }
  await closeMobile();return {area:name,projectId:id,slimRows:rows,conversationSearch:search,conversationCards:cards}
}
async function preflight(session) {
  const a=session.projects.find(item=>item.id===projectA);assert(a?.membership?.workspaceAccess==='internal'&&a.membership.role==='manager')
  const b=session.projects.find(item=>item.id==='p-cabinet')||session.projects.find(item=>item.id!==projectA&&item.membership?.role==='manager');assert(b,'验收需要另一个真实授权项目，不创建假数据')
  const workspace=await get(projectApi(projectA)+'/workspaces'),versions=workspace.internalVersions.filter(item=>item.status==='published');assert(versions.length)
  const version=versions.length>1?versions[1]:versions[0]
  const entries=(await get(`${projectApi(projectA)}/workspaces/versions/${version.id}/search?query=&limit=500`)).entries
  const preview=entries.find(item=>item.kind==='file'&&item.path==='prototypes/页面原型.html')||entries.find(item=>item.kind==='file'&&/^(?:WORKSPACE|README)\.md$/i.test(item.path))||entries.find(item=>item.kind==='file'&&/package\.json$/.test(item.path));assert(preview,'需要已有安全的原型/说明/包描述文件')
  const content=await get(`${projectApi(projectA)}/workspaces/versions/${version.id}/content?path=${encodeURIComponent(preview.path)}`)
  const deployments=await get(projectApi(projectA)+'/deployments?environmentId=env-test'),target=deployments.targets.find(item=>item.name==='前端部署验证');assert(target,'只读检查预先存在的真实验证目标')
  const tasks=deployments.tasks.filter(item=>item.targetId===target.id),task=process.env.UI_TASK_ID?tasks.find(item=>item.id===process.env.UI_TASK_ID):tasks.find((item,index)=>index>0&&['succeeded','failed','rolled_back','interrupted'].includes(item.status))||tasks[0];assert(task,'需要已有真实发布任务')
  const pack=workspace.releases.find(item=>item.id===task.sourceIdentity?.packageId)||workspace.releases[0];assert(pack)
  fixture={a,b,version,preview,content,target,task,pack}
  const result={projectA:a.id,projectB:b.id,versionId:version.id,versionChoices:versions.length,previewPath:preview.path,previewSha256:createHash('sha256').update(content.contents).digest('hex'),targetId:target.id,taskId:task.id,packageId:pack.id}
  report.fixture=result;return result
}
async function choose(label,text){await page.getByRole('combobox',{name:label,exact:true}).click();const option=page.getByRole('option').filter({hasText:text});assert.equal(await option.count(),1,'必须唯一匹配真实版本，保留原生示例状态后缀');await option.click()}
async function choosePreview() {
  await area('workspaces',projectA)
  await toggle('工作区分类','内部工作区').click();await choose('内部版本',fixture.version.name)
  await files().waitFor()
  const back=files().getByRole('button',{name:'返回文件目录',exact:true});if(await back.isVisible())await back.click()
  const explorer=files().getByRole('button',{name:'显示文件浏览器',exact:true});if(await explorer.isVisible())await explorer.click()
  await files().getByRole('searchbox').fill(path.posix.basename(fixture.preview.path))
  const item=files().locator(`[role="treeitem"][data-item-path=${JSON.stringify(fixture.preview.path)}]`);await item.waitFor();await item.click()
  return assertPreview()
}
async function assertPreview() {
  await until(async()=>{const source=await files().getAttribute('data-readonly-workspace');return source?.includes(projectA)&&source.includes(fixture.version.id)},'工作区应恢复原项目和固定版本')
  assert((await page.getByRole('combobox',{name:'内部版本',exact:true}).innerText()).includes(fixture.version.name))
  if(fixture.preview.path.endsWith('.html'))await files().frameLocator(`iframe[title=${JSON.stringify(path.posix.basename(fixture.preview.path))}]`).locator('body').waitFor()
  else await until(()=>files().evaluate((element,expected)=>{let text=element.textContent||'';for(const child of element.querySelectorAll('*'))if(child.shadowRoot)text+=child.shadowRoot.textContent||'';return text.includes(expected)},fixture.content.contents.split('\n').find(line=>line.trim())?.slice(0,36)||fixture.preview.path),'文件预览应显示真实来源内容')
  assert.equal(await files().locator('[contenteditable="true"],textarea').count(),0)
  return {versionId:fixture.version.id,path:fixture.preview.path,readOnly:true}
}
async function chooseTask() {
  await area('deployments',projectA);await toggle('部署分类','服务发布').click()
  const back=page.getByRole('button',{name:'返回服务列表',exact:true}).filter({visible:true});if(await back.isVisible())await back.click()
  await page.locator('[aria-label="部署服务列表"]').getByRole('button',{name:new RegExp(fixture.target.name)}).click()
  await toggle('部署详情分类','任务日志').click()
  const overview=await get(projectApi(projectA)+'/deployments?environmentId=env-test'),tasks=overview.tasks.filter(item=>item.targetId===fixture.target.id),index=tasks.findIndex(item=>item.id===fixture.task.id);assert(index>=0)
  await page.getByRole('combobox',{name:'部署任务',exact:true}).click();await page.getByRole('option').nth(index).click()
  await page.locator('pre[aria-label="部署增量日志"]').filter({visible:true}).waitFor()
  return assertTask()
}
async function assertTask(){
  const selection=await until(()=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)||'null'),`autoops:deployments:${currentSession.principalId}:${projectA}:selection`).then(value=>value?.taskId===fixture.task.id?value:null),'部署区应恢复原目标和任务选择')
  assert.equal(selection.targetId,fixture.target.id)
  const choice=page.getByRole('combobox',{name:'部署任务',exact:true});await choice.waitFor()
  const expected=await page.evaluate(value=>new Date(value).toLocaleString('zh-CN'),fixture.task.createdAt)
  await until(async()=>(await choice.innerText()).includes(expected),'部署任务控件必须显示恢复任务的实际创建时间')
  await page.locator('pre[aria-label="部署增量日志"]').filter({visible:true}).waitFor()
  return {taskId:selection.taskId,targetId:selection.targetId}
}
async function download(link,name){const [file]=await Promise.all([page.waitForEvent('download'),link.click()]);try{assert.equal(await file.failure(),null);assert.equal(file.suggestedFilename(),name);const bytes=await readFile(await file.path());report.downloads.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),temporaryDeleted:true});return bytes}finally{await file.delete()}}
async function packages() {
  await toggle('部署分类','源码包').click();const surface=page.locator('[aria-label="部署交付"]');await surface.waitFor()
  await surface.getByRole('button',{name:new RegExp(fixture.pack.name)}).click()
  const zip=surface.getByRole('link',{name:'下载前端 ZIP',exact:true});assert.equal(await zip.getAttribute('href'),`${projectApi(projectA)}/workspaces/packages/${fixture.pack.id}/frontend/download`)
  const sourceLink=surface.getByRole('link',{name:'查看工作区来源',exact:true}),sourceUrl=new URL(await sourceLink.getAttribute('href'),origin)
  const sourceRoute=sourceUrl.hash.startsWith('#/')?new URL(sourceUrl.hash.slice(1),'http://route.invalid'):sourceUrl
  assert.equal(sourceRoute.pathname,'/workspaces');assert.equal(sourceRoute.searchParams.get('projectId'),projectA);assert.equal(sourceRoute.searchParams.get('versionId'),fixture.pack.sourceVersionId)
  const bytes=await download(zip,'frontend.zip');assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.pack.services.find(item=>item.service==='frontend').sha256)
  const opener=page.getByRole('button',{name:'查看交付清单',exact:true}).filter({visible:true});const modal=await opener.isVisible();if(modal)await opener.click()
  const manifest=page.getByRole('link',{name:'下载交付清单',exact:true}).filter({visible:true});const data=JSON.parse((await download(manifest,'manifest.json')).toString('utf8'));assert.equal(data.releaseId,fixture.pack.id)
  if(modal){await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'交付清单',exact:true}).waitFor({state:'hidden'});await until(()=>opener.evaluate(element=>element===document.activeElement),'清单关闭应恢复焦点')}
  await geometry('deployments','source-packages')
  return {sourcePackageProject:projectA,packageId:fixture.pack.id,downloadsVerified:true}
}
async function sourceHandoff(){
  await area('workspaces',projectA);await assertPreview();await dismissToasts()
  const direct=page.getByRole('link',{name:'从此版本部署',exact:true}).filter({visible:true})
  if(await direct.count())await direct.first().click()
  else{await page.getByRole('button',{name:'工作区操作',exact:true}).click();await page.getByRole('menuitem',{name:'从此版本部署',exact:true}).click()}
  const dialog=page.getByRole('dialog',{name:'生成部署包',exact:true});await dialog.waitFor()
  assert.equal(routeState().pathname,'/deployments');assert.equal(routeState().projectId,projectA)
  assert((await dialog.getByRole('combobox',{name:'来源内部版本',exact:true}).innerText()).includes(fixture.version.name),'交接应固定明确来源版本')
  await page.keyboard.press('Tab');assert(await dialog.evaluate(element=>element.contains(document.activeElement)),'原生生成Dialog应约束Tab焦点')
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
  const generate=page.getByRole('button',{name:/^生成(?:部署)?包$/}).filter({visible:true})
  await until(()=>generate.evaluate(element=>element===document.activeElement),'跨页面来源交接关闭后应聚焦新的生成入口')
  await page.reload();await root('deployments').waitFor({timeout:60000});assert.equal(await page.getByRole('dialog',{name:'生成部署包',exact:true}).count(),0,'来源交接只执行一次，刷新不应重复打开Dialog')
  await area('workspaces',projectA);await assertPreview();return {sourceVersionId:fixture.version.id,dialogOnly:true,noPackageCreated:true,escapeFocus:true,refreshDoesNotReopen:true}
}
async function keyboardProjectPicker() {
  await openSidebar();const button=picker();await button.focus();await button.press('Enter')
  const search=page.getByRole('combobox',{name:'搜索项目',exact:true}).filter({visible:true});await search.waitFor();await until(()=>search.evaluate(element=>element===document.activeElement),'原生项目搜索应获取焦点')
  await search.fill(fixture.b.name);await page.getByRole('option').filter({hasText:fixture.b.name}).waitFor();await search.press('ArrowDown')
  await page.keyboard.press('Escape');await until(async()=>!await search.isVisible(),'Escape应关闭项目选择器');await until(()=>button.evaluate(element=>element===document.activeElement),'Escape应恢复项目选择器按钮焦点')
  await closeMobile();return {nativeSearch:true,keyboardNavigation:true,escapeFocus:true}
}
async function geometry(area,label) {
  await closeMobile();await dismissToasts()
  const value=await root(area).evaluate(element=>{
    const rect=target=>{if(!target)return null;const b=target.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height,clientWidth:target.clientWidth,scrollWidth:target.scrollWidth,clientHeight:target.clientHeight,scrollHeight:target.scrollHeight}}
    const content=element.querySelector('[data-readonly-workspace], [aria-label="服务发布"], [aria-label="部署交付"]')
    const toolbar=element.querySelector('[aria-label="工作区工具栏"], [aria-label="部署工具栏"]')
    return {viewport:{width:innerWidth,height:innerHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},page:rect(element),content:rect(content),toolbar:rect(toolbar),controls:[...(toolbar?.querySelectorAll('button')||[])].filter(item=>{const b=item.getBoundingClientRect();return b.width&&b.height}).map(item=>({label:item.getAttribute('aria-label')||item.textContent.trim(),rect:rect(item)}))}
  })
  assert(value.document.width<=value.viewport.width+1&&value.document.height<=value.viewport.height+1,'独立业务页应在内部滚动，不扩大整页')
  assert(value.page.left>=-1&&value.page.right<=value.viewport.width+1&&value.page.bottom<=value.viewport.height+1)
  assert(value.page.bottom>=value.viewport.height-3,'独立业务页面应占满窗口剩余空间')
  if(value.content){assert(value.content.height>0);assert(value.content.bottom>=value.viewport.height-3&&value.content.bottom<=value.viewport.height+1);assert(value.content.scrollWidth<=value.content.clientWidth+1)}
  if(value.toolbar)for(const control of value.controls)assert(control.rect.left>=value.toolbar.left-1&&control.rect.right<=value.toolbar.right+1,`工具栏操作越界：${control.label}`)
  report.geometry.push({session:currentSession.name,area,label,...value});await capture(`${currentSession.name}-${area}-${label}`);return value
}
async function theme(mode){await closeMobile();await page.goto(origin+'/agent-demo.html#/settings/appearance');await page.getByRole('group',{name:'外观模式',exact:true,includeHidden:true}).waitFor({state:'attached'});await closeMobile();await page.getByRole('group',{name:'外观模式',exact:true}).getByRole('button',{name:mode==='dark'?'使用深色模式':'使用浅色模式',exact:true}).click();await until(()=>page.evaluate(dark=>document.documentElement.classList.contains('dark')===dark,mode==='dark'),'本地外观选择应生效');await page.goto(`${origin}/agent-demo.html#/workspaces?projectId=${projectA}`);await root('workspaces').waitFor({timeout:60000});await closeMobile()}
async function restoreA(){await selectProject(projectA);await area('workspaces',projectA);const preview=await assertPreview();assert.equal(await toggle('工作区分类','部署发布').count(),0,'源码包不应再嵌套在工作区分类');await page.reload();await root('workspaces').waitFor({timeout:60000});await assertPreview();await area('deployments',projectA);const task=await assertTask();await page.reload();await root('deployments').waitFor({timeout:60000});await assertTask();return {preview,task,reloadRestoredBoth:true}}
async function switchAndHistory(){
  await area('workspaces',projectA);await selectProject(fixture.b.id);await assertArea('workspaces',fixture.b.id)
  const boundary=Date.now();await area('deployments',fixture.b.id);await area('chat',fixture.b.id);await area('workspaces',fixture.b.id)
  await area('deployments',fixture.b.id);await page.goBack();await until(()=>routeState().pathname==='/workspaces'&&routeState().projectId===fixture.b.id,'后退应恢复B工作区');await assertArea('workspaces',fixture.b.id)
  await page.goForward();await until(()=>routeState().pathname==='/deployments'&&routeState().projectId===fixture.b.id,'前进应恢复B部署页');await assertArea('deployments',fixture.b.id)
  await page.reload();await root('deployments').waitFor({timeout:60000});await assertArea('deployments',fixture.b.id)
  const relevant=report.projectRequests.filter(item=>item.session===currentSession.name&&item.at>=boundary);assert(relevant.length>0);assert(relevant.every(item=>item.projectId===fixture.b.id),'B三区浏览不得请求A工作区或部署数据')
  return {projectB:fixture.b.id,threeAreas:true,historyBackForward:true,reload:true,foreignProjectRequests:0,restored:await restoreA()}
}
async function settingsReturnToProjectArea(){
  const results=[]
  for(const name of ['deployments','workspaces']){
    await area(name,projectA)
    await (name==='deployments'?assertTask():assertPreview())
    const before=routeState()
    await openSidebar();await sidebar().getByRole('button',{name:'设置',exact:true}).click()
    await until(()=>routeState().pathname.startsWith('/settings'),'侧栏设置入口应进入原生设置页面')
    // Settings owns its original sidebar, without the business project navigation.
    if(!await sidebarOpen())await page.getByRole('button',{name:'切换主侧栏',exact:true}).filter({visible:true}).first().click()
    await until(sidebarOpen,'设置原生侧栏应可展开')
    await sidebar().getByRole('button',{name:'返回',exact:true}).click()
    await until(()=>{const state=routeState();return state.pathname===before.pathname&&state.projectId===projectA},'设置返回应恢复原项目业务页，而不是问答草稿')
    await root(name).waitFor();await assertArea(name,projectA)
    const restored=await (name==='deployments'?assertTask():assertPreview())
    assert.equal(routeState().versionId,before.versionId,'设置返回应保留原固定版本参数')
    results.push({area:name,projectId:projectA,returnedViaNativeSidebar:true,restored})
  }
  return results
}
async function invalidProject(){
  const forbidden='p-unavailable-ui-readonly',boundary=Date.now()
  for(const area of ['chat','workspaces','deployments']){
    await page.goto(`${origin}/agent-demo.html#/${area==='chat'?'':area}?projectId=${forbidden}`);await page.getByTestId('project-unavailable').waitFor({timeout:60000});assert.equal(routeState().projectId,forbidden)
    assert.equal(await files().count(),0);assert.equal(await page.locator('[aria-label="服务发布"]').count(),0);await capture(`${currentSession.name}-${area}-unavailable`)
  }
  const calls=report.projectRequests.filter(item=>item.session===currentSession.name&&item.at>=boundary)
  assert(!calls.some(item=>item.projectId===projectA||item.projectId===fixture.b.id),'非法项目不得回退请求任何已授权项目数据')
  await page.goto(`${origin}/agent-demo.html#/workspaces?projectId=${projectA}`);await root('workspaces').waitFor({timeout:60000});return {fallbackPrevented:true,foreignRequests:0}
}

try{
  const desktop=await login('desktop-admin');await run('real-authorized-fixture',()=>preflight(desktop))
  await run('unified-project-chat-and-initial-state',async()=>{await selectProject(projectA);const chat=await area('chat',projectA);const preview=await choosePreview(),task=await chooseTask();await geometry('deployments','existing-task');const artifact=await packages();await toggle('部署分类','服务发布').click();return {chat,preview,task,artifact}})
  await run('project-switch-three-areas-history-and-restore',switchAndHistory)
  await run('settings-return-to-project-area',settingsReturnToProjectArea)
  await run('workspace-to-deployment-source-handoff',sourceHandoff)
  await run('invalid-project-no-fallback',invalidProject)
  for(const mode of ['light','dark'])await run(`desktop-${mode}`,async()=>{await page.setViewportSize({width:1440,height:900});await theme(mode);await area('workspaces',projectA);const workspace=await geometry('workspaces',mode);await area('deployments',projectA);await toggle('部署分类','服务发布').click();return {workspace,deployments:await geometry('deployments',mode),keyboard:await keyboardProjectPicker()}})
  await run('desktop-short-600',async()=>{await page.setViewportSize({width:1440,height:600});await area('workspaces',projectA);const workspace=await geometry('workspaces','short');await area('deployments',projectA);await toggle('部署分类','服务发布').click();return {workspace,deployments:await geometry('deployments','short')}})
  const touch=await login('touch-admin',true);currentSession=touch;page=touch.page
  await run('touch-select-and-save-preview',async()=>{await selectProject(projectA);return {preview:await choosePreview(),task:await chooseTask()}})
  for(const mode of ['light','dark'])await run(`touch-${mode}`,async()=>{await theme(mode);await area('workspaces',projectA);const workspace=await geometry('workspaces',mode);await area('deployments',projectA);await toggle('部署分类','服务发布').click();return {workspace,deployments:await geometry('deployments',mode),keyboard:await keyboardProjectPicker()}})
  await run('touch-project-context-and-source-package',async()=>({context:await switchAndHistory(),package:await packages()}))
  const guest=await login('guest-external',false,'guest');currentSession=guest;page=guest.page
  await run('external-project-boundary-and-deployment403',async()=>{
    await selectProject(projectA);await area('workspaces',projectA);await openSidebar();const entry=navigation().locator('[aria-label="部署发布"]');assert(await entry.count()===0||await entry.isDisabled(),'外部成员不能操作部署入口');await closeMobile()
    await get(projectApi(projectA)+'/deployments',403)
    const deniedAt=Date.now();await page.goto(`${origin}/agent-demo.html#/deployments?projectId=${projectA}`);await page.getByTestId('project-unavailable').waitFor({timeout:60000});assert.equal(await page.locator('[aria-label="服务发布"]').count(),0)
    assert(!report.projectRequests.some(item=>item.session===guest.name&&item.at>=deniedAt&&item.kind==='deployments'),'外部部署页不应自动请求执行数据')
    const boundary=Date.now();await page.goto(`${origin}/agent-demo.html#/workspaces?projectId=${fixture.b.id}`);await page.getByTestId('project-unavailable').waitFor({timeout:60000});assert.equal(routeState().projectId,fixture.b.id)
    assert(!report.projectRequests.some(item=>item.session===guest.name&&item.at>=boundary&&item.projectId===projectA),'无权项目不可悄悄回退A工作区')
    await capture('guest-unauthorized-project');return {deploymentApi403:true,unauthorizedProjectFallback:false}
  })
  assert.equal(report.blockedHttpMutations.length,0,'区域浏览不应尝试业务写操作');assert.equal(report.blockedRpcMutations.length,0,'不应触发原生聊天/文件写操作');assert.equal(report.blockedExistingThreadReads.length,0,'不应读取已存在对话正文');assert.equal(report.pageErrors.length,0,'页面应没有运行错误')
  report.status='passed'
}catch(error){report.status='failed';report.error=redact(error.stack||error.message);process.exitCode=1;console.error(redact(error.stack||error.message))}
finally{for(const session of sessions){const item=report.cleanup[session.name]={};await session.context?.close().then(()=>{item.ownedBrowserClosed=true}).catch(error=>{item.error=redact(error.message);report.status='failed';process.exitCode=1});await rm(session.profile,{recursive:true,force:true});item.ownProfileRemoved=true}report.finishedAt=new Date().toISOString();await save()}
