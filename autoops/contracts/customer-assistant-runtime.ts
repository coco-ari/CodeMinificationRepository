import * as S from 'effect/Schema'
import { AssistantSelection } from './assistants.ts'
import { CustomerAssistantSource } from './customer-source.ts'
import { DirectoryId } from './project-directory.ts'
import type { CustomerCapabilities, CustomerDevice, CustomerWorkspace } from './runtime.ts'

/** 仅按当前账号获分配的助手读取目录；不接收设备所有者或任意运行目标。 */
export const CustomerAssistantRuntimeRequest = S.Struct({
  projectId: DirectoryId,
  question: AssistantSelection,
})
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
