import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { startBrowser } from './helpers/prototype-browser.mjs'

const browser = await startBrowser('materials')
const b = browser
const suffix = Date.now().toString(36)
const names = {
  folder: `验收资料-${suffix}`,
  nested: '第二层目录',
  document: `移动后-${suffix}.md`,
  upload: `上传-${suffix}.txt`,
  imported: `Git手册-${suffix}`,
  repository: `验收仓库-${suffix}`,
  stripped: `独立去Git-${suffix}`,
  sanitized: `独立脱敏-${suffix}`,
  zip: `验收下载-${suffix}.zip`,
  failed: `失败输出-${suffix}`,
  stopped: `中止输出-${suffix}`,
}

function verifyZip(buffer) {
  let offset = 0
  const files = []
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    const checksum = buffer.readUInt32LE(offset + 14)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const size = buffer.readUInt32LE(offset + 22)
    const nameSize = buffer.readUInt16LE(offset + 26)
    const extraSize = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString('utf8')
    const start = offset + 30 + nameSize + extraSize
    const content = buffer.subarray(start, start + compressedSize)
    assert.equal(method, 0)
    assert.equal(flags & 0x0800, 0x0800)
    assert.equal(content.length, size)
    assert.equal(crc32(content), checksum, `${name} CRC 不一致`)
    assert(!name.split('/').includes('..'))
    files.push({ name, content: content.toString('utf8') })
    offset = start + compressedSize
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50)
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50)
  assert.equal(buffer.readUInt16LE(buffer.length - 12), files.length)
  return files
}

const documentByName = async (name) =>
  (await b.storage()).projects.sol.documents.find((item) => item.name === name)
const artifactByName = async (name) =>
  (await b.storage()).projects.sol.artifacts.find((item) => item.name === name)
async function dialogText(text) {
  await b.clickText(text, '[role="dialog"] button')
  if (!['下载', '下载产物'].includes(text)) {
    await b.until(() => b.evaluate(`!document.querySelector('[role="dialog"]')`), '对话框关闭')
    await b.wait(220)
  }
}
const rowExpression = (name) =>
  `Array.from(document.querySelectorAll('tr')).find(row=>Array.from(row.querySelectorAll('button')).some(button=>button.textContent.trim()===${JSON.stringify(name)}))`
const docClick = (name) =>
  b.mouse(
    `Array.from(document.querySelectorAll('.mat-doc-item strong')).find(el=>el.textContent===${JSON.stringify(name)})?.closest('button')`,
    name,
  )
async function menu(label, text, role = 'menuitem') {
  await b.mouse(
    `Array.from(document.querySelectorAll('button[aria-label]')).find(el=>el.getAttribute('aria-label')===${JSON.stringify(label)}&&el.getClientRects().length)`,
    label,
  )
  await b.clickText(text, `[role="${role}"]`)
  await b.wait(180)
}
const rowButton = (name, button) =>
  button === '删除'
    ? menu(`${name} 操作菜单`, '删除产物')
    : b.mouse(
        `Array.from((${rowExpression(name)})?.querySelectorAll('button')||[]).find(el=>el.textContent.trim()===${JSON.stringify(button)})`,
        `${name} / ${button}`,
      )
const docMenu = (name, text) => menu(`${name} 更多操作`, text)
async function simulation(label, outcome) {
  if (outcome !== 'success') await menu(label, '模拟失败', 'menuitemradio')
}
async function reloadSelected(selector, text) {
  await b.command('Page.reload')
  await b.until(
    () =>
      b.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)})`,
      ),
    '刷新后恢复选中详情',
  )
  await b.wait(220)
}

async function createDocument(kind, name, content = '') {
  if (kind === 'folder') await menu('资料更多操作', '新建文件夹')
  else await b.clickText('新建文档')
  await b.fill('[aria-label="资料名称"]', name)
  if (kind === 'file') await b.fill('[aria-label="文档内容"]', content)
  await dialogText('保存')
  return b.until(() => documentByName(name), `创建 ${name}`)
}

async function processArtifact(sourceId, operation, name, outcome = 'success') {
  await b.clickText('生成产物')
  await b.select('[aria-label="输入源码产物"]', sourceId)
  await b.select('[aria-label="源码处理方式"]', operation)
  await b.fill('[aria-label="输出产物名称"]', name)
  await simulation('源码处理演示场景', outcome)
  await dialogText('生成独立产物')
  return b.until(() => artifactByName(name), `创建产物 ${name}`)
}

try {
  await b.reset()
  await b.route('/p/sol/documents')
  const top = await createDocument('folder', names.folder)
  await docClick(names.folder)
  const nested = await createDocument('folder', names.nested)
  assert.equal(nested.parentId, top.id)
  await docClick(names.nested)
  const original = await createDocument('file', '初始文档.md', '# 验收文档\n\n初始内容。')
  assert.equal(original.parentId, nested.id)
  await b.clickText('编辑文档')
  await b.fill(
    '[aria-label="文档内容"]',
    '# 已更新\n\n这是唯一最新正文，文件名搜索不匹配此内容标记：正文专用检索标记。',
  )
  await dialogText('保存')
  await docMenu('初始文档.md', '移动或重命名')
  await b.fill('[aria-label="资料名称"]', names.document)
  await b.select('[aria-label="所在文件夹"]', 'root')
  await dialogText('保存')
  const moved = await b.until(() => documentByName(names.document), '移动后的文档')
  assert.equal(moved.id, original.id)
  assert.equal(moved.parentId, null)
  assert.match(moved.content, /唯一最新正文/)
  assert(!moved.versions)
  await b.clickText('全部资料')
  await b.fill('[aria-label="按文件名搜索资料"]', '正文专用检索标记')
  assert(await b.evaluate(`document.body.innerText.includes('没有匹配此文件名的资料')`))
  await b.fill('[aria-label="按文件名搜索资料"]', names.document)
  await docClick(names.document)
  assert(
    await b.evaluate(
      `document.querySelector('.mat-doc-reader').innerText.includes('唯一最新正文')`,
    ),
  )
  await reloadSelected('.mat-doc-reader', names.document)
  assert.equal(
    await b.evaluate('new URLSearchParams(location.hash.split("?")[1]).get("document")'),
    moved.id,
  )
  await b.fill('[aria-label="按文件名搜索资料"]', '')
  b.check('多层目录、新建编辑、移动重命名、最新内容与仅文件名搜索')

  const fixtures = path.join(b.output, 'fixtures')
  await mkdir(fixtures, { recursive: true })
  const uploadPath = path.join(fixtures, names.upload)
  const uploadContent = '真实上传内容：中文与 emoji ✅\n第二行\n'
  await writeFile(uploadPath, uploadContent)
  const documentNode = await b.command('DOM.getDocument')
  const uploadNode = await b.command('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector: '[aria-label="上传研发资料"]',
  })
  await b.command('DOM.setFileInputFiles', { nodeId: uploadNode.nodeId, files: [uploadPath] })
  const uploaded = await b.until(() => documentByName(names.upload), '读取上传内容')
  assert.equal(uploaded.content, uploadContent)
  await docClick(names.upload)
  await b.clickText('下载', '.mat-doc-reader button')
  const downloadedText = await b.until(async () => {
    try {
      return await readFile(path.join(b.downloadDirectory, names.upload), 'utf8')
    } catch {
      return false
    }
  }, '下载上传资料')
  assert.equal(downloadedText, uploadContent)
  b.check('上传真实 UTF-8 文件、预览并逐字节下载')

  await menu('资料更多操作', '从 Git 导入')
  await b.select('[aria-label="Git 导入路径"]', 'docs/')
  await b.fill('[aria-label="Git 资料目标名称"]', names.imported)
  await dialogText('导入指定路径')
  const importedFolder = await b.until(() => documentByName(names.imported), 'Git 目录导入完成')
  assert.equal(importedFolder.source, 'git')
  assert.match(importedFolder.commit, /^[a-f0-9]{40}$/)
  const importedDocs = (await b.storage()).projects.sol.documents.filter(
    (item) =>
      item.repositoryId === importedFolder.repositoryId &&
      item.syncedAt === importedFolder.syncedAt,
  )
  assert(importedDocs.some((item) => item.gitPath === 'docs/runbook/deployment.md'))
  await docClick(names.imported)
  await docClick('architecture.md')
  assert(
    await b.evaluate(`document.querySelector('.mat-doc-reader').innerText.includes('Git 只读')`),
  )
  assert.equal(
    await b.evaluate(
      `Array.from(document.querySelectorAll('.mat-doc-reader button')).some(el=>el.textContent.trim()==='编辑文档')`,
    ),
    false,
  )
  await b.clickText('全部资料')
  await docMenu(names.imported, '同步')
  await simulation('资料同步演示场景', 'failed')
  await dialogText('同步最新内容')
  await b.until(
    async () =>
      (await b.storage()).tasks.some(
        (task) => task.title === `同步 ${names.imported}` && task.status === 'failed',
      ),
    'Git 同步失败',
  )
  assert.equal((await documentByName(names.imported)).commit, importedFolder.commit)
  await docMenu(names.imported, '同步')
  await dialogText('同步最新内容')
  await b.until(
    async () => (await documentByName(names.imported)).commit !== importedFolder.commit,
    'Git 同步最新内容',
  )
  assert.equal(
    (await b.storage()).projects.sol.documents.filter((item) => item.id === importedFolder.id)
      .length,
    1,
  )
  b.check('指定 Git 目录递归导入只读资料；同步失败保留原内容，成功只保留最新版本')

  await b.route('/p/sol/repositories')
  await b.clickText('添加仓库')
  await b.fill('[aria-label="仓库名称"]', names.repository)
  await b.select('[aria-label="Git 托管方"]', '自建 Git')
  await b.fill('[aria-label="仓库地址"]', 'https://git.example.invalid/team/test.git')
  await b.click('[aria-label="私有仓库"]')
  await b.fill('[aria-label="仓库用户名"]', 'demo-user')
  await b.fill('[aria-label="仓库演示凭据"]', 'fictional-acceptance-token')
  assert.equal(
    await b.evaluate(`document.querySelector('[aria-label="仓库演示凭据"]').type`),
    'password',
  )
  await dialogText('保存仓库')
  const repository = (await b.storage()).projects.sol.repositories.find(
    (item) => item.name === names.repository,
  )
  assert(repository.private)
  await b.clickText('获取源码')
  await b.select('[aria-label="源码引用类型"]', 'tag')
  await b.fill('[aria-label="源码引用"]', 'v3.2.1')
  await dialogText('获取并固定提交')
  const sourceName = `${names.repository} · v3.2.1`
  const source = await b.until(async () => {
    const value = await artifactByName(sourceName)
    return value?.status === 'ready' && value
  }, '获取标签源码')
  assert.equal(source.repositoryId, repository.id)
  assert.equal(source.refType, 'tag')
  assert.match(source.commit, /^[a-f0-9]{40}$/)
  assert(source.files.some((file) => file.name === '.git/config'))
  assert.equal(
    await b.evaluate('new URLSearchParams(location.hash.split("?")[1]).get("artifact")'),
    source.id,
  )
  await reloadSelected('.mat-artifact-inspector', sourceName)
  await b.clickText('查看来源仓库', '.mat-artifact-inspector button')
  assert.equal(
    await b.evaluate('new URLSearchParams(location.hash.split("?")[1]).get("repository")'),
    repository.id,
  )
  await b.clickText('查看产物', '.mat-snapshot-row button')
  assert.equal(
    await b.evaluate('new URLSearchParams(location.hash.split("?")[1]).get("artifact")'),
    source.id,
  )
  b.check('自建私有仓库配置、凭据掩码、按标签获取固定提交源码')

  await b.route('/p/sol/artifacts')
  const stripStart = await processArtifact(source.id, 'strip', names.stripped)
  await rowButton(sourceName, '删除')
  assert(
    await b.evaluate(`document.querySelector('[role=dialog]').innerText.includes('运行中的任务')`),
  )
  assert.equal(
    await b.evaluate(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.trim()==='删除文件').disabled`,
    ),
    true,
  )
  await dialogText('关闭')
  const stripped = await b.until(async () => {
    const item = await artifactByName(names.stripped)
    return item.status === 'ready' && item
  }, '去 Git 处理完成')
  assert.equal(stripped.id, stripStart.id)
  assert.equal(stripped.sourceId, source.id)
  assert(!stripped.files.some((file) => file.name.split('/').includes('.git')))
  for (const file of ['.gitignore', '.gitattributes', '.github/workflows/ci.yml'])
    assert(stripped.files.some((item) => item.name === file))
  assert((await artifactByName(sourceName)).files.some((file) => file.name === '.git/config'))
  await processArtifact(stripped.id, 'sanitize', names.sanitized)
  const sanitized = await b.until(async () => {
    const item = await artifactByName(names.sanitized)
    return item.status === 'ready' && item
  }, '脱敏完成')
  assert(!JSON.stringify(sanitized.files).includes('fictional-db-password'))
  assert(!JSON.stringify(sanitized.files).includes('internal.example.invalid'))
  const report = await artifactByName(`${names.sanitized} · 处理报告.md`)
  assert.equal(report.sourceId, sanitized.id)
  assert.match(report.content, /规则命中/)
  assert(!report.content.includes('fictional-db-password'))
  await processArtifact(sanitized.id, 'zip', names.zip)
  const zip = await b.until(async () => {
    const item = await artifactByName(names.zip)
    return item.status === 'ready' && item
  }, 'ZIP 生成完成')
  assert.equal(zip.commit, source.commit)
  await rowButton(names.zip, '下载')
  const archive = await b.until(async () => {
    try {
      return await readFile(path.join(b.downloadDirectory, names.zip))
    } catch {
      return false
    }
  }, 'ZIP 下载完成')
  const zipFiles = verifyZip(archive)
  assert.deepEqual(zipFiles, sanitized.files)
  await b.mouse(
    `Array.from(document.querySelectorAll('.mat-inspector-data button')).find(el=>el.textContent.trim()===${JSON.stringify(names.sanitized)})`,
    '返回脱敏来源',
  )
  assert.equal(
    await b.evaluate('new URLSearchParams(location.hash.split("?")[1]).get("artifact")'),
    sanitized.id,
  )
  await b.clickText('查看处理报告', '.mat-artifact-inspector button')
  assert.equal(
    await b.evaluate('new URLSearchParams(location.hash.split("?")[1]).get("artifact")'),
    report.id,
  )
  await b.route(`/p/sol/artifacts?artifact=${sanitized.id}`)
  const task = (await b.storage()).tasks.find((item) => item.id === sanitized.taskId)
  assert(task)
  await b.clickText(task.title, '.mat-inspector-data button')
  assert.equal(
    await b.evaluate('new URLSearchParams(location.hash.split("?")[1]).get("task")'),
    task.id,
  )
  await b.route(`/p/sol/artifacts?artifact=${sanitized.id}`)
  await b.clickText('Agent 问答', '.mat-artifact-inspector button')
  assert.equal(
    await b.evaluate('new URLSearchParams(location.hash.split("?")[1]).get("artifact")'),
    sanitized.id,
  )
  assert(await b.evaluate('location.hash.includes("/chat?")'))
  await b.route(`/p/sol/artifacts?artifact=${sanitized.id}`)
  await b.clickText('用于发布', '.mat-artifact-inspector button')
  assert(await b.evaluate('location.hash.includes("/services?artifact=")'))
  await b.route('/p/sol/artifacts')
  await b.route(`/p/sol/artifacts?artifact=${sanitized.id}`)
  await b.wait(300)
  await b.screenshot('artifacts-desktop')
  b.check('独立去 Git / 脱敏 / 报告 / 压缩完整来源链，运行中删除保护和实际 ZIP CRC 校验')

  await processArtifact(source.id, 'zip', names.failed, 'failed')
  await b.until(
    async () => (await artifactByName(names.failed)).status === 'failed',
    '处理失败输出',
  )
  assert.equal((await artifactByName(sourceName)).status, 'ready')
  await processArtifact(source.id, 'zip', names.stopped)
  await b.clickText('停止')
  await b.until(
    async () => (await artifactByName(names.stopped)).status === 'stopped',
    '中止输出状态',
  )
  await rowButton('sol-api · main', '删除')
  assert(await b.evaluate(`document.querySelector('[role=dialog]').innerText.includes('保留版本')`))
  await dialogText('关闭')
  await rowButton(names.sanitized, '删除')
  assert.equal(
    await b.evaluate(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.trim()==='删除文件').disabled`,
    ),
    false,
  )
  await dialogText('删除文件')
  const tombstone = await artifactByName(names.sanitized)
  assert.equal(tombstone.deleted, true)
  assert.equal(tombstone.files.length, 0)
  assert(
    (await b.storage()).tasks.some(
      (task) => task.status === 'success' && task.artifactIds?.includes(tombstone.id),
    ),
  )
  await menu('产物更多操作', '显示已删除产物', 'menuitemcheckbox')
  await b.clickText(names.sanitized, '.mat-artifact-table button')
  assert(
    await b.evaluate(
      `document.querySelector('.mat-artifact-inspector').innerText.includes('历史来源记录保留')`,
    ),
  )
  await b.click(`.mat-artifact-inspector [aria-label="${names.sanitized} 更多操作"]`)
  assert.equal(
    await b.evaluate(
      `Array.from(document.querySelectorAll('[role="menuitem"]')).find(el=>el.textContent.trim()==='下载产物').getAttribute('aria-disabled')`,
    ),
    'true',
  )
  await b.command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  })
  await b.command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  })
  b.check('失败与中止输出、部署版本保护、完成任务不阻止删除、历史 tombstone 禁止下载')

  await b.wait(300)
  await b.screenshot('artifacts-tombstone-desktop')
  await b.viewport(390, 844)
  await b.route('/p/sol/artifacts')
  await b.assertNoOverflow('移动端产物列表')
  await b.clickText(names.zip, '.mat-artifact-table button')
  await b.wait(300)
  await b.assertNoOverflow('移动端产物详情')
  assert.equal(
    await b.evaluate(`Boolean(document.querySelector('.mat-lineage')?.getClientRects().length)`),
    false,
  )
  await b.clickText('查看内容', '.mat-artifact-inspector button')
  await b.wait(300)
  await b.assertNoOverflow('移动端源码预览')
  await b.screenshot('source-preview-mobile')
  assert(
    await b.evaluate(
      `document.querySelector('[role=dialog]').innerText.includes(${JSON.stringify(names.sanitized)})`,
    ),
  )
  assert(
    !(await b.evaluate(
      `document.querySelector('[role=dialog]').innerText.includes(${JSON.stringify(sanitized.id)})`,
    )),
  )
  await dialogText('关闭')
  await b.clickText('返回产物列表')
  assert(
    await b.evaluate(
      `Boolean(document.querySelector('.mat-artifact-main')?.getClientRects().length)`,
    ),
  )
  await b.route('/p/sol/documents')
  await b.assertNoOverflow('移动端资料列表')
  await b.clickText('新建文档')
  await b.fill('[aria-label="资料名称"]', `手机创建-${suffix}.txt`)
  await b.fill('[aria-label="文档内容"]', '手机上创建并保存')
  await dialogText('保存')
  assert(await documentByName(`手机创建-${suffix}.txt`))
  assert(
    await b.evaluate(
      `document.querySelector('.mat-doc-reader').innerText.includes('手机上创建并保存')`,
    ),
  )
  await b.clickText('返回资料列表')
  assert(
    await b.evaluate(`Boolean(document.querySelector('.mat-doc-browser').getClientRects().length)`),
  )
  await b.screenshot('documents-mobile')
  b.check('390px 移动端列表和预览不溢出，手机可完成文档编辑保存')
  assert.deepEqual(b.errors, [], '不应有浏览器运行时异常')
  assert.deepEqual(b.warnings, [], '不应有浏览器错误日志')
  await writeFile(
    path.join(b.output, 'checks.json'),
    JSON.stringify(
      {
        checks: b.checks,
        errors: b.errors,
        warnings: b.warnings,
        downloads: await readdir(b.downloadDirectory),
      },
      null,
      2,
    ),
  )
  console.log(`资料模块浏览器验收通过：${b.checks.length} 项。截图：${b.output}`)
} catch (error) {
  await b.screenshot('failure').catch(() => {})
  console.error(await b.evaluate('document.body.innerText').catch(() => '无法读取页面'))
  throw error
} finally {
  await b.close()
}
