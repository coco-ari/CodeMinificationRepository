import { afterEach, expect, it } from 'vite-plus/test'
import { DEFAULT_CLIENT_SETTINGS } from '@t3tools/contracts/settings'
import { installAutoOpsHost, type AutoOpsT3Bootstrap } from './hostConfig'
import { effectiveAutoOpsClientSettings } from './clientSettings'

const bootstrap: AutoOpsT3Bootstrap = {
  principal: { id: 'profile-preference-test', displayName: '测试' },
  gatewayBasePath: '/api/agent-demo/t3', csrfToken: 'test',
  fixedModel: { instanceId: 'codex', model: 'test-model' }, runtimeMode: 'approval-required',
  projects: [], capabilities: {},
}
afterEach(() => installAutoOpsHost({ ...bootstrap, productProfile: { id: 't3-demo-full-v1' } }, 'http://localhost'))

it('enforces the lite policy without erasing preferences or appearance when a profile is restored', () => {
  const saved = {
    ...DEFAULT_CLIENT_SETTINGS, planModeEnabled: true, confirmThreadDelete: false,
    legacySidebarEnabled: true, fontSizeInterface: 18, followUpBehavior: 'steer' as const,
  }
  installAutoOpsHost({ ...bootstrap, productProfile: { id: 'project-assistant-lite-v1' }, clientSettingsOverrides: {
    planModeEnabled: false, confirmThreadDelete: true, legacySidebarEnabled: false,
  } }, 'http://localhost')
  const effective = effectiveAutoOpsClientSettings(saved)
  expect(effective.planModeEnabled).toBe(false)
  expect(effective.confirmThreadDelete).toBe(true)
  expect(effective.legacySidebarEnabled).toBe(false)
  expect(effective.fontSizeInterface).toBe(18)
  expect(effective.followUpBehavior).toBe('steer')
  expect(effectiveAutoOpsClientSettings(saved)).toBe(effective)
  expect(saved.planModeEnabled).toBe(true)
  expect(saved.confirmThreadDelete).toBe(false)
  installAutoOpsHost({ ...bootstrap, productProfile: { id: 't3-demo-full-v1' } }, 'http://localhost')
  expect(effectiveAutoOpsClientSettings(saved)).toBe(saved)
})

it('rejects an unknown product profile instead of silently enabling advanced capabilities', () => {
  expect(() => installAutoOpsHost({ ...bootstrap, productProfile: { id: 'unknown' } } as unknown as AutoOpsT3Bootstrap, 'http://localhost')).toThrow('不支持当前产品配置')
})
