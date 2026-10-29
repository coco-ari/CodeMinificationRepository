import { expect, it } from 'vite-plus/test'
import { environmentNodesHref, nodePageHref, parseNodePageSearch } from './deploymentNodeNavigation'

it('节点深链接保留来源项目环境，刷新解析后能返回原环境', () => {
  for (const from of ['projects', 'deployments'] as const) {
    const href = nodePageHref({
      nodeId: 'node-one',
      nodeView: 'details',
      nodeSection: 'storage',
      from,
      projectId: 'p-one',
      environmentId: 'test',
    })
    const search = parseNodePageSearch(
      Object.fromEntries(new URL(href, 'https://isolated.invalid').searchParams),
    )
    expect(search.nodeId).toBe('node-one')
    expect(search.nodeSection).toBe('storage')
    expect(
      environmentNodesHref({
        from: search.from!,
        projectId: search.returnProjectId!,
        environmentId: search.returnEnvironmentId!,
      }),
    ).toBe(`/${from}?projectId=p-one&nodeEnvironmentId=test`)
  }
})

it('不接受任意返回地址、残缺上下文或无节点的配置定位', () => {
  expect(() =>
    parseNodePageSearch({
      from: 'https://other.invalid',
      returnProjectId: 'p-one',
      returnEnvironmentId: 'test',
    }),
  ).toThrow()
  expect(() => parseNodePageSearch({ from: 'projects', returnProjectId: 'p-one' })).toThrow()
  expect(() => parseNodePageSearch({ nodeView: 'details' })).toThrow()
  expect(() => parseNodePageSearch({ nodeId: '../other' })).toThrow()
  expect(() => parseNodePageSearch({ nodeId: 'node-one', nodeSection: '../outside' })).toThrow()
})
