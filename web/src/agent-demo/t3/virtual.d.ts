declare module 'virtual:autoops-t3-host' {
  import type { ComponentType, ComponentProps } from 'react'
  export const Button: ComponentType<
    ComponentProps<'button'> & { variant?: 'outline' | 'ghost' | 'default' }
  >
  export const Skeleton: ComponentType<ComponentProps<'div'>>
  export const Input: ComponentType<ComponentProps<'input'>>
  export const Label: ComponentType<ComponentProps<'label'>>
  export interface AutoOpsT3Bootstrap {
    principal: { id: string; displayName: string }
    gatewayBasePath: string
    csrfToken: string
    fixedModel: { instanceId: string; model: string }
    runtimeMode: 'approval-required'
    productProfile?: { id: 't3-demo-full-v1' | 'project-assistant-lite-v1' }
    clientSettingsOverrides?: Readonly<Record<string, unknown>>
    projects: Array<{
      id: string
      name: string
      environments: Array<{ id: string; name: string }>
      agents: Array<{ id: string; name: string }>
    }>
    initialRoute?: { environmentId: string; threadId: string }
    capabilities: Readonly<Record<string, unknown>>
  }
  export function installAutoOpsHost(value: AutoOpsT3Bootstrap, origin: string): unknown
}
declare module 'virtual:autoops-t3-runtime' {
  import type { ComponentType } from 'react'
  interface History {
    replace(path: string): void
  }
  interface Router {
    load(): Promise<void>
  }
  export const AppRoot: ComponentType<{ router: Router }>
  export function getRouter(history: History): Router
  export function createHashHistory(): History
}
