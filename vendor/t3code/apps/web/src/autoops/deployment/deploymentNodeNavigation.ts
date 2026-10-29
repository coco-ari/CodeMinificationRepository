export type NodePageView = 'details' | 'connect' | 'assign' | 'create'
export type NodeReturnContext = {
  from: 'projects' | 'deployments'
  projectId: string
  environmentId: string
}
export type NodePageSearch = {
  nodeId?: string
  nodeView?: NodePageView
  nodeSection?: 'connection' | 'assignments' | 'storage'
  from?: NodeReturnContext['from']
  returnProjectId?: string
  returnEnvironmentId?: string
}

export function nodeRouteId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error('节点页面定位无效，请从原项目环境重新进入。')
  return value
}

export function parseNodePageSearch(search: Record<string, unknown>): NodePageSearch {
  const result: NodePageSearch = {}
  if (search.nodeId !== undefined) result.nodeId = nodeRouteId(search.nodeId)
  if (search.nodeView !== undefined) {
    if (!['details', 'connect', 'assign', 'create'].includes(String(search.nodeView)))
      throw new Error('节点页面不存在。')
    result.nodeView = search.nodeView as NodePageView
    if (result.nodeView !== 'create' && !result.nodeId) throw new Error('缺少节点定位。')
  }
  if (search.nodeSection !== undefined) {
    if (
      !result.nodeId ||
      (result.nodeView && result.nodeView !== 'details') ||
      !['connection', 'assignments', 'storage'].includes(String(search.nodeSection))
    )
      throw new Error('节点配置分组无效。')
    result.nodeSection = search.nodeSection as NonNullable<NodePageSearch['nodeSection']>
  }
  if (
    search.from !== undefined ||
    search.returnProjectId !== undefined ||
    search.returnEnvironmentId !== undefined
  ) {
    if (search.from !== 'projects' && search.from !== 'deployments')
      throw new Error('节点返回位置无效。')
    result.from = search.from
    result.returnProjectId = nodeRouteId(search.returnProjectId)
    result.returnEnvironmentId = nodeRouteId(search.returnEnvironmentId)
  }
  return result
}

export function nodePageHref(
  search: Pick<NodePageSearch, 'nodeId' | 'nodeView' | 'nodeSection'> & Partial<NodeReturnContext>,
) {
  const values = Object.entries({
    nodeId: search.nodeId,
    nodeView: search.nodeView,
    nodeSection: search.nodeSection,
    from: search.from,
    returnProjectId: search.projectId,
    returnEnvironmentId: search.environmentId,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  const query = new URLSearchParams(values).toString()
  return `/nodes${query ? `?${query}` : ''}`
}

export function environmentNodesHref(context: NodeReturnContext) {
  return `/${context.from}?${new URLSearchParams({ projectId: context.projectId, nodeEnvironmentId: context.environmentId })}`
}
