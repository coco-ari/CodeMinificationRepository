import {
  isOrchestrationV2WorkActive,
  isToolLifecycleItemType,
  type AssetResource,
  type RuntimeItemStatus,
  type ToolActivitySource,
  type ToolActivitySurface,
  type ToolActivityIcon,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import {
  resolveT3McpToolDefinition,
  type T3McpToolDefinition,
  type T3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { classifyToolActivity } from "@t3tools/shared/toolActivity";
import { toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";

import {
  summarizeT3ToolCalls,
  t3ToolResultIndicatesFailure,
  type T3ToolSummaryCall,
} from "@t3tools/client-runtime/t3ToolSummary";

export type WorkLogToolLifecycleStatus = RuntimeItemStatus | "stopped" | "idle";

export function toolItemForDisplay(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
    case "dynamic_tool": {
      const { output: _output, ...displayItem } = item;
      return displayItem;
    }
    case "file_change": {
      const { diffStr, oldStr: _oldStr, newStr: _newStr, ...displayItem } = item;
      // A failed edit's diffStr holds the provider's error, not a diff.
      return item.status === "failed" && diffStr?.trim()
        ? { ...displayItem, diffStr }
        : displayItem;
    }
    default:
      return item;
  }
}

type CompactionLabelItem = Pick<
  Extract<OrchestrationV2TurnItem, { type: "compaction" }>,
  "status" | "beforeTokenCount" | "afterTokenCount"
>;

export function contextCompactionTokenCounts(
  item: CompactionLabelItem,
): { readonly before: string; readonly after: string } | null {
  if (
    item.status === "running" ||
    item.beforeTokenCount === undefined ||
    item.afterTokenCount === undefined
  ) {
    return null;
  }
  return { before: formatTokens(item.beforeTokenCount), after: formatTokens(item.afterTokenCount) };
}

export function contextCompactionLabel(item: CompactionLabelItem): string {
  if (item.status === "failed") return "上下文压缩失败";
  if (item.status === "cancelled" || item.status === "interrupted")
    return "上下文压缩已停止";
  if (isOrchestrationV2WorkActive(item.status)) return "正在压缩上下文";
  const tokens = contextCompactionTokenCounts(item);
  return tokens
    ? `上下文已压缩：${tokens.before} → ${tokens.after} 个 token`
    : "上下文已压缩";
}

export interface WorkLogPresentationEntry {
  readonly questionAnswer?: import("@t3tools/contracts").UserInputAttachmentAnswerPayload;
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly rawCommand?: string;
  readonly detail?: string;
  readonly viewedImagePath?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly requestKind?: string;
  readonly itemType?: OrchestrationV2TurnItem["type"];
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly structuredPayload?: OrchestrationV2TurnItem;
  readonly toolSource?: ToolActivitySource;
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
}

export type ToolGroupAction =
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "read"
  | "edit"
  | "command"
  | "thread-create"
  | "browser"
  | "device"
  | "code-search"
  | "search"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | "pull-request"
  | ToolGroupAction
  | "dynamic-tool"
  | "reasoning"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function workEntryToolName(
  entry: Pick<WorkLogPresentationEntry, "label" | "toolTitle" | "toolData" | "structuredPayload">,
): string | undefined {
  const item = entry.structuredPayload;
  if (item?.type === "dynamic_tool" && item.toolName) return item.toolName;
  const data = asRecord(entry.toolData);
  if (typeof data?.server === "string" && typeof data.tool === "string") {
    return `${data.server}.${data.tool}`;
  }
  if (typeof data?.toolName === "string") return data.toolName;
  return resolveT3McpToolDefinition(entry.toolTitle) ? entry.toolTitle : entry.label;
}

function workEntryToolOutput(
  entry: Pick<WorkLogPresentationEntry, "toolData" | "structuredPayload">,
): unknown {
  const item = entry.structuredPayload;
  const data = asRecord(entry.toolData);
  return item?.type === "dynamic_tool"
    ? item.output
    : (data?.output ?? data?.result ?? data?.rawOutput ?? data?.content);
}

// Translate only the fixed upstream presentation vocabulary; tool IDs, aliases and output stay intact.
const t3ToolDisplayLabels: Readonly<Record<string, string>> = {
  "Link": "关联",
  "Linking": "正在关联",
  "Linked": "已关联",
  "Unlink": "取消关联",
  "Unlinking": "正在取消关联",
  "Unlinked": "已取消关联",
  "Check": "检查",
  "Checking": "正在检查",
  "Checked": "已检查",
  "Watch": "关注",
  "Watching": "正在关注",
  "Stop watching": "停止关注",
  "Unwatching": "正在停止关注",
  "Stopped watching": "已停止关注",
  "Write": "编写",
  "Writing": "正在编写",
  "Started writing": "已开始编写",
  "Read": "读取",
  "Reading": "正在读取",
  "Get": "获取",
  "Getting": "正在获取",
  "Got": "已获取",
  "Delegate": "委派",
  "Delegating": "正在委派",
  "Delegated": "已委派",
  "Cancel": "取消",
  "Canceling": "正在取消",
  "Requested cancellation of": "已请求取消",
  "Schedule": "安排",
  "Scheduling": "正在安排",
  "Scheduled": "已安排",
  "List": "列出",
  "Listing": "正在列出",
  "Listed": "已列出",
  "Update": "更新",
  "Updating": "正在更新",
  "Updated": "已更新",
  "Delete": "删除",
  "Deleting": "正在删除",
  "Requested deletion of": "已请求删除",
  "Deleted": "已删除",
  "Ask for": "请求",
  "Asking for": "正在请求",
  "Asked for": "已请求",
  "Create": "创建",
  "Creating": "正在创建",
  "Created": "已创建",
  "Start": "启动",
  "Starting": "正在启动",
  "Started": "已启动",
  "Send": "发送",
  "Sending": "正在发送",
  "Sent": "已发送",
  "Wait": "等待",
  "Waiting": "正在等待",
  "Waited": "已等待",
  "Stop": "停止",
  "Stopping": "正在停止",
  "Stopped": "已停止",
  "Requested a stop for": "已请求停止",
  "Interrupt": "中断",
  "Interrupting": "正在中断",
  "Requested an interrupt of": "已请求中断",
  "Hand off": "转移",
  "Handing off": "正在转移",
  "Handed off": "已转移",
  "Run": "运行",
  "Running": "正在运行",
  "Requested a run of": "已请求运行",
  "Edit": "编辑",
  "Editing": "正在编辑",
  "Edited": "已编辑",
  "Reorder": "调整顺序",
  "Reordering": "正在调整顺序",
  "Reordered": "已调整顺序",
  "Steer with": "引导当前执行",
  "Steering with": "正在引导当前执行",
  "Requested steering with": "已请求引导当前执行",
  "Answer": "回答",
  "Answering": "正在回答",
  "Answered": "已回答",
  "Set": "设置",
  "Setting": "正在设置",
  "Fork": "创建分支",
  "Forking": "正在创建分支",
  "Requested a fork of": "已请求创建分支",
  "Merge": "合并",
  "Merging": "正在合并",
  "Requested a merge of": "已请求合并",
  "Search": "搜索",
  "Searching": "正在搜索",
  "Searched": "已搜索",
  "Organize": "整理",
  "Organizing": "正在整理",
  "Organized": "已整理",
  "Launch": "启动",
  "Launching": "正在启动",
  "Launched": "已启动",
  "Register": "注册",
  "Registering": "正在注册",
  "Registered": "已注册",
  "Clone": "克隆",
  "Cloning": "正在克隆",
  "Cloned": "已克隆",
  "Prepare": "准备",
  "Preparing": "正在准备",
  "Prepared": "已准备",
  "Discard": "丢弃",
  "Discarding": "正在丢弃",
  "Discarded": "已丢弃",
  "Preview": "预览",
  "Previewing": "正在预览",
  "Previewed": "已预览",
  "Render": "渲染",
  "Rendering": "正在渲染",
  "Rendered": "已渲染",
  "a pull request": "拉取请求",
  "linked pull requests": "关联的拉取请求",
  "review guides": "评审指南",
  "a review guide": "评审指南",
  "orchestration capabilities": "编排能力",
  "a child task": "子任务",
  "delegated task status": "已委派任务的状态",
  "a delegated task": "已委派任务",
  "a recurring task": "定时任务",
  "scheduled tasks": "定时任务",
  "a scheduled task": "定时任务",
  "a secret": "密钥",
  "T3 threads": "T3 对话",
  "a T3 thread": "T3 对话",
  "to a T3 thread": "到 T3 对话",
  "for a T3 thread": "T3 对话",
  "a workflow": "工作流",
  "thread to a git worktree": "对话到 Git 工作树",
  "thread worktree status": "对话工作树状态",
  "queued messages": "队列消息",
  "a queued message": "队列消息",
  "a queued run": "队列轮次",
  "pending questions": "待回答问题",
  "thread configuration": "对话配置",
  "thread model": "对话模型",
  "this thread": "当前对话",
  "thread context": "对话上下文",
  "thread content": "对话内容",
  "thread transfers": "对话转移记录",
  "a thread": "对话",
  "T3 thread metadata": "T3 对话元数据",
  "workspace branches": "工作区分支",
  "preview tabs": "预览标签页",
  "a preview tab": "预览标签页",
  "environment preferences": "环境偏好",
  "a project thread": "项目对话",
  "projects": "项目",
  "a project": "项目",
  "a repository": "仓库",
  "an attachment upload": "附件上传",
  "a pending attachment": "待发送附件",
  "attachments": "附件",
  "an HTML page": "HTML 页面",
  "Open": "打开",
  "Opening": "正在打开",
  "Opened": "已打开",
  "Close": "关闭",
  "Closing": "正在关闭",
  "Closed": "已关闭"
};

function displayT3ToolLabel(label: string): string {
  return t3ToolDisplayLabels[label] ?? label;
}

function resolveT3McpToolPresentation(
  definition: T3McpToolDefinition | null,
  status: string | undefined,
  data?: unknown,
) {
  if (!definition) return null;
  const [rawAction, rawRunning, rawCompleted, rawDetail] = definition.labels;
  const action = displayT3ToolLabel(rawAction);
  const running = displayT3ToolLabel(rawRunning);
  const completed = displayT3ToolLabel(rawCompleted);
  const detail = displayT3ToolLabel(rawDetail);
  const verb =
    status === "inProgress"
      ? running
      : status === "completed"
        ? completed
        : status === "failed"
          ? `${action}失败`
          : status === "declined"
            ? `已拒绝${action}`
            : status === "stopped"
              ? `已停止${action}`
              : running;

  const actionKind =
    definition.summaryAction === "link-pr" ||
    definition.summaryAction === "unlink-pr" ||
    definition.summaryAction === "list-prs" ||
    definition.summaryAction === "watch-pr" ||
    definition.summaryAction === "unwatch-pr"
      ? definition.summaryAction
      : undefined;
  const payload = asRecord(data);
  const input =
    asRecord(payload?.arguments) ?? asRecord(payload?.input) ?? asRecord(payload?.rawInput);
  const urlTarget = typeof input?.url === "string" ? parseChangeRequestUrl(input.url) : null;
  const number = urlTarget?.number ?? input?.number;
  const target =
    actionKind !== undefined &&
    actionKind !== "list-prs" &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
      ? `PR #${number}`
      : detail;
  return {
    displayName: `${verb} ${target}`,
    icon: definition.icon,
    ...(actionKind === undefined ? {} : { action: actionKind }),
  };
}

export function liveActivityToolStatus(status: string | undefined, presentTense: boolean) {
  if (status === "failed" || status === "declined" || status === "stopped" || status === "idle") {
    return status;
  }
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

export function resolveWorkEntryToolPresentation(
  entry: Pick<
    WorkLogPresentationEntry,
    "label" | "toolTitle" | "toolData" | "toolLifecycleStatus" | "structuredPayload"
  >,
  fallbackStatus?: "inProgress" | "completed",
) {
  const definition = resolveT3McpToolDefinition(workEntryToolName(entry));
  const status = entry.toolLifecycleStatus ?? fallbackStatus;
  return resolveT3McpToolPresentation(
    definition,
    definition && t3ToolResultIndicatesFailure(workEntryToolOutput(entry)) ? "failed" : status,
    entry.toolData,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function commandResultContent(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  const directContent = Array.isArray(value) ? value : null;
  const record = asRecord(value);
  const content = record?.content;
  const contentText = nonEmptyString(content);
  if (contentText) return contentText;
  const blocks = directContent ?? (Array.isArray(content) ? content : null);
  if (!blocks) return null;

  const chunks = blocks.flatMap((entry) => {
    const text = nonEmptyString(entry) ?? nonEmptyString(asRecord(entry)?.text);
    return text ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

export function extractCommandOutputText(dataValue: unknown): string | null {
  const data = asRecord(dataValue);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);
  const outputStreams = [
    nonEmptyString(rawOutput?.stdout),
    nonEmptyString(rawOutput?.stderr),
  ].filter((value): value is string => value !== null);
  const acpContent = Array.isArray(data?.content)
    ? data.content
        .flatMap((entryValue) => {
          const entry = asRecord(entryValue);
          const content = asRecord(entry?.content);
          const text = entry?.type === "content" ? nonEmptyString(content?.text) : null;
          return text ? [text] : [];
        })
        .join("\n")
    : null;

  const candidates = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    acpContent,
    data?.result,
  ];
  for (const candidate of candidates) {
    const text = commandResultContent(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * Ingestion caps tool details at 180 chars and appends "...", so a long command
 * echo no longer equals the command it repeats. Treat a truncated prefix of the
 * command as the same echo.
 */
function textRepeatsCommand(text: string, commands: ReadonlyArray<string | null>): boolean {
  const truncated = text.endsWith("...")
    ? text.slice(0, -3)
    : text.endsWith("\u2026")
      ? text.slice(0, -1)
      : null;
  return commands.some((candidate) => {
    const command = candidate?.trim();
    if (!command) return false;
    if (command === text) return true;
    return (
      truncated !== null &&
      truncated.length > 0 &&
      command.length > truncated.length &&
      command.startsWith(truncated)
    );
  });
}

/**
 * OpenCode stores completed output in `detail` with no other output channel, so
 * plain equality is only treated as synthetic when the payload shape shows the
 * detail came from the command: Codex item metadata, an ACP tool call
 * (`data.toolCallId`, `kind: "execute"`), a Claude tool-name prefix, or no
 * structured command at all.
 */
export function commandDetailRepeatsCommand(input: {
  readonly detail: string;
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly toolName: unknown;
  readonly data: unknown;
}): boolean {
  const toolName = nonEmptyString(input.toolName)?.trim();
  const detail = input.detail.trim();
  const commands = [input.command, input.rawCommand];
  if (toolName) {
    const prefix = `${toolName}:`;
    if (detail.toLowerCase().startsWith(prefix.toLowerCase())) {
      const unprefixed = detail.slice(prefix.length).trim();
      if (textRepeatsCommand(unprefixed, commands)) return true;
    }
  }

  if (!textRepeatsCommand(detail, commands)) return false;

  const data = asRecord(input.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const hasStructuredCommand = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
  ].some((value) =>
    Array.isArray(value)
      ? value.some((part) => nonEmptyString(part) !== null)
      : nonEmptyString(value) !== null,
  );
  return (
    !hasStructuredCommand ||
    item !== null ||
    data?.toolCallId !== undefined ||
    nonEmptyString(data?.kind)?.toLowerCase() === "execute"
  );
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

function workEntryIndicatesToolFailureFromOutput(
  entry: WorkLogPresentationEntry,
  includeCommand: boolean,
): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return true;
  }
  // Reasoning detail is the model's own prose (often tens of KB), not tool
  // output: scanning it is slow on long threads and misreads phrases like
  // "that exit code 2 is expected" as a failed tool.
  if (!workLogEntryIsToolLike(entry) || entry.itemType === "reasoning") return false;
  if (
    resolveT3McpToolDefinition(workEntryToolName(entry)) &&
    t3ToolResultIndicatesFailure(workEntryToolOutput(entry))
  ) {
    return true;
  }
  const item = entry.structuredPayload;
  if (item?.type === "command_execution") {
    if (item.outputIndicatesFailure || (item.exitCode !== undefined && item.exitCode !== 0)) {
      return true;
    }
    if (item.output && toolOutputIndicatesFailure(item.output.slice(0, 32_768))) {
      return true;
    }
  }
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolOutputIndicatesFailure(output);
}

export function workEntryIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, true);
}

export function workEntryDisplayIndicatesToolFailure(entry: WorkLogPresentationEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, false);
}

export function workEntryIndicatesToolSuccess(entry: WorkLogPresentationEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    entry.tone !== "thinking" &&
    entry.toolLifecycleStatus !== "idle" &&
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped"
  );
}

function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "file_search" ||
    (entry.itemType === "web_search" &&
      /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label)))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (entry.itemType === "thread_created") return "thread-create";
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation?.action !== undefined) return presentation.action;
  if (presentation?.icon === "browser") return "browser";
  if (presentation?.icon === "device") return "device";
  if (entry.requestKind === "file-read" || entry.viewedImagePath !== undefined) return "read";
  if (entry.itemType === "approval_request" || entry.itemType === "user_input_request") {
    return workLogEntryIsToolLike(entry) ? "other" : "update";
  }
  const data = asRecord(entry.toolData) ?? {};
  const toolName =
    entry.structuredPayload?.type === "dynamic_tool"
      ? entry.structuredPayload.toolName
      : typeof data.toolName === "string"
        ? data.toolName
        : entry.toolTitle;
  const classified = classifyToolActivity({
    itemType:
      entry.itemType === "command_execution" ||
      entry.itemType === "file_change" ||
      entry.itemType === "web_search"
        ? entry.itemType
        : entry.itemType === "dynamic_tool"
          ? "dynamic_tool_call"
          : undefined,
    title: entry.toolTitle ?? entry.label,
    data: {
      ...data,
      ...(toolName ? { toolName } : {}),
    },
  });
  if (classified === "read") return "read";
  if (classified === "file_change" || entry.itemType === "file_change") return "edit";
  if (classified === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (classified === "search") {
    return entry.itemType === "web_search" && !workLogEntryIsLocalCodeSearch(entry)
      ? "search"
      : "code-search";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  if ((entry.changedFiles?.length ?? 0) > 0) return "edit";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const viewedImagePath = entry.viewedImagePath?.trim();
  if (
    viewedImagePath !== undefined &&
    !/[\r\n]/.test(viewedImagePath) &&
    isWorkspaceImagePreviewPath(viewedImagePath)
  ) {
    return viewedImagePath;
  }
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "media-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

export function resolveViewedImageAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;
  const resolvedFilePath =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;

  const media = resolveMediaSource(source, {
    threadId: input.threadId,
    workspaceRoot: input.workspaceRoot,
    resolvedFilePath,
  });
  if (media === null || media.access !== "environment") return null;
  return { resource: media.resource, alt: media.name, srcFragment: media.srcFragment };
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action !== "edit") return entries.length;
  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
    } else {
      for (const file of entry.changedFiles) changedFiles.add(file);
    }
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "link-pr": return `已关联 ${count} 个拉取请求`;
    case "unlink-pr": return `已取消关联 ${count} 个拉取请求`;
    case "watch-pr": return `正在关注 ${count} 个拉取请求`;
    case "unwatch-pr": return `已停止关注 ${count} 个拉取请求`;
    case "list-prs": return count === 1 ? "已检查关联的拉取请求" : `已检查关联的拉取请求 ${count} 次`;
    case "read": return `已读取 ${count} 个文件`;
    case "edit": return `已修改 ${count} 个文件`;
    case "command": return `已运行 ${count} 条命令`;
    case "thread-create": return `已创建 ${count} 个对话`;
    case "device": return `已使用设备控制 ${count} 次`;
    case "browser": return `已使用浏览器 ${count} 次`;
    case "search": return `已搜索网页 ${count} 次`;
    case "code-search": return `已搜索代码 ${count} 次`;
    case "other": return `已使用 ${count} 个工具`;
    case "update": return `已收到 ${count} 条更新`;
  }
}

function t3ToolSummaryCall(entry: WorkLogPresentationEntry): T3ToolSummaryCall {
  const item = entry.structuredPayload;
  const data =
    entry.toolData !== null && typeof entry.toolData === "object"
      ? (entry.toolData as Record<string, unknown>)
      : undefined;
  return {
    input:
      item?.type === "dynamic_tool"
        ? item.input
        : (data?.arguments ?? data?.input ?? data?.rawInput),
    output: workEntryToolOutput(entry),
    outcome:
      entry.toolLifecycleStatus === "failed" ||
      entry.toolLifecycleStatus === "declined" ||
      entry.tone === "error"
        ? "failed"
        : entry.toolLifecycleStatus === "completed"
          ? "completed"
          : "unfinished",
  };
}

function summaryActionPriority(action: ToolGroupAction | T3McpToolSummaryAction): number {
  switch (action) {
    case "command":
    case "edit":
    case "delegate":
    case "task-cancel":
    case "thread-create":
    case "thread-send":
    case "thread-interrupt":
    case "workflow-stop":
    case "schedule-create":
    case "schedule-update":
    case "schedule-delete":
    case "schedule-run":
    case "thread-configure":
    case "thread-fork":
    case "thread-merge":
    case "thread-organize":
    case "thread-update":
    case "queue-edit":
    case "queue-cancel":
    case "queue-reorder":
    case "queue-steer":
    case "question-respond":
    case "worktree-handoff":
    case "project-create":
    case "project-update":
    case "project-delete":
    case "project-clone":
    case "environment-update":
    case "attachment-prepare":
    case "attachment-discard":
    case "attachment-send":
      return 0;
    case "other":
    case "update":
      return 2;
    default:
      return 1;
  }
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): {
  summary: string;
  hasFailure: boolean;
} {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) {
    return {
      summary: entries.length === 1 ? "思考过程" : `思考过程（×${entries.length}）`,
      hasFailure: false,
    };
  }
  entries = toolEntries;
  const groups = new Map<
    ToolGroupAction | T3McpToolSummaryAction,
    {
      action: ToolGroupAction;
      t3Action: T3McpToolSummaryAction | null;
      entries: WorkLogPresentationEntry[];
    }
  >();
  const sources = new Map<string, ToolActivitySource>();
  for (const entry of entries) {
    const t3Action = resolveT3McpToolDefinition(workEntryToolName(entry))?.summaryAction ?? null;
    if (entry.toolSource && t3Action === null) {
      sources.set(entry.toolSource.key, entry.toolSource);
      continue;
    }
    const action = toolGroupAction(entry);
    const key = t3Action ?? action;
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { action, t3Action, entries: [entry] });
  }
  const summaries = [...groups].map(([action, group], index) => ({
    index,
    count: group.entries.length,
    priority: summaryActionPriority(action),
    ...(group.t3Action
      ? summarizeT3ToolCalls(group.t3Action, group.entries.map(t3ToolSummaryCall))
      : {
          label: toolGroupActionLabel(
            group.action,
            toolGroupActionCount(group.action, group.entries),
          ),
          failedCount: group.entries.filter(workEntryDisplayIndicatesToolFailure).length,
        }),
  }));
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ label }) => label);
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const sourceNames = [...new Set(sourceValues.map((source) => source.name))];
    const formattedNames =
      sourceNames.length < 2
        ? sourceNames[0]!
        : sourceNames.length === 2
          ? sourceNames.join("和")
          : `${sourceNames.slice(0, -1).join("、")}和${sourceNames.at(-1)}`;
    const allIntegrations = sourceValues.every((source) => source.kind === "integration");
    labels.unshift(
      `已使用 ${formattedNames}${allIntegrations ? " 集成" : ""}`,
    );
  }
  const sourcedCount = entries.filter(
    (entry) =>
      entry.toolSource !== undefined &&
      resolveT3McpToolDefinition(workEntryToolName(entry)) === null,
  ).length;
  const remainingCount =
    entries.length - sourcedCount - selected.reduce((count, group) => count + group.count, 0);
  if (remainingCount > 0) {
    labels.push(`已完成 ${remainingCount} 项其他操作`);
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  const summary =
    sentenceLabels.length < 3
      ? sentenceLabels.join("，")
      : sentenceLabels.join("，");
  return { summary, hasFailure: summaries.some((group) => group.failedCount > 0) };
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const toolEntries = entries.filter((entry) => entry.itemType !== "reasoning");
  if (entries.length > 0 && toolEntries.length === 0) return "reasoning";
  entries = toolEntries;
  if (
    entries.length > 0 &&
    entries.every((entry) => resolveWorkEntryToolPresentation(entry)?.icon === "pull-request")
  )
    return "pull-request";
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";
  const action = actions.values().next().value!;
  if (action !== "other") return action;
  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "dynamic_tool") return "dynamic-tool";
      if (entry.itemType === "subagent") return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}

export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}
