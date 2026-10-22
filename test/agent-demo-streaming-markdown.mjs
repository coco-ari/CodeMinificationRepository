import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

// Isolated renderer fixture: no Demo login, backend, credential, or model call.
const repository = process.cwd()
const temporary = await mkdtemp(path.join(tmpdir(), 'autoops-streaming-renderer-'))
let server
let browser
try {
  await writeFile(
    path.join(temporary, 'index.html'),
    `<!doctype html><html><body><div id="root"></div><script type="module">
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Markdown } from '/@fs/${repository}/web/src/agent-demo/Content.jsx';
const root = createRoot(document.getElementById('root'));
window.renderMarkdown = (content, streaming, identity='sample') => flushSync(() => root.render(React.createElement(StrictMode, null, React.createElement(Markdown, { content, streaming, identity }))));
Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText: async value => { window.copiedText=value; } } });
window.ready=true;
</script></body></html>`,
  )
  server = await createServer({
    configFile: false,
    root: temporary,
    cacheDir: path.join(temporary, '.vite'),
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.join(repository, 'web/src'),
        react: path.join(repository, 'node_modules/react'),
        'react-dom': path.join(repository, 'node_modules/react-dom'),
      },
    },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repository, temporary] } },
  })
  await server.listen()
  process.env.PROTOTYPE_URL = `http://127.0.0.1:${server.httpServer.address().port}/`
  browser = await startBrowser('agent-demo-streaming-markdown')
  const { evaluate, check } = browser
  await until(() => evaluate('window.ready'), 'React renderer ready')
  const render = async (content, streaming, identity = 'sample', settle = true) => {
    await evaluate(
      `window.renderMarkdown(${JSON.stringify(content)},${streaming},${JSON.stringify(identity)})`,
    )
    if (settle) await wait(45)
  }
  const first = '第一段中文，保持选择。\n\n'
  await render(first, true)
  await evaluate(
    `window.firstParagraph=document.querySelector('.workbench-demo-markdown p');window.firstText=firstParagraph.firstChild;const range=document.createRange();range.selectNodeContents(firstParagraph);getSelection().removeAllRanges();getSelection().addRange(range)`,
  )
  const code = '第二段 **增量粗体**。\n\n\`\`\`js\nconst value = "中文";'
  await render(first + code, true)
  assert.deepEqual(
    await evaluate(
      `({sameParagraph:document.querySelector('.workbench-demo-markdown p')===window.firstParagraph,sameText:window.firstParagraph.firstChild===window.firstText,selection:getSelection().toString(),code:document.querySelector('pre code')?.textContent})`,
    ),
    {
      sameParagraph: true,
      sameText: true,
      selection: '第一段中文，保持选择。',
      code: 'const value = "中文"',
    },
  )
  check('增量追加保持已完成段落、文本节点和选择区；未闭合代码围栏已可读')
  const table = '\n\`\`\`\n\n| 名称 | 值 |\n| --- | --- |\n| 中文 | 42 |\n\n末尾完成。'
  await render(first + code + table, true)
  const oldNodes = await evaluate(
    `window.table=document.querySelector('table');window.codeNode=document.querySelector('pre code');({tables:document.querySelectorAll('table').length,cells:[...document.querySelectorAll('td')].map(n=>n.textContent.trim()),copyButtons:document.querySelectorAll('[aria-label="复制代码"]').length})`,
  )
  assert.deepEqual(oldNodes, { tables: 1, cells: ['中文', '42'], copyButtons: 1 })
  await render(first + code + table, false, 'sample', false)
  assert.deepEqual(
    await evaluate(
      `({table:document.querySelector('table')===window.table,code:document.querySelector('pre code')===window.codeNode,tail:document.querySelector('.workbench-demo-markdown').textContent.endsWith('末尾完成。')})`,
    ),
    { table: true, code: true, tail: true },
  )
  check('完成立即 flush，中文尾字、代码和表格节点不重建')
  await browser.click('[aria-label="复制代码"]')
  assert.equal(await evaluate('window.copiedText'), 'const value = "中文";')
  check('shadcn 代码复制按钮读取实际完整代码')
  await render('新身份中文', true, 'new-identity', false)
  assert.ok(
    (await evaluate(`document.querySelector('.workbench-demo-markdown').textContent`)).startsWith(
      '新身份中',
    ),
  )
  assert.equal(await evaluate('document.querySelectorAll("pre").length'), 0)
  await render('内容已替换。', false, 'new-identity', false)
  assert.equal(
    await evaluate(`document.querySelector('.workbench-demo-markdown').textContent`),
    '内容已替换。',
  )
  check('切换身份与非追加修订清理旧 parser/工具条，首段及时显示')
  const unsafe =
    '[文件](/api/agent-demo/files/example) [外部](https://example.com) [阻止](javascript:alert%281%29)\n\n![阻止图片](data:image/svg+xml,test)\n\n<img src=x onerror=alert(1)> <script>alert(1)</script>'
  await render(unsafe, false, 'security')
  const safety = await evaluate(
    `({links:[...document.querySelectorAll('a')].map(n=>({text:n.textContent,href:n.getAttribute('href'),rel:n.rel})),scripts:document.querySelector('.workbench-demo-markdown').querySelectorAll('script,[onerror]').length,images:[...document.querySelectorAll('.workbench-demo-markdown img')].map(n=>n.getAttribute('src'))})`,
  )
  assert.ok(safety.links[0].href.endsWith('/api/agent-demo/files/example'))
  assert.equal(safety.links[1].href, 'https://example.com/')
  assert.equal(safety.links[2].href, null)
  assert.ok(safety.links.every((link) => link.rel === 'noopener noreferrer'))
  assert.equal(safety.scripts, 0)
  assert.deepEqual(safety.images, [null])
  check('资料链接保持可路由；危险 URL 与原始 HTML 不执行')
  // Several real updates within one render window must converge to the latest
  // text, then completion must synchronously expose the entire terminal text.
  await evaluate(
    `for(const text of ['一','一二','一二三','一二三四'])window.renderMarkdown(text,true,'burst');window.renderMarkdown('一二三四终',false,'burst')`,
  )
  assert.equal(
    await evaluate(`document.querySelector('.workbench-demo-markdown').textContent`),
    '一二三四终',
  )
  check('成批更新合并后不丢字，完成不等节流计时器')
  assert.deepEqual(browser.errors, [])
  await writeFile(
    path.join(browser.output, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        checks: browser.checks,
        modelCalls: 0,
        backendRequests: 0,
        dependency: 'streaming-markdown@0.2.15',
        completedAt: new Date().toISOString(),
        note: 'Isolated renderer DOM behavior, not model latency or full WebUI acceptance.',
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
