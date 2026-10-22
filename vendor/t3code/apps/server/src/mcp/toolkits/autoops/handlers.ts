import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { McpServer, McpSchema } from "effect/ai";
import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import * as Config from "../../../config.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { AutoOpsToolkit } from "./tools.ts";
import { requireToolThread } from "../../../../../../../../agent-demo/t3-adapters/access.mjs";
import { createAutoOpsBusinessTools, configuredBusinessArtifactStore } from "../../../../../../../../agent-demo/t3-adapters/business-tools.mjs";
import { renderBusinessPdf } from "../../../../../../../../agent-demo/t3-adapters/business-documents.mjs";
import { configuredBusinessResourceCatalog } from "../../../../../../../../agent-demo/t3-adapters/resources.mjs";

function artifacts() {
  const store = configuredBusinessArtifactStore();
  if (!store) throw new Error("AutoOps business storage is not configured");
  return store;
}
const unavailable = () => new OrchestratorMcpFailure({ code: "capability_denied", message: "当前会话业务权限或运行状态无效。" });
const toolFailure = (error: unknown) => new OrchestratorMcpFailure({
  code: "invalid_request",
  message: error instanceof Error && "code" in error ? error.message : "业务工具无法完成，请检查文件或授权状态。",
});
const current = Effect.gen(function* () {
  const scope = yield* Invocation.requireMcpCapability("autoops").pipe(Effect.mapError(unavailable));
  const caller = yield* Invocation.requireThreadScope(scope, "AutoOps business tools");
  const authorized = yield* Effect.try({ try: () => requireToolThread(caller.thread.threadId), catch: toolFailure });
  const threads = yield* Threads.ThreadManagementService;
  const config = yield* Config.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const projection = yield* threads.getThreadProjection(caller.thread.threadId).pipe(Effect.mapError(unavailable));
  const shell = yield* threads.getThreadShell(caller.thread.threadId).pipe(Effect.mapError(unavailable));
  const runId = shell?.activeRunId;
  if (runId == null || projection.thread.deletedAt !== null) return yield* unavailable();
  const files = [...new Map(projection.messages.flatMap((message) => message.attachments).map((file) => [file.id, file] as const)).values()];
  const tools = createAutoOpsBusinessTools({
    authorizeThread: (threadId) => requireToolThread(threadId),
    loadAttachments: () => files.map((file) => ({ id: file.id, name: file.name, mime: file.mimeType, sourceUrl: `/api/agent-demo/t3/autoops/attachments/${encodeURIComponent(file.id)}` })),
    loadAttachmentBytes: (_binding, id) => {
      const file = files.find((candidate) => candidate.id === id);
      if (file === undefined) throw new Error("Attachment outside current history");
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: file });
      if (path === null) throw new Error("Invalid attachment identity");
      return Effect.runPromise(fs.readFile(path));
    },
    storeArtifact: (input) => artifacts().create(input),
    renderPdf: renderBusinessPdf,
  });
  return { caller, authorized, runId, tools };
});
const invoke = (operation: (context: Effect.Success<typeof current>) => Promise<Record<string, unknown>>) => current.pipe(
  Effect.flatMap((context) => Effect.tryPromise({ try: () => operation(context), catch: toolFailure })),
);

export const layer = Access.toLayer(AutoOpsToolkit, {
  list_project_materials: Access.readsAsCaller(() => invoke(({ caller, tools }) => tools.listMaterials(caller.thread.threadId))),
  read_project_document: Access.readsAsCaller(({ id }) => invoke(({ caller, tools }) => tools.readDocument(caller.thread.threadId, id))),
  read_project_material: Access.readsAsCaller(({ path }) => invoke(({ caller }) => {
    const catalog = configuredBusinessResourceCatalog();
    if (!catalog) return Promise.reject(new Error("Business catalog unavailable"));
    return catalog.readForThread(caller.thread.threadId, path);
  })),
  read_attachment: Access.readsAsCaller(({ id }) => invoke(({ caller, tools }) => tools.readAttachment(caller.thread.threadId, id))),
  query_environment: Access.readsAsCaller(({ environmentId }) => invoke(({ caller, tools }) => tools.queryEnvironment(caller.thread.threadId, environmentId))),
  create_report: Access.readsAsCaller((input) => invoke(({ caller, runId, tools }) => tools.createReport(caller.thread.threadId, runId, input))),
  ask_user: Access.readsAsCaller((input) => current.pipe(Effect.flatMap(() => Effect.gen(function* () {
    // The client belongs to this HTTP invocation; never capture it while
    // registering a toolkit or retain it across users/provider sessions.
    const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
    if (Option.isNone(client)) return yield* new OrchestratorMcpFailure({ code: "orchestration_error", message: "当前运行器不支持交互表单。" });
    const answer = input.options?.length ? Schema.Literals(input.options) : Schema.String;
    return yield* McpServer.elicit({ message: input.prompt, schema: Schema.Struct({ answer }) }).pipe(
      Effect.provideService(McpSchema.McpServerClient, client.value),
      Effect.catch((error) => {
        // Effect's ElicitationDeclined also wraps transport/protocol failures.
        // Only a response without an underlying failure is a user's decline.
        if (error.cause === undefined) return Effect.succeed({ declined: true });
        const cause = error.cause;
        const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? String(cause._tag) : "Unknown";
        const reason = tag === "McpReverseOperationUnsupported" && typeof cause === "object" && cause !== null && "reason" in cause ? String(cause.reason) : undefined;
        return Effect.logWarning("AutoOps question transport failed", { errorTag: tag, reason }).pipe(
          Effect.andThen(new OrchestratorMcpFailure({ code: "orchestration_error", message: "交互表单未能送达用户；这不是用户取消，请说明暂时无法确认，不要使用默认答案。" })),
        );
      }),
    );
  })))),
});
