import * as C from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

// The remote transport carries T3's existing canonical values. These envelopes
// decode timestamps and branded identities at the process boundary, once.
export const HeadlessCodexInputs = {
  openSession: Schema.Struct({
    threadId: C.ThreadId,
    providerSessionId: C.ProviderSessionId,
    modelSelection: C.ModelSelection,
    runtimePolicy: Adapter.ProviderAdapterV2RuntimePolicy,
    resumeFromSession: Schema.optionalKey(C.OrchestrationV2ProviderSessionJson),
    initialNativeThreadId: Schema.optionalKey(Schema.String),
    initialProviderItemIdentityVersion: Schema.optionalKey(Schema.Literal(2)),
  }),
  ensureThread: Schema.Struct({
    threadId: C.ThreadId,
    title: Schema.optionalKey(Schema.String),
    modelSelection: C.ModelSelection,
    runtimePolicy: Adapter.ProviderAdapterV2RuntimePolicy,
    providerSessionId: Schema.optionalKey(C.ProviderSessionId),
    existingProviderThread: Schema.optionalKey(C.OrchestrationV2ProviderThreadJson),
  }),
  resumeThread: Schema.Struct({
    providerThread: C.OrchestrationV2ProviderThreadJson,
    threadId: Schema.optionalKey(C.ThreadId),
    modelSelection: Schema.optionalKey(C.ModelSelection),
    runtimePolicy: Schema.optionalKey(Adapter.ProviderAdapterV2RuntimePolicy),
  }),
  startTurn: Schema.Struct({
    appThread: C.OrchestrationV2AppThreadJson,
    threadId: C.ThreadId,
    runId: C.RunId,
    runOrdinal: C.PositiveInt,
    providerTurnOrdinal: C.PositiveInt,
    nativeThreadHasTurns: Schema.optionalKey(Schema.Boolean),
    restartContinuationOfRunId: Schema.optionalKey(C.RunId),
    attemptId: C.RunAttemptId,
    rootNodeId: C.NodeId,
    providerThread: C.OrchestrationV2ProviderThreadJson,
    message: Adapter.ProviderAdapterV2TurnMessage,
    modelSelection: C.ModelSelection,
    runtimePolicy: Adapter.ProviderAdapterV2RuntimePolicy,
    assistantConfiguration: Schema.optionalKey(
      Schema.Struct({
        instructions: Schema.String.check(Schema.isMaxLength(16000)),
        skillNames: Schema.Array(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
        ).check(Schema.isMaxLength(32)),
      }),
    ),
    appContext: Schema.optionalKey(
      Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String })),
    ),
  }),
  steerTurn: Schema.Struct({
    threadId: C.ThreadId,
    runId: C.RunId,
    providerThread: C.OrchestrationV2ProviderThreadJson,
    providerTurnId: C.ProviderTurnId,
    message: Adapter.ProviderAdapterV2TurnMessage,
  }),
  interruptTurn: Schema.Struct({
    providerThread: C.OrchestrationV2ProviderThreadJson,
    providerTurnId: C.ProviderTurnId,
    requestRuntimeRestart: Schema.optionalKey(Schema.Boolean),
  }),
  respondToRuntimeRequest: Schema.Struct({
    requestId: C.RuntimeRequestId,
    decision: Schema.optionalKey(C.ProviderApprovalDecision),
    answers: Schema.optionalKey(C.ProviderUserInputAnswers),
    response: Schema.optionalKey(Schema.Unknown),
  }),
  readThreadSnapshot: Schema.Struct({ providerThread: C.OrchestrationV2ProviderThreadJson }),
} as const;

export type HeadlessCodexMethod = keyof typeof HeadlessCodexInputs;
export const HeadlessCodexSnapshot = Schema.Struct({
  providerThread: C.OrchestrationV2ProviderThreadJson,
  providerTurns: Schema.Array(C.OrchestrationV2ProviderTurnJson),
  messages: Schema.Array(C.OrchestrationV2ConversationMessageJson),
  runtimeRequests: Schema.Array(C.OrchestrationV2RuntimeRequestJson),
  providerPayload: Schema.optionalKey(Schema.Unknown),
});

// Reuse canonical envelopes with T3 JSON projections; DateTime.Utc is in-memory-only.
const event = Adapter.ProviderAdapterV2Event.members;
export const HeadlessCodexEvent = Schema.Union([
  event[0].mapFields((fields) => ({ ...fields, appThread: C.OrchestrationV2AppThreadJson })),
  event[1].mapFields((fields) => ({
    ...fields,
    providerSession: C.OrchestrationV2ProviderSessionJson,
  })),
  event[2].mapFields((fields) => ({
    ...fields,
    providerThread: C.OrchestrationV2ProviderThreadJson,
  })),
  event[3].mapFields((fields) => ({ ...fields, providerTurn: C.OrchestrationV2ProviderTurnJson })),
  event[4].mapFields((fields) => ({ ...fields, node: C.OrchestrationV2ExecutionNodeJson })),
  event[5].mapFields((fields) => ({ ...fields, subagent: C.OrchestrationV2SubagentJson })),
  event[6].mapFields((fields) => ({
    ...fields,
    message: C.OrchestrationV2ConversationMessageJson,
  })),
  event[7].mapFields((fields) => ({ ...fields, turnItem: C.OrchestrationV2TurnItemJson })),
  event[8],
  event[9].mapFields((fields) => ({
    ...fields,
    runtimeRequest: C.OrchestrationV2RuntimeRequestJson,
  })),
  event[10],
  event[11],
  event[12].mapFields((fields) => ({
    ...fields,
    retryStartedAt: Schema.optional(Schema.DateTimeUtcFromString),
  })),
]);
