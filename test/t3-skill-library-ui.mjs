import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// Run this concrete browser command outside the macOS execution sandbox. Each
// profile is owned by this test; all business writes are restricted to its UUID.
const origin = (process.env.BASE_URL || 'http://192.168.31.157:18897').replace(/\/$/, '')
if (process.env.T3_SKILL_LIBRARY_MUTATIONS !== '1' || new URL(origin).port === '8787')
  throw new Error('技能管理验收仅允许显式授权的隔离实例，不能在正式 8787 运行。')
const marker = `skill-ui-${randomUUID().slice(0, 8)}`
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
  ownedSkillIds: [],
  coverage: { actualApi: true, actualUploads: true, modelCalls: false, actualTouchDevice: false },
  cleanup: {},
}
const sessions = [],
  ownedSkills = new Set(),
  ownedAssignments = new Set()
const client = new T3LiveClient(origin)
let page, originalCatalog, currentCatalog, readySkill, restrictedSkill
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
    if (skill.name === marker || skill.name === `${marker}-restricted`) ownedSkills.add(skill.id)
  for (const assignment of catalog.assignments)
    if (ownedSkills.has(assignment.skillId)) ownedAssignments.add(assignment.id)
  report.ownedSkillIds = [...ownedSkills]
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
  await page.goto(`${origin}/agent-demo.html#/skills`)
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
  await page.goto(`${origin}/agent-demo.html#/skills`)
  await page.locator('[data-skill-library]').waitFor()
  await closeMobileSidebar(session)
  await page.locator('[aria-label="技能管理范围"]').getByText('中央技能库', { exact: true }).click()
  if (id) {
    await page.locator(`[data-skill-row="${id}"]`).click()
    await page.getByRole('button', { name: '技能操作', exact: true }).waitFor()
  }
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
  if (!name.endsWith('-list') && !name.endsWith('-dialog')) {
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
        '[aria-label="技能列表"] [data-slot="scroll-area-viewport"], [data-slot="dialog-panel"]',
      ),
    ]
      .filter((element) => element.getBoundingClientRect().height > 0)
      .map((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    const controls = [
      ...root.querySelectorAll(
        '[aria-label="技能库工具栏"] button, [aria-label="技能操作"], [data-skill-row]',
      ),
    ]
      .filter((element) => element.getBoundingClientRect().height > 0)
      .map((element) => ({
        label: element.getAttribute('aria-label') || element.textContent?.slice(0, 32),
        rect: rect(element.getBoundingClientRect()),
      }))
    return {
      root: rect(bounds),
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      areas,
      controls,
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
  const desktop = await openSession()
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
    await page.locator(`[data-skill-row="${readySkill.id}"]`).click()
    await menu('分配技能')
    await choose('分配目标助手', currentCatalog.agents[0].name)
    await mutation('assign', () =>
      page.getByRole('button', { name: '保存分配', exact: true }).click(),
    )
    await dialogClosed()
    const assigned = currentCatalog.assignments.find((entry) => entry.skillId === readySkill.id)
    assert.deepEqual(assigned.workspaceTypes, ['internal'])
    return { skillId: readySkill.id, assignmentId: assigned.id, versionId: assigned.versionId }
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
  await step('scope-version-update-and-project-assignment', async () => {
    await page.locator('[aria-label="技能管理范围"]').getByText('助手技能', { exact: true }).click()
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
    await page.locator('[aria-label="技能管理范围"]').getByText('项目技能', { exact: true }).click()
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
  await step('draft-dollar-skill-chip-and-instructions', async () => {
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
    await page.getByText(/运行条件未满足：/).waitFor()
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
          await page.getByRole('button', { name: '返回技能列表', exact: true }).click()
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
    const after = await catalog()
    assert(!after.skills.some((entry) => ownedSkills.has(entry.id)))
    return { revocations: 2, deleted: 2 }
  })
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
      (entry) => ownedSkills.has(entry.id) && [marker, `${marker}-restricted`].includes(entry.name),
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
