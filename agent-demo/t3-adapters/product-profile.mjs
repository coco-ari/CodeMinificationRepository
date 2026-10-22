const optionalCapabilities = [
  'planMode', 'threadFork', 'historyRollback', 'subagents', 'interactiveArtifacts',
  'usageDashboard', 'customKeybindings', 'advancedOrganization', 'automaticRecovery',
  'advancedSend', 'diagnostics', 'systemNotifications',
]
export const PRODUCT_CAPABILITY_DISABLED = 'AUTOOPS_PRODUCT_CAPABILITY_DISABLED'
export const PRODUCT_CAPABILITY_MESSAGE = '精简版暂不开放此操作，已有对话和资料仍可查看'
const liteServerSettings = Object.freeze({
  responseStreamingMode: 'paragraph', sidebarAutoSettleAfterDays: null,
  sidebarAutoSettleOnMerge: false, sidebarAutoSettleKeepPullRequests: false,
  autoResumeLimitedThreads: false, snoozeLimitedThreads: false,
  compactIdleThreads: false, continueThreadsAfterServerUpdate: false,
})
const liteClientSettings = Object.freeze({
  planModeEnabled: false, confirmThreadDelete: true, sidebarWorkingShelfEnabled: false,
  legacySidebarEnabled: false, notificationMode: 'off', composerRichTextEnabled: true,
  composerCollapseOnScroll: true,
})
const profiles = Object.freeze(Object.fromEntries(['t3-demo-full-v1', 'project-assistant-lite-v1'].map((id) => {
  const full = id === 't3-demo-full-v1'
  return [id, Object.freeze({
    id,
    capabilities: Object.freeze({
      externalAgents: false, shell: false, arbitraryFilesystem: false,
      businessWrites: false, scheduledTasks: false, onlineThemes: false,
      ...Object.fromEntries(optionalCapabilities.map((key) => [key, full])),
    }),
    serverSettingsOverrides: full ? Object.freeze({}) : liteServerSettings,
    clientSettingsOverrides: full ? Object.freeze({}) : liteClientSettings,
  })]
})))

/** Missing means the existing full product. An invalid deployment value never silently downgrades. */
export function resolveProductProfile(env = process.env) {
  const id = env.AUTOOPS_DEMO_PROFILE === undefined ? 't3-demo-full-v1' : env.AUTOOPS_DEMO_PROFILE
  if (!Object.hasOwn(profiles, id)) throw new Error(`未知的 AutoOps 产品配置：${id}`)
  return profiles[id]
}
