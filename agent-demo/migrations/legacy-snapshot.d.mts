export interface LegacySnapshotManifest {
  format: 'autoops-legacy-demo-snapshot-v1'
  createdAt: string
  quiesced: boolean
  cutoverEligible: boolean
  eventWatermark: number
  tables: Record<string, number>
  native: { index: number; path: string }[]
  files: { path: string; bytes: number; sha256: string }[]
}
export function createLegacySnapshot(options: {
  sourceDb: string
  destination: string
  nativeDirectories?: string[]
  quiesced?: boolean
}): Promise<LegacySnapshotManifest>
export function verifyLegacySnapshot(directory: string): Promise<LegacySnapshotManifest>
