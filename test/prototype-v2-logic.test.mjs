import test from 'node:test'
import assert from 'node:assert/strict'
import { seedMaterials, demoSourceFiles } from '../web/src/prototype/v2/material-seed.js'
import {
  artifactBlockReason,
  descendantIds,
  documentPath,
  sanitizeFiles,
  simulatedCommit,
  stripGitFiles,
} from '../web/src/prototype/v2/material-utils.js'

test('源码去 Git 仅移除 .git 路径，保留项目配置和输入对象', () => {
  const input = [
    ...demoSourceFiles(),
    { name: 'vendor/library/.git/config', content: 'remote' },
    { name: '.gitmodules', content: 'submodule metadata' },
  ]
  const snapshot = structuredClone(input)
  const output = stripGitFiles(input)
  assert(!output.some((file) => file.name.split('/').includes('.git')))
  for (const name of ['.gitignore', '.gitattributes', '.github/workflows/ci.yml', '.gitmodules']) {
    assert(
      output.some((file) => file.name === name),
      `${name} 必须保留`,
    )
  }
  output[0].content = '修改输出不会污染输入'
  assert.deepEqual(input, snapshot)
})

test('脱敏覆盖常见配置、私钥与自定义规则，并且报告不泄露原值', () => {
  const input = [
    ...demoSourceFiles(),
    {
      name: 'key.pem',
      content: '-----BEGIN RSA PRIVATE KEY-----\nprivate-payload\n-----END RSA PRIVATE KEY-----',
    },
    {
      name: 'settings.json',
      content: '{"password": "unsafe-value", "token":"second-unsafe-value"}',
    },
    {
      name: 'credential.txt',
      content: 'ghp_123456789012345678901234567890123456\nAKIA1234567890123456',
    },
  ]
  const before = structuredClone(input)
  const result = sanitizeFiles(input, [
    { find: 'internal.example.invalid', replace: 'public.example.invalid' },
  ])
  const content = result.files.map((file) => file.content).join('\n')
  for (const original of [
    'fictional-db-password',
    'fictional-cache-password',
    'fictional-token',
    'fictional-access-key',
    'private-payload',
    'unsafe-value',
    'internal.example.invalid',
    'ghp_',
    'AKIA1234567890123456',
  ]) {
    assert(!content.includes(original), `输出仍含 ${original}`)
  }
  assert(content.includes('public.example.invalid'))
  assert(result.findings.some((item) => item.rule === '私钥块'))
  assert(!JSON.stringify(result.findings).includes('unsafe-value'))
  assert.deepEqual(input, before)
})

test('自定义替换按字面匹配，支持删除文本且忽略空规则', () => {
  const result = sanitizeFiles(
    [{ name: 'README.md', content: 'a.b aXb remove remove' }],
    [
      { find: 'a.b', replace: 'domain' },
      { find: 'remove', replace: '' },
      { find: '', replace: 'invalid' },
    ],
  )
  assert.equal(result.files[0].content, 'domain aXb  ')
  assert.equal(result.findings[1].count, 2)
})

test('已脱敏值及环境变量占位符不会被重复处理', () => {
  const result = sanitizeFiles([
    { name: '.env', content: 'PASSWORD=[REDACTED]\nAPI_TOKEN=${API_TOKEN}\n' },
  ])
  assert.equal(result.findings.length, 0)
  assert.equal(result.files[0].content, 'PASSWORD=[REDACTED]\nAPI_TOKEN=${API_TOKEN}\n')
})

test('产物运行中引用与保留部署版本阻止删除', () => {
  const artifact = { id: 'source-sol' }
  const project = { id: 'sol', services: [] }
  assert.match(
    artifactBlockReason(
      artifact,
      {
        tasks: [
          {
            id: 'task',
            projectId: 'sol',
            title: '发布 API',
            status: 'running',
            artifactIds: ['source-sol'],
          },
        ],
      },
      project,
    ),
    /运行中的任务/,
  )
  assert.match(
    artifactBlockReason(
      artifact,
      { tasks: [] },
      {
        ...project,
        services: [{ name: 'API', versions: [{ artifactId: 'source-sol', status: 'retained' }] }],
      },
    ),
    /保留版本/,
  )
})

test('已完成任务、历史会话、已移除部署版本不阻止删除', () => {
  const artifact = { id: 'source-sol' }
  const state = {
    tasks: [
      { projectId: 'sol', status: 'success', artifactIds: ['source-sol'] },
      { projectId: 'other', status: 'running', artifactIds: ['source-sol'] },
    ],
    conversations: [{ artifactIds: ['source-sol'] }],
  }
  const project = {
    id: 'sol',
    services: [
      {
        name: 'API',
        versions: [
          { artifactId: 'source-sol', status: 'removed' },
          { artifactId: 'source-sol', deleted: true },
        ],
      },
    ],
  }
  assert.equal(artifactBlockReason(artifact, state, project), '')
})

test('产物保护提示不能泄露私有任务标题和提示词', () => {
  const privatePrompt = '私有提示词：分析未公开项目采购计划'
  const reason = artifactBlockReason(
    { id: 'source-sol' },
    {
      tasks: [
        {
          id: 'private-task-identifier',
          projectId: 'sol',
          agentId: 'private-agent-identifier',
          title: privatePrompt,
          status: 'running',
          artifactIds: ['source-sol'],
        },
      ],
    },
    { id: 'sol', services: [] },
  )
  assert.match(reason, /运行中的任务/)
  assert(!reason.includes(privatePrompt))
  assert(!reason.includes('private-task-identifier'))
  assert(!reason.includes('private-agent-identifier'))
})

test('多层资料目录可递归定位，并避免异常循环无限遍历', () => {
  const { documents } = seedMaterials('sol')
  assert.equal(descendantIds(documents, 'folder-ops-sol').size, 3)
  assert.equal(
    documentPath(
      documents,
      documents.find((item) => item.id === 'doc-release-sol'),
    ),
    '运维手册/发布与回退/发布检查.txt',
  )
  const cycle = [
    { id: 'a', parentId: 'b', name: 'A' },
    { id: 'b', parentId: 'a', name: 'B' },
  ]
  assert.equal(descendantIds(cycle, 'a').size, 2)
  assert.equal(documentPath(cycle, cycle[0]), 'B/A')
})

test('示例源码具有完整提交号，默认脱敏产物与原始来源关联', () => {
  const seed = seedMaterials('sol')
  const raw = seed.artifacts.find((item) => item.id === 'source-sol')
  const sanitized = seed.artifacts.find((item) => item.id === 'sanitized-sol')
  assert.match(raw.commit, /^[a-f0-9]{40}$/)
  assert.equal(sanitized.commit, raw.commit)
  assert.equal(sanitized.sourceId, raw.id)
  assert.match(simulatedCommit('repo:main'), /^[a-f0-9]{40}$/)
  assert.equal(simulatedCommit('repo:main'), simulatedCommit('repo:main'))
})
