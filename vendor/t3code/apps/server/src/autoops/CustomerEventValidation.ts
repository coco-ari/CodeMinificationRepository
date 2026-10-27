import * as C from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { HeadlessCodexEvent, HeadlessCodexSnapshot } from "../provider/HeadlessCodexProtocol.ts";
import { CustomerCodexCapabilities } from "../provider/HeadlessCodexRunner.ts";
import { customerProviderInstanceId } from "../../../../../../agent-demo/t3-adapters/customer-target.mjs";
import {
  CustomerTransportError,
  type TransportSession,
} from "../../../../../../agent-demo/t3-adapters/customer-transport.mjs";

const reject = (message = "客户事件的实体不属于当前执行"): never => {
  throw new CustomerTransportError("CUSTOMER_EVENT_SCOPE", message);
};
const same = (actual: unknown, expected: unknown) => {
  if (actual !== expected) reject();
};
const absent = (value: unknown) => {
  if (value !== undefined && value !== null) reject("客户运行器返回了首版未开放的关联数据");
};
const decodePart = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return reject();
  }
};
type EntityKind =
  | "provider-thread"
  | "provider-turn"
  | "node"
  | "message"
  | "turn-item"
  | "runtime-request";

/** Match the exact shared IdAllocator format, not a substring inside an attacker-selected id. */
function scopedId(session: TransportSession, kind: EntityKind, id: string): void {
  if (typeof id !== "string" || id.length > 8192) reject();
  if (kind === "node" && session.runs?.some((run) => run.rootNodeId === id)) return;
  const parts = id.split(":");
  same(parts[0], kind);
  if ((kind === "node" || kind === "turn-item") && parts[1] === "runtime-request") {
    if (parts.length !== 3) reject();
    scopedId(session, "runtime-request", decodePart(parts[2]!));
    return;
  }
  same(parts[1], "provider");
  same(parts[2], "codex");
  const namespace = `customer:${customerProviderInstanceId({ deviceId: session.deviceId, runtimeId: "codex" })}:${session.threadId}:`;
  let offset = 3;
  if (kind === "provider-thread" && parts[offset] === "provider-instance") {
    same(
      decodePart(parts[offset + 1]!),
      customerProviderInstanceId({ deviceId: session.deviceId, runtimeId: "codex" }),
    );
    offset += 2;
  }
  if (kind === "runtime-request" && parts[offset] === "provider-turn") {
    scopedId(session, "provider-turn", decodePart(parts[offset + 1]!));
    offset += 2;
  }
  const marker =
    kind === "provider-thread"
      ? "native-thread"
      : kind === "provider-turn"
        ? "native-turn"
        : kind === "runtime-request"
          ? "native-request"
          : "native-item";
  same(parts[offset], marker);
  if (parts.length !== offset + (kind === "runtime-request" ? 3 : 2)) reject();
  if (!decodePart(parts[offset + 1]!).startsWith(namespace)) reject();
  if (kind === "runtime-request" && !parts[offset + 2]) reject();
}
function nativeRef(ref: C.OrchestrationV2ProviderRef | null | undefined) {
  if (ref) same(ref.driver, "codex");
}
function runFor(session: TransportSession, id: string | null, rootNodeId?: string) {
  const run = session.runs?.find(
    (run) => run.runId === id && (rootNodeId === undefined || run.rootNodeId === rootNodeId),
  );
  if (!run) return reject("客户事件没有对应的中心轮次");
  return run;
}
function providerThreadRef(session: TransportSession, id: string | null | undefined) {
  if (id == null) return;
  // T3 keeps the center-preallocated provider-thread row id after ensureThread loads the native
  // thread. Only the exact id persisted by the trusted adapter may use that non-native format.
  if (session.providerThreadId === id) return;
  scopedId(session, "provider-thread", id);
  if (session.providerThreadId) same(id, session.providerThreadId);
}
function knownTurn(session: TransportSession, id: string | null | undefined) {
  if (id == null) return undefined;
  scopedId(session, "provider-turn", id);
  const turn = session.providerTurnBindings?.find((turn) => turn.id === id);
  if (!turn) reject("客户事件引用了尚未登记的轮次");
  return turn;
}
function nodeRun(session: TransportSession, id: string | null | undefined) {
  if (id == null) return undefined;
  scopedId(session, "node", id);
  return (
    session.runs?.find((run) => run.rootNodeId === id)?.runId ??
    session.nodeBindings?.find((node) => node.id === id)?.runId
  );
}
function bindEntity(
  session: TransportSession,
  kind: "message" | "turn-item" | "runtime-request",
  id: string,
  runId: string,
) {
  scopedId(session, kind, id);
  const parts = id.split(":");
  if (kind === "runtime-request" && parts[3] === "provider-turn") {
    const turn = knownTurn(session, decodePart(parts[4]!));
    if (turn) same(turn.runId, runId);
  }
  if (kind === "turn-item" && parts[1] === "runtime-request")
    bindEntity(session, "runtime-request", decodePart(parts[2]!), runId);
  rememberEntityRun(session, kind, id, runId);
}
function rememberEntityRun(
  session: TransportSession,
  kind: "message" | "turn-item" | "runtime-request",
  id: string,
  runId: string,
) {
  const old = session.entityBindings?.find((entry) => entry.kind === kind && entry.id === id);
  if (old) same(old.runId, runId);
  else session.entityBindings = [...(session.entityBindings ?? []), { kind, id, runId }];
}
function validateSession(session: TransportSession, row: C.OrchestrationV2ProviderSession) {
  same(row.id, session.sessionId);
  same(row.driver, "codex");
  same(
    row.providerInstanceId,
    customerProviderInstanceId({ deviceId: session.deviceId, runtimeId: "codex" }),
  );
  // A remote process cannot advertise broader platform behavior or an executable center cwd.
  return {
    ...row,
    cwd: `customer://${session.deviceId}/${session.target.registeredWorkspaceId}`,
    capabilities: CustomerCodexCapabilities,
  };
}
function validateThread(session: TransportSession, row: C.OrchestrationV2ProviderThread) {
  same(row.driver, "codex");
  same(row.appThreadId, session.threadId);
  same(row.providerSessionId, session.sessionId);
  same(
    row.providerInstanceId,
    customerProviderInstanceId({ deviceId: session.deviceId, runtimeId: "codex" }),
  );
  providerThreadRef(session, row.id);
  absent(row.ownerNodeId);
  absent(row.forkedFrom);
  if (
    row.handoffIds.length ||
    (row.pendingBackgroundTasks ?? []).some((task) => task.kind === "subagent")
  )
    reject();
  absent(row.goal);
  absent(row.nativeMetadata?.forkHeadMessageId);
  if (row.nativeMetadata?.modelSelection)
    same(
      row.nativeMetadata.modelSelection.instanceId,
      customerProviderInstanceId({ deviceId: session.deviceId, runtimeId: "codex" }),
    );
  nativeRef(row.nativeThreadRef);
  nativeRef(row.nativeConversationHeadRef);
  return row;
}
function validateTurn(session: TransportSession, row: C.OrchestrationV2ProviderTurn) {
  providerThreadRef(session, row.providerThreadId);
  scopedId(session, "provider-turn", row.id);
  nativeRef(row.nativeTurnRef);
  const run = session.runs?.find(
    (run) => run.rootNodeId === row.nodeId && run.attemptId === row.runAttemptId,
  );
  if (!run) return reject("客户轮次不属于中心下发的运行尝试");
  if (row.ordinal < run.providerTurnOrdinal) reject();
  const old = session.providerTurnBindings?.find((turn) => turn.id === row.id);
  if (
    old &&
    (old.runId !== run.runId || old.attemptId !== run.attemptId || old.ordinal !== row.ordinal)
  )
    reject();
  if (!old)
    session.providerTurnBindings = [
      ...(session.providerTurnBindings ?? []),
      { id: row.id, runId: run.runId, attemptId: run.attemptId, ordinal: row.ordinal },
    ];
}
function validateNode(session: TransportSession, row: C.OrchestrationV2ExecutionNode) {
  same(row.threadId, session.threadId);
  const run = runFor(session, row.runId, row.rootNodeId);
  scopedId(session, "node", row.id);
  same(row.rootNodeId, run.rootNodeId);
  if (["subagent", "plan", "todo_list"].includes(row.kind)) reject();
  if (row.id === run.rootNodeId) {
    same(row.kind, "root_turn");
    same(row.parentNodeId, null);
  } else if (nodeRun(session, row.parentNodeId) !== run.runId)
    reject("客户节点的父节点不属于当前轮次");
  providerThreadRef(session, row.providerThreadId);
  const turn = knownTurn(session, row.providerTurnId);
  if (turn) same(turn.runId, run.runId);
  if (row.runtimeRequestId) bindEntity(session, "runtime-request", row.runtimeRequestId, run.runId);
  nativeRef(row.nativeItemRef);
  absent(row.checkpointScopeId);
  const old = session.nodeBindings?.find((node) => node.id === row.id);
  if (old) same(old.runId, run.runId);
  else session.nodeBindings = [...(session.nodeBindings ?? []), { id: row.id, runId: run.runId }];
  session.nodeIds = [...new Set([...(session.nodeIds ?? []), row.id])];
}
function validateMessage(session: TransportSession, row: C.OrchestrationV2ConversationMessage) {
  same(row.threadId, session.threadId);
  const run = runFor(session, row.runId);
  scopedId(session, "message", row.id);
  same(row.role, "assistant");
  same(row.createdBy, "agent");
  same(row.creationSource, "provider");
  if (row.nodeId !== null && nodeRun(session, row.nodeId) !== run.runId) reject();
  if (row.attachments.length) reject();
  absent(row.context);
  absent(row.senderThreadId);
  absent(row.scheduledTaskId);
  absent(row.notification);
  absent(row.delegatedCompletion);
  absent(row.workflowScript);
  bindEntity(session, "message", row.id, run.runId);
}
function validateRequest(session: TransportSession, row: C.OrchestrationV2RuntimeRequest) {
  scopedId(session, "runtime-request", row.id);
  const runId = nodeRun(session, row.nodeId);
  if (!runId) return reject();
  const turn = knownTurn(session, row.providerTurnId);
  if (turn) same(turn.runId, runId);
  if (row.kind === "auth_refresh" || row.kind === "dynamic_tool_call") reject();
  if (row.responseCapability.type === "live")
    same(row.responseCapability.providerSessionId, session.sessionId);
  if (row.responseCapability.type === "message" && row.kind !== "user_input") reject();
  nativeRef(row.nativeRequestRef);
  bindEntity(session, "runtime-request", row.id, runId);
}
const allowedItemTypes = new Set([
  "assistant_message",
  "reasoning",
  "user_input_request",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "approval_request",
  "system_notice",
  "error",
  "compaction",
  "dynamic_tool",
]);
function validateItem(session: TransportSession, row: C.OrchestrationV2TurnItem) {
  if (!allowedItemTypes.has(row.type)) reject("客户首版不支持此流程展示");
  same(row.threadId, session.threadId);
  const run = runFor(session, row.runId);
  const turn = knownTurn(session, row.providerTurnId);
  if (turn) same(turn.runId, run.runId);
  // T3 的重试/终态错误项由原轮次派生；只允许该精确ID，不能扩宽远端实体命名空间。
  const providerFailureItem =
    row.type === "error" &&
    turn !== undefined &&
    turn.attemptId === run.attemptId &&
    row.nodeId === run.rootNodeId &&
    row.providerThreadId === session.providerThreadId &&
    row.nativeItemRef === null &&
    row.parentItemId === null &&
    row.id ===
      derive.turnItemFromProviderItem({
        driver: C.ProviderDriverKind.make("codex"),
        nativeItemId: `terminal-failure:${turn.id}`,
      });
  if (!providerFailureItem) scopedId(session, "turn-item", row.id);
  if (row.parentItemId) bindEntity(session, "turn-item", row.parentItemId, run.runId);
  nativeRef(row.nativeItemRef);
  if (row.nodeId !== null && nodeRun(session, row.nodeId) !== run.runId) reject();
  providerThreadRef(session, row.providerThreadId);
  if (row.type === "assistant_message") {
    bindEntity(session, "message", row.messageId, run.runId);
    if (row.attachments?.length) reject();
  }
  if (row.type === "approval_request" || row.type === "user_input_request")
    bindEntity(session, "runtime-request", row.requestId, run.runId);
  if (row.type === "user_input_request") absent(row.questionAnswer);
  if (row.type === "compaction" && row.driver !== null) same(row.driver, "codex");
  if (providerFailureItem) rememberEntityRun(session, "turn-item", row.id, run.runId);
  else bindEntity(session, "turn-item", row.id, run.runId);
}
/** Only canonical events for this center-created session/run enter the native ingestor. */
export function validateCustomerEvent(
  session: TransportSession,
  raw: unknown,
): ProviderAdapterV2Event {
  const event = Schema.decodeUnknownSync(HeadlessCodexEvent)(raw);
  same(event.driver, "codex");
  if ("threadId" in event && event.threadId !== undefined) same(event.threadId, session.threadId);
  switch (event.type) {
    case "provider_session.updated":
      return { ...event, providerSession: validateSession(session, event.providerSession) };
    case "provider_thread.updated":
      absent(event.retainedNativeTurnIds);
      validateThread(session, event.providerThread);
      break;
    case "provider_turn.updated":
      validateTurn(session, event.providerTurn);
      break;
    case "node.updated":
      validateNode(session, event.node);
      break;
    case "message.updated":
      validateMessage(session, event.message);
      break;
    case "turn_item.updated":
      validateItem(session, event.turnItem);
      break;
    case "runtime_request.updated":
      validateRequest(session, event.runtimeRequest);
      break;
    case "command_output.delta":
      scopedId(session, "turn-item", event.itemId);
      break;
    case "turn.terminal": {
      providerThreadRef(session, event.providerThreadId);
      const turn = knownTurn(session, event.providerTurnId);
      const run = session.runs?.find(
        (run) => run.runOrdinal === event.runOrdinal && run.attemptId === turn?.attemptId,
      );
      if (!turn || !run || run.runId !== turn.runId) reject();
      if ("childTurnsContinue" in event) absent(event.childTurnsContinue);
      break;
    }
    default:
      return reject("客户运行器返回了首版未开放的事件");
  }
  return event;
}
/** Validate and encode before storing a receipt. Raw results never become trusted entities. */
export function validateCustomerResult(
  session: TransportSession,
  method: string,
  result: unknown,
): unknown {
  switch (method) {
    case "openSession": {
      const row = validateSession(
        session,
        Schema.decodeUnknownSync(C.OrchestrationV2ProviderSessionJson)(result),
      );
      return Schema.encodeSync(C.OrchestrationV2ProviderSessionJson)(row);
    }
    case "ensureThread":
    case "resumeThread": {
      const row = validateThread(
        session,
        Schema.decodeUnknownSync(C.OrchestrationV2ProviderThreadJson)(result),
      );
      return Schema.encodeSync(C.OrchestrationV2ProviderThreadJson)(row);
    }
    case "readThreadSnapshot": {
      const snapshot = Schema.decodeUnknownSync(HeadlessCodexSnapshot)(result);
      validateThread(session, snapshot.providerThread);
      for (const row of snapshot.providerTurns) validateTurn(session, row);
      for (const row of snapshot.messages) validateMessage(session, row);
      for (const row of snapshot.runtimeRequests) validateRequest(session, row);
      // The opaque native payload is not used by the customer MVP and may carry unrelated history.
      return Schema.encodeSync(HeadlessCodexSnapshot)({
        providerThread: snapshot.providerThread,
        providerTurns: snapshot.providerTurns,
        messages: snapshot.messages,
        runtimeRequests: snapshot.runtimeRequests,
      });
    }
    case "startTurn":
    case "steerTurn":
    case "interruptTurn":
    case "respondToRuntimeRequest":
      if (result != null) reject("客户控制命令返回了无效数据");
      return result;
    default:
      return reject("客户命令未开放");
  }
}
