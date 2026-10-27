import * as Schema from "effect/Schema";
import { CustomerAttachmentManifest } from "./customerAttachments.ts";
import { CustomerFileInput, CustomerFileResult } from "./customerFiles.ts";
import { isSharedExecutionScope, type SharedExecutionScope } from "../../../../../autoops/contracts/shared-execution.ts";
import { isCustomerPlatformToolReference, type CustomerPlatformToolReference } from "../../../../../autoops/contracts/customer-platform-tools.ts";

/** Device transport only. Browser chat and Provider events retain their T3 contracts. */
export const CUSTOMER_AGENT_PROTOCOL_VERSION = 1;
export const CUSTOMER_AGENT_MAX_FRAME_BYTES = 1024 * 1024;
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Cursor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
// 业务合同由其所属依赖实例验证，避免跨实例解释内部 schema 状态。
const CustomerSharedExecutionScope = Schema.declare<SharedExecutionScope>(isSharedExecutionScope);
const CustomerPlatformTools = Schema.declare<CustomerPlatformToolReference>(isCustomerPlatformToolReference);
export const CustomerAgentTarget = Schema.Struct({
  registeredWorkspaceId: Id,
  workspaceBindingRevision: Revision,
  runtimeId: Schema.Literal("codex"),
});
export type CustomerAgentTarget = typeof CustomerAgentTarget.Type;
export const CustomerAgentMethod = Schema.Literals([
  "openSession", "ensureThread", "resumeThread", "startTurn", "steerTurn",
  "interruptTurn", "respondToRuntimeRequest", "readThreadSnapshot", "catalog",
]);
export type CustomerAgentMethod = typeof CustomerAgentMethod.Type;
export const CustomerAgentCommand = Schema.Struct({
  type: Schema.Literal("command"), commandId: Id, sessionId: Id,
  target: CustomerAgentTarget, method: CustomerAgentMethod,
  runtimeEpoch: Schema.optional(Id), input: Schema.Unknown,
  executionScope: Schema.optional(CustomerSharedExecutionScope),
  platformTools: Schema.optional(CustomerPlatformTools),
  attachments: Schema.optional(Schema.Array(CustomerAttachmentManifest)),
  skillBindings: Schema.optional(Schema.Array(Schema.Struct({ id: Id, name: Id }))),
});
export type CustomerAgentCommand = typeof CustomerAgentCommand.Type;
export const CustomerAgentReceipt = Schema.Struct({
  type: Schema.Literal("receipt"), commandId: Id, sessionId: Id,
  state: Schema.Literals(["accepted", "completed", "failed", "unknown"]),
  runtimeEpoch: Schema.optional(Id), result: Schema.optional(Schema.Unknown),
  grantId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  error: Schema.optional(Schema.Struct({ code: Id, message: Schema.String })),
});
export type CustomerAgentReceipt = typeof CustomerAgentReceipt.Type;
export const CustomerAgentEvents = Schema.Struct({
  type: Schema.Literal("events"), sessionId: Id, runtimeEpoch: Id,
  events: Schema.Array(Schema.Struct({ seq: Revision, event: Schema.Unknown })),
});
export type CustomerAgentEvents = typeof CustomerAgentEvents.Type;
export const CustomerAgentResolution = Schema.Struct({
  runId: Id, attemptId: Id, resolvedAt: Schema.String,
  reason: Schema.Literal("operator_confirmed_process_stopped"),
});
export type CustomerAgentResolution = typeof CustomerAgentResolution.Type;
export const CustomerAgentClientFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("hello"), protocolVersion: Schema.Literal(1), deviceId: Id,
    connectorVersion: Id, connectorEpoch: Id,
    attachmentTransfers: Schema.optional(Schema.Boolean),
    workspaceFiles: Schema.optional(Schema.Boolean),
    assistantConfiguration: Schema.optional(Schema.Boolean),
    platformToolsVersion: Schema.optional(Schema.Literal(1)),
    sharedExecutionVersion: Schema.optional(Schema.Literal(1)),
    receiptQueries: Schema.optional(Schema.Boolean),
    workspaces: Schema.Array(Schema.Struct({
      ...CustomerAgentTarget.fields, projectId: Id, label: Schema.String,
    })),
    sessions: Schema.Array(Schema.Struct({
      sessionId: Id, runtimeEpoch: Id, state: Schema.Literals(["idle", "active", "unknown"]), live: Schema.optional(Schema.Boolean),
      lastSeq: Schema.optional(Cursor),
      resolution: Schema.optional(CustomerAgentResolution),
    })),
  }),
  CustomerAgentReceipt,
  Schema.Struct({ type: Schema.Literal("filesResult"), requestId: Id,
    result: Schema.optional(CustomerFileResult),
    error: Schema.optional(Schema.Struct({ code: Id, message: Schema.String })),
  }),
  CustomerAgentEvents,
  Schema.Struct({ type: Schema.Literal("runtimeState"), sessionId: Id, runtimeEpoch: Id,
    state: Schema.Literal("unknown"), reason: Schema.Literals(["runtime_lost", "journal_unavailable", "outcome_unknown"]) }),
  Schema.Struct({ type: Schema.Literal("delta"), sessionId: Id, runtimeEpoch: Id, event: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("ping"), at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("pong"), at: Schema.Number }),
]);
export type CustomerAgentClientFrame = typeof CustomerAgentClientFrame.Type;
export const CustomerAgentServerFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("welcome"), connectionEpoch: Id }),
  CustomerAgentCommand,
  Schema.Struct({ type: Schema.Literal("receiptQuery"), commandId: Id, sessionId: Id,
    grantId: Schema.optional(Schema.String.check(Schema.isMinLength(1),Schema.isMaxLength(512))) }),
  Schema.Struct({ type: Schema.Literal("files"), requestId: Id, target: CustomerAgentTarget, input: CustomerFileInput }),
  Schema.Struct({ type: Schema.Literal("filesCancel"), requestId: Id }),
  Schema.Struct({ type: Schema.Literal("ack"), sessionId: Id, runtimeEpoch: Id, seq: Cursor }),
  Schema.Struct({ type: Schema.Literal("replay"), sessionId: Id, runtimeEpoch: Id, afterSeq: Cursor }),
  Schema.Struct({ type: Schema.Literal("ping"), at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("pong"), at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("error"), code: Id, message: Schema.String }),
]);
export type CustomerAgentServerFrame = typeof CustomerAgentServerFrame.Type;

function parseFrame(raw: string): unknown {
  if (new TextEncoder().encode(raw).byteLength > CUSTOMER_AGENT_MAX_FRAME_BYTES) {
    throw new Error("客户连接消息超过大小限制");
  }
  return JSON.parse(raw);
}
export const decodeCustomerAgentClientFrame = (raw: string): CustomerAgentClientFrame =>
  Schema.decodeUnknownSync(CustomerAgentClientFrame)(parseFrame(raw));
export const decodeCustomerAgentServerFrame = (raw: string): CustomerAgentServerFrame =>
  Schema.decodeUnknownSync(CustomerAgentServerFrame)(parseFrame(raw));
