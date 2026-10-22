import type { ClientSettings } from '@t3tools/contracts/settings'
import { readAutoOpsHost } from './hostConfig'

type CachedSettings = {
  overrides: Readonly<Partial<ClientSettings>>
  effective: ClientSettings
}
const effectiveSnapshots = new WeakMap<ClientSettings, CachedSettings>()

/** Read policy without persisting it: switching profiles must reveal the user's original preferences. */
export function effectiveAutoOpsClientSettings(settings: ClientSettings): ClientSettings {
  const overrides = readAutoOpsHost()?.clientSettingsOverrides
  if (!overrides || Object.keys(overrides).length === 0) return settings
  const cached = effectiveSnapshots.get(settings)
  if (cached?.overrides === overrides) return cached.effective
  const effective = { ...settings, ...overrides }
  effectiveSnapshots.set(settings, { overrides, effective })
  return effective
}
