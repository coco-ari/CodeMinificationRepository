import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// The caller must authorize this concrete browser command outside the restricted launcher.
const origin = (process.env.BASE_URL || process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').replace(/\/$/, '')
if (new URL(origin).port === '8787' && process.env.T3_PRODUCTION_SMOKE !== '1') throw new Error('正式入口验收需要显式设置 T3_PRODUCTION_SMOKE=1。')
const output = path.resolve(process.env.ARTIFACT_DIR || '.test-artifacts/t3-workspace-mentions/stage')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
await mkdir(output, { recursive: true })
const report = { origin, startedAt: new Date().toISOString(), cases: [], pageErrors: [], messageDispatches: 0, initialMessages: 0, filesystemWrites: 0, workspaceMutations: 0, cleanup: {} }
const sessions = []
let page, admin, guest

async function until(read, message, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(message)
}
async function run(name, action) {
  const entry = { name }
  report.cases.push(entry)
  try { entry.result = await action(); entry.status = 'passed' }
  catch (error) {
    entry.status = 'failed'; entry.error = error.stack
    if (page) {
      await writeFile(path.join(output, `${name}-dom.txt`), await page.locator('body').innerText()).catch(() => {})
      await page.screenshot({ path: path.join(output, `${name}-failed.png`) }).catch(() => {})
    }
    throw error
  } finally {
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ name, status: entry.status, error: entry.error }))
  }
}
async function login(username) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'autoops-workspace-mentions-'))
  const session = { username, profile, ownedThreads: new Set(), draftIds: new Set() }
  sessions.push(session)
  const context = await chromium.launchPersistentContext(profile, { headless: true, locale: 'zh-CN', viewport: { width: 1440, height: 900 }, ...(executablePath ? { executablePath } : {}) })
  session.context = context
  const target = context.pages()[0] || await context.newPage()
  session.page = page = target
  target.setDefaultTimeout(15000)
  target.on('pageerror', (error) => report.pageErrors.push({ username, message: error.message }))
  target.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
    try {
      const decoded = JSON.parse(String(payload))
      for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
        if (message.payload?.type === 'message.dispatch') report.messageDispatches++
        if (message.tag === 'orchestration.launchThread' && message.payload?.initialMessage) report.initialMessages++
        if (/^(?:projects|filesystem)\.(?:writeFile|createDirectory|remove|rename)$/.test(message.tag ?? '')) report.filesystemWrites++
      }
    } catch {}
  }))
  target.on('request', (request) => {
    if (request.method() !== 'POST') return
    const pathname = new URL(request.url()).pathname
    if (/\/workspaces\/(?:external|packages|import|versions\/[^/]+\/publish)$/.test(pathname)) report.workspaceMutations++
    if (pathname.endsWith('/autoops/thread-bindings')) {
      try { const input = request.postDataJSON(); if (session.draftIds.has(input.threadId)) session.ownedThreads.add(input.threadId) } catch {}
    }
  })
  const draftId = randomUUID()
  session.draftIds.add(draftId)
  await target.goto(origin + '/agent-demo.html#/draft/' + draftId)
  await target.getByRole('textbox', { name: '用户名' }).fill(username)
  await target.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
  await target.getByRole('button', { name: '登录', exact: true }).click()
  await target.getByTestId('composer-editor').waitFor({ timeout: 60000 })
  assert(new URL(target.url()).hash.startsWith('#/draft/'), '验收只进入自己的新草稿')
  const bootstrapResponse = await target.request.get(origin + '/api/agent-demo/t3/autoops/bootstrap')
  assert.equal(bootstrapResponse.status(), 200)
  session.bootstrap = await bootstrapResponse.json()
  const projectId = process.env.T3_WORKSPACE_PROJECT_ID || session.bootstrap.projects[0]?.id
  assert(session.bootstrap.projects.some((project) => project.id === projectId), '测试项目必须属于当前账号')
  session.projectId = projectId
  const response = await target.request.get(origin + `${session.bootstrap.gatewayBasePath}/autoops/projects/${encodeURIComponent(projectId)}/workspaces`)
  assert.equal(response.status(), 200)
  session.overview = await response.json()
  return session
}
const choice = () => page.getByRole('button', { name: '对话工作区', exact: true })
const editor = () => page.getByTestId('composer-editor')
const drawer = () => page.locator('[data-composer-command-drawer="true"]')
const candidates = () => drawer().locator('[data-composer-item-id]')
async function scopeDescription(type) {
  return until(async () => {
    const value = await choice().getAttribute('aria-description')
    return value?.startsWith(type === 'internal' ? '内部 · ' : '外部 · ') && await choice().isEnabled() ? value : null
  }, `草稿没有自动选择${type === 'internal' ? '内部' : '外部'}工作区`)
}
async function clearOwnDraft(session) {
  // Clear through Lexical's keyboard flow so token deletion reaches its editor state.
  await editor().click()
  await editor().press('ControlOrMeta+A')
  await editor().press('Backspace')
  await editor().press('Escape')
  await until(async () => (await editor().innerText()).trim() === '' && !(await drawer().isVisible()), '本次验收草稿未清空')
  const hash = new URL(page.url()).hash
  assert(hash.startsWith('#/draft/'), '不能操作已有用户对话')
  session.draftIds.add(decodeURIComponent(hash.slice('#/draft/'.length).split('?')[0]))
}
async function mentionCycle(session, type, name) {
  const description = await scopeDescription(type)
  const versions = (type === 'internal' ? session.overview.internalVersions : session.overview.externalVersions).filter((version) => version.status === 'published' && description.endsWith(version.name))
  assert(versions.length, `原生范围说明未指向现有已发布版本：${description}`)
  await clearOwnDraft(session)
  await editor().fill('@')
  await drawer().waitFor()
  await page.getByRole('listbox', { name: '文件与文件夹', exact: true }).waitFor()
  const rows = await until(async () => {
    const items = await candidates().evaluateAll((elements) => elements.map((element) => ({ id: element.getAttribute('data-composer-item-id'), label: element.querySelector('span.font-medium')?.textContent?.trim() ?? '', text: element.innerText })))
    return items.some((item) => item.id?.endsWith('/backend/.env.example')) ? items : null
  }, '裸 @ 未列出真实 backend/.env.example 文件')
  const file = rows.find((item) => item.id?.endsWith('/backend/.env.example'))
  const canonicalPath = file.id.replace(/^path:(?:file|directory):/, '')
  const version = versions.find((entry) => canonicalPath.startsWith(`autoops/${session.projectId}/workspaces/${entry.id}/`))
  assert(version, '裸 @ 候选的固定版本与原生范围说明不一致')
  const prefix = `autoops/${session.projectId}/workspaces/${version.id}`
  const ancestorPaths = new Set(['autoops', `autoops/${session.projectId}`, `autoops/${session.projectId}/workspaces`, prefix])
  const ancestorLabels = new Set(['autoops', session.projectId, 'workspaces', version.id])
  for (const item of rows) {
    const candidatePath = item.id?.replace(/^path:(?:file|directory):/, '')
    if (!item.id?.startsWith('path:')) continue
    assert(!ancestorPaths.has(candidatePath), `裸 @ 出现平台祖先候选：${candidatePath}`)
    assert(!ancestorLabels.has(item.label), `裸 @ 出现平台祖先标签：${item.label}`)
    if (/^autoops\/[^/]+\/workspaces\/[^/]+\//.test(candidatePath)) assert(candidatePath.startsWith(prefix + '/'), '候选混入其他项目或版本')
  }
  assert(file.text.includes('backend') && !file.text.includes(prefix), '工作区文件应显示真实项目相对目录')
  await page.screenshot({ path: path.join(output, `${name}-bare-at.png`) })
  await editor().fill('@frontend/package')
  await until(async () => {
    const ids = await candidates().evaluateAll((elements) => elements.map((element) => element.getAttribute('data-composer-item-id')))
    return ids.length === 2 && ids.every((id) => id?.startsWith(`path:file:${prefix}/frontend/package`))
  }, '等待原生防抖搜索完成后再选择，不能点击上一个查询的候选')
  const selected = candidates().filter({ hasText: 'package.json' }).filter({ hasText: 'frontend' }).first()
  await selected.waitFor()
  const selectedId = await selected.getAttribute('data-composer-item-id')
  assert.equal(selectedId, `path:file:${prefix}/frontend/package.json`)
  await selected.click()
  const html = await until(async () => { const value = await editor().innerHTML(); return value.includes(version.id) ? value : null }, '选中标签未保存固定版本身份')
  assert(html.includes('/frontend/package.json') || html.includes('%2Ffrontend%2Fpackage.json'), '选中文件引用必须保留 canonical 相对路径')
  assert(!(await drawer().isVisible()), '选中候选后原生列表应关闭')
  await page.screenshot({ path: path.join(output, `${name}-selected-tag.png`) })
  await clearOwnDraft(session)
  return { scopeDescription: description, workspaceType: type, workspaceVersionId: version.id, bareFilePath: canonicalPath, candidateCount: rows.length, noPlatformAncestors: true, selectedCanonicalPath: `${prefix}/frontend/package.json` }
}

try {
  await run('admin-default-internal-mentions', async () => {
    admin = await login('admin')
    return mentionCycle(admin, 'internal', 'admin-internal')
  })
  await run('admin-switch-existing-external-mentions', async () => {
    page = admin.page
    await clearOwnDraft(admin)
    const external = admin.overview.externalVersions.find((version) => version.status === 'published' && version.isExample) || admin.overview.externalVersions.find((version) => version.status === 'published')
    assert(external, '需要事先存在已发布外部版本；本脚本不会生成或发布工作区')
    await choice().click()
    await page.getByRole('menuitemradio', { name: `外部脱敏 · ${external.name}`, exact: true }).first().click()
    const hash = new URL(page.url()).hash
    if (hash.startsWith('#/draft/')) admin.draftIds.add(decodeURIComponent(hash.slice('#/draft/'.length).split('?')[0]))
    const result = await mentionCycle(admin, 'external', 'admin-external')
    assert.equal(result.workspaceVersionId, external.id)
    return result
  })
  await run('guest-default-external-mentions', async () => {
    guest = await login('guest')
    assert.equal(guest.bootstrap.projects.find((project) => project.id === guest.projectId)?.membership?.workspaceAccess, 'external')
    assert.equal(guest.overview.internalVersions.length, 0)
    const result = await mentionCycle(guest, 'external', 'guest-external')
    await choice().click()
    const labels = await page.getByRole('menuitemradio').allTextContents()
    assert(labels.length > 0)
    assert(labels.every((label) => label.trim().startsWith('外部脱敏 · ')), 'guest 工作区菜单不得出现内部版本')
    await page.screenshot({ path: path.join(output, 'guest-external-only-menu.png') })
    await page.keyboard.press('Escape')
    return { ...result, noInternalWorkspaceOptions: true }
  })
  assert.deepEqual(report.pageErrors, [])
  assert.equal(report.messageDispatches, 0)
  assert.equal(report.initialMessages, 0)
  assert.equal(report.filesystemWrites, 0)
  assert.equal(report.workspaceMutations, 0)
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.fatal = error.stack; process.exitCode = 1 }
finally {
  for (const session of sessions) {
    if (session.context && session.bootstrap && session.ownedThreads.size) {
      const client = new T3LiveClient(origin)
      try {
        client.cookie = (await session.context.cookies(origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
        client.bootstrap = session.bootstrap
        await client.connect()
        for (const threadId of session.ownedThreads) {
          const projection = await client.projection(threadId)
          assert.equal(projection.runs.length, 0, '仅清理本次新建且没有消息的空对话')
          await client.rpc('orchestration.dispatchCommand', { type: 'thread.delete', threadId, commandId: randomUUID() })
        }
        report.cleanup[session.username] = { deletedOwnedEmptyThreads: [...session.ownedThreads] }
      } catch (error) { report.cleanup[session.username] = { error: error.message }; process.exitCode = 1 }
      finally { client.close() }
    }
    await session.context?.close().catch((error) => { report.cleanup.browserError = error.message; process.exitCode = 1 })
    await rm(session.profile, { recursive: true, force: true })
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
