import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import { createAutoOpsBusinessTools, type BusinessBinding } from "../../../../../../agent-demo/t3-adapters/business-tools.mjs";

const encodeResult = (result: Record<string, unknown>) => Schema.decodeUnknownSync(McpSchema.CallToolResult)({
  isError: false,
  structuredContent: result,
  content: [{ type: "text", text: "业务结果" }],
});

function tools(workspaceType: "internal" | "external", legacy = false) {
  const binding: BusinessBinding = {
    threadId: "thread-input-wire", projectId: "project-input-wire", environmentId: "env-test",
    agentId: "agent-project", ownerId: "actor-test", visibility: "private",
    ...(legacy ? {} : { workspaceType }),
  };
  return createAutoOpsBusinessTools({
    authorizeThread: () => ({
      binding,
      project: { id: binding.projectId, name: "隔离项目", environments: [{ id: "env-test", name: "测试环境" }] },
      agent: { id: binding.agentId },
    }),
    materialInput: {
      id: "input-wire", workspaceType, createdAt: "2026-10-24T00:00:00.000Z", revision: 2,
      repositories: [],
      sourceErrors: workspaceType === "external" ? [] : [{ sourceId: "source-one", name: "公开源码", mountPath: "demo", code: "WORKSPACE_GIT_TIMEOUT", message: "源码获取超时，本轮仅提供资料" }],
      sourceWarnings: workspaceType === "external" ? [] : [{ sourceId: "source-ready", name: "已同步源码", mountPath: "ready", code: "WORKSPACE_GIT_TIMEOUT", message: "更新失败，已同步内容仍可读取" }],
      files: [{ path: "docs/产品.pdf", name: "产品.pdf", mime: "application/pdf", size: 128 }],
      read: async () => ({ contents: "产品说明正文", byteLength: 18, truncated: false }),
    },
    loadAttachments: () => [],
    storeArtifact: () => { throw new Error("此回归不生成报告"); },
  });
}

describe("业务工具使用真实 MCP JSON 结果合同", () => {
  it.each([
    ["internal", false],
    ["external", false],
    ["internal", true],
  ] as const)("%s 范围，旧绑定=%s 的本轮资料结果可编码", async (workspaceType, legacy) => {
    const business = tools(workspaceType, legacy);
    const listing = await business.listMaterials("thread-input-wire");
    const result = encodeResult(listing);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      source: "workspace_input",
      workspace: { inputId: "input-wire", type: workspaceType, source: { repositories: [] } },
      documents: [{ id: "docs/产品.pdf", path: "autoops/project-input-wire/inputs/input-wire/docs/产品.pdf" }],
    });
    expect(listing.workspace).not.toHaveProperty("source.contentHash");
    expect(encodeResult(await business.queryEnvironment("thread-input-wire", "env-test")).isError).toBe(false);
    expect(encodeResult(await business.readDocument("thread-input-wire", "docs/产品.pdf")).structuredContent).toMatchObject({
      inputId: "input-wire", workspaceType, content: "产品说明正文",
    });
    if (workspaceType === "internal") {
      expect(result.structuredContent).toMatchObject({ workspace: { sourceErrors: [{ code: "WORKSPACE_GIT_TIMEOUT" }], sourceWarnings: [{ mountPath: "ready", code: "WORKSPACE_GIT_TIMEOUT" }] } });
      expect(encodeResult(await business.queryEnvironment("thread-input-wire", "env-test")).structuredContent).toMatchObject({ workspace: { sourceWarnings: [{ mountPath: "ready" }] } });
      await expect(business.readDocument("thread-input-wire", "demo/README.md")).rejects.toMatchObject({ code: "WORKSPACE_INPUT_SOURCE_UNAVAILABLE" });
    }
  });

  it("JSON 合同确实拒绝嵌套 undefined，不能用 stringify 隐式删除掩盖缺陷", () => {
    expect(() => encodeResult({ workspace: { source: { contentHash: undefined } } })).toThrow();
  });
});
