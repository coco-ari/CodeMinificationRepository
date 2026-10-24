import { describe, expect, it } from "vite-plus/test";
import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";
import { resolveWorkEntryToolPresentation, summarizeToolGroup, type WorkLogPresentationEntry } from "./presentation";

const entry = (fields: Partial<WorkLogPresentationEntry> = {}): WorkLogPresentationEntry => ({
  id: "tool-1",
  createdAt: "2026-10-24T00:00:00.000Z",
  tone: "tool",
  label: "原始工具标题",
  itemType: "dynamic_tool",
  toolLifecycleStatus: "completed",
  ...fields,
});

describe("中文工具摘要", () => {
  it.each(["t3-code", "mcp:t3-code", "mcp:t3_code", "mcp:t3code", "mcp:t3"])("按来源标识 %s 识别工作台工具且不修改记录", (key) => {
    const source = Object.freeze({ key, name: "T3", kind: "integration" as const });
    const call = Object.freeze(entry({ toolSource: source }));
    expect(summarizeToolGroup([call, call])).toEqual({ summary: "已调用工作台工具", hasFailure: false });
    expect(source.name).toBe("T3");
    expect(call.label).toBe("原始工具标题");
  });

  it("保留同名第三方工具及自定义来源名称", () => {
    expect(summarizeToolGroup([entry({ toolSource: { key: "mcp:customer", name: "T3", kind: "integration" } })]).summary).toBe("已调用T3工具");
    expect(summarizeToolGroup([entry({ toolSource: { key: "mcp:slack", name: "Slack", kind: "integration" } })]).summary).toBe("已调用Slack工具");
  });

  it("工具来源分组仍保留失败，混合成功不会覆盖错误", () => {
    const source = { key: "mcp:t3", name: "T3", kind: "integration" as const };
    const failed = entry({ toolSource: source, toolLifecycleStatus: "failed" });
    const success = entry({ id: "success", toolSource: source });
    expect(summarizeToolGroup([failed, success])).toEqual({ summary: "已调用工作台工具", hasFailure: true });
  });

  it("已知工具保留具体操作与失败状态，不退化成泛称", () => {
    for (const tool of T3_MCP_TOOL_NAMES) {
      const call = entry({ label: `T3-code.${tool}`, toolSource: { key: "t3-code", name: "T3 Code", kind: "integration" } });
      expect(resolveWorkEntryToolPresentation(call)?.displayName, tool).toMatch(/[\u4e00-\u9fff]/);
      expect(summarizeToolGroup([call]).summary, tool).not.toMatch(/集成|T3|工作台工具/);
      expect(summarizeToolGroup([entry({ ...call, toolLifecycleStatus: "failed" })]).hasFailure, tool).toBe(true);
    }
  });

  it("电脑和浏览器工具用中文去重，执行标题原样保留", () => {
    const call = entry({ toolSource: { key: "computer-use", name: "Computer Use", kind: "computer" } });
    expect(summarizeToolGroup([call, call]).summary).toBe("已调用电脑操作工具");
    expect(call.label).toBe("原始工具标题");
    expect(summarizeToolGroup([entry({ toolSource: { key: "browser-use", name: "Browser", kind: "browser" } })]).summary).toBe("已调用浏览器工具");
  });
});
