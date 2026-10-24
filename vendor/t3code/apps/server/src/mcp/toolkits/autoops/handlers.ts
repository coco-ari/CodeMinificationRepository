import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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
import { configuredAutoOpsAccess, AutoOpsAccessError } from "../../../../../../../../agent-demo/t3-adapters/access.mjs";
import { createAutoOpsBusinessTools, configuredBusinessArtifactStore } from "../../../../../../../../agent-demo/t3-adapters/business-tools.mjs";
import { renderBusinessPdf } from "../../../../../../../../agent-demo/t3-adapters/business-documents.mjs";
import { configuredHostResourceCatalog as configuredBusinessResourceCatalog } from "../../../autoops/resourceCatalog.ts";

import { createBusinessRunInputs } from "../../../../../../../../agent-demo/t3-adapters/thread-inputs.ts";
import { configuredWorkspaceManagement } from "../../../../../../../../agent-demo/t3-adapters/workspace-management.ts";

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
const current = (inputId: string) => Effect.gen(function* () {
  const scope = yield* Invocation.requireMcpCapability("autoops").pipe(Effect.mapError(unavailable));
  const caller = yield* Invocation.requireThreadScope(scope, "AutoOps business tools");
  const access = configuredAutoOpsAccess();
  if (!access) return yield* unavailable();
  const workspace = configuredWorkspaceManagement(access);
  const inputs = createBusinessRunInputs(access, workspace);
  const authorized = yield* Effect.try({ try: () => inputs.require(caller.thread.threadId, inputId), catch: toolFailure });
  const threads = yield* Threads.ThreadManagementService;
  const config = yield* Config.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const projection = yield* threads.getThreadProjection(caller.thread.threadId).pipe(Effect.mapError(unavailable));
  if (projection.thread.deletedAt !== null) return yield* unavailable();
  const runId = authorized.input.runId;
  let historyProjection = projection;
  let historyBinding = authorized.binding;
  // 原生子任务继承创建事件所属父轮的历史，不能借用父会话后来的轮次。
  for (let depth = 0; depth < 64 && !historyProjection.runs.some((run) => run.id === runId) && historyBinding.nativeParentThreadId; depth++) {
    const parentThreadId = historyBinding.nativeParentThreadId;
    historyBinding = yield* Effect.try({ try: () => access.requireToolThread(parentThreadId).binding, catch: toolFailure });
    historyProjection = yield* threads.getThreadProjection(ThreadId.make(parentThreadId)).pipe(Effect.mapError(unavailable));
  }
  const historyRun = historyProjection.runs.find((run) => run.id === runId);
  const ordinal = historyRun?.ordinal;
  const knownRuns = new Set(historyProjection.runs.filter((run) => ordinal !== undefined && run.ordinal <= ordinal).map((run) => run.id));
  // 迟到调用不能看到下一轮的新附件，子任务使用已验证的原父轮历史。
  const history = historyProjection.messages.filter((message) => message.runId !== null ? knownRuns.has(message.runId) : historyRun !== undefined && DateTime.toEpochMillis(message.createdAt) <= DateTime.toEpochMillis(historyRun.requestedAt));
  const referencePaths = history.flatMap((message) => message.context?.records ?? []).flatMap((record) => record.kind === "mention" && "path" in record && typeof record.path === "string" ? [record.path] : []);
  const referenceInputIds = referencePaths.flatMap((path) => path.match(/^autoops\/[^/]+\/inputs\/([^/]+)(?:\/|$)/)?.[1] ?? []);
  const files = [...new Map(history.flatMap((message) => message.attachments).map((file) => [file.id, file] as const)).values()];
  const capture = authorized.capture;
  const inputFiles = yield* Effect.try({ try: () => workspace.inputFiles(capture.projectId, capture.id, authorized.binding.ownerId), catch: toolFailure });
  const tools = createAutoOpsBusinessTools({
    authorizeThread: (threadId) => inputs.require(threadId, inputId),
    materialInput: {
      id: capture.id, workspaceType: capture.workspaceType, createdAt: capture.createdAt, revision: capture.revision,
      sourceErrors: capture.sourceErrors ?? [],
      sourceWarnings: capture.sourceWarnings ?? [],
      repositories: capture.repositories.map((repository) => ({ path: repository.source.mountPath, commit: repository.commit })),
      files: inputFiles.map((file) => ({ ...file, name: file.path.split("/").at(-1)! })),
      read: async (path) => {
        const file = await workspace.readInputContent(capture.projectId, capture.id, path, authorized.binding.ownerId);
        inputs.require(caller.thread.threadId, inputId);
        if (typeof file.contents !== "string") {
          const code = file.extraction.code ?? "RESOURCE_NOT_TEXT";
          const retryable = ["DOCUMENT_BUSY", "DOCUMENT_WORKER_ERROR", "DOCUMENT_WORKER_EXIT", "DOCUMENT_RESOURCE_LIMIT"].includes(code);
          throw new AutoOpsAccessError(code === "DOCUMENT_TIMEOUT" ? 504 : retryable ? 503 : 415, code, file.extraction.message ?? "正文暂不可用，请查看原件");
        }
        return { contents: file.contents, byteLength: new TextEncoder().encode(file.contents).byteLength, truncated: false };
      },
    },
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
  const catalog = configuredBusinessResourceCatalog({ attachmentsDir: config.attachmentsDir, readFile: (path) => Effect.runPromise(fs.readFile(path)) });
  const resourceHistory = { referencePaths, attachmentIds: files.map((file) => file.id), acceptedAt: historyRun ? DateTime.formatIso(historyRun.requestedAt) : "" };
  return { caller, authorized, runId, tools, catalog, referenceInputIds, resourceHistory };
});
const invoke = (inputId: string, operation: (context: Effect.Success<ReturnType<typeof current>>) => Promise<Record<string, unknown>>) => current(inputId).pipe(
  Effect.flatMap((context) => Effect.tryPromise({ try: () => operation(context), catch: toolFailure })),
);

export const layer = Access.toLayer(AutoOpsToolkit, {
  list_project_materials: Access.readsAsCaller(({ inputId }) => invoke(inputId, ({ caller, tools }) => tools.listMaterials(caller.thread.threadId))),
  read_project_document: Access.readsAsCaller(({ inputId, id }) => invoke(inputId, ({ caller, tools }) => tools.readDocument(caller.thread.threadId, id))),
  read_project_material: Access.readsAsCaller(({ inputId, path }) => invoke(inputId, ({ caller, catalog, referenceInputIds, resourceHistory }) => {
    if (!catalog) return Promise.reject(new Error("Business catalog unavailable"));
    return catalog.readForThread(caller.thread.threadId, path, inputId, referenceInputIds, resourceHistory);
  })),
  read_attachment: Access.readsAsCaller(({ inputId, id }) => invoke(inputId, ({ caller, tools }) => tools.readAttachment(caller.thread.threadId, id))),
  query_environment: Access.readsAsCaller(({ inputId, environmentId }) => invoke(inputId, ({ caller, tools }) => tools.queryEnvironment(caller.thread.threadId, environmentId))),
  create_report: Access.readsAsCaller((input) => invoke(input.inputId, ({ caller, runId, tools }) => tools.createReport(caller.thread.threadId, runId, input))),
  ask_user: Access.readsAsCaller((input) => current(input.inputId).pipe(Effect.flatMap(() => Effect.gen(function* () {
    // 表单客户端只属于本次调用，不能跨用户或提供商会话保留。
    const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
    if (Option.isNone(client)) return yield* new OrchestratorMcpFailure({ code: "orchestration_error", message: "当前运行器不支持交互表单。" });
    const answer = input.options?.length ? Schema.Literals(input.options) : Schema.String;
    return yield* McpServer.elicit({ message: input.prompt, schema: Schema.Struct({ answer }) }).pipe(
      Effect.provideService(McpSchema.McpServerClient, client.value),
      Effect.catch((error) => {
        // 没有底层失败的拒绝才表示用户主动取消，网络失败不能冒充取消。
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
