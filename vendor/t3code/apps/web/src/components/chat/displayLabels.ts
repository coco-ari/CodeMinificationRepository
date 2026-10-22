/** Display-only labels: native option IDs, payloads and user-authored text stay unchanged. */
const labels: Readonly<Record<string, string>> = {
  "Reasoning effort": "推理强度", "Reasoning Effort": "推理强度", reasoningEffort: "推理强度",
  "Reasoning": "思考强度", "Effort": "思考强度", "Thinking": "思考", "Thinking budget": "思考预算",
  "Service tier": "服务级别", "Service Tier": "服务级别", "Fast mode": "快速模式",
  "Context window": "上下文窗口", "Agent": "智能体", "Default": "默认", "default": "默认",
  "None": "无", "none": "无", "Minimal": "最低", "minimal": "最低",
  "Low": "低", "low": "低", "Medium": "中", "medium": "中", "High": "高", "high": "高",
  "Extra High": "很高", "Extra high": "很高", "xhigh": "很高", "Max": "最高", "max": "最高",
  "Ultra": "极高", "ultra": "极高", "Fast": "快速", "Normal": "普通", "Ultrafast": "极速",
  "Auto": "自动", "On": "开启", "Off": "关闭", "Enabled": "已启用", "Disabled": "已禁用",
  "Project": "项目", "Worktree": "工作树", "Branch": "分支", "Workspace": "工作区", "Path": "路径",
  "Approve": "批准", "Allow": "允许", "Allow once": "允许一次", "Approve once": "批准一次",
  "Approve for session": "本次会话批准", "Allow for session": "本次会话允许",
  "Always allow this session": "本次会话始终允许", "Decline": "拒绝", "Deny": "拒绝", "Cancel": "取消",
  pending: "等待中", queued: "已排队", running: "执行中", in_progress: "执行中",
  waiting: "等待中", completed: "已完成", failed: "失败", error: "错误", cancelled: "已取消",
  interrupted: "已中断", idle: "空闲", expired: "已过期", accepted: "已接受", declined: "已拒绝",
  resolved: "已解决", superseded: "已替代", consumed: "已使用", reverted: "已回退",
  not_resumable: "无法恢复", native: "原生", portable: "可移植",
};
export function displayChatLabel(label: string): string { return labels[label] ?? label; }
