import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import React from 'react'
import { renderToString } from 'react-dom/server'

// The real JSX adapter and copied views are loaded through Vite's SSR compiler.
// No listener, Demo server, credentials, remote source, or model call is used.
const repository = fileURLToPath(new URL('..', import.meta.url))
let server, temporary, module
before(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'autoops-tool-parts-unit-'))
  server = await createServer({
    configFile: false,
    plugins: [react()],
    cacheDir: path.join(temporary, '.vite'),
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    resolve: { alias: { '@': path.join(repository, 'web/src') } },
  })
  module = await server.ssrLoadModule('/web/src/agent-demo/tool-parts.jsx')
})
after(async () => {
  await server?.close()
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

const turn = {
  context: {
    documents: [
      { id: 'doc-1', name: '设计说明.md', content: '# 设计', mime: 'text/markdown' },
      { id: 'doc-2', name: '环境检查手册.md', content: '# 检查', mime: 'text/markdown' },
    ],
    environment: { id: 'env-test', name: '测试环境' },
  },
}
const read = (id) => ({
  id: `read-${id}`,
  name: 'read_project_document',
  input: { id },
  status: 'completed',
})
const render = (step, props = {}) =>
  renderToString(React.createElement(module.ToolPart, { step, turn, ...props }))

test('连续读取保留独立调用与具体文件名，不伪造合并或双层折叠', () => {
  const first = render(read('doc-1'))
  const second = render(read('doc-2'))
  assert.match(first, /设计说明.md/)
  assert.match(second, /环境检查手册.md/)
  assert.match(first, /查看文件 设计说明.md/)
  assert.doesNotMatch(first + second, /参数与结果|aria-expanded|已完成 2 个步骤/)
})

test('授权资料快照和附件预览不采用工具传回的外部 sourceUrl', () => {
  const sourceUrl = 'https://attacker.invalid/collect?secret=not-real'
  const doc = module.toolPresentation({ ...read('doc-1'), output: { sourceUrl } }, turn)
  assert.deepEqual(doc.file, { ...turn.context.documents[0], projectDocument: true })
  const attachment = module.toolPresentation(
    {
      name: 'read_attachment',
      input: { id: 'file-1' },
      output: { id: 'file-1', name: 'notes.txt', content: 'notes', sourceUrl },
    },
    turn,
  )
  assert.deepEqual(attachment.file, {
    id: 'file-1',
    name: 'notes.txt',
    mime: 'text/plain',
    content: 'notes',
  })
  assert.equal(attachment.file.url, undefined)
  assert.equal(attachment.file.sourceUrl, undefined)
  assert.equal(module.toolPresentation(read('unknown'), turn).static, false)
})

test('自定义读取失败走单层错误详情，不能被静态文件链接吞掉', () => {
  const step = { ...read('doc-1'), status: 'failed', error: { message: '资料读取权限已变化' } }
  assert.equal(module.toolPresentation(step, turn).static, false)
  const collapsed = render(step)
  assert.match(collapsed, /is-error/)
  assert.match(collapsed, /aria-expanded="false"/)
  const expanded = render(step, { expanded: true })
  assert.match(expanded, /资料读取权限已变化/)
  assert.match(expanded, /Id: doc-1/)
  assert.doesNotMatch(expanded, /参数与结果/)
})

test('缺失或不完整旧记录不崩溃，报告工具保留真实业务语义', () => {
  for (const step of [undefined, null, false, [], 'missing']) assert.equal(render(step), '')
  assert.doesNotThrow(() => module.toolPresentation(undefined, { context: { documents: {} } }))
  assert.doesNotThrow(() => render({ id: 'legacy', name: null }))
  for (const name of ['create_report', 'report.create']) {
    const presentation = module.toolPresentation(
      { name, input: { name: '发布报告.md', content: '# 报告' } },
      turn,
    )
    assert.equal(presentation.name, '生成报告')
    assert.equal(presentation.kind, 'report')
    assert.equal(presentation.description, '发布报告.md')
    assert.equal(presentation.static, false)
    assert.doesNotMatch(render({ name, input: { name: '发布报告.md' } }), /写入文件/)
  }
  assert.equal(
    module.toolPresentation({ name: 'arbitrary_custom_tool' }, turn).name,
    'Arbitrary custom tool',
  )
})

test('通用结果沿用上游结构化、JSON 树与原文模式，强制展开适合搜索命中', () => {
  const step = {
    id: 'query-1',
    name: 'query_environment',
    status: 'completed',
    input: { environmentId: 'env-test' },
    output: { resources: [{ id: 'api', name: 'API 服务', status: 'healthy' }] },
  }
  const html = render(step, { expanded: true })
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /结构化结果/)
  assert.match(html, /JSON 树/)
  assert.match(html, /JSON 原文/)
  assert.match(html, /API 服务/)
  assert.match(html, /复制工具结果/)
  assert.doesNotMatch(html, /参数与结果/)
})

test('上游输出边界限制、JSON 识别与嵌套文本信封保留正确结果', () => {
  assert.equal(
    module.unwrapTextBlocks([{ type: 'text', text: '[{"type":"text","text":"hello"}]' }]),
    'hello',
  )
  assert.equal(module.unwrapTextBlocks([{ type: 'image', text: 'not-text' }]), null)
  assert.equal(module.tryParseJsonOutput('{bad').isJson, false)
  assert.equal(module.tryParseJsonOutput('{"a":1}').isJson, true)
  const capped = module.capToolOutputText('a'.repeat(600000))
  assert.ok(capped.length < 525000)
  assert.ok(capped.startsWith('a'.repeat(512 * 1024)))
  assert.match(capped, /output truncated/)
})
