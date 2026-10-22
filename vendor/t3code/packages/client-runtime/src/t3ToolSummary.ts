import type { T3McpToolSummaryAction } from "@t3tools/shared/t3McpToolPresentation";

export interface T3ToolSummaryCall {
  readonly input: unknown;
  readonly output: unknown;
  readonly outcome: "completed" | "failed" | "unfinished";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface ToolResult {
  readonly data?: Record<string, unknown>;
  readonly failed: boolean;
}

function readResult(value: unknown, depth = 0): ToolResult {
  if (depth > 4) return { failed: false };
  if (typeof value === "string") {
    try {
      return readResult(JSON.parse(value), depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    let data: ToolResult["data"];
    let failed = false;
    for (const block of value) {
      const record = asRecord(block);
      const text = record?.text ?? asRecord(record?.content)?.text;
      const result = readResult(asRecord(text)?.text ?? text, depth + 1);
      data ??= result.data;
      failed ||= result.failed;
    }
    return { ...(data ? { data } : {}), failed };
  }
  const record = asRecord(value);
  if (!record) return { failed: false };
  const failed =
    record.isError === true ||
    record.is_error === true ||
    (typeof record._tag === "string" && /(?:Error|Failure)$/.test(record._tag)) ||
    record.error != null;
  const content = record.structuredContent ?? record.content;
  if (content !== undefined) {
    const result = readResult(content, depth + 1);
    return { ...(result.data ? { data: result.data } : {}), failed: failed || result.failed };
  }
  return { data: record, failed };
}

function readInput(value: unknown): Record<string, unknown> | undefined {
  const input = readResult(value).data;
  // Historical Cursor items retain the MCP args envelope.
  return input && typeof input.toolName === "string" ? asRecord(input.args) : input;
}

/** MCP errors can be returned as data even when the provider completed the tool call. */
export function t3ToolResultIndicatesFailure(output: unknown): boolean {
  return readResult(output).failed;
}

function countEntities(ids: ReadonlyArray<string | undefined>): number {
  return (
    new Set(ids.filter((value) => value !== undefined)).size +
    ids.filter((value) => value === undefined).length
  );
}

function quantity(count: number, noun: string, _plural?: string): string {
  return `${count} ${noun}`;
}

export function summarizeT3ToolCalls(
  action: T3McpToolSummaryAction,
  calls: ReadonlyArray<T3ToolSummaryCall>,
): { label: string; failedCount: number } {
  const results = calls.map((call) => {
    const result = readResult(call.output);
    return {
      input: readInput(call.input),
      output: result.data,
      outcome: result.failed ? ("failed" as const) : call.outcome,
    };
  });
  const completed = results.filter((call) => call.outcome === "completed");
  let failedCount = results.filter((call) => call.outcome === "failed").length;
  const selected = completed.length > 0 ? completed : results;
  const times = quantity(selected.length, "次");
  const phrase = (past: string, infinitive: string, object: string) =>
    `${completed.length > 0 ? past : `尝试${infinitive}`} ${object}`;
  const entityIds = (key: string) =>
    selected.map((call) => id(call.output?.[key]) ?? id(call.input?.[key]));
  const projectIds = selected.map(
    (call) => id(call.output?.id) ?? id(call.output?.projectId) ?? id(call.input?.projectId),
  );
  const threadIds = selected.map(
    (call) =>
      id(call.output?.threadId) ??
      id(asRecord(call.output?.thread)?.threadId) ??
      id(call.input?.threadId),
  );
  let label: string;
  switch (action) {
    case "thread-send": {
      const messages = countEntities(selected.map((call) => id(call.output?.messageId)));
      const targetsKnown = threadIds.every((value) => value !== undefined);
      const threads = new Set(threadIds).size;
      const object = targetsKnown
        ? messages === threads && messages > 1
          ? `消息到 ${quantity(threads, "个对话")}`
          : `${quantity(messages, "条消息")}到 ${quantity(threads, "个对话")}`
        : quantity(messages, "条消息");
      label = phrase("已发送", "发送", object);
      break;
    }
    case "thread-create": {
      const createdIds: string[] = [];
      const resultsKnown =
        completed.length > 0 &&
        completed.every((call) => {
          const threads = Array.isArray(call.output?.threads) ? call.output.threads : [call.output];
          return threads.every((thread) => {
            const record = asRecord(thread);
            if (record?.status === "rolled_back") return true;
            const threadId = id(record?.threadId);
            if (!threadId) return false;
            createdIds.push(threadId);
            return true;
          });
        });
      label = resultsKnown
        ? `已创建 ${quantity(new Set(createdIds).size, "个对话")}`
        : `已请求创建对话 ${times}`;
      break;
    }
    case "delegate":
      label = phrase("已委派", "委派", quantity(countEntities(entityIds("taskId")), "个任务"));
      break;
    case "thread-read":
    case "thread-wait": {
      const targets = threadIds.every((value) => value !== undefined)
        ? quantity(new Set(threadIds).size, "个对话")
        : `对话 ${times}`;
      label =
        action === "thread-read"
          ? phrase("已读取", "读取", targets)
          : phrase("已等待", "等待", targets);
      break;
    }
    case "thread-list":
      label = phrase("已列出", "列出", `对话 ${times}`);
      break;
    case "thread-interrupt":
      label = phrase(
        "已请求中断",
        "中断",
        quantity(countEntities(threadIds), "个对话"),
      );
      break;
    case "workflow-stop":
      label = phrase(
        "已请求停止",
        "停止",
        quantity(countEntities(entityIds("subagentId")), "个工作流"),
      );
      break;
    case "task-status":
      label = phrase("已检查", "检查", `任务状态 ${times}`);
      break;
    case "task-cancel":
      label = phrase(
        "已请求取消",
        "取消",
        quantity(countEntities(entityIds("taskId")), "个任务"),
      );
      break;
    case "schedule-create":
      label = phrase(
        "已安排",
        "安排",
        quantity(countEntities(entityIds("scheduledTaskId")), "个任务"),
      );
      break;
    case "schedule-list":
      label = phrase("已列出", "列出", `定时任务 ${times}`);
      break;
    case "schedule-update":
      label = phrase(
        "已更新",
        "更新",
        quantity(countEntities(entityIds("scheduledTaskId")), "个定时任务"),
      );
      break;
    case "schedule-delete":
      label = phrase(
        "已请求删除",
        "删除",
        quantity(countEntities(entityIds("scheduledTaskId")), "个定时任务"),
      );
      break;
    case "schedule-run":
      label = phrase("已请求", "请求", quantity(selected.length, "次定时任务执行"));
      break;
    case "thread-configuration":
      label = phrase("已检查", "检查", `对话配置 ${times}`);
      break;
    case "thread-configure":
      label = phrase("已设置", "设置", `对话模型 ${times}`);
      break;
    case "thread-fork":
      label = phrase("已请求", "请求", quantity(selected.length, "次分支对话创建"));
      break;
    case "thread-merge":
      label = phrase("已请求", "请求", quantity(selected.length, "次上下文合并"));
      break;
    case "thread-search":
      label = phrase("已搜索", "搜索", `对话 ${times}`);
      break;
    case "thread-transfers":
      label = phrase("已检查", "检查", `对话转移记录 ${times}`);
      break;
    case "thread-organize":
      label = phrase("已整理", "整理", `对话 ${times}`);
      break;
    case "thread-update":
      label = phrase("已更新", "更新", quantity(countEntities(threadIds), "个对话"));
      break;
    case "queue-list":
      label = phrase("已列出", "列出", `队列消息 ${times}`);
      break;
    case "queue-read":
      label = phrase(
        "已读取",
        "读取",
        quantity(countEntities(entityIds("queuedRunId")), "条队列消息"),
      );
      break;
    case "queue-edit":
      label = phrase(
        "已编辑",
        "编辑",
        quantity(countEntities(entityIds("queuedRunId")), "条队列消息"),
      );
      break;
    case "queue-cancel":
      label = phrase(
        "已请求取消",
        "取消",
        quantity(countEntities(entityIds("queuedRunId")), "个队列轮次"),
      );
      break;
    case "queue-reorder":
      label = phrase(
        "已调整顺序",
        "调整顺序",
        quantity(countEntities(entityIds("queuedRunId")), "个队列轮次"),
      );
      break;
    case "queue-steer":
      label = phrase(
        "已请求引导当前执行，使用",
        "引导当前执行，使用",
        quantity(countEntities(entityIds("queuedRunId")), "条队列消息"),
      );
      break;
    case "question-list":
      label = phrase("已列出", "列出", `待回答问题 ${times}`);
      break;
    case "question-read":
      label = phrase(
        "已读取",
        "读取",
        quantity(countEntities(entityIds("requestId")), "个待回答请求"),
      );
      break;
    case "question-respond":
      label = phrase(
        "已回答",
        "回答",
        quantity(countEntities(entityIds("requestId")), "个待回答请求"),
      );
      break;
    case "secret-request":
      label = phrase("已请求", "请求", quantity(selected.length, "项密钥"));
      break;
    case "worktree-handoff":
      label = phrase(
        "已转移到",
        "转移到",
        quantity(countEntities(entityIds("worktreePath")), "个工作树"),
      );
      break;
    case "worktree-list":
      label = phrase("已列出", "列出", `工作区分支 ${times}`);
      break;
    case "worktree-status":
      label = phrase("已检查", "检查", `工作树状态 ${times}`);
      break;
    case "project-list":
      label = phrase("已列出", "列出", `项目 ${times}`);
      break;
    case "project-read":
      label = phrase("已读取", "读取", quantity(countEntities(projectIds), "个项目"));
      break;
    case "project-create":
      label = phrase("已注册", "注册", quantity(countEntities(projectIds), "个项目"));
      break;
    case "project-update":
      label = phrase("已更新", "更新", quantity(countEntities(projectIds), "个项目"));
      break;
    case "project-delete":
      label = phrase("已删除", "删除", quantity(countEntities(projectIds), "个项目"));
      break;
    case "project-clone":
      label = phrase(
        "已克隆",
        "克隆",
        quantity(countEntities(entityIds("cwd")), "个仓库", "个仓库"),
      );
      break;
    case "environment-read":
      label = phrase("已检查", "检查", `环境偏好 ${times}`);
      break;
    case "environment-update":
      label = phrase("已更新", "更新", `环境偏好 ${times}`);
      break;
    case "attachment-prepare":
      label = phrase(
        "已准备",
        "准备",
        quantity(countEntities(entityIds("attachmentId")), "次附件上传"),
      );
      break;
    case "attachment-discard":
      label = phrase(
        "已丢弃",
        "丢弃",
        quantity(countEntities(entityIds("attachmentId")), "个待发送附件"),
      );
      break;
    case "attachment-send": {
      const messages = new Map<string, (typeof selected)[number]>();
      selected.forEach((call, index) =>
        messages.set(id(call.output?.messageId) ?? `call-${index}`, call),
      );
      const attachmentCount = [...messages.values()].reduce(
        (count, call) =>
          count + (Array.isArray(call.input?.attachments) ? call.input.attachments.length : 0),
        0,
      );
      const countsKnown = [...messages.values()].every(
        (call) => Array.isArray(call.input?.attachments) && call.input.attachments.length > 0,
      );
      const targets = threadIds.every((value) => value !== undefined)
        ? `到 ${quantity(new Set(threadIds).size, "个对话")}`
        : "";
      label = phrase(
        "已发送",
        "发送",
        countsKnown
          ? `${quantity(attachmentCount, "个附件")}${targets}`
          : `附件${targets} ${times}`,
      );
      break;
    }
    case "link-pr":
      label = phrase("已关联", "关联", quantity(selected.length, "个拉取请求"));
      break;
    case "unlink-pr":
      label = phrase("已取消关联", "取消关联", quantity(selected.length, "个拉取请求"));
      break;
    case "watch-pr":
      label = phrase("正在关注", "关注", quantity(selected.length, "个拉取请求"));
      break;
    case "unwatch-pr":
      label = phrase(
        "已停止关注",
        "停止关注",
        quantity(selected.length, "个拉取请求"),
      );
      break;
    case "list-prs":
      label = phrase(
        "已检查",
        "检查",
        `关联的拉取请求${selected.length === 1 ? "" : ` ${times}`}`,
      );
      break;
    case "write-pr-guides": {
      // One call writes many guides, and reports a refusal per guide rather than failing.
      const outcomes = selected.flatMap((call) =>
        Array.isArray(call.output?.guides)
          ? call.output.guides.map((guide) => asRecord(guide)?.outcome)
          : [],
      );
      const started = outcomes.filter((outcome) => outcome !== "failed").length;
      const failed = outcomes.length - started;
      failedCount += failed;
      if (outcomes.length === 0) {
        label = phrase(
          "已开始编写",
          "开始编写",
          `评审指南${selected.length === 1 ? "" : ` ${times}`}`,
        );
      } else if (started === 0) {
        label = `未能开始编写 ${quantity(failed, "份评审指南")}`;
      } else {
        label = phrase(
          "已开始",
          "开始",
          `${quantity(started, "份评审指南")}${failed > 0 ? `，${failed} 份失败` : ""}`,
        );
      }
      break;
    }
    case "read-pr-guide":
      label = phrase("已读取", "读取", quantity(selected.length, "份评审指南"));
      break;
    case "browser":
      label = phrase("已使用", "使用", `浏览器 ${times}`);
      break;
    case "device":
      label = phrase("已使用", "使用", `设备控制 ${times}`);
      break;
    case "html-preview":
      label = phrase("已预览", "预览", quantity(selected.length, "个 HTML 页面"));
      break;
    case "html-render":
      label = phrase("已渲染", "渲染", quantity(selected.length, "个 HTML 页面"));
      break;
    case "capabilities":
      label = phrase("已检查", "检查", `编排能力 ${times}`);
      break;
  }
  return { label, failedCount };
}
