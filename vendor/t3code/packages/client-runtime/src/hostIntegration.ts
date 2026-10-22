import type { ModelSelection, RuntimeMode } from '@t3tools/contracts'
/** Optional application boundary. Standalone T3 has no business host. */
export interface HostThreadLaunch {
  readonly threadId: string
  readonly projectId: string
}
export interface HostTurnConfiguration {
  readonly modelSelection?: ModelSelection
  readonly runtimeMode: RuntimeMode
}
export interface ClientHostIntegration {
  readonly turnConfiguration?: () => HostTurnConfiguration
  /** Runs before attachment persistence and native launch; failure aborts both. */
  readonly beforeThreadLaunch?: (input: HostThreadLaunch) => Promise<void>
}
let integration: ClientHostIntegration = {}
export function installClientHostIntegration(value: ClientHostIntegration): void {
  integration = value
}
export async function prepareHostThreadLaunch(input: HostThreadLaunch): Promise<void> {
  await integration.beforeThreadLaunch?.(input)
}

export function readHostTurnConfiguration(): HostTurnConfiguration | undefined {
  return integration.turnConfiguration?.()
}
