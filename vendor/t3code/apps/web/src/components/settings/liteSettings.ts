import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from '@t3tools/contracts/settings'

// Reset only the preferences exposed by this profile. Hidden preferences, drafts,
// uploaded themes and server policy remain available when the full profile returns.
const fields = [
  ['sendShortcut', '发送快捷键'],
  ['followUpBehavior', '追问处理方式'],
  ['appearanceContrast', '对比度'],
  ['glassOpacity', '玻璃透明度'],
  ['chatWidth', '对话宽度'],
  ['mathRenderingEnabled', '数学公式渲染'],
  ['motionPreference', '界面动效'],
  ['panelAnimationDurationMs', '面板动画'],
  ['fontFamilySans', '界面字体'],
  ['fontSizeInterface', '界面字号'],
  ['fontFamilyComposer', '输入字体'],
  ['fontSizePrompt', '输入字号'],
  ['fontFamilyCode', '代码字体'],
  ['fontSizeCode', '代码字号'],
  ['wordWrap', '自动换行'],
] as const satisfies ReadonlyArray<readonly [keyof ClientSettings, string]>

export function liteSettingsReset(settings: ClientSettings, macOS: boolean) {
  const exposed: ReadonlyArray<readonly [keyof ClientSettings, string]> = macOS
    ? [...fields, ['fontSmoothing', '字体平滑']]
    : fields
  const changed = exposed.filter(([key]) => settings[key] !== DEFAULT_CLIENT_SETTINGS[key])
  return {
    labels: changed.map(([, label]) => label),
    patch: Object.fromEntries(changed.map(([key]) => [key, DEFAULT_CLIENT_SETTINGS[key]])) as Partial<ClientSettings>,
  }
}

export async function persistLiteSettingsReset(
  settings: ClientSettings,
  macOS: boolean,
  persistUpdate: (update: (raw: ClientSettings) => ClientSettings) => Promise<ClientSettings>,
): Promise<void> {
  const { patch } = liteSettingsReset(settings, macOS)
  if (Object.keys(patch).length > 0) {
    await persistUpdate((raw) => ({ ...raw, ...patch }))
  }
}
