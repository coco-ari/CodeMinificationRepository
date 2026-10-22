export interface LegacyImportOptions {
  snapshot: string
  target: string
  model: string
  restoredCodexHome?: string
}
export interface NativeImportInput {
  dbPath: string
  targetDirectory: string
  model: string
  createdAt: string
  projects: { id: string; name: string }[]
  threads: {
    threadId: string
    events: unknown[]
    proof: { verified: boolean; nativeThreadId?: string }
  }[]
}
export interface NativeImportWriter {
  attachment(input: {
    threadId: string
    stableKey: string
    name: string
    mime: string
    size: number
  }): {
    attachment: { type: string; id: string; name: string; mimeType: string; sizeBytes: number }
    relativePath: string
  }
  providerThreadId(nativeId: string): string
  runId(threadId: string, ordinal: number): string
  write(input: NativeImportInput): Promise<void>
}
export interface LegacyImportReport {
  format: string
  sourceManifestSha256: string
  sourceEventWatermark: number
  importedAt: string
  threadCount: number
  verifiedContinuations: number
  compatibilityReadOnly: { threadId: string; reason: string }[]
  heldQueuedRuns: number
  nativeProviderStarted: boolean
}
export function importLegacySnapshot(
  options: LegacyImportOptions,
  nativeWriter: NativeImportWriter,
): Promise<LegacyImportReport>
