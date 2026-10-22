import { useNavigate } from '@tanstack/react-router'
import { Button } from '~/components/ui/button'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { readAutoOpsHost } from './hostConfig'

export function AutoOpsSkillsSettings() {
  const navigate = useNavigate()
  if (!readAutoOpsHost()) return null
  return (
    <SettingsSection id="autoops-skills" title="技能">
      <SettingsRow
        title="技能库"
        description="集中管理完整技能包、固定版本，以及助手和项目的可用范围。"
        control={
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/skills' })}>
            管理技能
          </Button>
        }
      />
      <SettingsRow
        title="使用技能"
        description="在对话中输入 $ 搜索当前范围可用的技能，点击标签查看说明。技能沿用会话权限；更新技能库不会自动升级已分配版本。"
      />
    </SettingsSection>
  )
}
