import type { AutoOpsT3Bootstrap } from 'virtual:autoops-t3-host'

/** 先完成原生会话映射，业务范围读取才能复用同一登录身份。 */
export async function loadHostBootstrap(signal: AbortSignal): Promise<AutoOpsT3Bootstrap | null> {
  const options = {
    credentials: 'same-origin' as const,
    signal,
    headers: { Accept: 'application/json' },
  }
  const session = await fetch('/api/agent-demo/t3/api/auth/session', options)
  if (session.status === 401) return null
  if (!session.ok) throw new Error('无法初始化对话登录状态')
  signal.throwIfAborted()
  const response = await fetch('/api/agent-demo/t3/autoops/bootstrap', options)
  if (response.status === 401) return null
  if (!response.ok) throw new Error('无法读取项目范围')
  return response.json() as Promise<AutoOpsT3Bootstrap>
}
