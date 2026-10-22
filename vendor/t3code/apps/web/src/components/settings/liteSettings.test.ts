import { describe, expect, it } from 'vite-plus/test'
import { DEFAULT_UNIFIED_SETTINGS } from '@t3tools/contracts/settings'
import { liteSettingsReset } from './liteSettings'
import { planScopedSettingsPatch } from './scopedSettings'

describe('lite preference restoration', () => {
  it('restores app motion to following the system without changing its independent panel duration', () => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, motionPreference: 'on' as const }
    expect(liteSettingsReset(settings, false)).toEqual({ labels: ['界面动效'], patch: { motionPreference: 'system' } })
  })
  it('restores exposed preferences without modifying hidden or server preferences', () => {
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      sendShortcut: 'mod-enter' as const,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity === 100 ? 75 : 100,
      defaultModelSelection: { instanceId: 'codex', model: 'must-not-reset' },
      responseStreamingMode: 'turn' as const,
      continueThreadsAfterServerUpdate: true,
      notificationMode: 'notifications-and-sound' as const,
      legacySidebarEnabled: true,
      fontFamilyTerminal: 'must-not-reset',
    }
    const { patch, labels } = liteSettingsReset(settings, false)
    expect(Object.keys(patch).sort()).toEqual(['glassOpacity', 'sendShortcut'])
    expect(labels).toEqual(['发送快捷键', '玻璃透明度'])
    const restored = { ...settings, ...patch }
    expect(restored.sendShortcut).toBe(DEFAULT_UNIFIED_SETTINGS.sendShortcut)
    expect(restored.glassOpacity).toBe(DEFAULT_UNIFIED_SETTINGS.glassOpacity)
    expect(restored.defaultModelSelection).toEqual(settings.defaultModelSelection)
    expect(restored.responseStreamingMode).toBe('turn')
    expect(restored.continueThreadsAfterServerUpdate).toBe(true)
    expect(restored.notificationMode).toBe('notifications-and-sound')
    expect(restored.legacySidebarEnabled).toBe(true)
    expect(restored.fontFamilyTerminal).toBe('must-not-reset')
  })

  it('produces a client-only native write plan even without a server connection', () => {
    const { patch } = liteSettingsReset({ ...DEFAULT_UNIFIED_SETTINGS, fontSizeInterface: 20 }, false)
    const plan = planScopedSettingsPatch({ kind: 'all', label: '全部环境', members: [], environmentIds: [] }, [], patch)
    expect(plan.hasClientWrite).toBe(true)
    expect(plan.unavailableReason).toBeNull()
    expect(plan.serverWrites).toEqual([])
    expect(plan.clientPatch).toEqual({ fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface })
  })

  it('resets platform-only font smoothing only where the control is available', () => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, fontSmoothing: !DEFAULT_UNIFIED_SETTINGS.fontSmoothing }
    expect(liteSettingsReset(settings, false).patch).not.toHaveProperty('fontSmoothing')
    expect(liteSettingsReset(settings, true).patch.fontSmoothing).toBe(DEFAULT_UNIFIED_SETTINGS.fontSmoothing)
  })

  it('has no write when exposed preferences already match defaults', () => {
    expect(liteSettingsReset(DEFAULT_UNIFIED_SETTINGS, true)).toEqual({ labels: [], patch: {} })
  })
})
