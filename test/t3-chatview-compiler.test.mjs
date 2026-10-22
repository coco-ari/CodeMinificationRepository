import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transformSync } from 'oxc-transform-react'
import { parse } from '../vendor/t3code/node_modules/.pnpm/@babel+parser@7.29.8/node_modules/@babel/parser/lib/index.js'

function compile(filename, source) {
  const result = transformSync(filename, source, {
    reactCompiler: { reportDiagnostics: true },
    jsx: { runtime: 'automatic', development: false },
  })
  assert.equal(result.fatal, false, JSON.stringify(result.errors, null, 2))
  return result
}

const refDiagnostics = (result) => result.errors.filter((error) =>
  /Cannot access refs during render/i.test(error.message) || /react-compiler\(Refs\)/.test(error.codeframe ?? ''))

function usesMemoCache(result, componentName) {
  const { program } = parse(result.code, { sourceType: 'module' })
  const bindings = new Set()
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'react/compiler-runtime') continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' &&
        ['c', 'useMemoCache'].includes(specifier.imported.name ?? specifier.imported.value)) bindings.add(specifier.local.name)
    }
  }
  const component = program.body.map((statement) =>
    statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement)
    .find((statement) => statement?.type === 'FunctionDeclaration' && statement.id?.name === componentName)
  assert(component?.body, `没有找到 ${componentName} 的编译结果`)
  return component.body.body.some((statement) => statement.type === 'VariableDeclaration' &&
    statement.declarations.some(({ init }) => init?.type === 'CallExpression' &&
      init.callee.type === 'Identifier' && bindings.has(init.callee.name)))
}

test('ChatView 保持 React Compiler 缓存，不因渲染期读取 ref 而退回未优化组件', async () => {
  const filename = new URL('../vendor/t3code/apps/web/src/components/ChatView.tsx', import.meta.url)
  const result = compile(filename.pathname, await readFile(filename, 'utf8'))
  assert.deepEqual(refDiagnostics(result), [], '渲染期 ref 读取会导致 T3 ChatView 被整段跳过编译')
  assert.equal(usesMemoCache(result, 'ChatView'), true, 'ChatView 必须保留实际编译缓存，不能静默退回未优化组件')
})

test('同一编译配置能识别 ref 违规并区分被跳过优化的组件', () => {
  const result = compile('UnsafeComposer.tsx', `
    import { useRef } from 'react'
    export default function UnsafeComposer() {
      const pending = useRef(false)
      return <button disabled={pending.current}>发送</button>
    }
  `)
  assert(refDiagnostics(result).length > 0)
  assert.equal(usesMemoCache(result, 'UnsafeComposer'), false)
})
