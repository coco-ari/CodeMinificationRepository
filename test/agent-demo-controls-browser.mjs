import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createServer } from 'vite'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

const sources = [
  'web/src/agent-demo/conversation-controls.jsx',
  'web/src/agent-demo/vendor/openchamber/keyboard-policy.js',
]
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { '@': path.resolve('web/src') } },
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.test-artifacts/**'] } },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'isolated-controls-fixture',
      configureServer(vite) {
        vite.middlewares.use('/__controls-test', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(
            await vite.transformIndexHtml(
              '/__controls-test',
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/helpers/agent-demo-controls-harness.jsx"></script></body></html>',
            ),
          )
        })
      },
    },
  ],
})
let browser, failure
const checks = []
const check = (name) => {
  checks.push(name)
  console.log(`✓ ${name}`)
}
try {
  await server.listen()
  process.env.PROTOTYPE_URL = `http://127.0.0.1:${server.httpServer.address().port}/__controls-test`
  browser = await startBrowser('agent-demo-controls')
  const { evaluate, command, click, clickText, fill, visible } = browser
  await until(() => evaluate('Boolean(window.controlsHarness)'), 'controls fixture')
  const ops = () => evaluate('controlsHarness.operations()')
  const configure = async (patch) => {
    await evaluate(`controlsHarness.settings(${JSON.stringify(patch)})`)
    await wait(50)
  }
  const keyboard = async (modifiers = 0, extra = {}) => {
    await evaluate('document.querySelector("[aria-label=测试输入问题]").focus()')
    for (const type of ['keyDown', 'keyUp'])
      await command('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        modifiers,
        ...extra,
      })
    await wait(40)
  }
  await click('[aria-label="排队到下一轮"]')
  assert.equal((await ops()).at(-1).delivery, 'queue')
  await click('[aria-label="选择运行中发送方式"]')
  await clickText('引导当前执行', '[role=menuitemradio]')
  await visible('[aria-label="引导当前执行"]')
  await keyboard()
  assert.equal((await ops()).at(-1).delivery, 'steer')
  await keyboard(2)
  assert.equal((await ops()).at(-1).delivery, 'queue')
  check('selected follow-up uses Enter; Ctrl+Enter uses alternate action')
  await configure({ userId: 'controls-b' })
  await visible('[aria-label="排队到下一轮"]')
  await configure({ userId: 'controls-a' })
  await visible('[aria-label="引导当前执行"]')
  check('follow-up preference is isolated by user and restores after switching back')
  await configure({ hasAttachments: true })
  await visible('[aria-label="排队到下一轮"]')
  await keyboard()
  assert.equal((await ops()).at(-1).delivery, 'queue')
  await configure({ hasAttachments: false, canSteer: false })
  await visible('[aria-label="排队到下一轮"]')
  await configure({ canSteer: true })
  await visible('[aria-label="引导当前执行"]')
  check(
    'unsupported steering or attachments temporarily use explicitly labelled queue without losing preference',
  )
  await evaluate('controlsHarness.clear()')
  await evaluate(
    '(()=>{const input=document.querySelector("[aria-label=测试输入问题]");input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));input.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,key:"Enter",keyCode:229,isComposing:true}));input.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));input.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,key:"Enter"}))})()',
  )
  assert.equal((await ops()).length, 0)
  await wait(80)
  await keyboard(8)
  assert.equal((await ops()).length, 0)
  check('IME confirmation and Shift+Enter never submit')
  await configure({ sending: true })
  await click('[aria-label="停止生成"]')
  assert.equal((await ops()).at(-1).kind, 'stop')
  await configure({ sending: false })
  await fill('[aria-label="测试输入问题"]', '')
  assert.equal(
    await evaluate('document.querySelectorAll(".workbench-demo-composer-actions button").length'),
    1,
  )
  check('stop remains available during submission; empty busy composer only shows stop')
  await fill('[aria-label="测试输入问题"]', '仍可发送的草稿')
  await configure({ running: false })
  await click('[aria-label="立即发送排队消息 q1"]')
  assert.equal((await ops()).at(-1).kind, 'send-queue')
  await evaluate('controlsHarness.items([{id:"q1",text:"第一条"},{id:"q2",text:"第二条"}])')
  await click('[aria-label="展开下一轮队列"]')
  await click('[aria-label="下移排队消息 q1"]')
  await click('[aria-label="编辑排队消息 q2"]')
  await click('[aria-label="移除排队消息 q2"]')
  await clickText('暂停队列')
  await clickText('恢复队列')
  const queueOps = (await ops()).map((op) => op.kind)
  for (const kind of ['move', 'edit', 'remove', 'pause', 'resume'])
    assert.ok(queueOps.includes(kind))
  await configure({ running: true })
  assert.equal(
    await evaluate('Boolean(document.querySelector("[aria-label^=立即发送排队消息]"))'),
    false,
  )
  check('single/multiple queue presentation exposes callbacks without any autonomous dispatch')
  await evaluate('document.querySelector("[aria-label=测试输入问题]").focus()')
  await evaluate(
    'controlsHarness.question({id:"question-focus",status:"pending",prompt:"新的问题",options:["选项一"]})',
  )
  await wait(50)
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '测试输入问题')
  await fill('[aria-label="澄清回答"]', '失败后仍需保留的回答')
  await clickText('提交并继续')
  await visible('[role=alert]')
  assert.equal(
    await evaluate('document.querySelector("[aria-label=澄清回答]").value'),
    '失败后仍需保留的回答',
  )
  check('new question does not steal composer focus; failed answer retains text and offers retry')
  await evaluate('controlsHarness.question({id:"question-b",status:"pending",prompt:"第二个问题"})')
  await fill('[aria-label="澄清回答"]', '问题B草稿')
  await evaluate(
    'controlsHarness.question({id:"question-focus",status:"pending",prompt:"新的问题"})',
  )
  await wait(50)
  assert.equal(
    await evaluate('document.querySelector("[aria-label=澄清回答]").value'),
    '失败后仍需保留的回答',
  )
  check('clarification drafts are independent per question identity')
  await evaluate('controlsHarness.answerMode("pending")')
  await clickText('提交并继续')
  await visible('button:disabled')
  await evaluate('controlsHarness.question({id:"question-b",status:"pending",prompt:"第二个问题"})')
  await wait(50)
  await evaluate('controlsHarness.resolve("question-focus")')
  await wait(50)
  assert.equal(await evaluate('document.querySelector("[aria-label=澄清回答]").value'), '问题B草稿')
  await evaluate(
    'controlsHarness.question({id:"question-focus",status:"pending",prompt:"新的问题"})',
  )
  await wait(50)
  assert.equal(await evaluate('document.querySelector("[aria-label=澄清回答]").value'), '')
  check('late successful response clears only its own question draft and preserves a newer prompt')
  await browser.viewport(390, 844)
  await evaluate('controlsHarness.clear()')
  await keyboard()
  assert.equal((await ops()).length, 0)
  await keyboard(4)
  assert.equal((await ops()).at(-1).delivery, 'queue')
  await browser.assertNoOverflow('mobile controls')
  const targets = await evaluate(
    'Array.from(document.querySelectorAll(".workbench-demo-composer-actions button,.workbench-demo-queue-actions button")).filter(n=>n.getClientRects().length).map(n=>({label:n.getAttribute("aria-label"),height:n.getBoundingClientRect().height}))',
  )
  assert.ok(
    targets.every((target) => target.height >= 39.5),
    JSON.stringify(targets),
  )
  check(
    'mobile Enter keeps newline; Cmd+Enter uses alternate action; action targets remain at least 40px',
  )
  assert.equal(browser.errors.length, 0, browser.errors.join('\n'))
} catch (error) {
  failure = error
  console.error(error)
} finally {
  const output = path.resolve('.test-artifacts/agent-demo-controls')
  await mkdir(output, { recursive: true })
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sources.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  )
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: !failure,
        boundary:
          'Isolated real Chromium component contracts. No backend, login or Agent/model execution.',
        checks,
        sourceHashes,
        error: failure?.message || null,
      },
      null,
      2,
    ),
  )
  await browser?.close()
  await server.close()
}
if (failure) process.exitCode = 1
