import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  describeMcpElicitation,
  describeMcpUserInput,
  toMcpElicitationResponse,
} from "./CodexMcpElicitation.ts";

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("Codex ordinary MCP forms", () => {
  const request = {
    mode: "form",
    serverName: "t3-code",
    threadId: "thread-1",
    turnId: "turn-1",
    message: "选择发布环境并说明原因",
    requestedSchema: {
      type: "object",
      properties: {
        environment: { type: "string", enum: ["测试", "生产"] },
        reason: { type: "string", minLength: 3 },
      },
      required: ["environment", "reason"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;
  it("preserves all questions and accepts only the person's actual values", () => {
    const form = describeMcpUserInput(request)!;
    NodeAssert.deepEqual(
      form.questions.map((q) => q.id),
      ["environment", "reason"],
    );
    NodeAssert.deepEqual(
      form.questions[0]!.options?.map((o) => o.label),
      ["测试", "生产"],
    );
    NodeAssert.deepEqual(form.respond({ environment: ["测试"], reason: "先在测试环境验证" }), {
      action: "accept",
      content: { environment: "测试", reason: "先在测试环境验证" },
    });
  });
  it("does not fabricate default answers or approve incomplete/invalid forms", () => {
    const withDefaults = {
      ...request,
      requestedSchema: {
        ...request.requestedSchema,
        properties: {
          ...request.requestedSchema.properties,
          reason: { type: "string", default: "默认值" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;
    NodeAssert.deepEqual(describeMcpUserInput(withDefaults)!.respond({ environment: "测试" }), {
      action: "decline",
    });
    NodeAssert.deepEqual(toMcpElicitationResponse(withDefaults, "accept"), { action: "decline" });
    for (const answers of [
      { environment: "其他", reason: "有效原因" },
      { environment: "测试", reason: "短" },
      { environment: ["测试", "生产"], reason: "有效原因" },
      { environment: "测试", reason: "有效原因", injected: "value" },
    ])
      NodeAssert.deepEqual(describeMcpUserInput(request)!.respond(answers), { action: "decline" });
  });
  it("validates primitive conversion with the MCP SDK's original schema", () => {
    const form = describeMcpUserInput({
      ...request,
      requestedSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 1 }, confirmed: { type: "boolean" } },
        required: ["count", "confirmed"],
      },
    })!;
    NodeAssert.deepEqual(form.respond({ count: "2", confirmed: "false" }), {
      action: "accept",
      content: { count: 2, confirmed: false },
    });
    for (const answers of [
      { count: "1.5", confirmed: "true" },
      { count: "0", confirmed: "true" },
      { count: "", confirmed: "true" },
      { count: "1", confirmed: "yes" },
    ])
      NodeAssert.deepEqual(form.respond(answers), { action: "decline" });
  });
  it("fails closed for unsupported array forms and leaves approval forms on the approval path", () => {
    NodeAssert.equal(
      describeMcpUserInput({
        ...request,
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "array", items: { type: "string", enum: ["a", "b"] }, default: [] } },
          required: ["answer"],
        },
      }),
      undefined,
    );
    NodeAssert.deepEqual(
      toMcpElicitationResponse(
        {
          ...request,
          requestedSchema: {
            type: "object",
            properties: { answer: { type: "array", items: { type: "string", enum: ["a", "b"] }, default: [] } },
            required: ["answer"],
          },
        },
        "accept",
      ),
      { action: "decline" },
    );
    NodeAssert.equal(
      describeMcpUserInput({
        ...request,
        requestedSchema: {
          type: "object",
          properties: { approval: { type: "string", enum: ["once", "always"] } },
          required: ["approval"],
        },
      }),
      undefined,
    );
  });
});
