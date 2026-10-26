// This is the Promise boundary owned by the customer connector, not an Effect service.
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as C from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Core from "../orchestration-v2/Adapters/CodexExecution.ts";
import type { CodexExecutionHost } from "./CodexExecutionHost.ts";
import {
  parseCodexSkillsListResponse,
  requestAllCodexModels,
  withCodexAppServerClient,
} from "./CodexProviderCore.ts";
import {
  HeadlessCodexInputs,
  HeadlessCodexSnapshot,
  HeadlessCodexEvent,
  type HeadlessCodexMethod,
} from "./HeadlessCodexProtocol.ts";

export interface CustomerCodexLocalPolicy {
  readonly approvalPolicy: "untrusted" | "on-request";
  readonly sandboxMode: "read-only" | "workspace-write";
  readonly networkAccess: boolean;
}

export interface HeadlessCodexRunnerOptions {
  readonly instanceId: string;
  /** Already canonicalized and registered by the local connector. */
  readonly cwd: string;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly localPolicy?: CustomerCodexLocalPolicy;
  readonly resolveAttachmentPath?: (attachment: C.ChatAttachment) => string | null;
  readonly onEvent: (event: unknown) => void | Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
}

export interface HeadlessCodexRunner {
  readonly processGeneration: string;
  readonly dispatch: (method: HeadlessCodexMethod, input: unknown) => Promise<unknown>;
  readonly catalog: () => Promise<{
    readonly models: ReadonlyArray<C.ServerProviderModel>;
    readonly skills: ReadonlyArray<C.ServerProviderSkill>;
  }>;
  readonly close: () => Promise<void>;
}

export class HeadlessCodexValidationError extends Error {
  readonly code = "CUSTOMER_EXECUTION_VALIDATION_FAILED";
  readonly outcome = "not_started";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Customer execution validation failed.", {
      cause,
    });
    this.name = "HeadlessCodexValidationError";
  }
}

async function preflight<A>(action: () => A | Promise<A>): Promise<A> {
  try {
    return await action();
  } catch (cause) {
    throw new HeadlessCodexValidationError(cause);
  }
}

const CUSTOMER_THREAD_CONFIG = {
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "tools.update_plan.enabled": false,
} as const;
const CUSTOMER_LAUNCH_ARGS = Object.entries(CUSTOMER_THREAD_CONFIG)
  .map(([key, value]) => `-c '${key}=${value}'`)
  .join(" ");

export const CustomerCodexCapabilities = {
  ...Core.CodexProviderCapabilitiesV2,
  sessions: {
    ...Core.CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...Core.CodexProviderCapabilitiesV2.threads,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  checkpointing: {
    ...Core.CodexProviderCapabilitiesV2.checkpointing,
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
  },
  planning: {
    ...Core.CodexProviderCapabilitiesV2.planning,
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
  },
  context: {
    ...Core.CodexProviderCapabilitiesV2.context,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
  },
} satisfies C.OrchestrationV2ProviderCapabilities;

export const resolveCustomerSkillMentions = Effect.fn("HeadlessCodexRunner.resolveSkills")(
  function* (
    client: CodexClient.CodexAppServerClient["Service"],
    cwd: string | null,
    text: string,
    selected?: readonly string[],
  ) {
    const names = [
      ...new Set(selected ?? [...text.matchAll(SKILL_MENTION_PATTERN)].map((match) => match[2]!)),
    ];
    if (names.length === 0) return [];
    const response = yield* client.request("skills/list", { cwds: cwd === null ? [] : [cwd] });
    const available = parseCodexSkillsListResponse(response, cwd ?? "");
    const result: CodexSchema.V2TurnStartParams__UserInput[] = [];
    for (const name of names) {
      const matches = available.filter((skill) => skill.name === name && skill.enabled);
      if (matches.length !== 1) {
        return yield* CodexErrors.CodexAppServerRequestError.internalError(
          "A selected local skill is unavailable or ambiguous. Refresh the local skill catalog.",
          undefined,
          { method: "skills/list", operation: "decode-payload" },
        );
      }
      result.push({ type: "skill", name, path: matches[0]!.path });
    }
    return result;
  },
);

/** Keep native refs unchanged while isolating their canonical projection keys. */
export function customerScopedIds(
  base: IdAllocator.IdAllocatorV2["Service"],
  prefix: () => string,
): IdAllocator.IdAllocatorV2["Service"] {
  const nativeItem = <A extends { readonly nativeItemId: string }>(input: A) => ({
    ...input,
    nativeItemId: prefix() + input.nativeItemId,
  });
  return {
    allocate: {
      ...base.allocate,
      runtimeRequest: (input) =>
        base.allocate.runtimeRequest({
          ...input,
          nativeRequestId: prefix() + (input.nativeRequestId ?? "session"),
        }),
    },
    derive: {
      ...base.derive,
      providerTurn: (input) =>
        base.derive.providerTurn({ ...input, nativeTurnId: prefix() + input.nativeTurnId }),
      providerThread: (input) =>
        base.derive.providerThread({ ...input, nativeThreadId: prefix() + input.nativeThreadId }),
      threadFromProviderThread: (input) =>
        base.derive.threadFromProviderThread({
          ...input,
          nativeThreadId: prefix() + input.nativeThreadId,
        }),
      nodeFromProviderItem: (input) => base.derive.nodeFromProviderItem(nativeItem(input)),
      messageFromProviderItem: (input) => base.derive.messageFromProviderItem(nativeItem(input)),
      turnItemFromProviderItem: (input) => base.derive.turnItemFromProviderItem(nativeItem(input)),
    },
  };
}

export function customerRuntimePolicy(
  cwd: string,
  policy: CustomerCodexLocalPolicy,
): Adapter.ProviderAdapterV2RuntimePolicy {
  if (
    !["untrusted", "on-request"].includes(policy.approvalPolicy) ||
    !["read-only", "workspace-write"].includes(policy.sandboxMode) ||
    typeof policy.networkAccess !== "boolean"
  ) {
    throw new Error("Invalid customer-local Codex policy.");
  }
  return {
    cwd,
    interactionMode: "default",
    runtimeMode: policy.sandboxMode === "read-only" ? "approval-required" : "auto-accept-edits",
    approvalPolicy: policy.approvalPolicy,
    sandboxPolicy:
      policy.sandboxMode === "read-only"
        ? { type: "readOnly", networkAccess: policy.networkAccess }
        : { type: "workspaceWrite", writableRoots: [cwd], networkAccess: policy.networkAccess },
  };
}

export function makeCustomerCodexHost(
  resolveAttachmentPath: (attachment: C.ChatAttachment) => string | null = () => null,
): CodexExecutionHost {
  return {
    additionalContext: () => ({}),
    mcpSessions: { read: () => Effect.succeed(undefined) },
    verifyInitialized: () => Effect.void,
    interactionMode: () => "default",
    threadParameters: () => ({ config: CUSTOMER_THREAD_CONFIG }),
    mcpApprovals: {},
    resolveSkillMentions: (client, cwd, text) => resolveCustomerSkillMentions(client, cwd, text),
    resolveAttachmentPath,
    resolveAttachmentPathById: () => null,
    snapshotMcpApp: () => Effect.succeed(undefined),
    requireLegacyTool: () => {
      throw new Error("Platform business tools are unavailable on a customer device.");
    },
    registerSubagent: () => {
      throw new Error("Subagents are unavailable on this customer runtime.");
    },
    recordFork: () => {
      throw new Error("Forking is unavailable on this customer runtime.");
    },
  };
}

/** One owner-controlled, registered directory and one managed app thread per runner.
 * The connector owns durable command/event journals; this boundary never retries turns. */
export async function createHeadlessCodexRunner(
  options: HeadlessCodexRunnerOptions,
): Promise<HeadlessCodexRunner> {
  const instanceId = Schema.decodeUnknownSync(C.ProviderInstanceId)(options.instanceId);
  if (!options.cwd || (!options.cwd.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(options.cwd))) {
    throw new Error("A registered absolute workspace directory is required.");
  }
  const runtimePolicy = customerRuntimePolicy(
    options.cwd,
    options.localPolicy ?? {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      networkAccess: false,
    },
  );
  const settings = Schema.decodeUnknownSync(C.CodexSettings)({
    binaryPath: options.binaryPath ?? "codex",
    homePath: options.homePath ?? "",
    launchArgs: CUSTOMER_LAUNCH_ARGS,
  });
  const environment = options.environment ?? process.env;
  const services = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    IdAllocator.layer,
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  );
  const manager = ManagedRuntime.make(services);
  const scope = await manager.runPromise(Scope.make());
  let closed = false;
  let session: Adapter.ProviderAdapterV2SessionRuntime | undefined;
  let threadId: C.ThreadId | undefined;
  let nativeThreadId: string | undefined;
  let client: CodexClient.CodexAppServerClient["Service"] | undefined;
  let clientInitialized = false;
  let selectedSkillNames: readonly string[] | undefined;
  const host = makeCustomerCodexHost(options.resolveAttachmentPath);
  const resolveSelectedSkills: typeof host.resolveSkillMentions = (active, cwd, text) => {
    const mentioned = [...text.matchAll(SKILL_MENTION_PATTERN)].map((match) => match[2]!);
    if (selectedSkillNames && mentioned.some((name) => !selectedSkillNames!.includes(name)))
      return Effect.die(new Error("此技能不在当前助手配置中"));
    return resolveCustomerSkillMentions(active, cwd, text, selectedSkillNames);
  };
  const adapter = await manager.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(Core.makeLayerAppServerClientFactory());
      // Layer.build owns the process factory in the caller's single runner scope.
      const baseFactory = yield* Effect.service(Core.CodexAppServerClientFactory).pipe(
        Effect.provide(context),
      );
      return yield* Core.makeCodexAdapterV2({
        instanceId,
        settings,
        environment,
        capabilities: CustomerCodexCapabilities,
        clientFactory: {
          open: (input) =>
            baseFactory.open(input).pipe(
              Effect.tap((opened) =>
                Effect.sync(() => {
                  client = opened;
                }),
              ),
            ),
        },
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: customerScopedIds(yield* IdAllocator.IdAllocatorV2, () => {
          if (threadId === undefined)
            throw new Error("Customer conversation identity is not bound.");
          return `customer:${instanceId}:${threadId}:`;
        }),
        host: {
          ...host,
          resolveSkillMentions: resolveSelectedSkills,
          settleBackgroundBeforeTerminal: true,
          onUncertainExecution: (cause) =>
            Effect.promise(() => Promise.resolve(options.onError?.(cause))),
          verifyInitialized: () =>
            Effect.sync(() => {
              clientInitialized = true;
            }),
        },
      });
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const run = <A, E>(effect: Effect.Effect<A, E>) => manager.runPromise(effect);
  const assertOpen = () => {
    if (closed) throw new Error("Customer runtime is closed.");
  };
  const assertThread = (candidate: C.OrchestrationV2ProviderThread) => {
    if (
      candidate.appThreadId !== threadId ||
      candidate.providerInstanceId !== instanceId ||
      (nativeThreadId !== undefined && candidate.nativeThreadRef?.nativeId !== nativeThreadId)
    ) {
      throw new Error(
        "The provider thread does not belong to this registered customer conversation.",
      );
    }
  };
  const catalogEffect = (active: CodexClient.CodexAppServerClient["Service"]) =>
    Effect.gen(function* () {
      const models = yield* requestAllCodexModels(active);
      const skills = parseCodexSkillsListResponse(
        yield* active.request("skills/list", { cwds: [options.cwd] }),
        options.cwd,
      );
      return { models, skills };
    });
  const catalog = async () => {
    assertOpen();
    return client !== undefined && clientInitialized
      ? run(catalogEffect(client))
      : manager.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const opened = yield* withCodexAppServerClient({
                binaryPath: settings.binaryPath,
                homePath: settings.homePath,
                launchArgs: settings.launchArgs,
                cwd: options.cwd,
                environment,
              });
              return yield* catalogEffect(opened.client);
            }),
          ),
        );
  };
  const validateSelection = async (selection: C.ModelSelection) => {
    if (selection.instanceId !== instanceId)
      throw new Error("The selected model belongs to another runtime.");
    const { models } = await catalog();
    const model = models.find((candidate) => candidate.slug === selection.model);
    if (!model)
      throw new Error("The selected model is no longer available on the customer runtime.");
    const effort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (option) => option.id === "reasoningEffort",
    );
    if (
      effort !== undefined &&
      (descriptor?.type !== "select" || !descriptor.options.some((option) => option.id === effort))
    ) {
      throw new Error("The selected reasoning effort is unavailable for this model.");
    }
  };
  const assertMessage = (message: Adapter.ProviderAdapterV2TurnMessage) => {
    if (/^\s*\/goal\b/iu.test(message.text))
      throw new Error("Persistent goals are unavailable on this customer runtime.");
    if (message.attachments.some((attachment) => !host.resolveAttachmentPath(attachment)))
      throw new Error("附件未能传到这台电脑，请重新发送");
  };
  const encodeThread = Schema.encodeSync(C.OrchestrationV2ProviderThreadJson);
  return {
    processGeneration: await manager.runPromise(randomUuidV4),
    catalog,
    dispatch: async (method, input) => {
      assertOpen();
      if (method === "openSession") {
        if (session !== undefined)
          throw new Error("This customer runtime already has an open session.");
        const decoded = Schema.decodeUnknownSync(HeadlessCodexInputs.openSession)(input);
        await validateSelection(decoded.modelSelection);
        threadId = decoded.threadId;
        session = await manager.runPromise(
          adapter
            .openSession({ ...decoded, runtimePolicy })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        );
        await manager.runPromise(
          Stream.runForEach(session.events, (event) =>
            Schema.encodeEffect(HeadlessCodexEvent)(event).pipe(
              Effect.flatMap((encoded) =>
                Effect.promise(() => Promise.resolve(options.onEvent(encoded))),
              ),
            ),
          ).pipe(
            Effect.catch((error) =>
              Effect.promise(() => Promise.resolve(options.onError?.(error))),
            ),
            Effect.forkIn(scope),
          ),
        );
        return Schema.encodeSync(C.OrchestrationV2ProviderSessionJson)(session.providerSession);
      }
      if (session === undefined) throw new Error("Open the customer runtime session first.");
      switch (method) {
        case "ensureThread": {
          const decoded = Schema.decodeUnknownSync(HeadlessCodexInputs.ensureThread)(input);
          if (decoded.threadId !== threadId)
            throw new Error("The conversation binding is immutable.");
          if (decoded.existingProviderThread !== undefined)
            assertThread(decoded.existingProviderThread);
          const result = await run(session.ensureThread({ ...decoded, runtimePolicy }));
          nativeThreadId = result.nativeThreadRef?.nativeId ?? undefined;
          return encodeThread(result);
        }
        case "resumeThread": {
          const decoded = Schema.decodeUnknownSync(HeadlessCodexInputs.resumeThread)(input);
          assertThread(decoded.providerThread);
          const result = await run(session.resumeThread({ ...decoded, runtimePolicy }));
          nativeThreadId = result.nativeThreadRef?.nativeId ?? undefined;
          return encodeThread(result);
        }
        case "startTurn": {
          const decoded = await preflight(async () => {
            const value = Schema.decodeUnknownSync(HeadlessCodexInputs.startTurn)(input);
            assertThread(value.providerThread);
            assertMessage(value.message);
            if (value.threadId !== threadId || value.appThread.id !== threadId)
              throw new Error("The conversation binding is immutable.");
            if (value.appContext?.length)
              throw new Error("Platform context bridging is unavailable on this customer runtime.");
            selectedSkillNames = value.assistantConfiguration?.skillNames;
            await validateSelection(value.modelSelection);
            if (client !== undefined)
              await run(
                resolveSelectedSkills(client, options.cwd, value.message.text, value.threadId),
              );
            return value;
          });
          const instructions = decoded.assistantConfiguration?.instructions;
          await run(
            session.startTurn({
              ...decoded,
              runtimePolicy,
              appContext: instructions ? [{ key: "autoops_assistant", text: instructions }] : [],
            }),
          );
          return null;
        }
        case "steerTurn": {
          const decoded = await preflight(async () => {
            const value = Schema.decodeUnknownSync(HeadlessCodexInputs.steerTurn)(input);
            assertThread(value.providerThread);
            assertMessage(value.message);
            if (value.threadId !== threadId)
              throw new Error("The conversation binding is immutable.");
            if (client !== undefined)
              await run(
                resolveSelectedSkills(client, options.cwd, value.message.text, value.threadId),
              );
            return value;
          });
          await run(session.steerTurn(decoded));
          return null;
        }
        case "interruptTurn": {
          const decoded = Schema.decodeUnknownSync(HeadlessCodexInputs.interruptTurn)(input);
          assertThread(decoded.providerThread);
          await run(session.interruptTurn(decoded));
          return null;
        }
        case "respondToRuntimeRequest":
          await run(
            session.respondToRuntimeRequest(
              Schema.decodeUnknownSync(HeadlessCodexInputs.respondToRuntimeRequest)(input),
            ),
          );
          return null;
        case "readThreadSnapshot": {
          const decoded = Schema.decodeUnknownSync(HeadlessCodexInputs.readThreadSnapshot)(input);
          assertThread(decoded.providerThread);
          return Schema.encodeSync(HeadlessCodexSnapshot)(
            await run(session.readThreadSnapshot(decoded)),
          );
        }
        default:
          throw new Error("Unsupported customer runtime operation.");
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await manager.runPromise(Scope.close(scope, Exit.void));
      await manager.dispose();
    },
  };
}
