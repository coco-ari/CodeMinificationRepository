import { describe, expect, it, vi } from 'vite-plus/test'
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from '@t3tools/contracts/settings'
import * as host from '../../autoops/hostConfig'
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsUpdate,
} from '../../hooks/useSettings'
import { persistLiteSettingsReset } from './liteSettings'

function setup() {
  const saved: ClientSettings = {
    ...DEFAULT_CLIENT_SETTINGS, fontSizeInterface: 20, planModeEnabled: true,
    legacySidebarEnabled: true, confirmThreadDelete: false, notificationMode: 'notifications',
  }
  __resetClientSettingsPersistenceForTests()
  __setClientSettingsForTests(saved)
  return saved
}

const liteHost: NonNullable<ReturnType<typeof host.readAutoOpsHost>> = {
  principal: { id: 'reset-test', displayName: '测试' },
  gatewayBasePath: '/api/agent-demo/t3', csrfToken: 'test', projects: [],
  fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required',
  capabilities: {}, productProfile: { id: 'project-assistant-lite-v1' },
  httpBaseUrl: 'https://work.test/api/agent-demo/t3', wsBaseUrl: 'wss://work.test/api/agent-demo/t3/ws',
  clientSettingsOverrides: { planModeEnabled: false, confirmThreadDelete: true, legacySidebarEnabled: false, notificationMode: 'off' },
}

describe('durable lite preference restoration', () => {
  it('waits for native persistence and merges only exposed fields into the original preference snapshot', async () => {
    const saved = setup()
    using read = vi.spyOn(host, 'readAutoOpsHost').mockReturnValue(liteHost)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const writing = new Promise<void>((resolve) => { started = resolve })
    let durable = saved
    let completed = false
    const reset = persistLiteSettingsReset(getClientSettings(), false, (update) =>
      persistClientSettingsUpdate(update, async (next) => {
        started()
        await held
        durable = next
      }),
    ).then(() => { completed = true })
    await writing
    expect(completed).toBe(false)
    expect(getClientSettings().fontSizeInterface).toBe(20)
    expect(durable).toBe(saved)
    release()
    await reset
    expect(completed).toBe(true)
    expect(durable.fontSizeInterface).toBe(DEFAULT_CLIENT_SETTINGS.fontSizeInterface)
    expect(durable.planModeEnabled).toBe(true)
    expect(durable.confirmThreadDelete).toBe(false)
    expect(durable.legacySidebarEnabled).toBe(true)
    expect(durable.notificationMode).toBe('notifications')
    expect(getClientSettings().planModeEnabled).toBe(false)
    read.mockReturnValue({ ...liteHost, productProfile: { id: 't3-demo-full-v1' }, clientSettingsOverrides: {} })
    expect(getClientSettings()).toEqual(durable)
  })

  it('rejects a failed write without publishing defaults and permits a later retry', async () => {
    const saved = setup()
    using read = vi.spyOn(host, 'readAutoOpsHost').mockReturnValue(liteHost)
    const failure = new Error('storage full')
    await expect(persistLiteSettingsReset(getClientSettings(), false, (update) =>
      persistClientSettingsUpdate(update, async () => { throw failure }),
    )).rejects.toBe(failure)
    expect(getClientSettings().fontSizeInterface).toBe(saved.fontSizeInterface)
    let durable = saved
    await persistLiteSettingsReset(getClientSettings(), false, (update) =>
      persistClientSettingsUpdate(update, async (next) => { durable = next }),
    )
    expect(getClientSettings().fontSizeInterface).toBe(DEFAULT_CLIENT_SETTINGS.fontSizeInterface)
    expect(durable.planModeEnabled).toBe(true)
    expect(durable.confirmThreadDelete).toBe(false)
  })

  it('does not write the client store for a theme-only restoration', async () => {
    setup()
    const persistUpdate = vi.fn<(update: (raw: ClientSettings) => ClientSettings) => Promise<ClientSettings>>()
    await persistLiteSettingsReset(DEFAULT_CLIENT_SETTINGS, false, persistUpdate)
    expect(persistUpdate).not.toHaveBeenCalled()
  })
})
