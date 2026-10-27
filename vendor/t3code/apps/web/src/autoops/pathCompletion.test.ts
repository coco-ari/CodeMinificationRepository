import { describe, expect, it } from 'vite-plus/test'
import {
  completeWorkspaceCommonPrefix,
  formatWorkspacePathQuery,
  workspaceRelativePath,
} from './pathCompletion'

const scope = {
  projectId: 'p-autoops',
  workspaceType: 'internal' as const,
  workspaceVersionId: 'version-1',
}
const root = 'autoops/p-autoops/workspaces/version-1/'
const file = (path: string) => ({ path: root + path, kind: 'file' as const })
const directory = (path: string) => ({ path: root + path, kind: 'directory' as const })

it('当前文件引用显示相对路径，不把线程和临时版本作为资料目录', () => {
  const alias =
    'autoops/p-autoops/current-input-files/source-thread/old-input/revision-2/docs/说明.md'
  expect(workspaceRelativePath(alias, scope)).toBe('docs/说明.md')
  expect(workspaceRelativePath(alias, { ...scope, workspaceType: 'external' })).toBe('docs/说明.md')
  expect(workspaceRelativePath(alias.replace('p-autoops', 'p-other'), scope)).toBeNull()
  expect(workspaceRelativePath(alias.replace('docs/说明.md', '../secret'), scope)).toBeNull()
})

describe('workspace path query completion', () => {
  it('resolves only complete paths inside the current immutable scope', () => {
    expect(workspaceRelativePath(root + 'frontend/package.json', scope)).toBe(
      'frontend/package.json',
    )
    expect(
      workspaceRelativePath(root + '需求 文档/说明.md', { ...scope, workspaceType: 'external' }),
    ).toBe('需求 文档/说明.md')
    for (const path of [
      root.slice(0, -1),
      root,
      root + 'frontend/',
      root + '../secret',
      root + 'frontend/./src',
      root + 'frontend//src',
      root + 'front\\end',
      root + 'frontend/../../secret',
      'autoops/other/workspaces/version-1/frontend',
      'autoops/p-autoops/workspaces/version-10/frontend',
      ...['\n', '\r', '\t', '\0', '\u007f', '\u0085', '\u2028', '\u2029'].map(
        (c) => root + '文' + c + '档',
      ),
    ])
      expect(workspaceRelativePath(path, scope)).toBeNull()
    expect(workspaceRelativePath(root + 'frontend', undefined)).toBeNull()
    expect(workspaceRelativePath(root + 'frontend', { projectId: scope.projectId })).toBeNull()
    expect(
      workspaceRelativePath(root + 'frontend', { ...scope, projectId: '../p-autoops' }),
    ).toBeNull()
  })

  it('formats partial Chinese, quoted and explicit relative paths without committing a token', () => {
    expect(formatWorkspacePathQuery('frontend/pack')).toBe('@frontend/pack')
    expect(formatWorkspacePathQuery('./frontend/')).toBe('@./frontend/')
    expect(formatWorkspacePathQuery('需求 文档/')).toBe('@"需求 文档/')
    expect(formatWorkspacePathQuery('文档/带"引号')).toBe('@"文档/带\\"引号')
    expect(formatWorkspacePathQuery('资料/@说明')).toBe('@"资料/@说明')
    for (const path of [
      '',
      './',
      '/root',
      '../secret',
      './a/../b',
      'a//b',
      'a\\b',
      'a\nb',
      'a\u2028b',
    ])
      expect(formatWorkspacePathQuery(path)).toBeNull()
  })

  it('extends only the common prefix and preserves an explicit ./ query', () => {
    const entries = [file('frontend/package.json'), file('frontend/package-lock.json')]
    expect(completeWorkspaceCommonPrefix(entries, 'frontend/pack', scope)).toBe('@frontend/package')
    expect(completeWorkspaceCommonPrefix(entries, './frontend/pack', scope)).toBe(
      '@./frontend/package',
    )
    expect(completeWorkspaceCommonPrefix(entries, 'frontend/package', scope)).toBeNull()
    expect(completeWorkspaceCommonPrefix(entries, 'frontend/package.', scope)).toBeNull()
    expect(completeWorkspaceCommonPrefix(entries, 'FRONTEND/pack', scope)).toBeNull()
    expect(
      completeWorkspaceCommonPrefix(entries, 'frontend/pack', scope, { truncated: true }),
    ).toBeNull()
    expect(
      completeWorkspaceCommonPrefix(entries, 'frontend/pack', scope, { truncated: false }),
    ).toBe('@frontend/package')
    expect(
      completeWorkspaceCommonPrefix([directory('docs'), file('docs/说明.md')], 'doc', scope),
    ).toBe('@docs/')
    expect(completeWorkspaceCommonPrefix([], '', scope)).toBeNull()
    expect(
      completeWorkspaceCommonPrefix([file('frontend/package.json')], 'front', scope),
    ).toBeNull()
  })

  it('uses Unicode code points and safely quotes a shared partial path', () => {
    expect(
      completeWorkspaceCommonPrefix(
        [file('需求 文档/甲.md'), file('需求 文档/乙.md')],
        '需求',
        scope,
      ),
    ).toBe('@"需求 文档/')
    expect(completeWorkspaceCommonPrefix([file('含"号/甲'), file('含"号/乙')], '含', scope)).toBe(
      '@"含\\"号/',
    )
    expect(completeWorkspaceCommonPrefix([file('文😀甲'), file('文😁乙')], '', scope)).toBe('@文')
    expect(completeWorkspaceCommonPrefix([file('😀甲'), file('😁乙')], '', scope)).toBeNull()
    expect(completeWorkspaceCommonPrefix([file('😀文件甲'), file('😀文件乙')], '😀', scope)).toBe(
      '@😀文件',
    )
  })

  it('fails closed when any candidate or query escapes its scope or contains unsafe characters', () => {
    const valid = file('frontend/package.json')
    for (const path of [
      'autoops/other/workspaces/version-1/frontend/package-lock.json',
      'autoops/p-autoops/workspaces/version-2/frontend/package-lock.json',
      root + 'frontend/../package-lock.json',
      root + 'frontend/package\n-lock.json',
      root + 'frontend/pack\\age',
    ])
      expect(
        completeWorkspaceCommonPrefix([valid, { path, kind: 'file' }], 'front', scope),
      ).toBeNull()
    const entries = [valid, file('frontend/package-lock.json')]
    for (const query of ['../front', '/front', '././front', 'front\\end', 'front\n', '\u2029front'])
      expect(completeWorkspaceCommonPrefix(entries, query, scope)).toBeNull()
    expect(completeWorkspaceCommonPrefix(entries, 'front', undefined)).toBeNull()
  })
})

it('当前资料候选使用不可变输入且不跨输入合并补全', () => {
  const scope = { projectId: 'p-current', workspaceType: 'internal' as const }
  expect(workspaceRelativePath('autoops/p-current/inputs/input-one/docs/需求.md', scope)).toBe(
    'docs/需求.md',
  )
  expect(workspaceRelativePath('autoops/p-other/inputs/input-one/docs/需求.md', scope)).toBeNull()
  expect(workspaceRelativePath('autoops/p-current/current/docs/需求.md', scope)).toBeNull()
  expect(
    completeWorkspaceCommonPrefix(
      [
        { path: 'autoops/p-current/inputs/input-one/docs/spec-a.md', kind: 'file' },
        { path: 'autoops/p-current/inputs/input-two/docs/spec-b.md', kind: 'file' },
      ],
      'docs/s',
      scope,
    ),
  ).toBeNull()
  expect(
    completeWorkspaceCommonPrefix(
      [
        { path: 'autoops/p-current/inputs/input-one/docs/spec-a.md', kind: 'file' },
        { path: 'autoops/p-current/inputs/input-one/docs/spec-b.md', kind: 'file' },
      ],
      'docs/s',
      scope,
    ),
  ).toBe('@docs/spec-')
})

it('保留旧绑定的对话继续使用当前输入候选，历史引用仍只允许原版本', () => {
  const entries = [
    { path: 'autoops/p-autoops/inputs/new-input/docs/甲.md', kind: 'file' as const },
    { path: 'autoops/p-autoops/inputs/new-input/docs/乙.md', kind: 'file' as const },
  ]
  expect(workspaceRelativePath(entries[0]!.path, scope)).toBe('docs/甲.md')
  expect(completeWorkspaceCommonPrefix(entries, 'doc', scope)).toBe('@docs/')
  expect(workspaceRelativePath(root + 'docs/原件.md', scope)).toBe('docs/原件.md')
  expect(
    workspaceRelativePath('autoops/p-autoops/workspaces/version-2/docs/原件.md', scope),
  ).toBeNull()
  expect(completeWorkspaceCommonPrefix([entries[0]!, file('docs/乙.md')], 'doc', scope)).toBeNull()
})
