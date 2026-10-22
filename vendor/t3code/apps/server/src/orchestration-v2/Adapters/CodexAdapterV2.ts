import {
  requireToolThread,
  isAutoOpsEnabled,
} from "../../../../../../../agent-demo/t3-adapters/access.mjs";
import { resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { buildCodexAdditionalContext } from "../../provider/CodexDeveloperInstructions.ts";
import {
  requireLegacyBusinessTool,
  recordLegacyNativeFork,
} from "../../../../../../../agent-demo/t3-adapters/legacy-tools.mjs";
import { registerNativeSubagent } from "../../../../../../../agent-demo/t3-adapters/subagents.mjs";
import {
  businessThreadParameters,
  businessMcpApprovals,
  prepareAutoOpsCodexRequest,
  effectiveBusinessInteractionMode,
} from "../../../../../../../agent-demo/t3-adapters/codex-policy.mjs";
import { resolveBusinessSkillMentions } from "../../../../../../../agent-demo/t3-adapters/skills.mjs";
import { verifyNativePolicy } from "../../autoops/nativePolicy.ts";
import { resolveAttachmentPath, resolveAttachmentPathById } from "../../attachmentStore.ts";
import { snapshotMcpApp } from "../../mcpApps/McpAppSnapshot.ts";
import { ServerConfig } from "../../config.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../../provider/Drivers/CodexHomeLayout.ts";
import type { CodexExecutionHost } from "../../provider/CodexExecutionHost.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CodexSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import * as Core from "./CodexExecution.ts";
import {
  CODEX_DRIVER_KIND,
  CODEX_DEFAULT_INSTANCE_ID,
  CodexAppServerClientFactory,
  type CodexAdapterV2Options as CoreOptions,
} from "./CodexExecution.ts";
export * from "./CodexExecution.ts";
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
export type CodexAdapterV2Options = Omit<CoreOptions, "host"> & {
  readonly serverConfig: ServerConfig["Service"];
};
export const layerAppServerClientFactory = Core.makeLayerAppServerClientFactory(
  prepareAutoOpsCodexRequest,
  resolveCodexLaunchArgs,
);
export const buildCodexTurnStartParams = (
  input: Parameters<typeof Core.buildCodexTurnStartParams>[0],
) =>
  Core.buildCodexTurnStartParams({
    ...input,
    additionalContext: buildCodexAdditionalContext,
    runtimePolicy: {
      ...input.runtimePolicy,
      interactionMode: effectiveBusinessInteractionMode(input.runtimePolicy.interactionMode),
    },
  });
export const makeCodexAdapterV2 = Effect.fn("CodexAdapterV2.makePlatform")(function* (
  options: CodexAdapterV2Options,
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const host: CodexExecutionHost = {
    additionalContext: buildCodexAdditionalContext,
    mcpSessions,
    verifyInitialized: verifyNativePolicy,
    interactionMode: effectiveBusinessInteractionMode,
    threadParameters: (threadId) =>
      threadId === undefined ? {} : businessThreadParameters(threadId),
    mcpApprovals: businessMcpApprovals(),
    resolveSkillMentions: (_client, _cwd, text, threadId) =>
      Effect.sync(() =>
        resolveBusinessSkillMentions(
          text,
          process.env,
          isAutoOpsEnabled() ? requireToolThread(threadId).binding : undefined,
        ),
      ),
    resolveAttachmentPath: (attachment) =>
      resolveAttachmentPath({ attachmentsDir: options.serverConfig.attachmentsDir, attachment }),
    resolveAttachmentPathById: (attachmentId) =>
      resolveAttachmentPathById({
        attachmentsDir: options.serverConfig.attachmentsDir,
        attachmentId,
      }),
    snapshotMcpApp: (input) =>
      snapshotMcpApp({ attachmentsDir: options.serverConfig.attachmentsDir, ...input }),
    requireLegacyTool: requireLegacyBusinessTool,
    registerSubagent: registerNativeSubagent,
    recordFork: recordLegacyNativeFork,
  };
  return yield* Core.makeCodexAdapterV2({ ...options, host });
});

export type CodexAdapterV2DriverEnv =
  | CodexAppServerClientFactory
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ServerConfig;

export const createCodexAdapterV2 = Effect.fn("CodexAdapterV2.createCodexAdapterV2")(function* (
  { instanceId, environment, enabled, config }: ProviderAdapterDriverCreateInput<CodexSettings>,
  hooks: Pick<CodexAdapterV2Options, "onUsageLimits" | "resolveRuntime"> = {},
) {
  const clientFactory = yield* CodexAppServerClientFactory;
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const hostEnvironment = yield* HostProcess.Environment;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const serverConfig = yield* ServerConfig;
  const homeLayout = yield* resolveCodexHomeLayout(config);

  yield* materializeCodexShadowHome(homeLayout).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterDriverCreateError({
          driver: CODEX_DRIVER_KIND,
          instanceId,
          detail: "Failed to materialize the Codex shadow home.",
          cause,
        }),
    ),
  );

  const settings = {
    ...config,
    enabled,
    binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    homePath: homeLayout.effectiveHomePath ?? "",
  } satisfies CodexSettings;

  return yield* makeCodexAdapterV2({
    instanceId,
    settings,
    environment: yield* mergeProviderInstanceEnvironment(environment, hostEnvironment),
    clientFactory,
    crypto,
    fileSystem,
    idAllocator,
    serverConfig,
    continuationRequests,
    ...hooks,
  });
});

export const CodexAdapterV2Driver: ProviderAdapterDriver<CodexSettings, CodexAdapterV2DriverEnv> = {
  driverKind: CODEX_DRIVER_KIND,
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => DEFAULT_CODEX_SETTINGS,
  create: createCodexAdapterV2,
};

const layer: Layer.Layer<
  ProviderAdapter.ProviderAdapterV2,
  never,
  | CodexAppServerClientFactory
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ServerConfig
> = Layer.effect(
  ProviderAdapter.ProviderAdapterV2,
  Effect.gen(function* () {
    const clientFactory = yield* CodexAppServerClientFactory;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const hostEnvironment = yield* HostProcess.Environment;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* ServerConfig;

    return yield* makeCodexAdapterV2({
      instanceId: CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: hostEnvironment,
      clientFactory,
      crypto,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests,
    });
  }),
);
