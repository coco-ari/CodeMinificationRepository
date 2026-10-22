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
  const session = { username, profile, ownedThreads: new Set(), draftIds: new Set(), searchRequests: [] }
  sessions.push(session)
  const context = await chromium.launchPersistentContext(profile, { headless: true, locale: 'zh-CN', viewport: { width: 1440, height: 900 }, ...(executablePath ? { executablePath } : {}) })
  session.context = context
  const target = context.pages()[0] || await context.newPage()
  session.page = page = target
  target.setDefaultTimeout(15000)
  target.on('pageerror', (error) => report.pageErrors.push({ username, message: error.message }))
  target.on('websocket', (socket) => {
    const pendingSearches = new Map()
    socket.on('framesent', ({ payload }) => {
      try {
        const decoded = JSON.parse(String(payload))
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          if (message.payload?.type === 'message.dispatch') report.messageDispatches++
          if (message.tag === 'orchestration.launchThread' && message.payload?.initialMessage) report.initialMessages++
          if (/^(?:projects|filesystem)\.(?:writeFile|createDirectory|remove|rename)$/.test(message.tag ?? '')) report.filesystemWrites++
          if (message.tag === 'projects.searchEntries') {
            const request = { query: message.payload?.query, cwd: message.payload?.cwd, completed: false, successful: false }
            session.searchRequests.push(request)
            pendingSearches.set(String(message.id), request)
          }
        }
      } catch {}
    })
    socket.on('framereceived', ({ payload }) => {
      try {
        const decoded = JSON.parse(String(payload))
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          const request = pendingSearches.get(String(message.requestId))
          if (message._tag === 'Exit' && request) {
            request.completed = true
            request.successful = message.exit?._tag === 'Success'
            pendingSearches.delete(String(message.requestId))
          }
        }
      } catch {}
    })
  })
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
async function pathCandidates() {
  return candidates().evaluateAll((elements) => elements.flatMap((element) => {
    const id = element.getAttribute('data-composer-item-id') ?? ''
    const match = /^path:(file|directory):(.+)$/.exec(id)
    return match ? [{ id, kind: match[1], path: match[2], selected: element.getAttribute('data-active') === 'true' }] : []
  }))
}
async function waitSearchQuery(session, prefix, query) {
  const versionId = prefix.slice(prefix.lastIndexOf('/') + 1)
  const wireQuery = query.startsWith('./') ? query : './' + query
  // Cached queries may reuse an earlier successful result in this exact immutable scope.
  return until(() => session.searchRequests.findLast((request) => {
    if (request.query !== wireQuery || !request.completed || !request.successful) return false
    try {
      const cwd = new URL(request.cwd)
      return cwd.protocol === 'autoops:' && cwd.hostname === 'projects' &&
        cwd.pathname.startsWith(`/${session.projectId}/environments/`) && cwd.searchParams.get('workspaceVersionId') === versionId
    } catch { return false }
  }), `当前范围没有完成前缀查询 ${wireQuery}`)
}
async function waitPrefixCandidates(session, prefix, query, accepts = () => true) {
  await waitSearchQuery(session, prefix, query)
  await drawer().waitFor()
  await page.getByRole('listbox', { name: '文件与文件夹', exact: true }).waitFor()
  return until(async () => {
    const rows = await pathCandidates()
    const relative = query.startsWith('./') ? query.slice(2) : query
    const slash = relative.lastIndexOf('/')
    const parent = slash < 0 ? prefix : `${prefix}/${relative.slice(0, slash)}`
    const basenamePrefix = relative.slice(slash + 1)
    // A stale parent result, recursive descendant, or thread row cannot satisfy this boundary.
    return rows.length && rows.length === await candidates().count() && rows.every((entry) =>
      entry.path.slice(0, entry.path.lastIndexOf('/')) === parent &&
      entry.path.slice(entry.path.lastIndexOf('/') + 1).startsWith(basenamePrefix)) && accepts(rows) ? rows : null
  }, `查询 @${query} 未显示当前层 basename 前缀候选`)
}
async function waitDirectoryCandidate(session, prefix, directory, query = directory) {
  return waitPrefixCandidates(session, prefix, query, (rows) =>
    rows.length === 1 && rows[0].id === `path:directory:${prefix}/${directory}`)
}
async function waitDirectChildren(session, prefix, directory) {
  return waitPrefixCandidates(session, prefix, directory + '/')
}
async function highlightCandidate(id) {
  const initial = await pathCandidates()
  const count = await candidates().count()
  assert(initial.some((entry) => entry.id === id), `候选不存在：${id}`)
  const activeId = () => candidates().evaluateAll((elements) => elements.find((element) => element.getAttribute('data-active') === 'true')?.getAttribute('data-composer-item-id') ?? null)
  const initiallyActive = await activeId()
  // The first row can be visually active without a user selection. Send an actual arrow
  // before trusting it; the first arrow may keep that visual row while making it explicit.
  await editor().press('ArrowDown')
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  if (count === 1) {
    await until(async () => await activeId() === id, '单项方向键选择没有保留原生候选高亮')
    return
  }
  if (initiallyActive === id && await activeId() === id) {
    await editor().press('ArrowDown')
    await until(async () => await activeId() !== id, '多项候选必须先离开视觉默认项，再用方向键明确选回')
  }
  for (let step = 0; step <= count + 1; step++) {
    const selected = await activeId()
    if (selected === id) return
    await editor().press('ArrowDown')
    await until(async () => await activeId() !== selected, '方向键没有更新原生候选高亮')
  }
  assert.fail(`方向键无法选中候选：${id}`)
}
async function expectRawDirectoryQuery(query, versionId) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await until(async () => (await editor().innerText()).trimEnd() === query, `Tab 应保留原始查询 ${query}`)
  assert(!(await editor().innerHTML()).includes(versionId), '目录 Tab 只能继续查询，不能提前形成固定资料标签')
}
async function expectCanonicalTag(canonicalPath, message) {
  return until(async () => {
    const html = await editor().innerHTML()
    let decoded = html
    try { decoded = decodeURIComponent(html) } catch {}
    return decoded.includes(canonicalPath) && !(await drawer().isVisible()) ? html : null
  }, message)
}
async function tabNavigationCycle(session, type, name, version) {
  const prefix = `autoops/${session.projectId}/workspaces/${version.id}`
  const completions = [], childCounts = []
  const docsQueries = []
  await clearOwnDraft(session)
  await page.mouse.move(0, 0)
  await editor().fill('@d')
  for (const query of ['d', 'do', 'doc', 'docs']) {
    if (query !== 'd') await editor().press(query.at(-1))
    await expectRawDirectoryQuery('@' + query, version.id)
    const rows = await waitDirectoryCandidate(session, prefix, 'docs', query)
    assert.equal(rows[0].id, `path:directory:${prefix}/docs`)
    assert.equal(rows.length, 1, '逐字前缀只允许 docs 本层目录，不得混入 backend、md 或对话')
    docsQueries.push({ query: '@' + query, wireQuery: './' + query, paths: rows.map((entry) => entry.path), activeIds: rows.filter((entry) => entry.selected).map((entry) => entry.id) })
    if (query === 'd') await page.screenshot({ path: path.join(output, `${name}-d-first-docs.png`) })
  }
  // No arrow key, candidate click or pointer hover has explicitly selected this unique row.
  await editor().press('Tab')
  await expectRawDirectoryQuery('@docs/', version.id)
  const docsChildren = await waitDirectChildren(session, prefix, 'docs')
  await page.screenshot({ path: path.join(output, `${name}-docs-tab-direct-children.png`) })
  completions.push('docs/'); childCounts.push(docsChildren.length)

  await clearOwnDraft(session)
  await editor().fill('@front')
  await waitDirectoryCandidate(session, prefix, 'frontend', 'front')
  await editor().press('ArrowDown')
  await editor().press('ArrowUp')
  await highlightCandidate(`path:directory:${prefix}/frontend`)
  assert(await drawer().isVisible())
  await editor().press('Tab')
  await expectRawDirectoryQuery('@frontend/', version.id)
  let children = await waitDirectChildren(session, prefix, 'frontend')
  assert(children.some((entry) => entry.path === `${prefix}/frontend/package.json`), '目录候选必须来自实际前端构建目录')
  completions.push('frontend/'); childCounts.push(children.length)
  await page.screenshot({ path: path.join(output, `${name}-tab-frontend-children.png`) })

  if (type === 'internal') {
    const gitId = `path:directory:${prefix}/frontend/.git`
    assert(children.some((entry) => entry.id === gitId), '内部原始示例应保留可导航的真实 .git 目录')
    await highlightCandidate(gitId)
    await editor().press('Tab')
    await expectRawDirectoryQuery('@frontend/.git/', version.id)
    children = await waitDirectChildren(session, prefix, 'frontend/.git')
    completions.push('frontend/.git/'); childCounts.push(children.length)
    const next = ['hooks', 'objects'].map((directory) => children.find((entry) => entry.kind === 'directory' && entry.path === `${prefix}/frontend/.git/${directory}`)).find(Boolean)
      ?? children.find((entry) => entry.kind === 'directory')
    assert(next, '使用原生候选里真实存在的 Git 子目录继续验证多级补全')
    const relative = next.path.slice(prefix.length + 1)
    await editor().press('ArrowDown')
    await editor().press('ArrowUp')
    await highlightCandidate(next.id)
    await editor().press('Tab')
    await expectRawDirectoryQuery(`@${relative}/`, version.id)
    const nested = await waitDirectChildren(session, prefix, relative)
    completions.push(relative + '/'); childCounts.push(nested.length)
    await page.screenshot({ path: path.join(output, `${name}-tab-nested-git-children.png`) })
  }

  await clearOwnDraft(session)
  await page.mouse.move(0, 0)
  await editor().fill('@frontend/pack')
  const packagePaths = [`${prefix}/frontend/package-lock.json`, `${prefix}/frontend/package.json`]
  const isPackagePair = (rows) => rows.length === 2 && rows.every((entry) => entry.kind === 'file') &&
    JSON.stringify(rows.map((entry) => entry.path).sort()) === JSON.stringify(packagePaths)
  await waitPrefixCandidates(session, prefix, 'frontend/pack', isPackagePair)
  await editor().press('Tab')
  await expectRawDirectoryQuery('@frontend/package', version.id)
  const ambiguousRows = await waitPrefixCandidates(session, prefix, 'frontend/package', isPackagePair)
  await page.screenshot({ path: path.join(output, `${name}-tab-common-package-prefix.png`) })
  await editor().press('Tab')
  await expectRawDirectoryQuery('@frontend/package', version.id)
  await waitPrefixCandidates(session, prefix, 'frontend/package', isPackagePair)
  assert(await drawer().isVisible(), '共有前缀不能再延长时 Tab 必须保留候选，不能默认引用第一项')
  await page.screenshot({ path: path.join(output, `${name}-tab-ambiguous-package-preserved.png`) })
  // Actual arrow input makes the later selection explicit even if its row was visually active.
  await editor().press('ArrowDown')
  await editor().press('ArrowUp')
  await highlightCandidate(`path:file:${prefix}/frontend/package.json`)
  await editor().press('Tab')
  await expectCanonicalTag(`${prefix}/frontend/package.json`, '文件 Tab 没有转成 canonical 标签')
  await page.screenshot({ path: path.join(output, `${name}-tab-file-tag.png`) })

  await clearOwnDraft(session)
  await editor().fill('@doc')
  await waitDirectoryCandidate(session, prefix, 'docs', 'doc')
  await highlightCandidate(`path:directory:${prefix}/docs`)
  assert(await drawer().isVisible(), '按 Enter 前目录菜单必须真实打开，避免触发发送')
  await editor().press('Enter')
  await expectCanonicalTag(`${prefix}/docs`, 'Enter 应保留原生目录引用能力')
  await page.screenshot({ path: path.join(output, `${name}-enter-directory-tag.png`) })

  await clearOwnDraft(session)
  await editor().fill('@front')
  await waitDirectoryCandidate(session, prefix, 'frontend', 'front')
  await editor().press('Escape')
  await until(async () => !(await drawer().isVisible()), 'Escape 没有关闭目录候选')
  assert.equal((await editor().innerText()).trimEnd(), '@front')
  await clearOwnDraft(session)
  await editor().fill('@front')
  await waitDirectoryCandidate(session, prefix, 'frontend', 'front')
  await highlightCandidate(`path:directory:${prefix}/frontend`)
  await editor().press('Shift+Tab')
  assert.equal((await editor().innerText()).trimEnd(), '@front', 'Shift+Tab 不得被目录补全占用')
  assert(!(await editor().innerHTML()).includes(version.id), 'Shift+Tab 不得插入引用标签')
  await page.screenshot({ path: path.join(output, `${name}-shift-tab-preserves-query.png`) })
  await clearOwnDraft(session)
  assert.equal(report.messageDispatches, 0)
  assert.equal(report.initialMessages, 0)
  return {
    completions, directChildCounts: childCounts, arrowNavigation: true,
    docsPrefixReproduction: { queries: docsQueries, noExplicitSelection: true, uniqueTabQuery: '@docs/', directChildren: docsChildren.map((entry) => entry.path), noRecursiveOrThreadRows: true },
    ambiguousFileTab: { initialQuery: '@frontend/pack', commonQuery: '@frontend/package', paths: ambiguousRows.map((entry) => entry.path), repeatedTabPreservesQuery: true, implicitFirstItemNotInserted: true, explicitArrowSelectionCreatesCanonicalTag: true },
    directoryTabRemainsRawQuery: true, fileTabCanonicalTag: true, directoryEnterCanonicalTag: true, escapeClosesMenu: true, shiftTabDoesNotComplete: true,
  }
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
    const roots = versions.map((version) => `autoops/${session.projectId}/workspaces/${version.id}`)
    const expectedNames = ['WORKSPACE.md', 'backend', 'docs', 'frontend', 'prototypes']
    return items.length === expectedNames.length && items.every((item) => {
      const match = /^path:(?:file|directory):(.+)$/.exec(item.id ?? '')
      const itemPath = match?.[1] ?? ''
      return roots.includes(itemPath.slice(0, itemPath.lastIndexOf('/'))) && expectedNames.includes(itemPath.slice(itemPath.lastIndexOf('/') + 1))
    }) && new Set(items.map((item) => item.id?.slice(item.id.lastIndexOf('/') + 1))).size === expectedNames.length ? items : null
  }, '裸 @ 必须只显示真实根层 backend/docs/frontend/prototypes/WORKSPACE.md，不得有后代或对话')
  const directory = rows.find((item) => item.id?.startsWith('path:directory:') && item.id.endsWith('/frontend'))
  assert(directory, '根层候选缺少 frontend 目录')
  const canonicalPath = directory.id.replace(/^path:(?:file|directory):/, '')
  const version = versions.find((entry) => canonicalPath.startsWith(`autoops/${session.projectId}/workspaces/${entry.id}/`))
  assert(version, '裸 @ 候选的固定版本与原生范围说明不一致')
  const prefix = `autoops/${session.projectId}/workspaces/${version.id}`
  await waitPrefixCandidates(session, prefix, '', (items) => items.length === rows.length)
  const ancestorPaths = new Set(['autoops', `autoops/${session.projectId}`, `autoops/${session.projectId}/workspaces`, prefix])
  const ancestorLabels = new Set(['autoops', session.projectId, 'workspaces', version.id])
  for (const item of rows) {
    const candidatePath = item.id?.replace(/^path:(?:file|directory):/, '')
    assert(item.id?.startsWith('path:'), '固定工作区裸 @ 不得混入对话候选')
    assert(!ancestorPaths.has(candidatePath), `裸 @ 出现平台祖先候选：${candidatePath}`)
    assert(!ancestorLabels.has(item.label), `裸 @ 出现平台祖先标签：${item.label}`)
    if (/^autoops\/[^/]+\/workspaces\/[^/]+\//.test(candidatePath)) assert(candidatePath.startsWith(prefix + '/'), '候选混入其他项目或版本')
  }
  assert(directory.text.includes('frontend') && !directory.text.includes(prefix), '工作区目录应显示真实项目相对路径')
  await page.screenshot({ path: path.join(output, `${name}-bare-at.png`) })
  await editor().fill('@frontend/package')
  await waitPrefixCandidates(session, prefix, 'frontend/package', (items) => items.length === 2 && items.every((item) => item.kind === 'file'))
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
  const tabNavigation = await tabNavigationCycle(session, type, name, version)
  return {
    scopeDescription: description, workspaceType: type, workspaceVersionId: version.id,
    bareRootPaths: rows.map((item) => item.id.replace(/^path:(?:file|directory):/, '')),
    candidateCount: rows.length, bareAtRootLayerOnly: true, noDescendantCandidates: true, noThreadCandidates: true,
    noPlatformAncestors: true, selectedCanonicalPath: `${prefix}/frontend/package.json`, tabNavigation,
  }
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
