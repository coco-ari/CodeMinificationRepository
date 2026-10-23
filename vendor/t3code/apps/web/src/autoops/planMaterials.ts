import { autoOpsRequest } from './apiClient'

export function saveAutoOpsPlan(
  threadId: string,
  name: string,
  contents: string,
): Promise<{ name: string; sourceUrl: string }> {
  return autoOpsRequest('/autoops/plan-materials', {
    label: '计划保存',
    body: { threadId, name, contents },
  })
}
