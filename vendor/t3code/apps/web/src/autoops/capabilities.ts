import { readAutoOpsHost } from './hostConfig'

// D01–D13 in the approved AutoOps migration plan. Chat lifecycle, history,
// queue/steer, questions, approvals, files, artifacts and personal organization
// remain T3 features. Host administration and coding-workspace controls do not.
export const isAutoOpsHosted = () => readAutoOpsHost() !== undefined
export const isAutoOpsLite = () =>
  readAutoOpsHost()?.productProfile?.id === 'project-assistant-lite-v1'

export type AutoOpsFeature =
  | 'workspace' | 'externalAgents' | 'projectAdministration' | 'providerConfiguration' | 'modelSelection'
  | 'scheduledTasks' | 'planMode' | 'threadFork' | 'historyRollback' | 'subagents'
  | 'interactiveArtifacts' | 'usageDashboard' | 'customKeybindings' | 'advancedOrganization'
  | 'automaticRecovery' | 'advancedSend' | 'diagnostics' | 'systemNotifications' | 'onlineThemes'
export function autoOpsFeature(
  feature: AutoOpsFeature,
): boolean {
  const host = readAutoOpsHost()
  if (!host) return true
  if (feature === 'modelSelection') return host.modelSelectionEnabled === true || host.customerAgentsEnabled === true
  if (['workspace', 'externalAgents', 'projectAdministration', 'providerConfiguration'].includes(feature)) return false
  if (feature === 'scheduledTasks') return host.capabilities.scheduledTasks === true
  // The hosted CSP deliberately does not allow a third-party theme marketplace.
  if (feature === 'onlineThemes') return false
  const enabled = host.capabilities[feature]
  return typeof enabled === 'boolean' ? enabled : !isAutoOpsLite()
}
const hostedSettings = new Set([
  '/settings',
  '/settings/general',
  '/settings/appearance',
  '/settings/keybindings',
  '/settings/archived',
  '/settings/open-source-licenses',
])
export function autoOpsRouteAllowed(path: string): boolean {
  if (!isAutoOpsHosted()) return true
  const pathname = path.split(/[?#]/, 1)[0]!.replace(/\/+$/, '') || '/'
  if (pathname === '/usage' || pathname.startsWith('/usage/')) return autoOpsFeature('usageDashboard')
  if (pathname === '/settings/keybindings' && !autoOpsFeature('customKeybindings')) return false
  if (pathname.startsWith('/settings')) return hostedSettings.has(pathname)
  if (pathname === '/projects') return true
  return !['/connect', '/connect-agent', '/pair', '/welcome', '/pull-requests', '/projects'].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}
const excludedActions = new Set([
  'project-settings',
  'copy-path',
  'copy-branch',
  'new-thread-on-branch',
])
const liteThreadActions = new Set([
  'new-thread', 'rename', 'pin', 'unpin', 'archive', 'unarchive', 'delete', 'discard',
  'copy', 'copy-link', 'mark-unread', 'mark-read', 'unsnooze', 'unsettle',
])
export function filterAutoOpsThreadMenu<
  T extends { readonly id: string; readonly children?: ReadonlyArray<T> },
>(items: ReadonlyArray<T>): ReadonlyArray<T> {
  if (!isAutoOpsHosted()) return items
  return items
    .filter((item) => !excludedActions.has(item.id) && (!isAutoOpsLite() || liteThreadActions.has(item.id)))
    .map((item) =>
      item.children ? { ...item, children: filterAutoOpsThreadMenu(item.children) } : item,
    )
    .filter((item) => !item.children || item.children.length > 0)
}
export function autoOpsCommandAllowed(value: string): boolean {
  if (!isAutoOpsHosted()) return true
  if (isAutoOpsLite()) {
    if (value.startsWith('action:')) {
      return [
        'action:new-thread', 'action:new-thread-in',
        'action:change-theme', 'action:change-appearance', 'action:theme-editor', 'action:settings',
      ].some((prefix) => value === prefix || value.startsWith(`${prefix}:`))
    }
    if (value.startsWith('settings:')) return autoOpsRouteAllowed(value.slice('settings:'.length))
  }
  return ![
    'action:add-project',
    'action:new-project',
    'action:project-settings',
    'action:new-thread-without-project',
    'action:link-pull-request',
    'action:open-thread-pull-requests',
    'action:pull-requests',
    'action:open-file-picker',
    'action:search-project-contents',
    'action:restart-agent-session',
  ].some((prefix) => value === prefix || value.startsWith(`${prefix}:`))
}

const excludedSettings = new Set([
  'projects-and-threads',
  'text-generation',
  'provider-update-checks',
  'background-activity',
  'start-from-origin',
  'add-project-starts-in',
  'text-generation-model',
  'diagnostics',
  'hide-whitespace-changes',
  'default-diff-file-state',
  'diff-layout',
  'diff-color-scheme',
  'terminal-font',
  'skills-in-slash-menu',
  'auto-settle-merged-threads',
  'update-track',
  'environment-identification',
  'proactive-panels',
])
const liteSettings = new Set([
  'behavior', 'send-shortcut', 'follow-up-behavior',
  'autoops-runtime', 'autoops-model', 'autoops-permissions', 'autoops-skills', 'about', 'app-version',
  'settings-information', 'open-source-licenses', 'archive',
  'appearance', 'appearance-interface', 'color-scheme', 'theme',
  'setting-appearance-contrast', 'setting-glass-opacity', 'chat-width', 'math-rendering',
  'motion', 'motion-preference', 'panel-animations', 'typography', 'interface-font', 'prompt-font', 'code-font',
  'font-smoothing', 'word-wrap',
])
export function autoOpsSettingAllowed(id?: string): boolean {
  if (!isAutoOpsHosted()) return id !== 'autoops-skills'
  // Unnamed rows are structural content (including archived conversations), not
  // configurable settings. Their named parent section controls availability.
  if (!id) return true
  if (isAutoOpsLite()) return liteSettings.has(id)
  return !id || !excludedSettings.has(id)
}

const liteShortcuts = new Set([
  'chat.new', 'chat.find', 'composer.stash', 'composer.sendAlternate',
  'thread.editQueuedMessage', 'thread.steerQueuedMessage', 'thread.stop',
  'thread.previous', 'thread.next', 'thread.pin',
  'commandPalette.toggle', 'sidebar.toggle', 'navigation.back', 'navigation.forward',
  'rightPanel.toggle', 'rightPanel.close', 'threadPanel.toggle', 'view.reopenClosed',
  'theme.select', 'appearance.cycle', 'themeEditor.toggle',
])
export function autoOpsShortcutAllowed(command?: string | null): boolean {
  if (!isAutoOpsHosted() || !command) return true
  if (['composer.effort','composer.increaseEffort','composer.decreaseEffort','modelPicker.toggle'].includes(command)) return readAutoOpsHost()?.modelSelectionEnabled === true || readAutoOpsHost()?.customerAgentsEnabled === true
  if (isAutoOpsLite()) return liteShortcuts.has(command)
  return (
    !['terminal.', 'diff.', 'editor.', 'filePicker.', 'projectSearch.', 'script.'].some((prefix) =>
      command.startsWith(prefix),
    ) &&
    ![
      'composer.host',
      'composer.workspace',
      'composer.cycleHost',
      'composer.branch',
      'composer.previousWorktree',
      'composer.effort',
      'composer.increaseEffort',
      'composer.decreaseEffort',
      'modelPicker.toggle',
    ].includes(command)
  )
}
