import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { chromium } from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

const origin = (process.env.BASE_URL || process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').replace(/\/$/, '')
if (new URL(origin).port === '8787' && process.env.T3_PRODUCTION_SMOKE !== '1') throw new Error('正式入口验收需要显式设置 T3_PRODUCTION_SMOKE=1。')
const output = path.resolve(process.env.ARTIFACT_DIR || '.test-artifacts/t3-workspaces/stage')
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.BROWSER_EXECUTABLE_PATH
await mkdir(output, { recursive: true })
const profile = await mkdtemp(path.join(os.tmpdir(), 'autoops-workspaces-ui-'))
const report = { origin, startedAt: new Date().toISOString(), cases: [], pageErrors: [], messageDispatches: 0, ownedThreads: [], downloads: [], cleanup: {} }
const ownedThreads = new Set()
let context, page, bootstrap, workspaceRoot, projectId, internal, external, release

async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((done) => setTimeout(done, 150))
  }
  throw new Error(message)
}

async function api(suffix = '') {
  const response = await page.request.get(origin + workspaceRoot + suffix, { headers: { origin, 'x-t3-orchestration-protocol': '2' } })
  const result = await response.json()
  assert.equal(response.status(), 200, `工作区 API ${suffix}: ${JSON.stringify(result)}`)
  return result
}

async function job(task) {
  return until(async () => {
    const state = await api()
    const current = state.tasks.find((entry) => entry.id === task.id)
    assert(current, '实际任务必须能通过刷新重新读取')
    if (current.status === 'failed' || current.status === 'interrupted') throw new Error(current.error || current.message)
    return current.status === 'completed' ? { task: current, state } : null
  }, `任务 ${task.id} 未完成`, 120000)
}

async function choose(label, text) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option').filter({ hasText: text }).first().click()
}

function tab(name) {
  return page.locator('[data-slot="toggle-group"][aria-label="工作区分类"]').getByText(name, { exact: true })
}

async function selectTab(name) {
  await tab(name).click()
  await until(() => tab(name).evaluate((element) => element.getAttribute('data-state') === 'on' || element.getAttribute('aria-checked') === 'true' || element.hasAttribute('data-pressed')), `未切换到${name}`)
}

async function workspaces() {
  await page.goto(origin + '/agent-demo.html#/workspaces')
  await page.getByRole('combobox', { name: '工作区项目', exact: true }).waitFor({ timeout: 60000 })
  if (projectId !== bootstrap.projects[0].id) await choose('工作区项目', bootstrap.projects.find((entry) => entry.id === projectId).name)
  await page.getByRole('combobox', { name: '内部版本', exact: true }).waitFor({ timeout: 30000 })
}

async function noOverflow() {
  const bounds = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
  assert(bounds.content <= bounds.viewport + 1, `页面发生横向溢出：${JSON.stringify(bounds)}`)
  return bounds
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(output, `${name}.png`) })
}

async function run(name, action) {
  if (process.env.T3_WORKSPACE_UI_CASE && name !== 'login-isolated-draft' && name !== process.env.T3_WORKSPACE_UI_CASE) return
  const entry = { name }
  report.cases.push(entry)
  try { entry.result = await action(); entry.status = 'passed' }
  catch (error) {
    entry.status = 'failed'; entry.error = error.stack
    await screenshot(`${name}-failed`).catch(() => {})
    throw error
  } finally {
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ name, status: entry.status, error: entry.error }))
  }
}

async function download(link, name) {
  const waiting = page.waitForEvent('download', { timeout: 30000 })
  await link.click()
  const item = await waiting
  assert.equal(await item.failure(), null, `下载失败：${name}`)
  const destination = path.join(output, name)
  await item.saveAs(destination)
  const bytes = await readFile(destination)
  const result = { name, suggestedFilename: item.suggestedFilename(), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  report.downloads.push(result)
  return { bytes, ...result }
}

try {
  context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1440, height: 900 }, locale: 'zh-CN', acceptDownloads: true, ...(executablePath ? { executablePath } : {}) })
  page = context.pages()[0] || await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => report.pageErrors.push(error.message))
  page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
    if (String(payload).includes('"message.dispatch"')) report.messageDispatches++
  }))
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith('/autoops/thread-bindings')) return
    try { const body = request.postDataJSON(); if (typeof body.threadId === 'string') ownedThreads.add(body.threadId) } catch {}
  })

  await run('login-isolated-draft', async () => {
    const draftId = randomUUID()
    await page.goto(origin + '/agent-demo.html#/draft/' + draftId)
    await page.getByRole('textbox', { name: '用户名' }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill(process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByTestId('composer-editor').waitFor({ timeout: 60000 })
    assert(new URL(page.url()).hash.startsWith('#/draft/'), '登录后只进入本次新建草稿')
    const response = await page.request.get(origin + '/api/agent-demo/t3/autoops/bootstrap')
    assert.equal(response.status(), 200)
    bootstrap = await response.json()
    projectId = process.env.T3_WORKSPACE_PROJECT_ID || bootstrap.projects[0]?.id
    assert(bootstrap.projects.some((entry) => entry.id === projectId), '测试项目必须属于当前用户')
    workspaceRoot = `${bootstrap.gatewayBasePath}/autoops/projects/${encodeURIComponent(projectId)}/workspaces`
    report.projectId = projectId
    return { draftId, isolatedProfile: true, noMessageSent: true }
  })

  await run('internal-tree-and-preview', async () => {
    await workspaces()
    const overview = await api()
    internal = overview.internalVersions.find((version) => version.isExample && version.status === 'published')
    assert(internal, '只使用平台明确标识的示例版本，不使用用户导入的资料')
    await choose('内部版本', internal.name)
    await page.locator('button[title="WORKSPACE.md"]').click()
    await until(async () => (await page.locator('pre code').innerText()).includes('最小示例'), '内部资料预览未读取真实文件')
    await page.locator('button[title="frontend"]').click()
    await page.locator('button[title="frontend/package.json"]').click()
    await until(async () => (await page.locator('pre code').innerText()).includes('autoops-workspace-example-frontend'), '前端源码预览未完成')
    const git = await api(`/versions/${internal.id}/tree?directory=frontend`)
    assert(git.entries.some((entry) => entry.name === '.git'), '内部工作区保留真实 Git 目录')
    assert(internal.source.repositories.every((repository) => /^[a-f0-9]{40,64}$/.test(repository.commit)), '来源包含真实固定提交')
    await screenshot('internal-desktop-light')
    return { sourceVersionId: internal.id, repositories: internal.source.repositories, bounds: await noOverflow(), sourcePreview: true }
  })

  await run('external-generate-review-and-publish', async () => {
    await selectTab('外部工作区')
    await choose('来源内部版本', internal.name)
    await page.getByRole('button', { name: '添加替换', exact: true }).click()
    await page.getByRole('textbox', { name: '规则 1 原始文本', exact: true }).fill('INTERNAL-DEMO')
    const replacement = `EXTERNAL-SMOKE-${randomUUID().slice(0, 8)}`
    await page.getByRole('textbox', { name: '规则 1 替换文本', exact: true }).fill(replacement)
    const waiting = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === workspaceRoot + '/external')
    await page.getByRole('button', { name: '生成外部版本', exact: true }).click()
    const response = await waiting
    assert.equal(response.status(), 202)
    const completed = await job(await response.json())
    external = completed.state.externalVersions.find((version) => version.id === completed.task.versionId)
    assert(external?.status === 'pending_review' && external.sourceVersionId === internal.id)
    assert(external.report.removedGitEntries > 0 && external.report.replacements > 0)
    assert(external.report.pendingFiles.some((file) => file.path.endsWith('.png')), '示例图片必须要求人工复核')
    await until(async () => (await page.getByRole('combobox', { name: '外部版本', exact: true }).innerText()).includes(external.name), '页面未跟进新生成的外部版本')
    assert(await page.getByRole('button', { name: '确认并发布版本', exact: true }).isDisabled(), '未逐项复核时不能发布')
    for (const [index, file] of external.report.pendingFiles.entries()) {
      const checked = await download(page.getByRole('link', { name: '下载检查', exact: true }).nth(index), `review-${index}-${path.basename(file.path)}`)
      if (file.path.endsWith('.png')) assert.equal(checked.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      await choose(`复核 ${file.path}`, '排除文件')
    }
    await screenshot('external-pending-review')
    const published = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === `${workspaceRoot}/versions/${external.id}/publish`)
    await page.getByRole('button', { name: '确认并发布版本', exact: true }).click()
    const publishedResponse = await published
    assert.equal(publishedResponse.status(), 200)
    external = await publishedResponse.json()
    assert.equal(external.status, 'published')
    assert.equal(external.report.pendingFiles.length, 0)
    await until(() => page.getByText('此版本已通过检查并固定保存，可用于全新的外部工作区对话。', { exact: true }).isVisible(), '发布状态未反映到页面')
    await page.locator('button[title="docs"]').click()
    await page.locator('button[title="docs/需求说明.md"]').click()
    const text = await until(async () => {
      const value = await page.locator('pre code').innerText()
      return value.includes(replacement) ? value : null
    }, '外部预览未应用项目脱敏规则')
    assert(!text.includes('INTERNAL-DEMO'))
    const tree = await api(`/versions/${external.id}/tree?directory=frontend`)
    assert(!tree.entries.some((entry) => entry.name === '.git'), '外部目录不能保留 Git 元数据')
    await screenshot('external-published-desktop')
    return { taskId: completed.task.id, versionId: external.id, excludedFiles: external.report.excludedFiles, redactionCount: external.report.replacements, realImageDownloaded: true, bounds: await noOverflow() }
  })

  await run('external-new-conversation-scope', async () => {
    const previousUrl = page.url()
    await page.locator('button[data-ui="button"]').filter({ hasText: '新建对话' }).click()
    await page.getByTestId('composer-editor').waitFor({ timeout: 60000 })
    const hash = new URL(page.url()).hash
    assert(hash.startsWith('#/draft/') && page.url() !== previousUrl)
    const draftId = decodeURIComponent(hash.slice('#/draft/'.length).split('?')[0])
    await until(async () => (await page.getByRole('combobox', { name: '对话工作区', exact: true }).innerText()).includes(external.name), '新草稿没有绑定所选外部版本')
    const scope = await page.evaluate(({ projectId, versionId }) => {
      const values = Object.keys(localStorage).filter((name) => name.startsWith('autoops:t3:') && name.includes(':thread-scope:'))
      for (const key of values) {
        const value = JSON.parse(localStorage.getItem(key))
        if (value.projectId === projectId && value.workspaceVersionId === versionId) return value
      }
      return null
    }, { projectId, versionId: external.id })
    assert.equal(scope?.projectId, projectId)
    assert.equal(scope?.workspaceType, 'external')
    assert.equal(scope?.workspaceVersionId, external.id)
    assert.equal((await page.getByTestId('composer-editor').innerText()).trim(), '', '全新外部对话不能带入原始上下文')
    await screenshot('external-empty-draft')
    return { draftId, workspaceType: scope.workspaceType, workspaceVersionId: scope.workspaceVersionId, emptyComposer: true, noMessageSent: true }
  })

  await run('packages-download-and-manifest', async () => {
    await workspaces()
    await selectTab('部署发布')
    await choose('打包内部版本', internal.name)
    for (const name of ['前端源码包', '后端源码包']) {
      const checkbox = page.getByRole('checkbox', { name, exact: true })
      if (!await checkbox.isChecked()) await checkbox.check()
    }
    const waiting = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === workspaceRoot + '/packages')
    await page.getByRole('button', { name: '生成部署包', exact: true }).click()
    const response = await waiting
    assert.equal(response.status(), 202)
    const completed = await job(await response.json())
    release = completed.state.releases.find((entry) => entry.id === completed.task.releaseId)
    assert.equal(release?.sourceVersionId, internal.id, '部署包必须直接来自内部固定版本')
    const region = page.getByRole('region', { name: release.name, exact: true })
    await region.waitFor()
    for (const service of release.services) {
      const archive = await download(region.getByRole('link', { name: service.service === 'frontend' ? '下载前端 ZIP' : '下载后端 ZIP', exact: true }), `${service.service}.zip`)
      assert.equal(archive.sha256, service.sha256)
      assert.equal(archive.size, service.size)
      const files = unzipSync(archive.bytes)
      assert(Object.keys(files).every((name) => !name.split('/').includes('.git')), '部署包不得包含 Git 元数据')
      assert(files['package.json'], '独立仓库部署包包含实际构建入口')
      assert(JSON.parse(Buffer.from(files['package.json']).toString()).scripts.build)
    }
    assert.deepEqual(release.services.map((service) => service.service).sort(), ['backend', 'frontend'])
    const manifest = await download(region.getByRole('link', { name: '下载 manifest.json', exact: true }), 'manifest.json')
    const value = JSON.parse(manifest.bytes.toString())
    assert.equal(value.sourceVersionId, internal.id)
    assert.equal(value.status, 'packaged', '下载部署包不能冒充已部署成功')
    for (const service of value.services) assert.equal(service.sha256, release.services.find((entry) => entry.service === service.service).sha256)
    await screenshot('packages-desktop-light')
    return { taskId: completed.task.id, releaseId: release.id, sourceVersionId: internal.id, zipHashesVerified: true, manifestVerified: true, bounds: await noOverflow() }
  })

  await run('dark-narrow-and-keyboard', async () => {
    await page.goto(origin + '/agent-demo.html#/settings/appearance')
    await page.getByRole('button', { name: '使用深色模式', exact: true }).click()
    await workspaces()
    await page.setViewportSize({ width: 390, height: 844 })
    const bounds = []
    for (const [name, label] of [['internal', '内部工作区'], ['external', '外部工作区'], ['packages', '部署发布']]) {
      await selectTab(label)
      bounds.push({ tab: name, ...await noOverflow() })
      await screenshot(`${name}-dark-390`)
    }
    await selectTab('内部工作区')
    await tab('内部工作区').focus()
    await page.keyboard.press('ArrowRight')
    await until(() => tab('外部工作区').evaluate((element) => document.activeElement === element), '原生分段选择器方向键未移动焦点')
    await page.keyboard.press('Space')
    await page.getByRole('button', { name: '生成外部版本', exact: true }).waitFor()
    await page.goto(origin + '/agent-demo.html#/settings/appearance')
    await page.getByRole('button', { name: '使用浅色模式', exact: true }).click()
    await workspaces()
    bounds.push({ tab: 'internal-light', ...await noOverflow() })
    await screenshot('internal-light-390')
    return { bounds, nativeKeyboardSelection: true, themePreferenceIsolated: true }
  })
  assert.deepEqual(report.pageErrors, [], '浏览器不能有未处理错误')
  assert.equal(report.messageDispatches, 0, '本次 UI 验收不能调用真实模型发送消息')
} catch (error) {
  report.fatal = error.stack
  process.exitCode = 1
} finally {
  report.ownedThreads = [...ownedThreads]
  if (context && bootstrap && ownedThreads.size) {
    const client = new T3LiveClient(origin)
    try {
      client.cookie = (await context.cookies(origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
      client.bootstrap = bootstrap
      await client.connect()
      for (const threadId of ownedThreads) {
        const projection = await client.projection(threadId)
        const terminal = (run) => ['completed', 'failed', 'interrupted', 'cancelled', 'canceled', 'rolled_back'].includes(run.status)
        if (projection.runs.some((run) => !terminal(run))) {
          await client.rpc('orchestration.dispatchCommand', { type: 'thread.stop', threadId, commandId: randomUUID() })
          await until(async () => (await client.projection(threadId)).runs.every(terminal), `本次测试对话 ${threadId} 未停止`, 45000)
        }
        await client.rpc('orchestration.dispatchCommand', { type: 'thread.delete', threadId, commandId: randomUUID() })
      }
      report.cleanup.deletedOwnedThreads = [...ownedThreads]
    } catch (error) { report.cleanup.error = error.message; process.exitCode = 1 }
    finally { client.close() }
  }
  await context?.close().catch((error) => { report.cleanup.browserError = error.message })
  await rm(profile, { recursive: true, force: true })
  report.cleanup.isolatedProfileRemoved = true
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
}
