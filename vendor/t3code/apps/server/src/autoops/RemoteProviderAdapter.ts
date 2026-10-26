import * as C from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HeadlessCodexInputs,
  HeadlessCodexSnapshot,
  type HeadlessCodexMethod,
} from "../provider/HeadlessCodexProtocol.ts";
import { CustomerCodexCapabilities } from "../provider/HeadlessCodexRunner.ts";
import {
  authorizeCustomerModel,
  assertCustomerInput,
} from "../../../../../../agent-demo/t3-adapters/customer-target.mjs";
import type { RemoteDeviceHub } from "./RemoteDeviceService.ts";

const driver = C.ProviderDriverKind.make("codex");
const protocolError = (cause: unknown) =>
  new Adapter.ProviderAdapterProtocolError({
    driver,
    detail: cause instanceof Error ? cause.message : "客户连接请求未完成",
    cause,
  });
const unsupported = () => Effect.fail(protocolError(new Error("客户首版未开放此能力")));

/** The T3 execution adapter, with local process calls replaced by bounded device commands. */
export function makeRemoteProviderAdapter(
  hub: RemoteDeviceHub,
  instanceId: C.ProviderInstanceId,
): Adapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CustomerCodexCapabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: (input) =>
      Effect.gen(function* () {
        const binding = hub.access.getThreadBinding(input.threadId);
        if (!binding || binding.executionBinding.kind !== "customer")
          return yield* protocolError(new Error("客户对话绑定不存在"));
        const customerTarget = binding.executionBinding;
        yield* Effect.try({
          try: () => {
            hub.bind(binding, input.providerSessionId, input.modelSelection);
            if (!input.resumeFromSession) {
              hub.access.requireQuestionForActor(
                binding.ownerId,
                binding.threadId,
                input.modelSelection,
              );
              authorizeCustomerModel(hub.access, binding, input.modelSelection);
            }
          },
          catch: protocolError,
        });
        const command = <T>(
          method: HeadlessCodexMethod,
          value: unknown,
          key: unknown,
          codec: Schema.Codec<T, unknown>,
        ) =>
          Schema.encodeUnknownEffect(HeadlessCodexInputs[method])(value).pipe(
            Effect.flatMap((encoded) =>
              Effect.tryPromise({
                try: (signal) => hub.command(input.providerSessionId, method, encoded, key, signal),
                catch: protocolError,
              }),
            ),
            Effect.flatMap((result) => Schema.decodeUnknownEffect(codec)(result)),
            Effect.mapError(protocolError),
          );
        // Return the logical session first: its subscriber must drain old events before
        // a new customer process may replace their epoch.
        const persisted = hub.session(input.providerSessionId);
        if (input.reattachOnly && !persisted?.providerSession)
          return yield* protocolError(
            new Error("旧客户会话尚未完成建立，等待设备对账；不会自动启动新进程"),
          );
        const openNative = () =>
          command(
            "openSession",
            { ...input, runtimePolicy: { ...input.runtimePolicy, cwd: null } },
            ["open", hub.connectorEpoch(customerTarget.deviceId)],
            C.OrchestrationV2ProviderSessionJson,
          );
        const providerSession = persisted?.providerSession
          ? yield* Schema.decodeUnknownEffect(C.OrchestrationV2ProviderSessionJson)(
              persisted.providerSession,
            ).pipe(Effect.mapError(protocolError))
          : yield* openNative();
        const ensureProcessReady = Effect.fn("RemoteProviderAdapter.ensureProcessReady")(
          function* () {
            yield* Effect.tryPromise({
              try: (signal) => hub.awaitOnline(input.providerSessionId, signal),
              catch: protocolError,
            });
            const reported = hub.runtimeState(input.providerSessionId);
            if (reported?.state === "unknown")
              return yield* protocolError(new Error("客户执行结果未知，请先在本机核实"));
            if (reported?.live === true) return false;
            const saved = hub.session(input.providerSessionId);
            if (
              saved?.state === "unknown" ||
              saved?.state === "active" ||
              reported?.state === "unknown"
            )
              return yield* protocolError(new Error("旧客户执行尚未确认结束，请先在本机核实"));
            yield* Effect.tryPromise({
              try: (signal) => hub.awaitInboxDrained(input.providerSessionId, signal),
              catch: protocolError,
            });
            yield* openNative();
            return true;
          },
        );
        const controller = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
        const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromAsyncIterable(
            hub.events(input.providerSessionId, controller.signal),
            protocolError,
          ),
          eventPersistenceKey: (event) => {
            const key = hub.identity(event);
            return key ? C.CommandId.make(key) : undefined;
          },
          acknowledgeEvent: (event) =>
            Effect.tryPromise({ try: () => hub.acknowledge(event), catch: protocolError }),
          ensureThread: (value) =>
            ensureProcessReady().pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  command(
                    "ensureThread",
                    value,
                    [
                      "ensureThread",
                      value.existingProviderThread?.id ?? input.threadId,
                      hub.session(input.providerSessionId)?.runtimeEpoch,
                    ],
                    C.OrchestrationV2ProviderThreadJson,
                  ),
                ),
              ),
              Effect.tap((thread) =>
                Effect.sync(() =>
                  hub.update(input.providerSessionId, { providerThreadId: thread.id }),
                ),
              ),
            ),
          resumeThread: (value) =>
            ensureProcessReady().pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  command(
                    "resumeThread",
                    value,
                    [
                      "resumeThread",
                      value.providerThread.id,
                      hub.session(input.providerSessionId)?.runtimeEpoch,
                    ],
                    C.OrchestrationV2ProviderThreadJson,
                  ),
                ),
              ),
              Effect.tap((thread) =>
                Effect.sync(() =>
                  hub.update(input.providerSessionId, { providerThreadId: thread.id }),
                ),
              ),
            ),
          startTurn: (value) =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () =>
                  hub.access.requireQuestionForActor(
                    binding.ownerId,
                    binding.threadId,
                    value.modelSelection,
                  ),
                catch: protocolError,
              });
              const reopened = yield* ensureProcessReady();
              // The manager's logical session can survive a customer process
              // restart. Its thread-loaded cache does not imply that this new
              // native process has resumed the conversation yet.
              if (reopened) {
                yield* command(
                  "resumeThread",
                  {
                    providerThread: value.providerThread,
                    threadId: value.threadId,
                    modelSelection: value.modelSelection,
                    runtimePolicy: value.runtimePolicy,
                  },
                  [
                    "resumeThread",
                    value.providerThread.id,
                    hub.session(input.providerSessionId)?.runtimeEpoch,
                  ],
                  C.OrchestrationV2ProviderThreadJson,
                );
              }
              yield* Effect.try({
                try: () => {
                  hub.access.requireQuestionForActor(
                    binding.ownerId,
                    binding.threadId,
                    value.modelSelection,
                  );
                  authorizeCustomerModel(hub.access, binding, value.modelSelection);
                  assertCustomerInput(value.message, customerTarget);
                  const session = hub.session(input.providerSessionId)!;
                  const runs = [...(session.runs ?? [])];
                  if (
                    !runs.some(
                      (run) => run.runId === value.runId && run.attemptId === value.attemptId,
                    )
                  )
                    runs.push({
                      runId: value.runId,
                      attemptId: value.attemptId,
                      rootNodeId: value.rootNodeId,
                      runOrdinal: value.runOrdinal,
                      providerTurnOrdinal: value.providerTurnOrdinal,
                    });
                  hub.update(input.providerSessionId, {
                    runs,
                    providerThreadId: value.providerThread.id,
                    state: "active",
                  });
                },
                catch: protocolError,
              });
              const assistantConfiguration = yield* Effect.try({
                try: () => {
                  const selected = hub.access.requireQuestionForActor(
                    binding.ownerId,
                    binding.threadId,
                    value.modelSelection,
                  );
                  if (!selected) return undefined;
                  const scope = hub.access.customerRunScope(binding.threadId,value.runId);
                  const capabilities = hub.access.customerRegistry.getCapabilities(
                    scope?.providerId ?? binding.ownerId, customerTarget,
                  );
                  const catalog = scope ? capabilities?.sharedProfile : capabilities;
                  if (capabilities?.assistantConfiguration !== true || !catalog)
                    throw new Error("请更新电脑连接程序后使用助手预设");
                  return {
                    instructions: hub.access.questionInstructions(
                      binding.ownerId,
                      binding.threadId,
                      value.modelSelection,
                    ),
                    skillNames: selected.configuration.skillIds.map((id) => {
                      const skill = catalog.skills.find((skill) => skill.id === id);
                      if (!skill) throw new Error("所选电脑技能已变更，请重新选择");
                      return skill.name;
                    }),
                  };
                },
                catch: protocolError,
              });
              yield* command(
                "startTurn",
                {
                  ...value,
                  ...(assistantConfiguration ? { assistantConfiguration } : {}),
                  appContext: [],
                  runtimePolicy: { ...value.runtimePolicy, cwd: null },
                },
                [value.runId, value.attemptId],
                Schema.Unknown,
              );
            }).pipe(
              Effect.mapError((cause) => {
                // Journal insertion precedes network delivery. Before that durable
                // start command exists, model/policy/resume preflight failure is
                // provably not an uncertain execution of this user message.
                return hub.hasDispatchedRun(input.providerSessionId, value.runId, value.attemptId)
                  ? cause
                  : Object.assign(cause, { outcome: "not_started" as const });
              }),
            ),
          steerTurn: (value) =>
            Effect.try({
              try: () => assertCustomerInput(value.message, customerTarget),
              catch: protocolError,
            }).pipe(
              Effect.andThen(() =>
                command("steerTurn", value, [value.runId, value.message.messageId], Schema.Unknown),
              ),
              Effect.asVoid,
            ),
          interruptTurn: (value) =>
            command("interruptTurn", value, [value.providerTurnId], Schema.Unknown).pipe(
              Effect.asVoid,
            ),
          respondToRuntimeRequest: (value) =>
            command(
              "respondToRuntimeRequest",
              value,
              [value.requestId, value.decision, value.answers, value.response],
              Schema.Unknown,
            ).pipe(Effect.asVoid),
          readThreadSnapshot: (value) =>
            command(
              "readThreadSnapshot",
              value,
              [
                value.providerThread.id,
                hub.session(input.providerSessionId)?.runtimeEpoch,
                hub.journal.cursor(
                  input.providerSessionId,
                  hub.session(input.providerSessionId)?.runtimeEpoch ?? "",
                ).received,
              ],
              HeadlessCodexSnapshot,
            ),
          rollbackThread: unsupported,
          forkThread: unsupported,
        };
        return runtime;
      }),
  };
}
