import { describe, expect, it, vi } from 'vite-plus/test'
import * as host from './hostConfig'
import {
  autoOpsCommandAllowed, autoOpsFeature, autoOpsRouteAllowed, autoOpsSettingAllowed,
  autoOpsShortcutAllowed, filterAutoOpsThreadMenu, isAutoOpsLite,
} from './capabilities'
import { getSettingsSearchTargetScope, searchSettings } from '../components/settings/settingsSearch'

function bootstrap(lite: boolean) {
  return {
    principal: { id: 'alice', displayName: 'Alice' },
    productProfile: { id: lite ? 'project-assistant-lite-v1' : 't3-demo-full-v1' },
    gatewayBasePath: '/api/agent-demo/t3', csrfToken: 'test-only',
    fixedModel: { instanceId: 'codex', model: 'configured-model' },
    runtimeMode: 'approval-required', projects: [], capabilities: {},
    httpBaseUrl: 'https://work.test/api/agent-demo/t3',
    wsBaseUrl: 'wss://work.test/api/agent-demo/t3/ws',
  } as NonNullable<ReturnType<typeof host.readAutoOpsHost>>
}

describe('AutoOps product profiles', () => {
  it('restores native model and reasoning shortcuts only for catalog-backed hosts', () => {
    using read = vi.spyOn(host, 'readAutoOpsHost').mockReturnValue(bootstrap(true))
    for (const command of ['modelPicker.toggle', 'composer.effort', 'composer.increaseEffort', 'composer.decreaseEffort']) {
      expect(autoOpsShortcutAllowed(command)).toBe(false)
    }
    read.mockReturnValue({ ...bootstrap(true), modelSelectionEnabled: true })
    expect(autoOpsFeature('modelSelection')).toBe(true)
    expect(autoOpsFeature('providerConfiguration')).toBe(false)
    for (const command of ['modelPicker.toggle', 'composer.effort', 'composer.increaseEffort', 'composer.decreaseEffort']) {
      expect(autoOpsShortcutAllowed(command)).toBe(true)
    }
    expect(autoOpsShortcutAllowed('composer.mode')).toBe(false)
  })
  it('retains standalone behavior and older full-host bootstrap compatibility', () => {
    using read = vi.spyOn(host, 'readAutoOpsHost').mockReturnValue(undefined)
    expect(isAutoOpsLite()).toBe(false)
    expect(autoOpsRouteAllowed('/settings/providers')).toBe(true)
    expect(autoOpsFeature('onlineThemes')).toBe(true)
    const { productProfile: _, ...oldHost } = bootstrap(false)
    read.mockReturnValue(oldHost)
    expect(autoOpsFeature('threadFork')).toBe(true)
    expect(autoOpsRouteAllowed('/settings/keybindings')).toBe(true)
    expect(autoOpsFeature('onlineThemes')).toBe(false)
    expect(autoOpsFeature('workspace')).toBe(false)
  })

  it('uses server feature declarations and falls back to the lite profile', () => {
    using read = vi.spyOn(host, 'readAutoOpsHost').mockReturnValue(bootstrap(true))
    expect(isAutoOpsLite()).toBe(true)
    for (const capability of ['planMode', 'threadFork', 'historyRollback', 'subagents',
      'interactiveArtifacts', 'usageDashboard', 'customKeybindings', 'advancedOrganization',
      'automaticRecovery', 'advancedSend', 'diagnostics', 'systemNotifications'] as const) {
      expect(autoOpsFeature(capability)).toBe(false)
    }
    read.mockReturnValue({ ...bootstrap(false), capabilities: { threadFork: false } })
    expect(autoOpsFeature('threadFork')).toBe(false)
  })

  it('blocks removed routes including direct links and leaves history restoration reachable', () => {
    using read = vi.spyOn(host, 'readAutoOpsHost').mockReturnValue(bootstrap(true))
    for (const route of ['/usage', '/usage/limits?period=day', '/settings/keybindings/',
      '/settings/providers', '/settings/projects', '/projects/host-checkout', '/connect', '/pull-requests']) {
      expect(autoOpsRouteAllowed(route)).toBe(false)
    }
    for (const route of ['/settings/general', '/settings/appearance#theme',
      '/settings/archived', '/settings/open-source-licenses', '/projects', '/projects?projectId=project-a']) {
      expect(autoOpsRouteAllowed(route)).toBe(true)
    }
  })

  it('keeps native appearance and sending controls while removing unsupported settings from search', () => {
    using read = vi.spyOn(host, 'readAutoOpsHost').mockReturnValue(bootstrap(true))
    for (const id of ['send-shortcut', 'follow-up-behavior', 'theme', 'color-scheme',
      'setting-appearance-contrast', 'setting-glass-opacity', 'chat-width', 'word-wrap',
      'math-rendering', 'panel-animations', 'interface-font', 'prompt-font', 'code-font']) {
      expect(autoOpsSettingAllowed(id)).toBe(true)
    }
    for (const id of ['default-model', 'default-permissions', 'new-threads', 'worktree-submodules',
      'composer-context', 'terminal-font', 'diff-color-scheme', 'mobile-app', 'privacy-policy',
      'legacy-plan-mode', 'continue-threads-after-server-update', 'auto-resume-limited-threads']) {
      expect(autoOpsSettingAllowed(id)).toBe(false)
    }
    expect(searchSettings('工作区')).toEqual([])
    expect(searchSettings('快捷键').map((item) => item.id)).toEqual(['send-shortcut'])
    expect(searchSettings('主题').map((item) => item.id)).toContain('theme')
    expect(getSettingsSearchTargetScope('compact-idle-threads')).toBeNull()
    expect(getSettingsSearchTargetScope('appearance')).toMatchObject({ scope: null })
  })

  it('preserves reverse transitions for old personal states without exposing new automation', () => {
    using read = vi.spyOn(host, 'readAutoOpsHost').mockReturnValue(bootstrap(true))
    expect(autoOpsSettingAllowed(undefined)).toBe(true)
    const items = filterAutoOpsThreadMenu([
      { id: 'pin' }, { id: 'unpin' }, { id: 'archive' }, { id: 'unarchive' },
      { id: 'snooze' }, { id: 'unsnooze' }, { id: 'settle' }, { id: 'unsettle' },
      { id: 'auto-settle' }, { id: 'regenerate-title' }, { id: 'discard' },
      { id: 'copy', children: [{ id: 'copy-path' }, { id: 'copy-thread-id' }] },
    ])
    expect(items.map((item) => item.id)).toEqual([
      'pin', 'unpin', 'archive', 'unarchive', 'unsnooze', 'unsettle', 'discard',
    ])
    expect(items.some(item => item.id === 'copy')).toBe(false)
    expect(filterAutoOpsThreadMenu<{ id: string; children?: ReadonlyArray<{ id: string }> }>([
      { id: 'copy', children: [{ id: 'copy-path' }] },
    ])).toEqual([])
  })

  it('keeps queue, steering, stop and native theme shortcuts without coding or advanced execution', () => {
    using read = vi.spyOn(host, 'readAutoOpsHost').mockReturnValue(bootstrap(true))
    for (const command of ['chat.new', 'chat.find', 'composer.stash', 'composer.sendAlternate',
      'thread.editQueuedMessage', 'thread.steerQueuedMessage', 'thread.stop', 'themeEditor.toggle']) {
      expect(autoOpsShortcutAllowed(command)).toBe(true)
    }
    for (const command of ['chat.newWithoutProject', 'chat.newLocal', 'composer.sendBackground',
      'composer.sendAndNewThread', 'composer.mode', 'thread.undo', 'thread.settle', 'preview.toggle',
      'usage.open', 'terminal.toggle', 'pullRequest.copyNumber']) {
      expect(autoOpsShortcutAllowed(command)).toBe(false)
    }
    expect(autoOpsCommandAllowed('action:new-thread-in:project')).toBe(true)
    expect(autoOpsCommandAllowed('action:theme-editor')).toBe(true)
    expect(autoOpsCommandAllowed('action:usage')).toBe(false)
    expect(autoOpsCommandAllowed('action:restart-agent-session')).toBe(false)
    expect(autoOpsCommandAllowed('action:copy-prompt-link')).toBe(false)
    expect(autoOpsCommandAllowed('action:copy-prompt-link-with-context')).toBe(false)
    expect(autoOpsCommandAllowed('action:copy-thread-reference')).toBe(false)
    expect(autoOpsShortcutAllowed('thread.copyReference')).toBe(false)
    expect(searchSettings('SKILL.md').map(item => item.id)).toContain('autoops-skills')
  })
})
