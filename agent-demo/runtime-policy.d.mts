export type Json = null | string | number | boolean | ReadonlyArray<Json> | { readonly [key: string]: Json };
export const RUNNER_CONFIG: Readonly<Record<string, Json>>;
export function buildRunnerConfig(options?: { provider?: string; providerBaseUrl?: string; model?: string }, reject?: (code: string, message: string, status?: number) => never): Readonly<Record<string, Json>>;
