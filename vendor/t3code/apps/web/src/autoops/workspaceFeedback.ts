/** 使用稳定错误码说明处理办法，不向用户暴露请求收据或远端错误原文。 */
export function workspaceFailureMessage(code: string | undefined, fallback: string) {
  switch (code) {
    case 'WORKSPACE_GIT_TIMEOUT':
      return '连接仓库超时，请重试。'
    case 'WORKSPACE_GIT_DNS_FAILED':
      return '无法连接仓库，请稍后重试。'
    case 'WORKSPACE_GIT_REF_NOT_FOUND':
      return '找不到所选分支或版本，请修改源码来源。'
    case 'WORKSPACE_GIT_FAILED':
      return '无法拉取仓库，请检查地址、凭证或网络。'
    case 'WORKSPACE_SYNC_FAILED':
      return '同步失败，请重试。'
    default:
      return fallback
  }
}
