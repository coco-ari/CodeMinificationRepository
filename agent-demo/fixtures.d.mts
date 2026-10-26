import type { RuntimeProject, RuntimeAgent } from '../autoops/contracts/runtime.ts'
export const users: Array<{
  id: string
  username: string
  name: string
  role: string
  kind?: 'internal' | 'external'
  status?: string
}>
export const projects: RuntimeProject[]
export const agents: RuntimeAgent[]
export function contextFor(conversation: { projectId: string; environmentId: string }): unknown
