import * as S from 'effect/Schema'
import { AssistantSelection } from './assistants.ts'
import { CustomerAssistantSource } from './customer-source.ts'
import { DirectoryId } from './project-directory.ts'
import type { CustomerCapabilities, CustomerDevice, CustomerWorkspace } from './runtime.ts'

/** 草稿按已分配助手读取；已保存会话按服务端绑定及当前会话权限读取，不接收所有者身份。 */
export const CustomerAssistantRuntimeRequest = S.Union([S.Struct({
  projectId: DirectoryId,
  question: AssistantSelection,
}), S.Struct({threadId: DirectoryId})])
export type CustomerAssistantRuntimeRequest = typeof CustomerAssistantRuntimeRequest.Type
export interface CustomerAssistantRuntime {
  target: typeof CustomerAssistantSource.Type
  profile: 'self' | 'linux-docker-readonly-v1'
  device: Pick<CustomerDevice, 'id' | 'label' | 'status' | 'online'>
  workspace: Pick<CustomerWorkspace, 'label' | 'status'>
  capabilities: Omit<CustomerCapabilities, 'sharedProfile'> | null
  available: boolean
  reason?: { code: string; message: string }
}
