import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// 此浏览器命令需在 macOS 沙盒外授权运行；临时配置和业务写入仅属于本次 UUID。
const origin = (process.env.BASE_URL || 'http://192.168.31.157:18897').replace(/\/$/, '')
if (process.env.T3_SKILL_LIBRARY_MUTATIONS !== '1' || new URL(origin).port === '8787')
  throw new Error('技能管理验收仅允许显式授权的隔离实例，不能在正式 8787 运行。')
const marker = `skill-ui-${randomUUID().slice(0, 8)}`
const targetedCase = process.env.T3_SKILL_LIBRARY_CASE
if (targetedCase && !['project-filter-unassign', 'management'].includes(targetedCase))
  throw new Error(`未知的技能验收案例：${targetedCase}`)
const longName =
  `技能闭环验收 ${marker} · ${'长中文标题用于验证列表省略和菜单边界'.repeat(3)}`.slice(0, 76)
const referenceName = `${'长中文参考资料目录文件'.repeat(5)}.md`
const referencePath = `references/nested/${referenceName}`
const output = path.resolve(
  process.env.ARTIFACT_DIR || `.test-artifacts/skill-library-ui/${marker}`,
)
await mkdir(output, { recursive: true })
const report = {
  origin,
  marker,
  startedAt: new Date().toISOString(),
  steps: [],
  pageErrors: [],
  blockedMutations: [],
  mutations: [],
  ownedSkillIds: [],
  coverage: { actualApi: true, actualUploads: targetedCase !== 'project-filter-unassign', modelCalls: false, actualTouchDevice: false },
  cleanup: {},
}
const sessions = [],
  ownedSkills = new Set(),
  ownedAssignments = new Set()
const client = new T3LiveClient(origin)
let page, originalCatalog, currentCatalog, readySkill, restrictedSkill, primaryAgent, secondaryAgent, primaryProject
const ownedName = name => name === marker || name.startsWith(`${marker}-`)
const markdown = (name, title, extra = '') =>
  `---\nname: ${name}\ndescription: 检查当前项目授权资料并引用来源\nmetadata:\n  display-name: ${title}\nallowed-tools:\n  - list_project_materials\n  - read_project_document\n---\n\n只读取当前授权项目。引用真实资料来源，不执行任何任意命令。\n\n${extra}`
const readyMarkdown = markdown(marker, longName)
const versionZip = Buffer.from(
  zipSync({
    'SKILL.md': strToU8(markdown(marker, longName, `阅读 [参考资料](${referencePath})。`)),
    [referencePath]: strToU8(
      `# 技能参考证据\n\n${marker} reference-v2\n\n[返回技能说明](../../SKILL.md)\n\n${'这是一行长中文参考资料，用于验证源代码预览的独立滚动与文件目录。'.repeat(30)}`,
    ),
    'assets/template.txt': strToU8('模板文件\n'),
  }),
)
const restrictedZip = Buffer.from(
  zipSync({
    'SKILL.md': strToU8(
      markdown(`${marker}-restricted`, `${marker} 依赖脚本的技能`, '运行 scripts/check.sh。'),
    ),
    'scripts/check.sh': strToU8('#!/bin/sh\nprintf unavailable\n'),
  }),
)
async function until(read, message, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(message)
}
async function step(name, action) {
  const item = { name }
  report.steps.push(item)
  try {
    item.result = await action()
    item.status = 'passed'
  } catch (error) {
    item.status = 'failed'
    item.error = error.stack
    await page?.screenshot({ path: path.join(output, `${name}-failed.png`) }).catch(() => {})
    throw error
  } finally {
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ name, status: item.status, error: item.error }))
  }
}
function captureOwned(catalog) {
  currentCatalog = catalog
  for (const skill of catalog.skills)
    if (ownedName(skill.name)) ownedSkills.add(skill.id)
  for (const assignment of catalog.assignments)
    if (ownedSkills.has(assignment.skillId)) ownedAssignments.add(assignment.id)
  report.ownedSkillIds = [...ownedSkills]
  writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
}
async function catalog() {
  const result = await client.http('/autoops/skill-library')
  captureOwned(result)
  return result
}
async function mutation(action, click, expectOk = true) {
  const resultPromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/autoops/skill-library') &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.action === action,
  )
  void resultPromise.catch(() => {})
  await click()
  const response = await resultPromise
  const result = await response.json()
  report.mutations.push({action,body:response.request().postDataJSON(),status:response.status()})
  assert.equal(response.ok(), expectOk, JSON.stringify(result))
  if (response.ok()) {
    captureOwned(result)
    await until(
      () =>
        page
          .locator('[data-skill-library]')
          .getAttribute('data-skill-library-revision')
          .then((revision) => revision === result.revision),
      '页面未呈现服务端已保存的版本',
    )
  }
  return result
}
async function openSession(touch = false) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autoops-skill-library-'))
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    locale: 'zh-CN',
    viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: touch,
    hasTouch: touch,
    ...(process.env.BROWSER_EXECUTABLE_PATH
      ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
      : {}),
  })
  const session = { context, profile, touch, page: context.pages()[0] || (await context.newPage()) }
  sessions.push(session)
  await context.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || url.pathname.endsWith('/login'))
      return route.continue()
    if (url.pathname.endsWith('/api/observability/v1/traces'))
      return route.fulfill({ status: 204, body: '' })
    if (url.pathname.endsWith('/autoops/skill-library')) {
      const body = request.postDataJSON() ?? {}
      const allowed = body.action?.startsWith('import-')
        ? body.skillId
          ? ownedSkills.has(body.skillId)
          : body.contents?.includes(marker) || body.fileName?.includes(marker)
        : body.action === 'unassign'
          ? ownedAssignments.has(body.assignmentId)
          : ownedSkills.has(body.skillId)
      if (allowed) return route.continue()
    }
    report.blockedMutations.push({ method: request.method(), pathname: url.pathname })
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: '验收禁止修改非本次创建的数据。' }),
    })
  })
  await context.routeWebSocket(
    (url) => url.pathname.endsWith('/api/agent-demo/t3/ws'),
    (socket) => {
      const server = socket.connectToServer()
      socket.onMessage((payload) => {
        let messages
        try {
          const decoded = JSON.parse(String(payload))
          messages = Array.isArray(decoded) ? decoded : [decoded]
        } catch {
          server.send(payload)
          return
        }
        const invalid = messages.filter(
          (message) =>
            (/^orchestration\./.test(message.tag) &&
              !/^orchestration\.(get|list|subscribe)/.test(message.tag)) ||
            /^(projects|filesystem|server|settings)\.(write|create|remove|delete|rename|update|set)/.test(
              message.tag,
            ),
        )
        if (invalid.length) {
          report.blockedMutations.push(
            ...invalid.map((message) => ({ method: message.tag, type: message.payload?.type })),
          )
          return
        }
        server.send(payload)
      })
    },
  )
  page = session.page
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => report.pageErrors.push({ touch, message: error.message }))
  await page.goto(`${origin}/agent-demo.html#/skills?projectId=${encodeURIComponent(primaryProject.id)}&skillView=library`)
  await page.getByRole('textbox', { name: '用户名' }).fill('admin')
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('[data-skill-library]').waitFor({ timeout: 60000 })
  await closeMobileSidebar(session)
  return session
}
async function closeMobileSidebar(session) {
  const mobile = page.locator('[data-sidebar="sidebar"][data-mobile="true"]:visible').first()
  if (await mobile.isVisible()) {
    await page.keyboard.press('Escape')
    await until(async () => !(await mobile.isVisible()), '移动侧栏应正常关闭')
  }
}
async function management(session, id) {
  page = session.page
  await closeMobileSidebar(session)
  await page.goto(`${origin}/agent-demo.html#/skills?projectId=${encodeURIComponent(primaryProject.id)}&skillView=library`)
  await page.locator('[data-skill-library]').waitFor()
  await closeMobileSidebar(session)
  const back=page.getByRole('button',{name:'返回技能库',exact:true})
  if(await back.isVisible())await back.click()
  const refreshed=page.waitForResponse(response=>response.request().method()==='GET'&&response.url().endsWith('/autoops/skill-library'))
  void refreshed.catch(()=>{})
  await page.getByRole('button',{name:'刷新技能库',exact:true}).click()
  const response=await refreshed
  assert.equal(response.status(),200)
  captureOwned(await response.json())
  await until(()=>page.getByRole('button',{name:'刷新技能库',exact:true}).isEnabled(),'目录刷新完成')
  if (id) {
    await page.locator(`[data-skill-row="${id}"]`).click()
    await page.getByRole('button', { name: '技能操作', exact: true }).waitFor()
  }
}
const skillCard = id => page.locator(`[data-skill-card="${id}"]`)
const targetSelector = (type,id) => `[data-skill-target-type="${type}"][data-skill-target-id="${id}"]`
const agentTarget = (skillId,agentId) => skillCard(skillId).locator(targetSelector('agent',agentId))
const assignedTo = (skillId,type,id) => currentCatalog.assignments.find(entry=>entry.skillId===skillId&&entry.targetType===type&&entry.targetId===id)
async function ownedMutation(body) {
  assert(body.action.startsWith('import-') ? body.skillId ? ownedSkills.has(body.skillId) : body.contents?.includes(marker)||body.fileName?.includes(marker) : body.action==='unassign' ? ownedAssignments.has(body.assignmentId) : ownedSkills.has(body.skillId),'API准备只能改本轮数据')
  const before=await catalog()
  const next=await client.http('/autoops/skill-library','POST',{revision:before.revision,...body})
  captureOwned(next)
  return next
}
async function projectPopover(skill) {
  const trigger=skillCard(skill.id).getByRole('button',{name:`项目分配：${skill.displayName}`,exact:true})
  await trigger.scrollIntoViewIfNeeded()
  if(sessions.some(session=>session.page===page&&session.touch))await trigger.tap()
  else await trigger.click()
  const list=page.locator('[aria-label="项目分配列表"]')
  await list.waitFor()
  return {trigger,list}
}
async function closeProjectPopover(trigger) {
  await page.keyboard.press('Escape')
  await until(async()=>await page.locator('[aria-label="项目分配列表"]').count()===0,'项目浮层应关闭')
  await until(()=>trigger.evaluate(element=>element===document.activeElement),'项目浮层关闭后恢复入口焦点')
}
async function assertQuickView() {
  assert.equal(await page.locator('[aria-label="技能详情"]:visible').count(),0,'快切不应打开技能文件详情')
}
async function visualCardContract() {
  const normal=currentCatalog.skills.filter(skill=>skill.enabled&&skill.versions.find(version=>version.id===skill.latestVersionId)?.readiness==='ready')
  for(const skill of normal) {
    const card=skillCard(skill.id)
    if(!(await card.count()))continue
    const text=await card.innerText()
    assert(!text.includes('新分配：')&&!text.includes('可分配'),'正常卡片不应常驻新分配行或可分配徽标')
    for(const version of skill.versions)assert(!text.includes(version.id.slice(0,8)),'版本标识应在按需详情/提示中展示')
  }
  const measured=await page.locator('[data-skill-card]').first().evaluate(card=>{
    const grid=card.parentElement,gridBounds=grid.getBoundingClientRect()
    return {gridWidth:gridBounds.width,columns:getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,cards:[...grid.querySelectorAll('[data-skill-card]')].map(element=>({id:element.getAttribute('data-skill-card'),height:element.getBoundingClientRect().height}))}
  })
  if(page.viewportSize().width===1440) {
    assert.equal(measured.columns,2,'1440桌面应使用T3受控宽度双列卡片')
    assert(measured.gridWidth<=1026,'技能内容列不应超过T3 wide/max-w-5xl容器')
  }
  return {...measured,normalCards:measured.cards.filter(card=>normal.some(skill=>skill.id===card.id))}
}
async function assignmentHelp() {
  const trigger=page.getByRole('button',{name:'技能分配说明',exact:true})
  await trigger.scrollIntoViewIfNeeded()
  if(sessions.some(session=>session.page===page&&session.touch))await trigger.tap()
  else await trigger.click()
  const popup=page.locator('[data-slot="popover-popup"]').filter({hasText:'项目未单独分配时沿用助手设置'})
  await popup.waitFor()
  const rect=await popup.boundingBox(),viewport=page.viewportSize()
  assert(rect&&rect.x>=-2&&rect.x+rect.width<=viewport.width+2&&rect.y>=-2&&rect.y+rect.height<=viewport.height+2,'技能分配说明浮层不能越出视窗')
  await page.keyboard.press('Escape')
  await until(()=>trigger.evaluate(element=>element===document.activeElement),'分配说明关闭后恢复说明入口焦点')
}
async function restrictedReason(skill,screenshotName) {
  const trigger=skillCard(skill.id).getByRole('button',{name:skill.versions.length>1?'最新版本未就绪':'未就绪',exact:true})
  await trigger.scrollIntoViewIfNeeded()
  if(sessions.some(session=>session.page===page&&session.touch))await trigger.tap()
  else await trigger.click()
  const popup=page.locator('[data-slot="popover-popup"]').filter({hasText:'运行条件未满足'})
  await popup.waitFor()
  const version=skill.versions.find(entry=>entry.id===skill.latestVersionId)
  assert((await popup.innerText()).includes(version.reason),'未就绪原因应完整来自真实技能版本')
  const rect=await popup.boundingBox(),viewport=page.viewportSize()
  assert(rect&&rect.x>=-2&&rect.x+rect.width<=viewport.width+2&&rect.y>=-2&&rect.y+rect.height<=viewport.height+2,'运行条件浮层不能越出视窗')
  if(screenshotName)await page.screenshot({path:path.join(output,`${screenshotName}.png`)})
  await page.keyboard.press('Escape')
  await until(()=>trigger.evaluate(element=>element===document.activeElement),'运行条件浮层关闭后恢复入口焦点')
}
async function delayedRefreshGuard(skillId,agentId) {
  await until(()=>agentTarget(skillId,agentId).isEnabled(),'目录载入完成后再验证刷新')
  let release,received=false,completed,routeError,claimed=false
  const pending=new Promise(resolve=>{release=resolve})
  const finished=new Promise(resolve=>{completed=resolve})
  const handler=async route=>{
    if(route.request().method()!=='GET'||claimed)return route.fallback()
    claimed=true
    try {
      const response=await route.fetch();received=true
      await pending
      await route.fulfill({response})
    }catch(error){routeError=error}finally{completed()}
  }
  await page.route('**/autoops/skill-library',handler)
  try {
    await page.getByRole('button',{name:'刷新技能库',exact:true}).click()
    await until(()=>received,'应收到被延迟的真实目录GET')
    assert.equal(await agentTarget(skillId,agentId).isDisabled(),true,'刷新未完成时卡片写入口必须禁用')
    assert.equal(await page.getByRole('button',{name:'导入技能',exact:true}).isDisabled(),true)
  }finally{release();if(claimed)await finished;await page.unroute('**/autoops/skill-library',handler)}
  if(routeError)throw routeError
  await until(async()=>!(await agentTarget(skillId,agentId).isDisabled()),'真实刷新响应结束后恢复快切')
}
async function menu(label) {
  await page.getByRole('button', { name: '技能操作', exact: true }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}
async function choose(label, text) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option').filter({ hasText: text }).first().click()
}
async function dialogClosed() {
  await until(async () => (await page.getByRole('dialog').count()) === 0, '弹窗应正常关闭')
}
async function theme(session, mode) {
  page = session.page
  await closeMobileSidebar(session)
  await page.goto(`${origin}/agent-demo.html#/settings/appearance`)
  await page
    .getByRole('group', { name: '外观模式', exact: true, includeHidden: true })
    .waitFor({ state: 'attached' })
  await closeMobileSidebar(session)
  await page
    .getByRole('group', { name: '外观模式', exact: true })
    .getByRole('button', { name: mode === 'dark' ? '使用深色模式' : '使用浅色模式', exact: true })
    .click()
  await until(
    () =>
      page.evaluate(
        (dark) => document.documentElement.classList.contains('dark') === dark,
        mode === 'dark',
      ),
    '原生外观切换失败',
  )
}
async function geometry(name) {
  if (!name.endsWith('-list') && !name.endsWith('-dialog') && !name.endsWith('-popover')) {
    await page
      .locator('[aria-label="技能详情"] .chat-markdown')
      .filter({ hasText: marker })
      .first()
      .waitFor()
    await until(
      async () =>
        (await page.getByRole('status', { name: '正在加载文件', exact: true }).count()) === 0,
      '内容截图应等待实际文件正文载入',
    )
  }
  const measured = await page.evaluate(() => {
    const root = document.querySelector('[data-skill-library]'),
      bounds = root.getBoundingClientRect()
    const rect = (value) => ({
      left: value.left,
      right: value.right,
      top: value.top,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
    })
    const areas = [
      ...document.querySelectorAll(
        '[aria-label="技能列表"] [data-slot="scroll-area-viewport"], [data-slot="dialog-panel"], [aria-label="项目分配列表"]',
      ),
    ]
      .filter((element) => element.getBoundingClientRect().height > 0)
      .map((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    const controls = [
      ...root.querySelectorAll(
        '[aria-label="技能库工具栏"] button, [aria-label="技能操作"], [data-skill-row], [data-skill-target-type]',
      ),
    ]
      .filter((element) => element.getBoundingClientRect().height > 0)
      .map((element) => ({
        label: element.getAttribute('aria-label') || element.textContent?.slice(0, 32),
        rect: rect(element.getBoundingClientRect()),
        target:element.hasAttribute('data-skill-target-type'),
      }))
    const popover=document.querySelector('[aria-label="项目分配列表"]')
    const popup=popover?.closest('[data-slot="popover-popup"], [data-slot="popover-content"], [role="dialog"]')??popover
    return {
      root: rect(bounds),
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      areas,
      controls,
      popup:popup?rect(popup.getBoundingClientRect()):null,
      popupTargets:popover?[...popover.querySelectorAll('[data-skill-target-type]')].map(element=>rect(element.getBoundingClientRect())):[],
      coarse:matchMedia('(pointer: coarse)').matches,
    }
  })
  report.lastGeometry = { name, ...measured }
  assert(
    measured.root.right <= measured.viewport.width + 2 &&
      measured.documentWidth <= measured.viewport.width + 2,
    '页面不能横向溢出',
  )
  for (const area of measured.areas)
    assert(area.scrollWidth <= area.clientWidth + 2, '技能列表或弹窗内部内容横向溢出')
  for (const control of measured.controls)
    assert(
      control.rect.left >= measured.root.left - 2 && control.rect.right <= measured.root.right + 2,
      `${control.label} 超出页面边界`,
    )
  if(measured.popup)assert(measured.popup.left>=-2&&measured.popup.right<=measured.viewport.width+2&&measured.popup.top>=-2&&measured.popup.bottom<=measured.viewport.height+2,'项目浮层必须完整落在视窗内')
  for(const target of measured.popupTargets)assert(target.left>=-2&&target.right<=measured.viewport.width+2,'项目选择按钮不能超出浮层视窗边界')
  if(measured.coarse)for(const rect of [...measured.controls.filter(control=>control.target).map(control=>control.rect),...measured.popupTargets])assert(rect.height>=43,'触屏分配控件点击高度应至少44px')
  await page.screenshot({ path: path.join(output, `${name}.png`) })
  return measured
}
async function importFile(buffer, filename, action) {
  await page
    .getByLabel('技能包文件', { exact: true })
    .setInputFiles({ name: filename, mimeType: 'application/zip', buffer })
  await page.getByText(filename, { exact: false }).first().waitFor()
  const result = await mutation(action, () =>
    page.getByRole('button', { name: '导入并检查', exact: true }).click(),
  )
  await dialogClosed()
  return result
}

try {
  await client.login()
  originalCatalog = await catalog()
  await writeFile(path.join(output,'original-catalog.json'),JSON.stringify(originalCatalog,null,2))
  primaryAgent=originalCatalog.agents.find(entry=>entry.id==='a-project')??originalCatalog.agents[0]
  secondaryAgent=originalCatalog.agents.find(entry=>entry.id!==primaryAgent.id)
  primaryProject=originalCatalog.projects.find(entry=>entry.id==='p-autoops'&&primaryAgent.projectIds.includes(entry.id))??originalCatalog.projects.find(entry=>primaryAgent.projectIds.includes(entry.id))
  assert(primaryAgent&&secondaryAgent&&primaryProject,'验收需要两个助手和至少一个授权项目')
  const desktop = await openSession()
  if(targetedCase==='project-filter-unassign') {
    await step('project-filter-unassign-removes-card-and-releases-toast',async()=>{
      await ownedMutation({action:'import-markdown',contents:readyMarkdown})
      readySkill=currentCatalog.skills.find(skill=>skill.name===marker)
      assert(readySkill)
      await ownedMutation({action:'assign',skillId:readySkill.id,targetType:'project',targetId:primaryProject.id,versionId:readySkill.latestVersionId,workspaceTypes:['internal'],enabled:true})
      await management(desktop)
      await page.locator('[aria-label="技能管理"]').getByText('项目技能',{exact:true}).click()
      assert.equal(new URL(page.url().split('#')[1],origin).searchParams.get('projectId'),primaryProject.id)
      await skillCard(readySkill.id).waitFor()
      const {list}=await projectPopover(readySkill)
      const project=list.locator(targetSelector('project',primaryProject.id))
      assert.equal(await project.getAttribute('aria-pressed'),'true')
      await mutation('unassign',()=>project.click())
      await until(async()=>await skillCard(readySkill.id).count()===0,'取消当前项目分配后卡片必须退出该项目筛选')
      await until(async()=>await page.locator('[aria-label="项目分配列表"]').count()===0,'卡片移除后项目浮层必须卸载')
      assert.equal(assignedTo(readySkill.id,'project',primaryProject.id),undefined)
      const expectedFocus=await page.locator('[data-skill-row]:visible').count()
        ?page.locator('[data-skill-row]:visible').first()
        :page.getByRole('button',{name:'添加技能',exact:true})
      await until(()=>expectedFocus.evaluate(element=>element===document.activeElement),'卡片移除后焦点必须恢复到下一张可见卡片或添加技能入口')
      assert.equal(await expectedFocus.isEnabled(),true)
      await page.locator('[data-slot="toast-title"]:visible').filter({hasText:`已取消“${primaryProject.name}”的分配，沿用助手设置。`}).waitFor()
      await page.screenshot({path:path.join(output,'project-filter-after-unassign.png')})
      await page.getByRole('button',{name:'添加技能',exact:true}).click()
      await choose('分配的技能',readySkill.displayName)
      await mutation('assign',()=>page.getByRole('button',{name:'保存分配',exact:true}).click())
      await dialogClosed()
      await skillCard(readySkill.id).waitFor()
      await page.locator('[data-slot="toast-title"]:visible').filter({hasText:'分配已保存。'}).waitFor()
      assert.deepEqual(assignedTo(readySkill.id,'project',primaryProject.id).workspaceTypes,['internal'])
      await page.screenshot({path:path.join(output,'project-filter-after-reassign.png')})
      return {skillId:readySkill.id,projectId:primaryProject.id,removedFromFilteredCards:true,popupUnmounted:true,focusReturnedToAvailableControl:true,unassignToastPublished:true,subsequentAssignmentToastPublished:true,defaultInternal:true}
    })
  } else {
  await step('markdown-import-and-agent-assignment', async () => {
    await page.getByRole('button', { name: '导入技能', exact: true }).click()
    await page.locator('[aria-label="技能导入方式"]').getByText('粘贴正文', { exact: true }).click()
    await page.getByRole('textbox', { name: 'SKILL.md 正文', exact: true }).fill(readyMarkdown)
    await mutation('import-markdown', () =>
      page.getByRole('button', { name: '导入并检查', exact: true }).click(),
    )
    await dialogClosed()
    readySkill = currentCatalog.skills.find((skill) => skill.name === marker)
    assert(readySkill)
    assert.equal(readySkill.versions[0].readiness, 'ready')
    await management(desktop)
    const target=agentTarget(readySkill.id,primaryAgent.id)
    await target.waitFor()
    await page.screenshot({path:path.join(output,'initial-desktop-cards.png')})
    const cardVisual=await visualCardContract()
    await assignmentHelp()
    await delayedRefreshGuard(readySkill.id,primaryAgent.id)
    const beforeSuccess=await skillCard(readySkill.id).boundingBox()
    await mutation('assign',()=>target.click())
    const afterSuccess=await skillCard(readySkill.id).boundingBox()
    assert(beforeSuccess&&afterSuccess&&Math.abs(beforeSuccess.y-afterSuccess.y)<=1&&Math.abs(beforeSuccess.x-afterSuccess.x)<=1,'成功反馈不能推动卡片的位置')
    await assertQuickView()
    let assigned = assignedTo(readySkill.id,'agent',primaryAgent.id)
    assert.deepEqual(assigned.workspaceTypes, ['internal'])
    assert.equal(await target.getAttribute('aria-pressed'),'true')
    await mutation('unassign',()=>target.click())
    assert.equal(assignedTo(readySkill.id,'agent',primaryAgent.id),undefined)
    assert.equal(await target.getAttribute('aria-pressed'),'false')
    await target.focus()
    await mutation('assign',()=>page.keyboard.press('Enter'))
    assigned=assignedTo(readySkill.id,'agent',primaryAgent.id)
    const originalAgent=structuredClone(assigned)
    const {trigger,list}=await projectPopover(readySkill)
    const project=list.locator(targetSelector('project',primaryProject.id))
    await mutation('assign',()=>project.click())
    assert.deepEqual(assignedTo(readySkill.id,'project',primaryProject.id).workspaceTypes,['internal'])
    assert.equal(await project.getAttribute('aria-pressed'),'true')
    const assignedToast=page.locator('[data-slot="toast-title"]:visible').filter({hasText:`已分配给“${primaryProject.name}”，仅用于内部工作区。`})
    assert.equal(await assignedToast.count(),0,'项目弹层打开时成功Toast应延后，避免抢占Escape')
    await mutation('unassign',()=>project.click())
    assert.equal(assignedTo(readySkill.id,'project',primaryProject.id),undefined)
    assert.deepEqual(assignedTo(readySkill.id,'agent',primaryAgent.id),originalAgent,'项目快切不可改写助手绑定')
    const revokedToast=page.locator('[data-slot="toast-title"]:visible').filter({hasText:`已取消“${primaryProject.name}”的分配，沿用助手设置。`})
    assert.equal(await revokedToast.count(),0,'项目弹层打开时取消分配的成功Toast也应延后')
    await closeProjectPopover(trigger)
    await revokedToast.waitFor()
    const currentProjectTarget=skillCard(readySkill.id).locator(targetSelector('project',primaryProject.id))
    assert.equal(await skillCard(readySkill.id).locator('[data-skill-target-type="project"]').count(),1,'卡片只常驻当前项目入口')
    await mutation('assign',()=>currentProjectTarget.click())
    assert.equal(assignedTo(readySkill.id,'project',primaryProject.id).targetId,primaryProject.id)
    await mutation('unassign',()=>currentProjectTarget.click())
    assert.equal(assignedTo(readySkill.id,'project',primaryProject.id),undefined)
    await assertQuickView()
    await management(desktop,readySkill.id)
    return { skillId: readySkill.id, assignmentId: assigned.id, versionId: assigned.versionId,agentQuickToggle:true,projectPopoverQuickToggle:true,keyboardAssign:true,defaultInternal:true,refreshBlocksWrites:true,cardVisual,successDoesNotMoveCards:true,assignmentHelpFocus:true,projectSuccessToastAfterClose:true }
  })
  await step('archive-new-version-pinned-assignment-and-files', async () => {
    const first = currentCatalog.assignments.find((entry) => entry.skillId === readySkill.id)
    await menu('导入新版本')
    await importFile(versionZip, `${marker}.zip`, 'import-archive')
    readySkill = currentCatalog.skills.find((skill) => skill.id === readySkill.id)
    assert.equal(readySkill.versions.length, 2)
    assert.notEqual(readySkill.latestVersionId, first.versionId)
    assert.equal(
      currentCatalog.assignments.find((entry) => entry.id === first.id).versionId,
      first.versionId,
    )
    const pagesBefore = desktop.context.pages().length
    const managementUrl = page.url()
    await page.getByRole('link', { name: '参考资料', exact: true }).click()
    await page.getByText(`${marker} reference-v2`, { exact: false }).first().waitFor()
    assert.equal(page.url(), managementUrl, '包内参考链接应留在当前技能文件面板')
    assert.equal(desktop.context.pages().length, pagesBefore, '包内参考链接不能另开未授权路径')
    await page.getByRole('link', { name: '返回技能说明', exact: true }).click()
    await page.getByRole('link', { name: '参考资料', exact: true }).waitFor()
    await page.locator('[data-file-browser-panel]').getByRole('searchbox').fill(referenceName)
    await page
      .locator('[data-file-browser-panel]')
      .locator(`[data-item-path="${referencePath}"]`)
      .first()
      .click()
    await page.getByText(`${marker} reference-v2`, { exact: false }).first().waitFor()
    return {
      versions: readySkill.versions.length,
      oldAssignmentPinned: true,
      actualNestedFilePreview: true,
      relativePackageLinksVerified: true,
    }
  })
  await step('quick-toggles-preserve-pinned-version-and-external-scope',async()=>{
    const oldVersion=readySkill.versions.find(version=>version.id!==readySkill.latestVersionId).id
    await ownedMutation({action:'assign',skillId:readySkill.id,targetType:'agent',targetId:primaryAgent.id,versionId:oldVersion,workspaceTypes:['internal','external'],enabled:true})
    await management(desktop)
    const preserved=structuredClone(assignedTo(readySkill.id,'agent',primaryAgent.id))
    const second=agentTarget(readySkill.id,secondaryAgent.id)
    await mutation('assign',()=>second.click())
    assert.equal(assignedTo(readySkill.id,'agent',secondaryAgent.id).versionId,readySkill.latestVersionId)
    assert.deepEqual(assignedTo(readySkill.id,'agent',secondaryAgent.id).workspaceTypes,['internal'])
    assert.deepEqual(assignedTo(readySkill.id,'agent',primaryAgent.id),preserved)
    await mutation('unassign',()=>second.click())
    assert.deepEqual(assignedTo(readySkill.id,'agent',primaryAgent.id),preserved)
    await ownedMutation({action:'assign',skillId:readySkill.id,targetType:'agent',targetId:primaryAgent.id,versionId:oldVersion,workspaceTypes:['internal','external'],enabled:false})
    await management(desktop)
    const primary=agentTarget(readySkill.id,primaryAgent.id)
    assert.equal(await primary.getAttribute('aria-pressed'),'false')
    await mutation('assign',()=>primary.click())
    const restored=assignedTo(readySkill.id,'agent',primaryAgent.id)
    assert.equal(restored.versionId,oldVersion);assert.deepEqual(restored.workspaceTypes,['internal','external']);assert.equal(restored.enabled,true)
    await ownedMutation({action:'assign',skillId:readySkill.id,targetType:'project',targetId:primaryProject.id,versionId:oldVersion,workspaceTypes:['external'],enabled:false})
    await management(desktop)
    const {trigger,list}=await projectPopover(readySkill),project=list.locator(targetSelector('project',primaryProject.id))
    assert.equal(await project.getAttribute('aria-pressed'),'false')
    await mutation('assign',()=>project.click())
    const restoredProject=assignedTo(readySkill.id,'project',primaryProject.id)
    assert.equal(restoredProject.versionId,oldVersion);assert.deepEqual(restoredProject.workspaceTypes,['external']);assert.equal(restoredProject.enabled,true)
    assert.deepEqual(assignedTo(readySkill.id,'agent',primaryAgent.id),restored)
    await mutation('unassign',()=>project.click())
    await closeProjectPopover(trigger)
    await assertQuickView()
    await management(desktop,readySkill.id)
    return {oldVersion,latestVersion:readySkill.latestVersionId,otherTargetDoesNotRewrite:true,disabledAgentRestored:true,disabledProjectRestored:true,externalPreserved:true}
  })
  await step('scope-version-update-and-project-assignment', async () => {
    await page.getByRole('button',{name:'返回技能库',exact:true}).click()
    await page.locator('[aria-label="技能管理"]').getByText('助手技能', { exact: true }).click()
    await page.locator(`[data-skill-row="${readySkill.id}"]`).click()
    await menu('调整当前分配')
    await choose('分配技能版本', readySkill.latestVersionId.slice(0, 8))
    await page.getByRole('checkbox', { name: '外部工作区', exact: true }).check()
    await mutation('assign', () =>
      page.getByRole('button', { name: '保存分配', exact: true }).click(),
    )
    await dialogClosed()
    assert.equal(
      currentCatalog.assignments.find((entry) => entry.skillId === readySkill.id).versionId,
      readySkill.latestVersionId,
    )
    await page.getByRole('button',{name:'返回技能库',exact:true}).click()
    await page.locator('[aria-label="技能管理"]').getByText('项目技能', { exact: true }).click()
    await page.getByRole('button', { name: '添加技能', exact: true }).click()
    await choose('分配的技能', longName)
    await mutation('assign', () =>
      page.getByRole('button', { name: '保存分配', exact: true }).click(),
    )
    await dialogClosed()
    assert.equal(
      currentCatalog.assignments.filter((entry) => entry.skillId === readySkill.id).length,
      2,
    )
    return { agentAndProjectScopes: true, explicitUpgrade: true, externalGrantedExplicitly: true }
  })
  // 管理页验收可在无模型运行器的隔离实例执行，问答链路另行验证。
  if (targetedCase === 'management') report.coverage.draftSkillSelection = false
  else await step('draft-dollar-skill-chip-and-instructions', async () => {
    page = desktop.page
    await page.goto(`${origin}/agent-demo.html#/draft/${randomUUID()}`)
    const editor = page.getByTestId('composer-editor')
    await editor.waitFor({ timeout: 60000 })
    await editor.fill(`$autoops-${marker}`)
    await page.getByRole('option').filter({ hasText: readySkill.displayName }).first().click()
    await editor
      .getByRole('button', { name: `技能 ${readySkill.displayName}，查看详情`, exact: true })
      .click()
    const read = page.waitForResponse(
      (response) =>
        response.url().includes('/skill-library/contexts/') &&
        new URL(response.url()).searchParams.get('path') === 'SKILL.md' &&
        new URL(response.url()).searchParams.get('metadata') !== '1',
    )
    void read.catch(() => {})
    await page.getByRole('button', { name: '查看使用说明', exact: true }).click()
    const instructions = await read
    assert.equal(instructions.status(), 200)
    assert((await instructions.text()).includes(marker), '说明必须来自当前授权技能快照')
    await page
      .getByText('只读取当前授权项目。引用真实资料来源，不执行任何任意命令。', { exact: false })
      .first()
      .waitFor()
    await page.screenshot({ path: path.join(output, 'draft-skill-instructions.png') })
    const draftUrl = page.url()
    const pagesBefore = desktop.context.pages().length
    const referenceRead = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === new URL(instructions.url()).pathname &&
        url.searchParams.get('path') === referencePath &&
        url.searchParams.get('metadata') !== '1'
      )
    })
    void referenceRead.catch(() => {})
    await page.getByRole('link', { name: '参考资料', exact: true }).click()
    const referenceResponse = await referenceRead
    assert.equal(referenceResponse.status(), 200)
    assert((await referenceResponse.text()).includes(`${marker} reference-v2`))
    await page.getByText(`${marker} reference-v2`, { exact: false }).first().waitFor()
    assert.equal(page.url(), draftUrl, '草稿技能参考链接应留在当前对话面板')
    assert.equal(desktop.context.pages().length, pagesBefore, '草稿技能参考不能另开错误路径')
    await page.screenshot({ path: path.join(output, 'draft-skill-reference.png') })
    await page.getByRole('link', { name: '返回技能说明', exact: true }).click()
    await page.getByRole('link', { name: '参考资料', exact: true }).waitFor()
    await editor.fill('')
    await management(desktop, readySkill.id)
    return {
      nativeDollarSelection: true,
      chipInstructionsActualRead: true,
      scopedReferenceActualRead: true,
      referenceBackLinkVerified: true,
      noMessageSent: true,
    }
  })
  await step('enable-disable-recheck-and-error-focus', async () => {
    await management(desktop, readySkill.id)
    await mutation('set-enabled', () => menu('停用技能'))
    assert.equal(currentCatalog.skills.find((entry) => entry.id === readySkill.id).enabled, false)
    await mutation('set-enabled', () => menu('启用技能'))
    assert.equal(currentCatalog.skills.find((entry) => entry.id === readySkill.id).enabled, true)
    await mutation('verify', () => menu('重新校验版本'))
    await menu('分配与版本详情')
    await page.keyboard.press('Escape')
    await dialogClosed()
    await until(
      () =>
        page
          .getByRole('button', { name: '技能操作', exact: true })
          .evaluate((element) => element === document.activeElement),
      '菜单弹窗关闭后应恢复操作入口焦点',
    )
    await page.getByRole('button',{name:'返回技能库',exact:true}).click()
    await page.getByRole('button', { name: '导入技能', exact: true }).click()
    await page.locator('[aria-label="技能导入方式"]').getByText('粘贴正文', { exact: true }).click()
    await page
      .getByRole('textbox', { name: 'SKILL.md 正文', exact: true })
      .fill(`invalid markdown ${marker}`)
    await mutation(
      'import-markdown',
      () => page.getByRole('button', { name: '导入并检查', exact: true }).click(),
      false,
    )
    await page.getByRole('dialog').getByRole('alert').waitFor()
    await until(
      () => page.getByRole('button', { name: '导入并检查', exact: true }).isEnabled(),
      '错误后的目录同步应结束并恢复操作',
    )
    await page.keyboard.press('Escape')
    await dialogClosed()
    await until(
      () =>
        page
          .getByRole('button', { name: '导入技能', exact: true })
          .evaluate((element) => element === document.activeElement),
      '失败弹窗关闭后应恢复导入按钮焦点',
    )
    return { toggleAndVerifyReal: true, invalidImportRejected: true, focusRestored: true }
  })
  await step('restricted-package-is-honest', async () => {
    await page.getByRole('button', { name: '导入技能', exact: true }).click()
    await importFile(restrictedZip, `${marker}-restricted.zip`, 'import-archive')
    restrictedSkill = currentCatalog.skills.find((entry) => entry.name === `${marker}-restricted`)
    assert(restrictedSkill)
    assert.equal(restrictedSkill.versions[0].readiness, 'restricted')
    await management(desktop,restrictedSkill.id)
    await page.locator('[aria-label="技能详情"]').getByText(/运行条件未满足：/).waitFor()
    await page.getByRole('button', { name: '技能操作', exact: true }).click()
    assert.equal(
      await page.getByRole('menuitem', { name: '分配技能', exact: true }).isDisabled(),
      true,
    )
    await page.keyboard.press('Escape')
    return {
      importedWithFiles: restrictedSkill.versions[0].fileCount,
      reason: restrictedSkill.versions[0].reason,
      notPretendingReady: true,
    }
  })
  await step('disabled-and-restricted-cards-block-additions-but-allow-revoke',async()=>{
    const preserved=currentCatalog.assignments.filter(entry=>entry.skillId===readySkill.id).map(entry=>structuredClone(entry))
    await ownedMutation({action:'set-enabled',skillId:readySkill.id,enabled:false})
    await management(desktop)
    assert.equal(await agentTarget(readySkill.id,secondaryAgent.id).isDisabled(),true,'全局停用不可新增助手分配')
    assert.equal(await agentTarget(readySkill.id,primaryAgent.id).isDisabled(),false,'全局停用仍允许撤回既有助手分配')
    await mutation('unassign',()=>agentTarget(readySkill.id,primaryAgent.id).click())
    let popup=await projectPopover(readySkill)
    const project=popup.list.locator(targetSelector('project',primaryProject.id))
    assert.equal(await project.isDisabled(),false,'全局停用仍允许撤回既有项目分配')
    await mutation('unassign',()=>project.click())
    assert.equal(await project.isDisabled(),true,'全局停用撤回后不可新增')
    await closeProjectPopover(popup.trigger)
    assert.equal(currentCatalog.skills.find(entry=>entry.id===readySkill.id).enabled,false,'快切不可自动全局启用')
    await ownedMutation({action:'set-enabled',skillId:readySkill.id,enabled:true})
    for(const entry of preserved)await ownedMutation({action:'assign',skillId:entry.skillId,versionId:entry.versionId,targetType:entry.targetType,targetId:entry.targetId,workspaceTypes:entry.workspaceTypes,enabled:entry.enabled})
    // A restricted new version must not prevent revoking an older ready binding.
    const name=`${marker}-restricted-upgrade`
    await ownedMutation({action:'import-markdown',contents:markdown(name,`${marker} 已分配旧版后升级为未就绪`)})
    let skill=currentCatalog.skills.find(entry=>entry.name===name)
    const oldVersion=skill.latestVersionId
    for(const [targetType,targetId] of [['agent',primaryAgent.id],['project',primaryProject.id]])await ownedMutation({action:'assign',skillId:skill.id,versionId:oldVersion,targetType,targetId,workspaceTypes:['internal','external']})
    await ownedMutation({action:'import-archive',skillId:skill.id,fileName:`${name}.zip`,archiveBase64:Buffer.from(zipSync({'SKILL.md':strToU8(markdown(name,`${marker} 已分配旧版后升级为未就绪`,'运行 scripts/check.sh。')),'scripts/check.sh':strToU8('#!/bin/sh\nprintf unavailable\n')})).toString('base64')})
    skill=currentCatalog.skills.find(entry=>entry.id===skill.id)
    assert.equal(skill.versions.find(version=>version.id===skill.latestVersionId).readiness,'restricted')
    await management(desktop)
    assert.equal(await agentTarget(skill.id,secondaryAgent.id).isDisabled(),true)
    assert.equal(await agentTarget(skill.id,primaryAgent.id).isDisabled(),false)
    await mutation('unassign',()=>agentTarget(skill.id,primaryAgent.id).click())
    popup=await projectPopover(skill)
    await mutation('unassign',()=>popup.list.locator(targetSelector('project',primaryProject.id)).click())
    await closeProjectPopover(popup.trigger)
    assert.equal(await agentTarget(restrictedSkill.id,primaryAgent.id).isDisabled(),true)
    await assertQuickView()
    return {globallyDisabledNoAdd:true,globallyDisabledCanRevoke:true,restrictedLatestCanRevokeReadyAssignment:true,neverAutoEnabled:true}
  })
  await step('owned-long-name-card-scroll-fixtures',async()=>{
    for(let index=0;index<12;index++)await ownedMutation({action:'import-markdown',contents:markdown(`${marker}-scroll-${index}`,`${marker} ${index} ${'长标题用于检查卡片控件省略与内部滚动'.repeat(3)}`.slice(0,76))})
    await management(desktop)
    assert((await page.locator('[data-skill-card]').count())>=15)
    return {ownedScrollCards:12,onlyOwnUuidNames:true}
  })
  for (const [name, session, size] of [
    ['desktop', desktop, { width: 1440, height: 900 }],
    ['short', desktop, { width: 1440, height: 560 }],
    ['touch', await openSession(true), { width: 390, height: 844 }],
  ]) {
    await step(`${name}-light-dark-layout-menu-dialog-keyboard`, async () => {
      page = session.page
      await page.setViewportSize(size)
      const checks = []
      for (const mode of ['light', 'dark']) {
        await theme(session, mode)
        await management(session)
        checks.push(await geometry(`${name}-${mode}-list`))
        checks.push({name:`${name}-${mode}-card-hierarchy`,...await visualCardContract()})
        await assignmentHelp()
        await restrictedReason(restrictedSkill,`${name}-${mode}-restricted-reason`)
        const scroll = page.locator('[aria-label="技能列表"] [data-slot="scroll-area-viewport"]').first()
        const scrolling=await scroll.evaluate(element=>{const before=element.scrollTop;element.scrollTop=element.scrollHeight;return {before,after:element.scrollTop,height:element.clientHeight,total:element.scrollHeight}})
        assert(scrolling.total>scrolling.height&&scrolling.after>0,'多卡列表必须有独立可用滚动')
        const lastCard=currentCatalog.skills.find(skill=>skill.name===`${marker}-scroll-11`)
        assert(lastCard)
        await skillCard(lastCard.id).scrollIntoViewIfNeeded()
        const beforeDetails=await scroll.evaluate(element=>element.scrollTop)
        assert(beforeDetails>0,'滚动恢复必须在真实非零位置验证')
        await page.locator(`[data-skill-row="${lastCard.id}"]`).click()
        await page.getByRole('button',{name:'返回技能库',exact:true}).click()
        await until(()=>page.locator(`[data-skill-row="${lastCard.id}"]`).evaluate(element=>element===document.activeElement),'返回后恢复末尾长标题卡片的焦点')
        await until(async()=>Math.abs((await scroll.evaluate(element=>element.scrollTop))-beforeDetails)<=2,'文件详情返回后应恢复原卡片滚动位置')
        await skillCard(readySkill.id).scrollIntoViewIfNeeded()
        const {trigger,list}=await projectPopover(readySkill)
        await page.getByLabel('搜索分配项目',{exact:true}).fill(primaryProject.name)
        await list.locator(targetSelector('project',primaryProject.id)).waitFor()
        checks.push(await geometry(`${name}-${mode}-popover`))
        await closeProjectPopover(trigger)
        // Opening and leaving details must restore the exact card and its focus.
        await page.locator(`[data-skill-row="${readySkill.id}"]`).click()
        await page.getByRole('button',{name:'返回技能库',exact:true}).click()
        await until(()=>page.locator(`[data-skill-row="${readySkill.id}"]`).evaluate(element=>element===document.activeElement),'返回卡片应恢复查看按钮焦点')
        await skillCard(readySkill.id).getByRole('button',{name:`项目分配：${readySkill.displayName}`,exact:true}).focus()
        await page.keyboard.press('Enter')
        await page.locator('[aria-label="项目分配列表"]').waitFor()
        await page.keyboard.press('Tab')
        const focusInPopover=await page.evaluate(()=>{const active=document.activeElement;return Boolean(active?.closest('[data-slot="popover-popup"], [data-slot="popover-content"], [role="dialog"]')||active?.closest('[aria-label="项目分配列表"]'))})
        assert(focusInPopover,'键盘焦点应进入项目浮层')
        await closeProjectPopover(skillCard(readySkill.id).getByRole('button',{name:`项目分配：${readySkill.displayName}`,exact:true}))
        await management(session, readySkill.id)
        checks.push(await geometry(`${name}-${mode}`))
        await page.getByRole('button', { name: '技能操作', exact: true }).click()
        await page.keyboard.press('End')
        await page.keyboard.press('Home')
        await page.keyboard.press('Escape')
        await until(
          () =>
            page
              .getByRole('button', { name: '技能操作', exact: true })
              .evaluate((element) => element === document.activeElement),
          '菜单 Escape 后入口应获得焦点',
        )
        await menu('导入新版本')
        checks.push(await geometry(`${name}-${mode}-dialog`))
        await page.keyboard.press('Escape')
        await dialogClosed()
        if (session.touch) {
          await page.getByRole('button', { name: '返回技能库', exact: true }).click()
          await page.locator(`[data-skill-row="${readySkill.id}"]`).waitFor()
          await until(
            () =>
              page
                .locator(`[data-skill-row="${readySkill.id}"]`)
                .evaluate((element) => element === document.activeElement),
            '窄屏返回列表后应恢复所选技能的焦点',
          )
          checks.push(await geometry(`${name}-${mode}-list`))
          await page.locator(`[data-skill-row="${readySkill.id}"]`).click()
        }
      }
      return {
        layouts: checks,
        menusAndDialogsKeyboardVerified: true,
        touchEmulation: session.touch,
      }
    })
  }
  await step('revoke-and-delete-owned-skills', async () => {
    await management(desktop, readySkill.id)
    await menu('分配与版本详情')
    for (const assignment of currentCatalog.assignments.filter(
      (entry) => entry.skillId === readySkill.id,
    ))
      await mutation('unassign', () =>
        page
          .locator(`[data-skill-assignment="${assignment.id}"]`)
          .getByRole('button', { name: '撤销分配', exact: true })
          .click(),
      )
    await page.keyboard.press('Escape')
    await dialogClosed()
    for (const skill of [readySkill, restrictedSkill]) {
      await management(desktop, skill.id)
      await menu('删除技能')
      await mutation('delete', () =>
        page.getByRole('dialog').getByRole('button', { name: '删除技能', exact: true }).click(),
      )
      await dialogClosed()
    }
    for(const skill of currentCatalog.skills.filter(entry=>ownedSkills.has(entry.id)))await ownedMutation({action:'delete',skillId:skill.id})
    const after = await catalog()
    assert(!after.skills.some((entry) => ownedSkills.has(entry.id)))
    return { uiDeletions: 2, allOwnedRemoved: true }
  })
  }
  assert.deepEqual(report.pageErrors, [])
  assert.deepEqual(report.blockedMutations, [])
} catch (error) {
  report.fatal = error.stack
  process.exitCode = 1
} finally {
  // Recovery is deliberately bounded to exact IDs whose names carry this run's UUID.
  try {
    let current = await catalog()
    for (const assignment of current.assignments.filter((entry) =>
      ownedSkills.has(entry.skillId),
    )) {
      current = await client.http('/autoops/skill-library', 'POST', {
        revision: current.revision,
        action: 'unassign',
        assignmentId: assignment.id,
      })
      captureOwned(current)
    }
    for (const skill of current.skills.filter(
      (entry) => ownedSkills.has(entry.id) && ownedName(entry.name),
    )) {
      current = await client.http('/autoops/skill-library', 'POST', {
        revision: current.revision,
        action: 'delete',
        skillId: skill.id,
      })
      captureOwned(current)
    }
    if (originalCatalog) {
      assert.deepEqual(current.skills, originalCatalog.skills, '既有技能必须保持不变')
      assert.deepEqual(current.assignments, originalCatalog.assignments, '既有分配必须保持不变')
    }
    report.cleanup.ownedSkillsRemoved = !current.skills.some((entry) => ownedSkills.has(entry.id))
    report.cleanup.existingCatalogPreserved = true
  } catch (error) {
    report.cleanup.error = error.stack
    process.exitCode = 1
  }
  client.close()
  for (const session of sessions) {
    await session.context.close().catch(() => {})
    await rm(session.profile, { recursive: true, force: true })
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
