import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client, requestId } from './agent-demo-helpers.mjs'
import { startBrowser, until } from './helpers/prototype-browser.mjs'

// Explicit opt-in: creates/deletes only its own private scenario conversations.
// Checks the deployed UI + real HTTP persistence, with zero model calls.
if (process.env.AGENT_DEMO_DEPLOYED_CHECK !== '1') throw new Error('需要显式启用部署验收')
const origin = new URL(process.env.AGENT_DEMO_URL).origin
const client = await new Client('admin', origin).login()
const created = new Set()
const report = { mode: 'deployed-scenario-message-actions', realModelCalls: 0, checks: [] }
let browser
try {
  const source = await client.create({ title: `分支入口验收 ${requestId().slice(0, 8)}` })
  created.add(source.id)
  await client.send(source.id, '第一轮：读取项目资料')
  await client.finish(source.id)
  await client.send(source.id, '第二轮：整理摘要')
  const original = await client.finish(source.id)
  const assistant = original.messages.find((m) => m.role === 'assistant')
  process.env.PROTOTYPE_URL = `${origin}/agent-demo.html#conversation=${source.id}`
  browser = await startBrowser('agent-demo-message-actions-deployed')
  await browser.viewport(1280, 900)
  await browser.fill('[aria-label="用户名"]', 'admin')
  await browser.fill('[aria-label="密码"]', process.env.AGENT_DEMO_PASSWORD || 'Demo123!')
  await browser.clickText('登录')
  const selector = `[data-message-id="${assistant.id}"] [aria-label="分支菜单"]`
  await browser.visible(selector)
  await browser.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`,
  )
  const point = await browser.evaluate(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await browser.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  const beforeIds = (await client.api('GET', '/bootstrap')).conversations.map((c) => c.id).sort()
  await browser.click(selector)
  await browser.visible('[role="menuitem"]')
  assert.deepEqual(
    (await client.api('GET', '/bootstrap')).conversations.map((c) => c.id).sort(),
    beforeIds,
  )
  report.checks.push('ZeroTier实际页面：分支图标只打开菜单，不创建会话')
  await browser.clickText('从这里分支', '[role="menuitem"]')
  const forkId = await until(
    () =>
      browser.evaluate(
        `(()=>{const id=document.querySelector('.workbench-demo-chat')?.dataset.conversationId;return id&&id!==${JSON.stringify(source.id)}?id:null})()`,
      ),
    '进入分支',
  )
  created.add(forkId)
  const fork = await client.conversation(forkId)
  assert.equal(fork.turns.length, 1)
  assert.equal(fork.activeTurnId, null)
  assert.ok(!fork.messages.some((m) => m.content?.includes('第二轮：整理摘要')))
  assert.deepEqual(await client.conversation(source.id), original)
  const afterIds = (await client.api('GET', '/bootstrap')).conversations.map((c) => c.id)
  assert.deepEqual(
    afterIds.filter((id) => !beforeIds.includes(id)),
    [forkId],
  )
  report.checks.push('选择一次仅创建一个分支：保留第一轮、排除第二轮、原历史不变、不自动运行')
  await browser.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await browser.screenshot('desktop-fork')
  await browser.viewport(390, 844)
  await browser.visible('.is-assistant [aria-label="更多消息操作"]')
  await browser.click('.is-assistant [aria-label="更多消息操作"]')
  await browser.visible('.workbench-demo-message-sheet')
  await browser.evaluate(
    `Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`,
  )
  assert.ok(
    await browser.evaluate(
      `[...document.querySelectorAll('.workbench-demo-message-sheet-actions button')].every(n=>n.getBoundingClientRect().height>=44)`,
    ),
  )
  await browser.screenshot('mobile-actions')
  await browser.key('Escape', 27)
  await until(
    () => browser.evaluate(`!document.querySelector('.workbench-demo-message-sheet')`),
    '关闭操作面板',
  )
  report.checks.push('390px页面使用单一更多入口与44px文字操作面板，可正常关闭')
  assert.deepEqual(browser.errors, [])
  report.health = await client.api('GET', '/health')
  report.buildAssets = await browser.evaluate('[...document.scripts].map(s=>s.src).filter(Boolean)')
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = error.stack
  throw error
} finally {
  for (const id of created) {
    const c = await client.conversation(id)
    if (c.activeTurnId) {
      await client.stop(id, c.activeTurnId)
      await client.finish(id)
    }
    await client.api('DELETE', `/conversations/${id}`, { requestId: requestId() })
  }
  report.cleanedUp = true
  report.testedAt = new Date().toISOString()
  if (browser) {
    await writeFile(path.join(browser.output, 'report.json'), JSON.stringify(report, null, 2))
    await browser.close()
  }
  console.log(JSON.stringify(report, null, 2))
}
