import type { buildCodexAdditionalContext } from "./CodexDeveloperInstructionsCore.ts";
import type { ChatAttachment, ProviderInteractionMode, ThreadId } from "@t3tools/contracts";
import type { McpAppReference } from "@t3tools/shared/mcpApp";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";

/** Host resources are deliberately injected. Native protocol conversion must not import
 * the platform database, secrets, file store or business tool policy. */
export interface CodexExecutionHost {
  readonly settleBackgroundBeforeTerminal?: boolean;
  readonly onUncertainExecution?: (cause: unknown) => Effect.Effect<void>;
  readonly additionalContext: typeof buildCodexAdditionalContext;
  readonly mcpSessions: {
    readonly read: (
      threadId: ThreadId,
    ) => Effect.Effect<McpProviderSession.McpProviderSessionConfig | undefined>;
  };
  readonly verifyInitialized: (
    client: CodexClient.CodexAppServerClient["Service"],
  ) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
  readonly interactionMode: (mode: ProviderInteractionMode) => ProviderInteractionMode;
  readonly threadParameters: (threadId: ThreadId | undefined) => {
    readonly cwd?: string;
    readonly baseInstructions?: string;
    readonly config?: Readonly<Record<string, Schema.Json>>;
  };
  readonly mcpApprovals: Readonly<Record<string, Schema.Json>>;
  readonly resolveSkillMentions: (
    client: CodexClient.CodexAppServerClient["Service"],
    cwd: string | null,
    text: string,
    threadId: ThreadId,
  ) => Effect.Effect<
    ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>,
    CodexErrors.CodexAppServerError
  >;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
  readonly resolveAttachmentPathById: (attachmentId: string) => string | null;
  readonly snapshotMcpApp: (input: {
    readonly threadId: ThreadId;
    readonly server: string;
    readonly tool: string;
    readonly resourceUri: string;
    readonly contents: ReadonlyArray<unknown>;
  }) => Effect.Effect<
    McpAppReference | undefined,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  >;
  readonly requireLegacyTool: (
    appThreadId: string,
    nativeThreadId: string,
    tool: string,
    namespace?: string | null,
  ) => { readonly server: string; readonly tool: string };
  readonly registerSubagent: (
    parentThreadId: ThreadId,
    childThreadId: ThreadId,
    nativeThreadId: string,
    parentRunId?: string,
    providerTurnId?: string,
  ) => unknown;
  readonly recordFork: (
    sourceThreadId: ThreadId | null,
    targetThreadId: ThreadId,
    nativeSourceId: string,
    nativeTargetId: string,
  ) => unknown;
}
