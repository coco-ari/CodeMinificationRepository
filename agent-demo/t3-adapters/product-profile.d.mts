export type ProductProfileId = 't3-demo-full-v1' | 'project-assistant-lite-v1';
export const PRODUCT_CAPABILITY_DISABLED: 'AUTOOPS_PRODUCT_CAPABILITY_DISABLED';
export const PRODUCT_CAPABILITY_MESSAGE: string;
export interface ProductProfile {
  readonly id: ProductProfileId;
  readonly capabilities: Readonly<Record<'planMode' | 'threadFork' | 'historyRollback' | 'subagents' | 'interactiveArtifacts' | 'usageDashboard' | 'customKeybindings' | 'advancedOrganization' | 'automaticRecovery' | 'advancedSend' | 'diagnostics' | 'systemNotifications' | 'onlineThemes' | 'externalAgents' | 'shell' | 'arbitraryFilesystem' | 'businessWrites' | 'scheduledTasks', boolean>>;
  readonly serverSettingsOverrides: Readonly<Partial<{
    responseStreamingMode: 'paragraph' | 'turn'; sidebarAutoSettleAfterDays: number | null;
    sidebarAutoSettleOnMerge: boolean; sidebarAutoSettleKeepPullRequests: boolean;
    autoResumeLimitedThreads: boolean; snoozeLimitedThreads: boolean;
    compactIdleThreads: boolean; continueThreadsAfterServerUpdate: boolean;
  }>>;
  readonly clientSettingsOverrides: Readonly<Partial<{
    planModeEnabled: boolean; confirmThreadDelete: boolean; sidebarWorkingShelfEnabled: boolean;
    legacySidebarEnabled: boolean; notificationMode: 'off'; composerRichTextEnabled: boolean;
    composerCollapseOnScroll: boolean;
  }>>;
}
export function resolveProductProfile(env?: NodeJS.ProcessEnv): ProductProfile;
