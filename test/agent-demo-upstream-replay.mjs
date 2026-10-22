import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

// Replays the authorized read-only snapshot in an isolated database. Never
// mutates the deployed conversation, and never calls a model or real tools.
const fixture =
  process.env.AGENT_DEMO_REPLAY_FILE ||
  '.test-artifacts/agent-demo-upstream-parity/user-report-conversation.json'
const conversation = JSON.parse(await readFile(fixture, 'utf8'))
const directory = await mkdtemp(path.join(os.tmpdir(), 'autoops-upstream-replay-'))
const db = new DatabaseSync(path.join(directory, 'demo.sqlite'))
db.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY, body TEXT NOT NULL)')
db.prepare('INSERT INTO conversations(id,body) VALUES(?,?)').run(
  conversation.id,
  JSON.stringify(conversation),
)
db.close()
let origin, browser
const child = spawn(process.execPath, ['agent-demo/server.mjs'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: directory, AGENT_BRIDGE_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
child.stdout.on('data', (chunk) => {
  logs += chunk
  const match = logs.match(/"port":(\d+)/)
  if (match) origin = `http://127.0.0.1:${match[1]}`
})
child.stderr.on('data', (chunk) => {
  logs += chunk
})
const checks = []
const report = { mode: 'user-conversation-read-only-local-replay', realModelCalls: 0, checks }
try {
  await until(() => origin, 'replay server')
  process.env.PROTOTYPE_URL = `${origin}/agent-demo.html#conversation=${conversation.id}`
  browser = await startBrowser('agent-demo-upstream-replay')
  await browser.viewport(1280, 900)
  await browser.fill('[aria-label="用户名"]', 'admin')
  await browser.fill('[aria-label="密码"]', 'Demo123!')
  await browser.clickText('登录')
  await browser.visible('.workbench-demo-activity-toggle')
  const turn = conversation.turns.at(-1)
  const final = turn.timeline.at(-1)
  assert.equal(final.type, 'text')
  assert.equal(
    await browser.evaluate(`document.querySelectorAll('.workbench-demo-tool-row').length`),
    0,
  )
  assert.equal(
    await browser.evaluate(`document.querySelectorAll('.workbench-demo-reasoning').length`),
    0,
  )
  assert.ok(
    await browser.evaluate(
      `document.querySelector('[data-activity-final-answer]').textContent.includes('发布准备未完成')`,
    ),
  )
  checks.push('用户原轮12段时间线默认收起中间活动，最终答复完整可读')
  assert.ok(
    await browser.evaluate(
      "parseFloat(getComputedStyle(document.querySelector('.workbench-demo-markdown-table td')).paddingLeft) > 0",
    ),
  )
  await browser.evaluate("document.querySelector('.workbench-demo-messages').scrollTop=0")
  await browser.screenshot('completed-folded')

  await browser.evaluate(
    `Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value)=>{window.copied=value}}})`,
  )
  assert.equal(
    await browser.evaluate(
      `document.querySelectorAll('.is-assistant .workbench-demo-answer-actions').length`,
    ),
    1,
  )
  await browser.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await until(
    () =>
      browser.evaluate(
        `getComputedStyle(document.querySelector('.is-assistant .workbench-demo-message-action-icons')).opacity==='0'`,
      ),
    'pointer away hides actions',
  )
  await browser.evaluate(
    `document.querySelector('[aria-label="复制回复"]').scrollIntoView({block:'center'})`,
  )
  const copyPoint = await browser.evaluate(
    `(()=>{const r=document.querySelector('[aria-label="复制回复"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await browser.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...copyPoint })
  await until(
    () =>
      browser.evaluate(
        `getComputedStyle(document.querySelector('.is-assistant .workbench-demo-message-action-icons')).opacity==='1'`,
      ),
    'hover reveals answer actions',
  )
  await browser.click('[aria-label="复制回复"]')
  assert.equal(await browser.evaluate('window.copied'), final.text)
  checks.push('复制回复仅包含最终答复，不混入过程说明')

  await browser.click('.workbench-demo-activity-toggle')
  await browser.visible('[aria-label="查看文件 环境检查手册.md"]')
  const ids = await browser.evaluate(
    `[...document.querySelectorAll('[data-part-id]')].map(n=>n.dataset.partId)`,
  )
  assert.deepEqual(
    ids,
    turn.timeline.map((p) => p.id),
  )
  assert.equal(
    await browser.evaluate(
      `document.querySelectorAll('.workbench-demo-tool-row.is-static').length`,
    ),
    2,
  )
  assert.equal(
    await browser.evaluate(`document.querySelectorAll('.workbench-demo-steps').length`),
    0,
  )
  checks.push('展开按原顺序展示全部5次工具/3段思考/4段文字，读取行各有真实文件名')
  await browser.evaluate(`document.querySelector('.workbench-demo-messages').scrollTop=0`)
  await browser.screenshot('activity-expanded')

  await browser.click('[aria-label="查看文件 环境检查手册.md"]')
  await browser.visible('[role=dialog]')
  assert.ok(
    await browser.evaluate(
      `document.querySelector('[role=dialog]').textContent.includes('磁盘超过80%')`,
    ),
  )
  await browser.key('Escape', 27)
  await until(() => browser.evaluate(`!document.querySelector('[role=dialog]')`), 'close preview')
  checks.push('静态读取行点击直接打开授权资料正文预览')

  await browser.click('[aria-label="展开 查询环境"]')
  assert.ok(
    await browser.evaluate(
      `document.querySelector('.workbench-demo-tool-body').textContent.includes('demo_fixture_snapshot')`,
    ),
  )
  await browser.click('[aria-label="JSON 树"]')
  assert.ok(
    await browser.evaluate(
      `document.querySelector('.workbench-demo-tool-output').textContent.includes('resourceSnapshot')`,
    ),
  )
  await browser.click('[aria-label="JSON 原文"]')
  assert.ok(
    await browser.evaluate(
      `document.querySelector('.workbench-demo-tool-output').textContent.includes('"collectedAt"')`,
    ),
  )
  await browser.screenshot('tool-result')
  checks.push('环境数据使用上游结构化结果/JSON树/原文，无额外参数与结果折叠层')

  const reasoning = turn.timeline.find((p) => p.type === 'reasoning' && p.text.length > 100)
  await browser.click(`[data-part-id="${reasoning.id}"] [aria-label="展开思考过程"]`)
  await until(
    () =>
      browser.evaluate(
        `document.querySelector('.workbench-demo-reasoning-body')?.textContent.length>100`,
      ),
    'reasoning body',
  )
  assert.equal(
    await browser.evaluate(`document.querySelector('[aria-label="复制思考内容"]')===null`),
    true,
  )
  assert.equal(
    await browser.evaluate(
      `[...document.querySelectorAll('.workbench-demo-reasoning-toggle')].some(n=>/\d+\s*秒/.test(n.textContent))`,
    ),
    false,
  )
  checks.push('直接上游思考组件：无自行添加秒数或复制条，真实内容可展开')

  await browser.click('.workbench-demo-activity-toggle')
  await wait(260)
  await browser.click('[aria-label="搜索对话"]')
  const term = reasoning.text.slice(0, 10)
  await browser.fill('[aria-label="搜索当前对话"]', term)
  await until(
    () =>
      browser.evaluate(
        `document.querySelector('[data-part-id="${reasoning.id}"] [aria-label="收起思考过程"]')!==null`,
      ),
    'search opens activity and reasoning',
  )
  await until(
    () => browser.evaluate(`CSS.highlights.get('workbench-demo-search-current')?.size>0`),
    'search highlight',
  )
  checks.push('搜索能展开整轮活动再定位其内思考内容')
  await browser.click('[aria-label="关闭对话搜索"]')
  await browser.viewport(390, 844)
  await browser.assertNoOverflow('390px原会话回放')
  await browser.screenshot('mobile-expanded')
  await browser.click('.workbench-demo-activity-toggle')
  await wait(260)
  await browser.screenshot('mobile-folded')
  checks.push('390px移动端展开/收起无横向溢出')
  assert.deepEqual(browser.errors, [])
  report.buildAssets = await browser.evaluate('[...document.scripts].map(s=>s.src).filter(Boolean)')
  report.testedAt = new Date().toISOString()
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = error.stack
  if (browser) await browser.screenshot('failure').catch(() => {})
  throw error
} finally {
  if (browser) {
    await writeFile(path.join(browser.output, 'report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
  await rm(directory, { recursive: true, force: true })
  console.log(JSON.stringify(report, null, 2))
}
