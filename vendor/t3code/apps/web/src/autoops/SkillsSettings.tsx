import { useNavigate } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { readAutoOpsHost } from "./hostConfig";
import { autoOpsProjectHref, useAutoOpsProjectId } from "./projectNavigation";

export function AutoOpsSkillsSettings() {
  const navigate = useNavigate();
  const projectId = useAutoOpsProjectId();
  const host = readAutoOpsHost();
  if (!host) return null;
  return (
    <SettingsSection id="autoops-skills" title="skill">
      <SettingsRow
        title="skill库"
        description="集中管理完整skill包、固定版本，以及助手和项目的可用范围。"
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigate({
                href: projectId ? autoOpsProjectHref("skills", projectId) : "/skills",
              })
            }
          >
            管理skill
          </Button>
        }
      />
      <SettingsRow
        title={host.customerAgentsEnabled ? "使用平台skill" : "使用skill"}
        description={
          host.customerAgentsEnabled
            ? "在平台对话输入 $ 选择当前范围的固定版本skill；客户本机skill仅在对应客户工作区的对话中选择。更新skill库不会自动升级已分配版本。"
            : "在对话中输入 $ 搜索当前范围可用的skill，点击标签查看说明。skill沿用会话权限；更新skill库不会自动升级已分配版本。"
        }
      />
    </SettingsSection>
  );
}
