import type { RuntimeMode } from "@t3tools/contracts";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "逐项确认",
    description: "执行命令和修改文件前询问。",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "自动接受编辑",
    description: "自动批准编辑，其他操作前询问。",
    icon: PenLineIcon,
  },
  auto: {
    label: "自动",
    description: "支持此模式的运行器会批准常规操作，其他运行器仍会询问。",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "完全访问",
    description: "执行命令和编辑时无需询问。",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
