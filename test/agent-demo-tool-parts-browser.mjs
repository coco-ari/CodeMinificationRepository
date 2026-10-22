import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

// Real React/shadcn/copied OpenChamber views with only controlled tool fixtures.
// No login, backend, model, or user's existing conversation is involved.
const repository = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'autoops-tool-parts-browser-'))
let server, browser
try {
  await writeFile(
    path.join(temporary, 'index.html'),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="workbench-demo-document"><main class="workbench-demo-chat" style="max-width:760px;padding:20px;margin:auto"><div id="root"></div></main><script type="module">
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ToolPart } from '/@fs/${repository}/web/src/agent-demo/tool-parts.jsx';
import '/@fs/${repository}/web/src/index.css';
import '/@fs/${repository}/web/src/styles/solid-glass.css';
import '/@fs/${repository}/web/src/agent-demo/styles.css';
const root=createRoot(document.getElementById('root'));
window.previews=[];window.readCount=0;
window.renderTools=(steps,turn={},extra={})=>flushSync(()=>root.render(React.createElement(StrictMode,null,steps.map((step,index)=>React.createElement(ToolPart,{key:step?.id||'missing-'+index,step,turn,onRead:()=>window.readCount++,onPreview:file=>window.previews.push(file),...extra})))));
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedText=value;}}});
window.ready=true;
</script></body></html>`,
  )
  server = await createServer({
    configFile: false,
    root: temporary,
    cacheDir: path.join(temporary, '.vite'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.join(repository, 'web/src'),
        react: path.join(repository, 'node_modules/react'),
        'react-dom': path.join(repository, 'node_modules/react-dom'),
      },
    },
    server: { host: '127.0.0.1', port: 0, ws: false, fs: { allow: [repository, temporary] } },
  })
  await server.listen()
  process.env.PROTOTYPE_URL = `http://127.0.0.1:${server.httpServer.address().port}/`
  browser = await startBrowser('agent-demo-tool-parts')
  const { evaluate, check } = browser
  await until(() => evaluate('window.ready'), '工具夹具就绪')
  const render = async (steps, turn = {}, extra = {}) => {
    await evaluate(
      `window.renderTools(${JSON.stringify(steps)},${JSON.stringify(turn)},${JSON.stringify(extra)})`,
    )
    await wait(60)
  }
  const docs = [
    { id: 'design', name: '工作台设计.md', mime: 'text/markdown', content: '# 设计' },
    { id: 'manual', name: '环境检查手册.md', mime: 'text/markdown', content: '# 检查' },
  ]
  const turn = { context: { documents: docs } }
  const reads = docs.map((doc) => ({
    id: `read-${doc.id}`,
    name: 'read_project_document',
    input: { id: doc.id },
    status: 'completed',
    output: { sourceUrl: 'https://attacker.invalid/collect' },
  }))
  await render(reads, turn)
  assert.equal(
    await evaluate(`document.querySelectorAll('.workbench-demo-tool-row.is-static').length`),
    2,
  )
  assert.equal(await evaluate(`document.querySelectorAll('[aria-expanded]').length`), 0)
  await browser.click('[aria-label="查看文件 环境检查手册.md"]')
  assert.deepEqual(await evaluate('window.previews[0]'), { ...docs[1], projectDocument: true })
  assert.equal(await evaluate('window.readCount'), 1)
  check('每次读取显示具体文件名并直接预览授权快照，没有重复详情层或外部sourceUrl跳转')

  await render([undefined], turn)
  assert.equal(await evaluate(`document.getElementById('root').textContent`), '')
  await render([reads[0]], turn)
  assert.ok(
    await evaluate(
      `document.querySelector('.workbench-demo-tool-file').textContent.includes('工作台设计.md')`,
    ),
  )
  const failed = { ...reads[0], status: 'failed', error: { message: '当前资料读取被拒绝' } }
  await render([failed], turn)
  await browser.click('[aria-label="展开 读取文件"]')
  assert.ok(
    await evaluate(
      `document.querySelector('.workbench-demo-tool-body').textContent.includes('当前资料读取被拒绝')`,
    ),
  )
  assert.equal(
    await evaluate(`document.querySelectorAll('.workbench-demo-tool-body [aria-expanded]').length`),
    0,
  )
  check('缺失步骤恢复无崩溃；业务读取失败转为单层错误详情，错误信息可见')

  const query = {
    id: 'query',
    name: 'query_environment',
    status: 'completed',
    input: { environmentId: 'env-test' },
    output: { resources: [{ id: 'api', name: 'API 服务', status: 'healthy' }] },
  }
  await render([query])
  await browser.click('[aria-label="展开 查询环境"]')
  await browser.click('[aria-label="JSON 原文"]')
  assert.equal(
    await evaluate(`document.querySelector('.workbench-demo-tool-output pre').textContent`),
    JSON.stringify(query.output, null, 2),
  )
  await browser.click('[aria-label="复制工具结果"]')
  assert.equal(await evaluate('window.copiedText'), JSON.stringify(query.output, null, 2))
  await browser.click('[aria-label="JSON 树"]')
  assert.ok(
    await evaluate(`document.querySelector('.workbench-demo-tool-output [dir="ltr"]') !== null`),
  )
  await browser.click('[aria-label="结构化结果"]')
  assert.ok(
    await evaluate(
      `document.querySelector('.workbench-demo-tool-output').textContent.includes('API 服务')`,
    ),
  )
  check('真实点击切换结构化/树/原文与复制，工具结果不额外包第二个详情折叠')

  const large = {
    id: 'large',
    name: 'custom_result',
    status: 'completed',
    output: Array.from({ length: 600 }, (_, index) => `value-${index}`),
  }
  await render([large], {}, { expanded: true })
  await browser.click('[aria-label="JSON 树"]')
  await until(
    () =>
      evaluate(`document.querySelectorAll('.workbench-demo-tool-output [data-index]').length > 0`),
    '上游JSON树虚拟列表',
  )
  const mounted = await evaluate(
    `document.querySelectorAll('.workbench-demo-tool-output [data-index]').length`,
  )
  assert.ok(mounted < 160, `virtual tree mounted ${mounted} rows`)
  await evaluate(
    `const tree=document.querySelector('.workbench-demo-tool-output [dir="ltr"]');tree.scrollTop=tree.scrollHeight;tree.dispatchEvent(new Event('scroll'))`,
  )
  await until(
    () =>
      evaluate(
        `document.querySelector('.workbench-demo-tool-output').textContent.includes('value-599')`,
      ),
    '虚拟列表末项',
  )
  check('直接复用上游大结果虚拟JSON树，600项只挂载窗口行并可滚到末项')

  const report = {
    id: 'report',
    name: 'create_report',
    status: 'completed',
    input: { name: '发布准备报告.md', content: '# 发布报告' },
    output: { id: 'artifact-report', name: '发布准备报告.md', status: 'delivered_to_host' },
  }
  await render([report], {}, { expanded: true })
  assert.ok(
    await evaluate(
      `document.querySelector('.workbench-demo-tool-name').textContent === '生成报告'`,
    ),
  )
  assert.equal(
    await evaluate(`document.getElementById('root').textContent.includes('写入文件')`),
    false,
  )
  const long = {
    id: 'long',
    name: '很长的项目资料名称用于验证小屏幕文件导航不会横向撑破消息区域的环境检查手册.md',
    content: '# 文档',
  }
  await browser.viewport(390, 844)
  await render(
    [
      {
        id: 'read-long',
        name: 'read_project_document',
        input: { id: 'long' },
        status: 'completed',
      },
    ],
    { context: { documents: [long] } },
  )
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`))
  const rowHeight = await evaluate(
    `document.querySelector('.workbench-demo-tool-row').getBoundingClientRect().height`,
  )
  assert.ok(rowHeight >= 36)
  await browser.click(`[aria-label="查看文件 ${long.name}"]`)
  assert.equal(await evaluate('window.previews.at(-1).id'), 'long')
  await browser.screenshot('tool-file-mobile')
  check('报告使用准确业务名称；390px长文件名不横向溢出，36px行仍可点击预览')

  assert.deepEqual(browser.errors, [])
  await writeFile(
    path.join(browser.output, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        checks: browser.checks,
        modelCalls: 0,
        backendRequests: 0,
        completedAt: new Date().toISOString(),
        source: 'OpenChamber 6491f51d',
        note: 'Isolated tool UI; not full conversation/backend validation.',
      },
      null,
      2,
    ),
  )
} finally {
  await browser?.close()
  await server?.close()
  await rm(temporary, { recursive: true, force: true })
}
