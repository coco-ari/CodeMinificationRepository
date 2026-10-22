import { SettingsGroup } from './SettingsGroup'
import { autoOpsFeature, isAutoOpsHosted, isAutoOpsLite } from '~/autoops/capabilities'
import { readAutoOpsHost } from '~/autoops/hostConfig'
import { liteSettingsReset, persistLiteSettingsReset } from './liteSettings'
import { persistClientSettingsUpdate } from '../../hooks/useSettings'
import { settingsScopeEnvironmentLabels } from './settingsScopeAxis'
import { useScopedSettingsWriteAllowed } from './useScopedSettings'
import { Spinner } from '~/components/ui/spinner'
import { NotificationSettings } from './NotificationSettings'
import { PRIVACY_POLICY_URL } from '../../legalLinks'
import { ArchiveIcon, ArchiveX, CheckIcon, ChevronRightIcon, SettingsIcon } from 'lucide-react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  type BackgroundActivityProfile,
  type DesktopUpdateChannel,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
} from '@t3tools/contracts'
import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import { presentThreadShell } from '@t3tools/client-runtime/state/shell'
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type DiffLayout,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MAX_PROMPT_FONT_SIZE,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PANEL_ANIMATION_DURATION_MS,
  MIN_PROMPT_FONT_SIZE,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ResponseStreamingMode,
  MIN_TERMINAL_FONT_SIZE,
  type QuitConfirmationMode,
  SidebarProjectSortOrder,
} from '@t3tools/contracts/settings'
import { resolveServerBackgroundActivitySettings } from '@t3tools/shared/backgroundActivitySettings'
import { createModelSelection } from '@t3tools/shared/model'
import * as Duration from 'effect/Duration'
import * as Equal from 'effect/Equal'
import * as Schema from 'effect/Schema'
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from '../../branding'
import { CliCommandSettingsRow } from './CliCommandSettingsRow'
import { MobileAppSettingsRow } from './MobileAppSettingsRow'
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDisabledReason,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from '../../components/desktopUpdate.logic'
import { ProviderModelPicker } from '../chat/ProviderModelPicker'
import { TraitsPicker } from '../chat/TraitsPicker'
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from '../SidebarStageBackdrop'
import { isElectron } from '../../env'
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from '../../hostedPairing'
import { useCustomThemes } from '../../hooks/useCustomThemes'
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from '../../hooks/useTheme'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from './useScopedSettings'
import { useScopedModelDisabledReason } from './useScopedModelAvailability'
import { useSettingsScope } from './SettingsScopeContext'
import { ProjectDefaultsSettings } from './ProjectDefaultsSettings'
import { useThreadActions } from '../../hooks/useThreadActions'
import { useDesktopUpdateState } from '../../state/desktopUpdate'
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from '../../modelSelection'
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from '../../providerInstances'
import { ensureLocalApi, readLocalApi } from '../../localApi'
import { isMacPlatform } from '../../lib/utils'
import { useEnvironmentProviders } from '../../state/environments'
import { EMPTY_SERVER_PROVIDERS } from '../../state/server'
import { useArchivedThreadSnapshots } from '../../lib/archivedThreadsState'
import { RelativeTime } from '../RelativeTime'
import { Button } from '../ui/button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../ui/collapsible'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '../ui/dialog'
import { DraftInput } from '../ui/draft-input'
import { Input } from '../ui/input'
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  resolveDefaultFamilyLabel,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from '../../appearanceFonts'
import { CodeFontPreview, PromptFontPreview, TerminalFontPreview } from './SettingsFontPreviews'
import { discoverInstalledFonts, FontFamilyPicker, useFontEnumeration } from './FontFamilyPicker'
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from '../ui/number-field'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { ScopedSwitch } from './ScopedSwitch'
import { stackedThreadToast, toastManager } from '../ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import { ThemeLibrary } from './ThemeSettings'
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
  resolveBackgroundActivityProfileOption,
} from './SettingsPanels.logic'
import {
  PolicyTooltip,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTarget,
  useSettingsSearchTargetId,
} from './settingsLayout'
import { searchableSetting } from './settingsSearch'
import { ProjectFavicon } from '../ProjectFavicon'
import { PanelAnimationsPreview } from './PanelAnimationsPreview'
import { CustomerDevicesSettings } from '../../autoops/CustomerDevicesSettings'
import { AutoOpsSkillsSettings } from '../../autoops/SkillsSettings'

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: '图案',
  pill: '版本标签',
  none: '无',
}

const RESPONSE_STREAMING_MODE_LABELS: Record<ResponseStreamingMode, string> = {
  turn: '等待完整回复',
  paragraph: '显示已完成的段落',
}

const RESPONSE_STREAMING_MODE_DESCRIPTIONS: Record<ResponseStreamingMode, string> = {
  turn: 'Agent 完成本轮后显示文本。',
  paragraph: '每个段落或代码块完成后立即显示。',
}

const SIDEBAR_PROJECT_SORT_ORDER_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: '最近用户消息',
  created_at: '创建时间',
  manual: '手动',
}
const isSidebarProjectSortOrder = Schema.is(SidebarProjectSortOrder)

const TIMESTAMP_FORMAT_LABELS = {
  locale: '系统默认',
  '12-hour': '12 小时制',
  '24-hour': '24 小时制',
} as const

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: '舒适',
  wide: '宽',
  full: '全宽',
}

const DIFF_LAYOUT_LABELS: Record<DiffLayout, string> = {
  stacked: '上下排列',
  split: '左右并排',
}

const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, string> = {
  direct: '直接退出',
  hold: '长按',
  'double-click': '按两次',
}

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: '均衡',
  performance: '性能优先',
  'battery-saver': '省电',
}

type BackgroundActivityProfileOption = BackgroundActivityProfile | 'advanced'

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<BackgroundActivityProfileOption, string> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
  advanced: '高级',
}

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced: '客户端空闲、主机锁定或处于低电量模式时暂停探测。',
  performance: '只要有订阅的客户端保持连接，就允许在相应范围内进行后台探测。',
  'battery-saver': '主机或客户端使用电池时也会暂停后台探测。',
}

const ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION = '使用自定义间隔。'

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make('codex')
const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | 'pauseWhenHostLocked'
    | 'pauseWhenHostLowPower'
    | 'pauseWhenClientLowPower'
    | 'pauseWhenOnBattery'
  readonly label: string
}> = [
  { key: 'pauseWhenHostLocked', label: '主机锁定时暂停' },
  { key: 'pauseWhenHostLowPower', label: '主机低电量时暂停' },
  { key: 'pauseWhenClientLowPower', label: '客户端低电量时暂停' },
  { key: 'pauseWhenOnBattery', label: '使用电池时暂停' },
]

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  }
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  }
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>版本</span>
      <code className="text-2xs font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  )
}

function AboutVersionSection() {
  const updateState = useDesktopUpdateState()
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false)
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false)

  const hasDesktopBridge = typeof window !== 'undefined' && Boolean(window.desktopBridge)
  const selectedUpdateChannel = updateState?.channel ?? 'latest'
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL

  const handleUpdateChannelChange = (channel: DesktopUpdateChannel) => {
    const bridge = window.desktopBridge
    if (
      !bridge ||
      typeof bridge.setUpdateChannel !== 'function' ||
      channel === selectedUpdateChannel
    ) {
      return
    }

    setIsChangingUpdateChannel(true)
    void bridge
      .setUpdateChannel(channel)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: '无法切换更新通道',
            description: error instanceof Error ? error.message : '更新通道切换失败。',
          }),
        )
      })
      .finally(() => {
        setIsChangingUpdateChannel(false)
      })
  }

  const handleButtonClick = async () => {
    const bridge = window.desktopBridge
    if (!bridge) return

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : 'none'

    if (action === 'download') {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: '无法下载更新',
            description: error instanceof Error ? error.message : '下载失败。',
          }),
        )
      })
      return
    }

    if (action === 'install') {
      if (isUpdateActionPending) return
      setIsUpdateActionPending(true)
      let confirmed = false
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
        )
      } catch (error) {
        setIsUpdateActionPending(false)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: '无法确认更新',
            description: error instanceof Error ? error.message : '更新确认失败。',
          }),
        )
        return
      }
      if (!confirmed) {
        setIsUpdateActionPending(false)
        return
      }
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title: '无法安装更新',
              description: error instanceof Error ? error.message : '安装失败。',
            }),
          )
        })
        .finally(() => setIsUpdateActionPending(false))
      return
    }

    if (typeof bridge.checkForUpdate !== 'function') return
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title: '无法检查更新',
              description: result.state.message ?? '此版本不支持自动更新。',
            }),
          )
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: '无法检查更新',
            description: error instanceof Error ? error.message : '检查更新失败。',
          }),
        )
      })
  }

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : 'none'
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null
  const buttonDisabled =
    action === 'none' ? !canCheckForUpdate(updateState) : isDesktopUpdateButtonDisabled(updateState)

  const actionLabel: Record<string, string> = { download: '下载', install: '安装' }
  const statusLabel: Record<string, string> = {
    checking: '正在检查…',
    downloading: '正在下载…',
    'up-to-date': '已是最新版本',
  }
  const buttonLabel = actionLabel[action] ?? statusLabel[updateState?.status ?? ''] ?? '检查更新'
  const description =
    action === 'download' || action === 'install'
      ? '有可用更新。'
      : (getDesktopUpdateDisabledReason(updateState) ?? '当前应用版本。')

  return (
    <>
      <SettingsRow
        id={searchableSetting('app-version').id}
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={buttonDisabled || isUpdateActionPending}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          {...searchableSetting('update-track')}
          description="使用稳定版或每日构建版。可随时切换回来。"
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel)
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="更新通道"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === 'nightly' ? '每日构建版' : '稳定版'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  稳定版
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  每日构建版
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          {...searchableSetting('update-track')}
          description="切换托管应用的发布通道。"
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                )
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="更新通道">
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  最新
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  每日构建版
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {hasDesktopBridge ? <CliCommandSettingsRow /> : null}
    </>
  )
}

export function useSettingsRestore(onRestored?: () => void) {
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setAppearanceMode,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme()
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  )
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings)

  const changedSettingLabels = isAutoOpsLite() ? [
    ...(theme !== 'system' ? ['主题'] : []),
    ...(!followSystem ? ['跟随系统'] : []),
    ...(themeHalves !== null ? ['主题混合'] : []),
    ...liteSettingsReset(settings, isMacPlatform(navigator.platform)).labels,
  ] : [
    ...(theme !== 'system' ? ['主题'] : []),
    ...(!followSystem ? ['跟随系统'] : []),
    ...(themeHalves !== null ? ['主题混合'] : []),
    ...(settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast
      ? ['对比度']
      : []),
    ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ['玻璃透明度'] : []),
    ...(settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? ['差异颜色'] : []),
    ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? ['对话宽度'] : []),
    ...(settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled
      ? ['数学公式渲染']
      : []),
    ...(settings.motionPreference !== DEFAULT_UNIFIED_SETTINGS.motionPreference ? ['界面动效'] : []),
    ...(settings.panelAnimationDurationMs !== DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs
      ? ['面板动画']
      : []),
    ...(settings.environmentIdentificationMode !==
    DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
      ? ['环境标识']
      : []),
    ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? ['时间格式'] : []),
    ...(settings.notificationMode !== DEFAULT_UNIFIED_SETTINGS.notificationMode
      ? ['对话通知']
      : []),
    ...(settings.inAppNotificationsEnabled !== DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled
      ? ['应用内通知']
      : []),
    ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
      ? ['可见对话']
      : []),
    ...(settings.sidebarProjectGroupingMode !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
      ? ['项目分组']
      : []),
    ...(settings.sidebarProjectSortOrder !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder
      ? ['项目顺序']
      : []),
    ...(settings.sidebarWorkingShelfEnabled !== DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled
      ? ['执行中分区']
      : []),
    ...(settings.sidebarAutoSettleAfterDays !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
      ? ['自动收起不活跃对话']
      : []),
    ...(settings.sidebarAutoSettleKeepPullRequests !==
    DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests
      ? ['保留关联拉取请求的对话']
      : []),
    ...(settings.sidebarAutoSettleOnMerge !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge
      ? ['合并后自动收起对话']
      : []),
    ...(settings.autoResumeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads
      ? ['额度恢复后自动继续对话']
      : []),
    ...(settings.snoozeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads
      ? ['暂缓受额度限制的对话']
      : []),
    ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ['自动换行'] : []),
    ...(settings.persistComposerContextStrip !==
    DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip
      ? ['输入框上下文']
      : []),
    ...getChangedTypographySettingLabels(settings),
    ...(settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed
      ? ['差异文件默认状态']
      : []),
    ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
      ? ['空白字符差异']
      : []),
    ...(settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? ['差异布局'] : []),
    ...(settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled
      ? ['自动打开面板']
      : []),
    ...(settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu
      ? ['在斜杠菜单中显示技能']
      : []),
    ...(settings.composerCollapseOnScroll !== DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll
      ? ['滚动时收起输入框']
      : []),
    ...(settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled
      ? ['富文本输入框']
      : []),
    ...(settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? ['发送快捷键'] : []),
    ...(settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior
      ? ['追问处理方式']
      : []),
    ...(settings.contextWindowMeterEnabled !== DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled
      ? ['上下文窗口指示器']
      : []),
    ...(settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode
      ? ['回复流式显示']
      : []),
    ...(settings.enableProviderUpdateChecks !== DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
      ? ['检查提供方更新']
      : []),
    ...(settings.continueThreadsAfterServerUpdate !==
    DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate
      ? ['重启后继续对话']
      : []),
    ...(isBackgroundActivityDirty ? ['后台活动'] : []),
    ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
      ? ['新对话模式']
      : []),
    ...(settings.newWorktreesStartFromOrigin !==
    DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
      ? ['从远程创建新工作树']
      : []),
    ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
      ? ['添加项目的起始目录']
      : []),
    ...(settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin
      ? ['取消置顶确认']
      : []),
    ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
      ? ['归档确认']
      : []),
    ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
      ? ['删除确认']
      : []),
    ...(settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? ['退出快捷键'] : []),
    ...(isTextGenerationModelDirty ? ['文本生成模型'] : []),
    ...getChangedBrowserSettingLabels(settings),
    ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
      ? ['Agent 浏览器访问']
      : []),
  ]

  const restoreDefaults = async () => {
    if (changedSettingLabels.length === 0) return
    const api = readLocalApi()
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ['恢复默认设置？', `将重置以下设置： ${changedSettingLabels.join(', ')}.`].join('\n'),
      { variant: 'destructive' },
    )
    if (!confirmed) return

    // Only touch the theme keys that are actually dirty, so a theme-storage
    // failure cannot block restoring unrelated settings. Preferences are
    // re-read after the confirmation dialog: they may have changed (another
    // tab, an OS flip) while it was open, and rollback must restore the live
    // values rather than the ones captured at render time.
    let previousTheme = theme
    try {
      previousTheme = readThemePreference()
    } catch {}
    const liveHalves = readThemeHalves()
    const needsThemeReset = previousTheme !== 'system'
    const needsMixReset = liveHalves !== null
    const previousAppearanceMode = readAppearanceModePreference(previousTheme)
    const needsFollowSystemReset = previousAppearanceMode !== 'system'
    const notifyThemeRestoreFailure = () => {
      toastManager.add(
        stackedThreadToast({
          type: 'error',
          title: '无法恢复主题设置',
          description: '请重试。',
        }),
      )
    }
    // Rollback restores the base preference first (which clears any mix) and
    // then re-applies the captured mix on top, so no failure path can leave
    // the pair of keys half-restored.
    const previousHalves = liveHalves
    const rollbackThemeState = () => {
      let restored = true
      if (needsThemeReset) restored = setTheme(previousTheme) && restored
      if (previousHalves?.light) restored = setThemeHalf('light', previousHalves.light) && restored
      if (previousHalves?.dark) restored = setThemeHalf('dark', previousHalves.dark) && restored
      if (isAutoOpsLite() && needsFollowSystemReset) {
        restored = setAppearanceMode(previousAppearanceMode) && restored
      }
      return restored
    }
    if (needsThemeReset && !setTheme('system')) {
      notifyThemeRestoreFailure()
      return
    }
    if (needsMixReset && !clearThemeHalves()) {
      rollbackThemeState()
      notifyThemeRestoreFailure()
      return
    }
    if (needsFollowSystemReset && !setFollowSystem(true)) {
      rollbackThemeState()
      notifyThemeRestoreFailure()
      return
    }
    if (isAutoOpsLite()) {
      try {
        await persistLiteSettingsReset(
          settings, isMacPlatform(navigator.platform), persistClientSettingsUpdate,
        )
      } catch {
        const themeRestored = rollbackThemeState()
        toastManager.add(stackedThreadToast({
          type: 'error',
          title: '未恢复默认设置',
          description: themeRestored
            ? '无法保存本地设置，已保留原有偏好。请重试。'
            : '无法保存本地设置，且部分主题选择未能恢复。请重新加载页面后检查。',
        }))
        return
      }
      onRestored?.()
      return
    }
    updateSettings({
      appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
      diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
      chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,
      mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
      motionPreference: DEFAULT_UNIFIED_SETTINGS.motionPreference,
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      notificationMode: DEFAULT_UNIFIED_SETTINGS.notificationMode,
      inAppNotificationsEnabled: DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      persistComposerContextStrip: DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
      diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout,
      proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
      composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
      composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
      sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut,
      followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
      contextWindowMeterEnabled: DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
      sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
      sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
      sidebarAutoSettleKeepPullRequests: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests,
      sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
      autoResumeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads,
      snoozeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
      responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      continueThreadsAfterServerUpdate: DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
      confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
      fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
      fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
      fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
      fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
      fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
      fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
      fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
      browserDefaultViewport: DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
      browserDefaultZoomFactor: DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor,
      browserDefaultAppearance: DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance,
      browserRecordingFrameRate: DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate,
      browserRecordingShowKeyPresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowKeyPresses,
      browserRecordingShowMousePresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowMousePresses,
      browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget,
      browserSearchEngine: DEFAULT_UNIFIED_SETTINGS.browserSearchEngine,
      browserCustomSearchUrl: DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl,
      browserAutoShowFloatingPreview: DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
      pullRequestLinksOpenInApp: DEFAULT_UNIFIED_SETTINGS.pullRequestLinksOpenInApp,
      enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
    })
    onRestored?.()
  }

  return {
    changedSettingLabels,
    restoreDefaults,
  }
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const canWriteSettings = useScopedSettingsWriteAllowed()
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings)
  const activeProfile = resolvedBackgroundActivity.profile
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  )
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  )
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  )
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  )

  return (
    <Dialog open={open && canWriteSettings} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>后台活动</DialogTitle>
          <DialogDescription>调整共享电源策略及其后台检查间隔。</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset
            disabled={!canWriteSettings}
            className="min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground"
          >
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">共享策略</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  控制订阅的间隔触发后是否允许执行后台任务。
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === 'balanced' ||
                    value === 'performance' ||
                    value === 'battery-saver'
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    })
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="共享后台策略">
                  <SelectValue>{BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS['battery-saver']}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {searchableSetting('git-fetch-interval').title}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  在后台刷新远程分支状态。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          automaticGitFetchInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="缩短 Git 拉取间隔" />
                    <NumberFieldInput aria-label="Git 拉取间隔（秒）" />
                    <NumberFieldIncrement aria-label="延长 Git 拉取间隔" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">提供方健康检查间隔</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  刷新提供方可用性、版本和认证状态。模型目录更新遵循“检查提供方更新”设置。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          providerHealthRefreshInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="缩短提供方健康检查间隔" />
                    <NumberFieldInput aria-label="提供方健康检查间隔（秒）" />
                    <NumberFieldIncrement aria-label="延长提供方健康检查间隔" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">主机电源监测</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  客户端活跃时轮询主机电源状态。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorActiveInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="缩短活跃时主机电源检查间隔" />
                    <NumberFieldInput aria-label="活跃时主机电源检查间隔（秒）" />
                    <NumberFieldIncrement aria-label="延长活跃时主机电源检查间隔" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">空闲主机监测</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  没有活跃的前台客户端时轮询主机电源状态。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorIdleInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="缩短空闲时主机电源检查间隔" />
                    <NumberFieldInput aria-label="空闲时主机电源检查间隔（秒）" />
                    <NumberFieldIncrement aria-label="延长空闲时主机电源检查间隔" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-r sm:even:border-r-0"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <Switch
                    checked={resolvedBackgroundActivity[key]}
                    onCheckedChange={(checked) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            [key]: Boolean(checked),
                          },
                        ),
                      )
                    }
                    aria-label={label}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canWriteSettings}
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            全部重置
          </Button>
          <Button onClick={() => onOpenChange(false)}>完成</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

export function AppearanceSettingsPanel() {
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme()
  const customThemes = useCustomThemes()
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false)
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  const environmentStageLabel = useEnvironmentStageLabel()
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY)
  const glassOpacitySliderStyle = {
    '--settings-slider-progress': `${glassOpacityRatio * 100}%`,
    '--settings-slider-fill-offset': `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST)
  const appearanceContrastSliderStyle = {
    '--settings-slider-progress': `${appearanceContrastRatio * 100}%`,
    '--settings-slider-fill-offset': `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS)
  const panelAnimationDurationSliderStyle = {
    '--settings-slider-progress': `${panelAnimationDurationRatio * 100}%`,
    '--settings-slider-fill-offset': `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title="颜色与主题" variant="plain" hideTitle>
        <div id={searchableSetting('theme').id}>
          <ThemeLibrary
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setAppearanceMode={setAppearanceMode}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="appearance-interface" title="界面">
        <SettingsRow
          {...searchableSetting('setting-appearance-contrast')}
          description="调整界面颜色和边框的对比度。"
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label="contrast"
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast"
              >
                {settings.appearanceContrast}%
              </output>
              <input
                aria-label="对比度"
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value)
                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast })
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting('setting-glass-opacity')}
          description="数值越高，菜单、对话框和输入框越不透明。"
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="玻璃透明度"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="玻璃透明度"
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value)
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity })
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        {showEnvironmentIdentification ? (
          <SettingsRow
            {...searchableSetting('environment-identification')}
            description="选择开发环境和每日构建环境的标识方式。"
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label="环境标识"
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  if (value === 'artwork' || value === 'pill' || value === 'none') {
                    updateSettings({ environmentIdentificationMode: value })
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="环境标识">
                  <SelectValue>
                    {ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}

        <SettingsRow
          {...searchableSetting('diff-color-scheme')}
          description="选择新增和删除内容的颜色，包括变更计数。"
          resetAction={
            settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? (
              <SettingResetButton
                label="差异颜色"
                onClick={() =>
                  updateSettings({ diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.diffColorScheme}
                onValueChange={(value) => {
                  if (value === 'red-green' || value === 'blue-orange')
                    updateSettings({ diffColorScheme: value })
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="差异颜色">
                  <span
                    aria-hidden="true"
                    className={
                      settings.diffColorScheme === 'blue-orange'
                        ? 'flex shrink-0 flex-row-reverse gap-1'
                        : 'flex shrink-0 gap-1'
                    }
                  >
                    <span className="size-2 rounded-full bg-diff-deletion" />
                    <span className="size-2 rounded-full bg-diff-addition" />
                  </span>
                  <SelectValue>
                    {settings.diffColorScheme === 'blue-orange' ? '蓝色与橙色' : '红色与绿色'}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="red-green">红色与绿色（默认）</SelectItem>
                  <SelectItem value="blue-orange">蓝色与橙色</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting('composer-context')}
          description="对话开始后，在输入框下方保留分支和工作树控件。"
          resetAction={
            settings.persistComposerContextStrip !==
            DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip ? (
              <SettingResetButton
                label="输入框上下文"
                onClick={() =>
                  updateSettings({
                    persistComposerContextStrip:
                      DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.persistComposerContextStrip}
              onCheckedChange={(checked) =>
                updateSettings({ persistComposerContextStrip: Boolean(checked) })
              }
              aria-label="在活跃对话中保持输入框上下文可见"
            />
          }
        />

        <SettingsRow
          {...searchableSetting('chat-width')}
          description="设置大屏幕上消息和输入框的最大宽度。"
          resetAction={
            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
              <SettingResetButton
                label="对话宽度"
                onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.chatWidth}
                onValueChange={(value) => {
                  if (value === 'comfortable' || value === 'wide' || value === 'full')
                    updateSettings({ chatWidth: value })
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="对话宽度">
                  <SelectValue>{CHAT_WIDTH_LABELS[settings.chatWidth]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="comfortable">舒适（默认）</SelectItem>
                  <SelectItem value="wide">宽</SelectItem>
                  <SelectItem value="full">全宽</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting('math-rendering')}
          description="在消息和 Markdown 预览中排版 LaTeX 公式，例如 $x^2$ 或 \\[x^2\\]。输入框中仍可编辑 TeX 源码。"
          resetAction={
            settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled ? (
              <SettingResetButton
                label="数学公式渲染"
                onClick={() =>
                  updateSettings({
                    mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.mathRenderingEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ mathRenderingEnabled: Boolean(checked) })
              }
              aria-label="数学公式渲染"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="motion" title="动画">
        <SettingsRow
          {...searchableSetting('motion-preference')}
          description="控制思考、加载及界面过渡动效。选择开启后，即使系统关闭动画，工作台仍显示动效。"
          resetAction={settings.motionPreference !== DEFAULT_UNIFIED_SETTINGS.motionPreference ? (
            <SettingResetButton label="界面动效" onClick={() => updateSettings({ motionPreference: DEFAULT_UNIFIED_SETTINGS.motionPreference })} />
          ) : null}
          control={
            <Select value={settings.motionPreference} onValueChange={(value) => {
              if (value === 'system' || value === 'on' || value === 'off') updateSettings({ motionPreference: value })
            }}>
              <SelectTrigger size="sm" className="w-full min-w-0 sm:w-44" aria-label="界面动效">
                <SelectValue>{{ system: '跟随系统', on: '开启动效', off: '关闭动效' }[settings.motionPreference]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="system">跟随系统</SelectItem>
                <SelectItem value="on">开启动效</SelectItem>
                <SelectItem value="off">关闭动效</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting('panel-animations')}
          description="设置面板打开和关闭的速度。"
          control={
            <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
              <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
              <div className="flex w-full items-center gap-3">
                <output
                  className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="panel-animation-duration"
                >
                  {settings.panelAnimationDurationMs} ms
                </output>
                <input
                  aria-label="面板动画时长"
                  className="settings-slider min-w-0 flex-1"
                  id="panel-animation-duration"
                  max={MAX_PANEL_ANIMATION_DURATION_MS}
                  min={MIN_PANEL_ANIMATION_DURATION_MS}
                  onChange={(event) => {
                    const panelAnimationDurationMs = Number(event.currentTarget.value)
                    if (
                      Number.isInteger(panelAnimationDurationMs) &&
                      panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                      panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                    ) {
                      updateSettings({ panelAnimationDurationMs })
                    }
                  }}
                  step={25}
                  style={panelAnimationDurationSliderStyle}
                  type="range"
                  value={settings.panelAnimationDurationMs}
                />
              </div>
            </div>
          }
          resetAction={
            settings.panelAnimationDurationMs !==
            DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
              <SettingResetButton
                label="面板动画"
                onClick={() =>
                  updateSettings({
                    panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                  })
                }
              />
            ) : null
          }
        />
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  )
}

function useFontDefaultFamilies() {
  const settings = useScopedSettings()
  const [defaults] = useState(() => ({
    sans: resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ?? '系统默认',
    code: resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ?? '系统等宽字体',
  }))
  return {
    sans: defaults.sans,
    code: defaults.code,
    interfaceFamily: settings.fontFamilySans.trim() || defaults.sans,
  }
}

function InterfaceFontRow({ preview }: { preview?: ReactNode }) {
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  const defaults = useFontDefaultFamilies()
  return (
    <FontFamilySettingsRow
      {...searchableSetting('interface-font')}
      description={isAutoOpsHosted() ? "界面和消息正文中的文字。" : "代码块和终端以外的所有文字。"}
      defaultFamily={defaults.sans}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilySans}
      value={settings.fontFamilySans}
      onValueChange={(fontFamilySans) => updateSettings({ fontFamilySans })}
      onReset={() =>
        updateSettings({
          fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
          fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        })
      }
      size={{
        label: '界面字号',
        min: MIN_INTERFACE_FONT_SIZE,
        max: MAX_INTERFACE_FONT_SIZE,
        value: settings.fontSizeInterface,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        onChange: (fontSizeInterface) => updateSettings({ fontSizeInterface }),
      }}
      {...(preview !== undefined ? { preview } : {})}
    />
  )
}

function PromptFontRow() {
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  const defaults = useFontDefaultFamilies()
  return (
    <FontFamilySettingsRow
      {...searchableSetting('prompt-font')}
      description="仅应用于编写提示词的输入框，也适合使用等宽字体。"
      defaultFamily={defaults.interfaceFamily}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer}
      value={settings.fontFamilyComposer}
      onValueChange={(fontFamilyComposer) => updateSettings({ fontFamilyComposer })}
      onReset={() =>
        updateSettings({
          fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
          fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        })
      }
      size={{
        label: '输入字号',
        min: MIN_PROMPT_FONT_SIZE,
        max: MAX_PROMPT_FONT_SIZE,
        value: settings.fontSizePrompt,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        onChange: (fontSizePrompt) => updateSettings({ fontSizePrompt }),
      }}
      preview={<PromptFontPreview />}
    />
  )
}

function CodeFontRow({
  title,
  description = isAutoOpsHosted() ? '代码块和文件预览。' : '代码块、差异和文件预览。',
  preview,
}: {
  title?: string
  description?: string
  preview?: ReactNode
}) {
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  const defaults = useFontDefaultFamilies()
  return (
    <FontFamilySettingsRow
      {...searchableSetting('code-font')}
      {...(title !== undefined ? { title } : {})}
      description={description}
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyCode}
      value={settings.fontFamilyCode}
      onValueChange={(fontFamilyCode) => updateSettings({ fontFamilyCode })}
      onReset={() =>
        updateSettings({
          fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
          fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        })
      }
      requireMonospace
      size={{
        label: '代码字号',
        min: MIN_CODE_FONT_SIZE,
        max: MAX_CODE_FONT_SIZE,
        value: settings.fontSizeCode,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        onChange: (fontSizeCode) => updateSettings({ fontSizeCode }),
      }}
      preview={preview ?? <CodeFontPreview />}
    />
  )
}

function TerminalFontRow() {
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  const defaults = useFontDefaultFamilies()
  return (
    <FontFamilySettingsRow
      {...searchableSetting('terminal-font')}
      description="终端输出，独立于代码块和差异的字体设置。"
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal}
      value={settings.fontFamilyTerminal}
      onValueChange={(fontFamilyTerminal) => updateSettings({ fontFamilyTerminal })}
      onReset={() =>
        updateSettings({
          fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
          fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        })
      }
      requireMonospace
      size={{
        label: '终端字号',
        min: MIN_TERMINAL_FONT_SIZE,
        max: MAX_TERMINAL_FONT_SIZE,
        value: settings.fontSizeTerminal,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        onChange: (fontSizeTerminal) => updateSettings({ fontSizeTerminal }),
      }}
      preview={
        <TerminalFontPreview
          family={resolveTerminalFontPreference({
            advanced: true,
            code: settings.fontFamilyCode,
            terminal: settings.fontFamilyTerminal,
          })}
          size={settings.fontSizeTerminal}
        />
      }
    />
  )
}

function FontSmoothingRow() {
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  if (!isMacPlatform(navigator.platform)) return null
  return (
    <SettingsRow
      {...searchableSetting('font-smoothing')}
      description="使用更纤细的灰度字体平滑，替代 macOS 默认效果。"
      resetAction={
        settings.fontSmoothing !== DEFAULT_UNIFIED_SETTINGS.fontSmoothing ? (
          <SettingResetButton
            label="字体平滑"
            onClick={() =>
              updateSettings({ fontSmoothing: DEFAULT_UNIFIED_SETTINGS.fontSmoothing })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.fontSmoothing}
          onCheckedChange={(checked) => updateSettings({ fontSmoothing: Boolean(checked) })}
          aria-label="字体平滑"
        />
      }
    />
  )
}

function WordWrapRow() {
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  return (
    <SettingsRow
      {...searchableSetting('word-wrap')}
      description={isAutoOpsHosted() ? "默认在代码块、表格和文件预览中将长行自动换行。" : "默认在代码块、表格、差异和文件预览中将长行自动换行。"}
      resetAction={
        settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
          <SettingResetButton
            label="自动换行"
            onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wordWrap}
          onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
          aria-label={isAutoOpsHosted() ? "默认将代码、表格和文件预览自动换行" : "默认将代码、表格、差异和文件预览自动换行"}
        />
      }
    />
  )
}

function FontSettingsGroup() {
  return (
    <>
      <InterfaceFontRow />
      <PromptFontRow />
      <CodeFontRow />
      {autoOpsFeature('workspace') && <TerminalFontRow />}
      <FontSmoothingRow />
    </>
  )
}

function SimpleFontRows() {
  const settings = useScopedSettings()
  return (
    <>
      <InterfaceFontRow preview={<PromptFontPreview />} />
      <CodeFontRow
        title="等宽字体"
        description={
          autoOpsFeature('workspace')
            ? '代码块、差异、文件预览和终端。'
            : '代码块和文件预览。'
        }
        preview={
          <>
            <CodeFontPreview />
            {autoOpsFeature('workspace') && (
              <TerminalFontPreview
                family={resolveTerminalFontPreference({
                  advanced: false,
                  code: settings.fontFamilyCode,
                  terminal: settings.fontFamilyTerminal,
                })}
                size={resolveTerminalFontSizePreference({
                  advanced: false,
                  code: settings.fontSizeCode,
                  terminal: settings.fontSizeTerminal,
                })}
              />
            )}
          </>
        }
      />
    </>
  )
}

// Font smoothing only renders on macOS, so a search jump to it elsewhere
// must not flip the section - the target would never mount to be scrolled to.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  'prompt-font',
  'terminal-font',
  ...(typeof navigator !== 'undefined' && isMacPlatform(navigator.platform)
    ? ['font-smoothing']
    : []),
])

function TypographySection() {
  const [advanced, setAdvanced] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  )
  const searchTargetId = useSettingsSearchTargetId()
  const lastExpandedTargetRef = useRef<string | null>(null)
  useEffect(() => {
    if (searchTargetId === null || !ADVANCED_TYPOGRAPHY_TARGET_IDS.has(searchTargetId)) return
    if (lastExpandedTargetRef.current === searchTargetId) return
    lastExpandedTargetRef.current = searchTargetId
    setAdvanced(true)
  }, [searchTargetId, setAdvanced])
  return (
    <SettingsSection
      id="typography"
      title="字体排版"
      headerAction={
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
          高级
          <Switch
            checked={advanced}
            onCheckedChange={(checked) => setAdvanced(Boolean(checked))}
            aria-label="显示高级字体设置"
          />
        </label>
      }
    >
      {advanced ? <FontSettingsGroup /> : <SimpleFontRows />}
      <WordWrapRow />
    </SettingsSection>
  )
}

function FontFamilySettingsRow({
  id,
  title,
  description,
  defaultFamily,
  defaultValue,
  preview,
  value,
  onValueChange,
  onReset,
  requireMonospace = false,
  size,
}: {
  id?: string
  title: string
  description: string
  defaultFamily: string
  defaultValue: string
  preview?: ReactNode
  value: string
  onValueChange: (value: string) => void
  onReset: () => void
  requireMonospace?: boolean
  size: {
    label: string
    min: number
    max: number
    value: number
    defaultValue: number
    onChange: (v: number) => void
  }
}) {
  const trimmed = value.trim()
  const [draft, setDraft] = useState(value)
  const [draftSettled, setDraftSettled] = useState(true)
  // Each pending commit remembers the value it was typed against, so one that outlives
  // an external change (hydration, reset, picker selection) drops its stale draft.
  const commitTimerRef = useRef<{ readonly id: number; readonly value: string } | null>(null)
  const cancelPendingCommit = () => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current.id)
    commitTimerRef.current = null
  }
  // Bumped on every external value change, so a pending commit typed before one never lands,
  // even if the value has since changed back to what it was typed against.
  const [adopted, setAdopted] = useState({ value, generation: 0 })
  if (adopted.value !== value) {
    setAdopted({ value, generation: adopted.generation + 1 })
    setDraft(value)
    setDraftSettled(true)
  }
  const readAdoptedGeneration = useEffectEvent(() => adopted.generation)
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current.id)
    },
    [],
  )
  const acceptsFamily = (candidate: string) =>
    isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamily(candidate))
  const commitDraft = (next: string) => {
    setDraftSettled(true)
    if (next.trim().length === 0 || acceptsFamily(next)) {
      onValueChange(next)
    }
  }
  const flushDraft = () => {
    const pending = commitTimerRef.current
    cancelPendingCommit()
    if (pending !== null && pending.value === value) commitDraft(draft)
  }
  const draftTrimmed = draft.trim()
  const draftPending = draftSettled && draftTrimmed.length > 0 && draftTrimmed !== trimmed
  const resetToDefault = () => {
    cancelPendingCommit()
    setDraft(defaultValue)
    setDraftSettled(true)
    onReset()
  }
  const resetAction =
    value !== defaultValue || size.value !== size.defaultValue ? (
      <SettingResetButton label={title.toLowerCase()} onClick={resetToDefault} />
    ) : null
  const fontEnumeration = useFontEnumeration()
  const [inputFocused, setInputFocused] = useState(false)
  const familyControl =
    fontEnumeration.status === 'granted' ? (
      <FontFamilyPicker
        ariaLabel={`${title}字体系列`}
        defaultFamily={defaultFamily}
        selectedFamily={trimmed}
        requireMonospace={requireMonospace}
        initialOpen={inputFocused}
        onSelect={onValueChange}
      />
    ) : (
      <Input
        size="sm"
        aria-label={`${title}字体系列`}
        aria-invalid={draftPending || undefined}
        autoCapitalize="off"
        autoComplete="off"
        className="min-w-0 flex-1"
        maxLength={200}
        onFocus={() => {
          setInputFocused(true)
          discoverInstalledFonts()
        }}
        onBlur={() => {
          setInputFocused(false)
          flushDraft()
        }}
        onChange={(event) => {
          const next = event.currentTarget.value
          setDraft(next)
          setDraftSettled(false)
          cancelPendingCommit()
          const typedAgainst = value
          const typedInGeneration = adopted.generation
          commitTimerRef.current = {
            id: window.setTimeout(() => {
              commitTimerRef.current = null
              if (readAdoptedGeneration() === typedInGeneration) commitDraft(next)
            }, 400),
            value: typedAgainst,
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') flushDraft()
          if (event.key === 'Escape') {
            // Discard uncommitted typing without closing the settings page,
            // which is what an unhandled Escape does.
            event.preventDefault()
            event.stopPropagation()
            cancelPendingCommit()
            setDraft(value)
            setDraftSettled(true)
          }
        }}
        placeholder={defaultFamily}
        spellCheck={false}
        value={draft}
      />
    )
  const control = (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">{familyControl}</div>
      <Select
        value={String(size.value)}
        onValueChange={(next) => {
          if (typeof next !== 'string') return
          const parsed = Number(next)
          if (Number.isInteger(parsed) && parsed >= size.min && parsed <= size.max) {
            size.onChange(parsed)
          }
        }}
      >
        <SelectTrigger size="sm" className="w-22 shrink-0" aria-label={size.label}>
          <SelectValue>{size.value} px</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {Array.from({ length: size.max - size.min + 1 }, (_, index) => size.min + index).map(
            (px) => (
              <SelectItem hideIndicator key={px} value={String(px)}>
                {px} px
              </SelectItem>
            ),
          )}
        </SelectPopup>
      </Select>
    </div>
  )
  return (
    <SettingsRow
      {...(id !== undefined ? { id } : {})}
      title={title}
      description={description}
      resetAction={resetAction}
      control={control}
    >
      {preview}
    </SettingsRow>
  )
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number
  onCommit: (days: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [draftSource, setDraftSource] = useState(value)
  if (draftSource !== value) {
    setDraftSource(value)
    setDraft(String(value))
  }

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        const parsed = Number(event.target.value)
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed)
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="自动收起前的不活跃天数"
    />
  )
}

const LEGACY_FEATURE_TARGET_IDS: ReadonlySet<string> = new Set([
  'legacy-plan-mode',
  'legacy-context-window-indicator',
  'legacy-sidebar',
])

function LegacyFeaturesSection() {
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  const [open, setOpen] = useState(false)
  const searchTargetId = useSettingsSearchTargetId()
  const targetRef = useSettingsSearchTarget<HTMLElement>('legacy-features')
  const lastExpandedTargetRef = useRef<string | null>(null)
  useEffect(() => {
    if (searchTargetId === null) {
      lastExpandedTargetRef.current = null
      return
    }
    if (!LEGACY_FEATURE_TARGET_IDS.has(searchTargetId)) return
    if (lastExpandedTargetRef.current === searchTargetId) return
    lastExpandedTargetRef.current = searchTargetId
    setOpen(true)
  }, [searchTargetId])

  return (
    <section id="legacy-features" ref={targetRef} tabIndex={-1} className="space-y-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 sm:px-4">
          <h2 className="text-sm font-normal text-foreground/70 transition-colors group-hover:text-foreground">
            兼容功能
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <SettingsGroup>
            <SettingsRow
              {...searchableSetting('legacy-plan-mode')}
              description="恢复执行/计划模式、/plan、/default 和 Shift+Tab。关闭时使用执行模式。"
              control={
                <Switch
                  checked={settings.planModeEnabled}
                  onCheckedChange={(checked) => {
                    updateSettings({ planModeEnabled: Boolean(checked) })
                  }}
                  aria-label="计划模式（兼容功能）"
                />
              }
            />
            <SettingsRow
              {...searchableSetting('legacy-context-window-indicator')}
              description="在输入框中用圆形指示器显示上下文窗口用量。"
              control={
                <Switch
                  checked={settings.contextWindowMeterEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ contextWindowMeterEnabled: Boolean(checked) })
                  }
                  aria-label="上下文窗口指示器（兼容功能）"
                />
              }
            />
            <SettingsRow
              {...searchableSetting('legacy-sidebar')}
              description="恢复按项目组织的对话树，替代默认的扁平侧栏。"
              control={
                <Switch
                  checked={settings.legacySidebarEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ legacySidebarEnabled: Boolean(checked) })
                  }
                  aria-label="侧栏（兼容功能）"
                />
              }
            />
          </SettingsGroup>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  )
}

function AutoOpsRuntimeSettings() {
  const host = readAutoOpsHost()
  return (
    <SettingsSection id="autoops-runtime" title="当前配置">
      <SettingsRow
        id="autoops-model"
        title={host?.modelSelectionEnabled ? '默认模型' : '模型'}
        description={host?.modelSelectionEnabled ? '在对话输入区选择模型和该模型支持的思考强度。' : '由项目助手统一配置。'}
        control={<span className="text-sm text-muted-foreground">{host?.fixedModel.model ?? '暂不可用'}</span>}
      />
      <SettingsRow
        id="autoops-permissions"
        title={host?.customerAgentsEnabled ? "平台执行权限" : "执行权限"}
        description={host?.customerAgentsEnabled ? "平台仅访问当前项目与对话授权的资料及工具；客户工作区按客户本机配置执行。" : "仅访问当前项目与对话授权的资料及工具。"}
        control={<span className="text-sm text-muted-foreground">受控执行</span>}
      />
    </SettingsSection>
  )
}

export function GeneralSettingsPanel() {
  const modifierLabel = isMacPlatform(navigator.platform) ? '⌘' : 'Ctrl'
  const sendShortcutOptions = [
    { value: 'enter', label: 'Enter' },
    { value: 'mod-enter-multiline', label: `${modifierLabel} + Enter 发送多行提示词` },
    { value: 'mod-enter', label: `${modifierLabel} + Enter 始终发送` },
  ] as const
  const settings = useScopedSettings()
  const updateSettings = useUpdateScopedSettings()
  const navigate = useNavigate()
  const { scope, environment, connectedEnvironments, target } = useSettingsScope()
  const environmentId = environment?.environmentId ?? null
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null
  const hasServerTargets = connectedEnvironments.length > 0
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false)
  const mixedResponseStreamingMode = useScopedSettingsMixed(['responseStreamingMode'])
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  )
  const providersByEnvironment = useEnvironmentProviders()
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS
  const supportsAutoSettlement =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    )
  const supportsAutoSettlementScope = connectedEnvironments.every(
    (target) => target.serverConfig?.environment.capabilities.threadAutoSettlementScope === true,
  )
  const supportsRestartContinuation =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadRestartContinuation === true,
    )

  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  )
  const textGenerationModelSelection = resolveAppModelSelectionState(
    settings,
    textGenerationProviders,
  )
  const textGenInstanceId = textGenerationModelSelection.instanceId
  const textGenModel = textGenerationModelSelection.model
  const textGenModelOptions = textGenerationModelSelection.options
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(textGenerationProviders),
      settings,
      target?.projectId ?? null,
    ),
  )
  const hasTextGenerationProvider = textGenerationModelInstanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  )
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  )
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    textGenInstanceId,
    textGenModel,
  )
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  )
  const textGenerationModelDisabledReason = useScopedModelDisabledReason(
    settings,
    textGenerationModelInstanceEntries,
  )
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings)
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings)
  const mixedBackgroundActivity = useScopedSettingsMixed(['backgroundActivity'])
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(['addProjectBaseDirectory'])
  const mixedTextGenerationModel = useScopedSettingsMixed(['textGenerationModelSelection'])
  const backgroundActivityDescription =
    backgroundActivityProfileOption === 'advanced'
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} 共享策略： ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile]
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  )

  return (
    <SettingsPageContainer>
      {isAutoOpsLite() ? <AutoOpsRuntimeSettings /> : <ProjectDefaultsSettings category="general" />}
      {isAutoOpsHosted() ? <><CustomerDevicesSettings /><AutoOpsSkillsSettings /></> : null}
      <SettingsSection id="organization" title="对话整理">
        <SettingsRow
          {...searchableSetting('project-grouping')}
          description="合并不同环境中的相同仓库。"
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="项目分组"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== 'separate') {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode)
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                })
              }}
              aria-label="项目分组"
            />
          }
        />
        <SettingsRow
          {...searchableSetting('project-order')}
          description="侧栏项目选择器和命令面板中的项目顺序。"
          resetAction={
            settings.sidebarProjectSortOrder !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder ? (
              <SettingResetButton
                label="项目顺序"
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (isSidebarProjectSortOrder(value)) {
                  updateSettings({ sidebarProjectSortOrder: value })
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="项目顺序">
                <SelectValue>
                  {SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SidebarProjectSortOrder.literals.map((sortOrder) => (
                  <SelectItem hideIndicator key={sortOrder} value={sortOrder}>
                    {SIDEBAR_PROJECT_SORT_ORDER_LABELS[sortOrder]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          serverScoped
          {...searchableSetting('auto-resume-limited-threads')}
          description="在报告的额度重置时间继续受限对话。每个对话都可以取消已安排的继续执行。"
          settingKeys={['autoResumeLimitedThreads']}
          control={
            <ScopedSwitch
              settingKeys={['autoResumeLimitedThreads']}
              checked={settings.autoResumeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
              }
              aria-label="额度恢复后自动继续对话"
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting('snooze-limited-threads')}
          description="将受额度限制的对话暂缓到报告的重置时间。结合自动继续功能，可在唤醒后接着执行。"
          settingKeys={['snoozeLimitedThreads']}
          control={
            <ScopedSwitch
              settingKeys={['snoozeLimitedThreads']}
              checked={settings.snoozeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ snoozeLimitedThreads: Boolean(checked) })
              }
              aria-label="暂缓受额度限制的对话"
            />
          }
        />

        <SettingsRow
          {...searchableSetting('working-shelf')}
          description="将执行中和监测中的对话收进“执行中”分区。需要你处理时，它们会回到收件箱顶部。"
          resetAction={
            settings.sidebarWorkingShelfEnabled !==
            DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled ? (
              <SettingResetButton
                label="执行中分区"
                onClick={() =>
                  updateSettings({
                    sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label="执行中分区（测试版）"
            />
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={['compactIdleThreads']}
          {...searchableSetting('compact-idle-threads')}
          description={
            isAutoOpsHosted()
              ? '当前 Codex 运行器不支持空闲自动压缩；可在对话中使用 /compact 主动压缩。'
              : '在长时间空闲的 Claude 对话提示词缓存到期前压缩上下文，以降低再次继续时的成本。'
          }
          resetAction={
            !isAutoOpsHosted() &&
            settings.compactIdleThreads !== DEFAULT_UNIFIED_SETTINGS.compactIdleThreads ? (
              <SettingResetButton
                label="压缩空闲 Claude 对话"
                onClick={() =>
                  updateSettings({
                    compactIdleThreads: DEFAULT_UNIFIED_SETTINGS.compactIdleThreads,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={['compactIdleThreads']}
              disabled={isAutoOpsHosted()}
              checked={settings.compactIdleThreads}
              onCheckedChange={(checked) =>
                updateSettings({ compactIdleThreads: Boolean(checked) })
              }
              aria-label="压缩空闲 Claude 对话（测试版）"
            />
          }
        />

        {supportsAutoSettlement ? (
          <>
            <SettingsRow
              serverScoped
              settingKeys={['sidebarAutoSettleOnMerge']}
              {...searchableSetting('auto-settle-merged-threads')}
              description="拉取请求合并后收起关联对话。关闭拉取请求也仍会自动收起对话。"
              resetAction={
                settings.sidebarAutoSettleOnMerge !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
                  <SettingResetButton
                    label="合并后自动收起"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={['sidebarAutoSettleOnMerge']}
                  checked={settings.sidebarAutoSettleOnMerge}
                  onCheckedChange={(checked) =>
                    updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
                  }
                  aria-label="合并后自动收起对话"
                />
              }
            />

            <SettingsRow
              serverScoped
              settingKeys={['sidebarAutoSettleAfterDays']}
              {...searchableSetting('auto-settle-inactive-threads')}
              description="侧栏中超过此时间没有活动的对话会自动收起。"
              resetAction={
                settings.sidebarAutoSettleAfterDays !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
                  <SettingResetButton
                    label="auto-settle"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleAfterDays:
                          DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={['sidebarAutoSettleAfterDays']}
                  checked={settings.sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="自动收起不活跃对话"
                />
              }
            />
            {settings.sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                serverScoped
                settingKeys={['sidebarAutoSettleAfterDays']}
                title={searchableSetting('days-before-auto-settle').title}
                description="任何新活动都会自动恢复已收起的对话。"
                control={
                  <AutoSettleDaysInput
                    value={settings.sidebarAutoSettleAfterDays}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
            {settings.sidebarAutoSettleAfterDays !== null && supportsAutoSettlementScope ? (
              <SettingsRow
                serverScoped
                settingKeys={['sidebarAutoSettleKeepPullRequests']}
                title="保留关联拉取请求的对话"
                description="关联拉取请求的对话不会因不活跃而收起。合并或关闭拉取请求时仍会收起。"
                control={
                  <ScopedSwitch
                    settingKeys={['sidebarAutoSettleKeepPullRequests']}
                    checked={settings.sidebarAutoSettleKeepPullRequests}
                    onCheckedChange={(checked) =>
                      updateSettings({ sidebarAutoSettleKeepPullRequests: checked })
                    }
                    aria-label="保留关联拉取请求的对话"
                  />
                }
              />
            ) : null}
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection id="behavior" title="行为">
        <NotificationSettings />
        <SettingsRow
          {...searchableSetting('in-app-notifications')}
          description="应用处于前台时，其他对话完成、失败或需要输入或审批时显示提示。"
          control={
            <Switch
              checked={settings.inAppNotificationsEnabled}
              onCheckedChange={(checked) => updateSettings({ inAppNotificationsEnabled: checked })}
              aria-label="应用内通知"
            />
          }
        />
        <SettingsRow
          {...searchableSetting('time-format')}
          description="系统默认遵循浏览器或操作系统的时钟偏好。"
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="时间格式"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === 'locale' || value === '12-hour' || value === '24-hour') {
                  updateSettings({ timestampFormat: value })
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="时间戳格式">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS['12-hour']}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS['24-hour']}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={['responseStreamingMode']}
          {...searchableSetting('response-streaming')}
          description={
            mixedResponseStreamingMode
              ? '所选目标使用不同的流式显示模式。'
              : RESPONSE_STREAMING_MODE_DESCRIPTIONS[settings.responseStreamingMode]
          }
          resetAction={
            settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode ? (
              <SettingResetButton
                label="回复流式显示"
                onClick={() =>
                  updateSettings({
                    responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={mixedResponseStreamingMode ? null : settings.responseStreamingMode}
              onValueChange={(value) => {
                if (value === 'turn' || value === 'paragraph') {
                  updateSettings({ responseStreamingMode: value })
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="回复流式显示">
                <SelectValue>
                  {(value: ResponseStreamingMode | null) =>
                    value === null ? '不一致' : RESPONSE_STREAMING_MODE_LABELS[value]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="turn">
                  {RESPONSE_STREAMING_MODE_LABELS.turn}
                </SelectItem>
                <SelectItem hideIndicator value="paragraph">
                  {RESPONSE_STREAMING_MODE_LABELS.paragraph}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting('hide-whitespace-changes')}
          description="设置差异面板是否默认忽略仅空白字符的变更。"
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="空白字符差异"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="默认隐藏空白字符变更"
            />
          }
        />
        <SettingsRow
          {...searchableSetting('default-diff-file-state')}
          description="打开差异或拉取请求的代码标签页时，默认展开或折叠文件。"
          resetAction={
            settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed ? (
              <SettingResetButton
                label="差异文件默认状态"
                onClick={() =>
                  updateSettings({
                    diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffFilesCollapsed ? 'collapsed' : 'expanded'}
              onValueChange={(value) => {
                if (value === 'expanded' || value === 'collapsed') {
                  updateSettings({ diffFilesCollapsed: value === 'collapsed' })
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="差异文件默认状态">
                <SelectValue>{settings.diffFilesCollapsed ? '已折叠' : '已展开'}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="expanded">
                  已展开
                </SelectItem>
                <SelectItem hideIndicator value="collapsed">
                  已折叠
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting('diff-layout')}
          description="以上下或左右方式显示差异。差异工具栏中的开关也可修改此设置。"
          resetAction={
            settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? (
              <SettingResetButton
                label="差异布局"
                onClick={() => updateSettings({ diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffLayout}
              onValueChange={(value) => {
                if (value === 'stacked' || value === 'split') {
                  updateSettings({ diffLayout: value })
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="差异布局">
                <SelectValue>{DIFF_LAYOUT_LABELS[settings.diffLayout]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="stacked">
                  {DIFF_LAYOUT_LABELS.stacked}
                </SelectItem>
                <SelectItem hideIndicator value="split">
                  {DIFF_LAYOUT_LABELS.split}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting('proactive-panels')}
          description="优先打开关联的拉取请求；否则，在至少 3 个文件或 50 行被编辑时打开变更面板。"
          resetAction={
            settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled ? (
              <SettingResetButton
                label="自动打开面板"
                onClick={() =>
                  updateSettings({
                    proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.proactivePanelsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ proactivePanelsEnabled: Boolean(checked) })
              }
              aria-label="自动打开面板"
            />
          }
        />

        <SettingsRow
          {...searchableSetting('skills-in-slash-menu')}
          description="在 / 命令菜单中也显示技能。输入 $ 时始终显示技能。"
          resetAction={
            settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
              <SettingResetButton
                label="在斜杠菜单中显示技能"
                onClick={() =>
                  updateSettings({
                    showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.showSkillsInSlashMenu}
              onCheckedChange={(checked) =>
                updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
              }
              aria-label="在斜杠菜单中显示技能"
            />
          }
        />

        <SettingsRow
          {...searchableSetting('composer-rich-text')}
          description="输入时显示格式化的 Markdown。"
          resetAction={
            settings.composerRichTextEnabled !==
            DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
              <SettingResetButton
                label="富文本输入框"
                onClick={() =>
                  updateSettings({
                    composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerRichTextEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ composerRichTextEnabled: Boolean(checked) })
              }
              aria-label="富文本输入框"
            />
          }
        />

        <SettingsRow
          {...searchableSetting('composer-collapse')}
          description="滚动已有对话时，将输入框收为单行。聚焦输入框或开始输入即可再次展开。"
          resetAction={
            settings.composerCollapseOnScroll !==
            DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll ? (
              <SettingResetButton
                label="滚动时收起输入框"
                onClick={() =>
                  updateSettings({
                    composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerCollapseOnScroll}
              onCheckedChange={(checked) =>
                updateSettings({ composerCollapseOnScroll: Boolean(checked) })
              }
              aria-label="滚动时收起输入框"
            />
          }
        />

        <SettingsRow
          {...searchableSetting('send-shortcut')}
          description="选择按 Enter 时发送提示词还是换行"
          resetAction={
            settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
              <SettingResetButton
                label="发送快捷键"
                onClick={() =>
                  updateSettings({ sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sendShortcut}
              onValueChange={(value) => {
                const option = sendShortcutOptions.find((option) => option.value === value)
                if (option) updateSettings({ sendShortcut: option.value })
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0 max-w-full"
                aria-label="发送快捷键"
              >
                <SelectValue>
                  {
                    sendShortcutOptions.find((option) => option.value === settings.sendShortcut)
                      ?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {sendShortcutOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center justify-between gap-4">
                      {option.label}
                      {settings.sendShortcut === option.value && <CheckIcon aria-hidden="true" />}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting('follow-up-behavior')}
          description={
            'Agent 执行期间，将追问加入队列或用于引导当前执行。' +
            (settings.sendShortcut === 'mod-enter-multiline'
              ? `按 ${modifierLabel} + Enter（单行提示词）或 ${modifierLabel} + Shift + Enter（多行提示词），可对这一条消息使用相反的处理方式。`
              : `按 ${modifierLabel}${settings.sendShortcut === 'mod-enter' ? ' + Shift' : ''} + Enter，可对这一条消息使用相反的处理方式。`)
          }
          resetAction={
            settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
              <SettingResetButton
                label="追问处理方式"
                onClick={() =>
                  updateSettings({
                    followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.followUpBehavior}
              onValueChange={(value) => {
                if (value === 'queue' || value === 'steer') {
                  updateSettings({ followUpBehavior: value })
                }
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-0" aria-label="追问处理方式">
                <SelectValue>
                  {settings.followUpBehavior === 'queue' ? '队列' : '引导当前执行'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="queue">队列</SelectItem>
                <SelectItem value="steer">引导当前执行</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={['enableProviderUpdateChecks']}
          {...searchableSetting('provider-update-checks')}
          description="检查已安装提供方 CLI 的新版本，并更新模型目录。关闭后可能看不到新模型。"
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="检查提供方更新"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={['enableProviderUpdateChecks']}
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="检查提供方版本"
            />
          }
        />

        <SettingsRow
          {...searchableSetting('continue-threads-after-server-update')}
          serverScoped
          settingKeys={['continueThreadsAfterServerUpdate']}
          description="所选环境发生更新、崩溃或设备重启后，自动继续被中断的对话。"
          status={
            !supportsRestartContinuation ? '所选的所有已连接环境都必须支持重启后继续。' : undefined
          }
          resetAction={
            supportsRestartContinuation &&
            settings.continueThreadsAfterServerUpdate !==
              DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
              <SettingResetButton
                label="重启后继续对话"
                onClick={() =>
                  updateSettings({
                    continueThreadsAfterServerUpdate:
                      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={['continueThreadsAfterServerUpdate']}
              checked={settings.continueThreadsAfterServerUpdate}
              disabled={!supportsRestartContinuation}
              onCheckedChange={(checked) =>
                updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
              }
              aria-label="重启后继续对话"
            />
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={['backgroundActivity']}
          id={searchableSetting('background-activity').id}
          title={
            <span className="inline-flex items-center gap-1.5">
              {searchableSetting('background-activity').title}
              <PolicyTooltip>
                此共享策略控制 Git 刷新、提供方健康探测等后台任务，任务仍按各自的间隔触发。
              </PolicyTooltip>
            </span>
          }
          description={backgroundActivityDescription}
          resetAction={
            canResetBackgroundActivity ? (
              <SettingResetButton
                label="后台活动"
                onClick={() => updateSettings(resetBackgroundActivitySettings())}
              />
            ) : null
          }
          control={
            <>
              <Select
                value={mixedBackgroundActivity ? null : backgroundActivityProfileOption}
                onValueChange={(value) => {
                  if (value === 'advanced') {
                    if (isEnvironmentScope) setBackgroundActivityDialogOpen(true)
                    return
                  }
                  if (
                    value === 'balanced' ||
                    value === 'performance' ||
                    value === 'battery-saver'
                  ) {
                    updateSettings(backgroundActivityProfileSettings(value))
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="后台活动配置">
                  <SelectValue>
                    {(value: BackgroundActivityProfileOption | null) =>
                      value === null ? '不一致' : BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[value]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS['battery-saver']}
                  </SelectItem>
                  <SelectItem hideIndicator value="advanced" disabled={!isEnvironmentScope}>
                    {isEnvironmentScope
                      ? BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced
                      : `${BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced} （一个环境）`}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {backgroundActivityProfileOption === 'advanced' && isEnvironmentScope ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="配置高级后台活动"
                        onClick={() => setBackgroundActivityDialogOpen(true)}
                      >
                        <SettingsIcon className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">配置后台活动</TooltipPopup>
                </Tooltip>
              ) : null}
              <BackgroundActivityAdvancedDialog
                open={backgroundActivityDialogOpen && isEnvironmentScope}
                onOpenChange={setBackgroundActivityDialogOpen}
              />
            </>
          }
        />
      </SettingsSection>

      <SettingsSection id="projects-and-threads" title="项目与对话">
        <SettingsRow
          serverScoped
          settingKeys={['newWorktreesStartFromOrigin']}
          {...searchableSetting('start-from-origin')}
          description="使用基础分支所跟踪远程分支的最新提交，即使分支名不同。否则使用 origin 上的同名分支；该远程分支不存在时使用本地分支。"
          resetAction={
            settings.newWorktreesStartFromOrigin !==
            DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
              <SettingResetButton
                label="从远程创建新工作树"
                onClick={() =>
                  updateSettings({
                    newWorktreesStartFromOrigin:
                      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={['newWorktreesStartFromOrigin']}
              checked={settings.newWorktreesStartFromOrigin}
              onCheckedChange={(checked) =>
                updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
              }
              aria-label="默认从远程创建新工作树"
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={['addProjectBaseDirectory']}
          {...searchableSetting('add-project-starts-in')}
          description="留空时，“添加项目”浏览器默认从“~/”打开。"
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="添加项目的起始目录"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={mixedAddProjectBaseDirectory ? '' : settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder={mixedAddProjectBaseDirectory ? '不一致' : '~/'}
              spellCheck={false}
              aria-label="添加项目的起始目录"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="confirmations" title="操作确认">
        <SettingsRow
          {...searchableSetting('unpin-confirmation')}
          description="取消置顶对话前询问。"
          resetAction={
            settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
              <SettingResetButton
                label="取消置顶确认"
                onClick={() =>
                  updateSettings({
                    confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label="取消置顶对话前确认"
            />
          }
        />

        <SettingsRow
          {...searchableSetting('archive-confirmation')}
          description="归档对话前，需要再次点击行内归档操作。"
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="归档确认"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="归档对话前确认"
            />
          }
        />

        <SettingsRow
          {...searchableSetting('delete-confirmation')}
          description="删除对话及其聊天记录前询问。"
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="删除确认"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="删除对话前确认"
            />
          }
        />

        {isElectron ? (
          <SettingsRow
            {...searchableSetting('quit-confirmation')}
            description="长按模式下，快速按两次也可以退出。"
            resetAction={
              settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? (
                <SettingResetButton
                  label="退出快捷键行为"
                  onClick={() =>
                    updateSettings({ confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.confirmQuit}
                onValueChange={(value) => {
                  if (value === 'direct' || value === 'hold' || value === 'double-click') {
                    updateSettings({ confirmQuit: value })
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="退出快捷键行为">
                  <SelectValue>{QUIT_CONFIRMATION_MODE_LABELS[settings.confirmQuit]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(QUIT_CONFIRMATION_MODE_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection id="text-generation" title="文本生成">
        <SettingsRow
          serverScoped
          settingKeys={['textGenerationModelSelection']}
          {...searchableSetting('text-generation-model')}
          description="为使用此提供方的已连接设备生成对话标题及其他文本。版本控制可单独覆盖此设置。"
          resetAction={
            hasServerTargets && isTextGenerationModelDirty ? (
              <SettingResetButton
                label="文本生成模型"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                连接环境后即可选择文本生成模型。
              </span>
            ) : !hasTextGenerationProvider ? (
              <span className="text-sm text-muted-foreground">没有可用的文本生成提供方。</span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={textGenInstanceId}
                  model={textGenModel}
                  lockedProvider={null}
                  instanceEntries={textGenerationModelInstanceEntries}
                  modelOptionsByInstance={textGenerationModelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  {...(mixedTextGenerationModel ? { triggerLabel: '不一致' } : {})}
                  getModelDisabledReason={textGenerationModelDisabledReason}
                  {...(environmentId
                    ? {
                        onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                          void navigate({
                            to: '/settings/providers',
                            search: { environmentId, instanceId },
                          })
                        },
                      }
                    : {})}
                  onInstanceModelChange={(instanceId, model) => {
                    const reason = textGenerationModelDisabledReason(instanceId, model)
                    if (reason) {
                      toastManager.add({
                        type: 'error',
                        title: '未保存文本生成模型',
                        description: reason,
                      })
                      return
                    }
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(instanceId, model),
                        },
                        textGenerationProviders,
                      ),
                    })
                  }}
                />
                {textGenInstanceEntry ? (
                  <TraitsPicker
                    provider={textGenProvider}
                    models={textGenInstanceEntry?.models ?? []}
                    model={textGenModel}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={textGenModelOptions}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={
                      settings.planModeEnabled || selectsPlanAgent(textGenModelOptions)
                    }
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(nextOptions) => {
                      updateSettings({
                        textGenerationModelSelection: resolveAppModelSelectionState(
                          {
                            ...settings,
                            textGenerationModelSelection: createModelSelection(
                              textGenInstanceId,
                              textGenModel,
                              nextOptions,
                            ),
                          },
                          textGenerationProviders,
                        ),
                      })
                    }}
                  />
                ) : null}
              </div>
            )
          }
        />
      </SettingsSection>

      <SettingsSection id="about" title="关于">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <>
            <SettingsRow
              id={searchableSetting('app-version').id}
              title={<AboutVersionTitle />}
              description="当前应用版本。"
            />
          </>
        )}
        <MobileAppSettingsRow />
        <SettingsRow
          {...searchableSetting('privacy-policy')}
          description="了解我们如何处理你的数据，包括 T3 Code 收集的匿名使用数据。"
          control={
            <Button
              render={<a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer noopener" />}
              size="sm"
              variant="outline"
            >
              查看政策
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection id="settings-information" title={isAutoOpsLite() ? '开源许可' : '诊断'}>
        <SettingsRow
          {...searchableSetting('diagnostics')}
          description={
            isEnvironmentScope
              ? '查看此环境的进程、资源用量和日志。'
              : '一次查看一个环境的进程、资源用量和日志。'
          }
          control={
            <Button
              render={
                <Link to="/settings/diagnostics" search={{ machine: environmentId ?? undefined }} />
              }
              size="sm"
              variant="outline"
            >
              查看诊断
            </Button>
          }
        />
        <SettingsRow
          {...searchableSetting('open-source-licenses')}
          description="T3 Code 使用的依赖、资源及可选工具的声明。"
          control={
            <Button
              render={<Link to="/settings/open-source-licenses" />}
              size="sm"
              variant="outline"
            >
              查看许可证
            </Button>
          }
        />
      </SettingsSection>

      {!isAutoOpsLite() && <LegacyFeaturesSection />}
    </SettingsPageContainer>
  )
}

export function ArchivedThreadsPanel() {
  const { scope, groups: projectGroups, environments } = useSettingsScope()
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions()
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds)

  const { groups: archivedGroups, hasMultipleEnvironments } = (() => {
    const selectedProjectKeys =
      scope.kind === 'project' || scope.kind === 'checkout'
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(`${environmentId}:${project.id}`),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    )
    const environmentLabels = new Map(
      environments.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments)
        return [environment.environmentId, secondary ? `${primary} (${secondary})` : primary]
      }),
    )
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...presentThreadShell(environmentId, thread),
        environmentLabel: environmentLabels.get(environmentId) ?? environmentId,
      })),
    )
    const hasMultipleEnvironments =
      new Set(
        threads
          .filter((thread) =>
            projectsByEnvironmentAndId.has(`${thread.environmentId}:${thread.projectId}`),
          )
          .map((thread) => thread.environmentId),
      ).size > 1
    const logicalGroupsByProjectKey = new Map(
      projectGroups.flatMap((group) =>
        group.memberProjectRefs.map(
          (member) => [`${member.environmentId}:${member.projectId}`, group] as const,
        ),
      ),
    )

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values())
    const groups = new Map<
      string,
      {
        readonly project: (typeof archivedProjects)[number]
        readonly title: string
        readonly threads: Array<(typeof threads)[number]>
      }
    >()
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = []
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread)
        }
      }
      if (projectThreads.length > 0) {
        const physicalProjectKey = `${project.environmentId}:${project.id}` as const
        const logicalGroup = hasMultipleEnvironments
          ? logicalGroupsByProjectKey.get(physicalProjectKey)
          : undefined
        const groupKey = logicalGroup?.projectKey ?? physicalProjectKey
        const group = groups.get(groupKey)
        if (group) {
          group.threads.push(...projectThreads)
        } else {
          groups.set(groupKey, {
            project,
            title: logicalGroup?.displayName ?? project.title,
            threads: projectThreads,
          })
        }
      }
    }
    const sortedGroups = Array.from(groups, ([key, group]) => ({
      ...group,
      key,
      threads: group.threads.toSorted((left, right) => {
        const leftKey = left.archivedAt ?? left.createdAt
        const rightKey = right.archivedAt ?? right.createdAt
        return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id)
      }),
    }))
    return { groups: sortedGroups, hasMultipleEnvironments }
  })()

  const handleArchivedThreadContextMenu = async (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi()
    if (!api) return
    const clicked = await api.contextMenu.show(
      [
        { id: 'unarchive', label: '取消归档' },
        { id: 'delete', label: '删除', destructive: true },
      ],
      position,
    )

    if (clicked === 'unarchive') {
      const result = await unarchiveThread(threadRef)
      if (result._tag === 'Success') {
        refreshArchivedThreads()
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: '取消归档对话失败',
            description: error instanceof Error ? error.message : '发生错误。',
          }),
        )
      }
      return
    }

    if (clicked === 'delete') {
      const result = await confirmAndDeleteThread(threadRef)
      if (result._tag === 'Success') {
        refreshArchivedThreads()
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: '删除对话失败',
            description: error instanceof Error ? error.message : '发生错误。',
          }),
        )
      }
    }
  }

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting('archive').id}
          title={searchableSetting('archive').title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? '正在加载已归档对话'
                  : archiveError
                    ? '无法加载已归档对话'
                    : '没有已归档对话'}
              </span>
            }
            description={
              isLoadingArchive
                ? '正在检查已连接的环境。'
                : (archiveError ?? '已归档的对话会显示在这里。')
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ key, project, title, threads: projectThreads }, index) => (
          <SettingsSection
            key={key}
            id={index === 0 ? searchableSetting('archive').id : undefined}
            title={title}
            icon={<ProjectFavicon project={project} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={`${thread.environmentId}:${thread.id}`}
                onContextMenu={(event) => {
                  event.preventDefault()
                  void (async () => {
                    const result = await settlePromise(() =>
                      handleArchivedThreadContextMenu(
                        scopeThreadRef(thread.environmentId, thread.id),
                        {
                          x: event.clientX,
                          y: event.clientY,
                        },
                      ),
                    )
                    if (result._tag === 'Failure') {
                      const error = squashAtomCommandFailure(result)
                      toastManager.add(
                        stackedThreadToast({
                          type: 'error',
                          title: '归档对话操作失败',
                          description: error instanceof Error ? error.message : '发生错误。',
                        }),
                      )
                    }
                  })()
                }}
                title={thread.title}
                description={
                  <span className={hasMultipleEnvironments ? 'block truncate' : undefined}>
                    {hasMultipleEnvironments ? `${thread.environmentLabel} · ` : null}
                    已归档 <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
                    {'· 创建于'}
                    <RelativeTime timestamp={thread.createdAt} />
                  </span>
                }
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      void (async () => {
                        const result = await unarchiveThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                        )
                        if (result._tag === 'Success') {
                          refreshArchivedThreads()
                          return
                        }
                        if (!isAtomCommandInterrupted(result)) {
                          const error = squashAtomCommandFailure(result)
                          toastManager.add(
                            stackedThreadToast({
                              type: 'error',
                              title: '取消归档对话失败',
                              description: error instanceof Error ? error.message : '发生错误。',
                            }),
                          )
                        }
                      })()
                    }}
                  >
                    <ArchiveX className="size-3.5" />
                    <span>取消归档</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  )
}
