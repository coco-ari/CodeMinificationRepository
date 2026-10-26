import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  configuredAutoOpsAccess,
  type AutoOpsPrincipal,
} from "../../../../../../agent-demo/t3-adapters/access.mjs";
import { authorizeAutoOpsRpc } from "../../../../../../agent-demo/t3-adapters/rpc-policy.mjs";
import { validateQuestionCommand } from "./questionCommands.ts";

/** Acting web user, never inferred from the owner of a shared conversation. */
export const CurrentAutoOpsPrincipal = Context.Reference<AutoOpsPrincipal | undefined>(
  "autoops/CurrentPrincipal",
  { defaultValue: () => undefined },
);

/** Attach inside the native startup queue, which executes in its worker fiber. */
export const withCommandPrincipal = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  sessionId: string,
  method: string,
  payload: unknown,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const access = configuredAutoOpsAccess();
    if (!access) return effect;
    // The RPC authorization middleware reports authorization errors before enqueue.
    // A revoked session while queued must fail closed, never reach the command core.
    return Effect.sync(() => {
      const principal = access.principalForNativeSession(sessionId);
      authorizeAutoOpsRpc(access, principal, method, payload);
      return principal;
    }).pipe(
      Effect.flatMap((principal) =>
        validateQuestionCommand(access, principal, method, payload).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const command = payload as {
                threadId?: string;
                commandId?: string;
                messageId?: string;
                runId?: string;
                initialMessage?: { messageId?: string };
                type?: string;
              };
              const messageId =
                method === "orchestration.launchThread"
                  ? command.initialMessage?.messageId
                  : method === "orchestration.dispatchCommand" &&
                      command.type === "message.dispatch"
                    ? command.messageId
                    : undefined;
              if (
                method === "orchestration.dispatchCommand" &&
                command.type === "queued-run.edit" &&
                command.threadId &&
                command.commandId &&
                command.runId
              )
                access.recordQueuedEditActor(
                  principal,
                  command.threadId,
                  command.commandId,
                  command.runId,
                );
              if (messageId && command.threadId && command.commandId)
                access.recordMessageActor(
                  principal,
                  command.threadId,
                  command.commandId,
                  messageId,
                );
            }),
          ),
          Effect.andThen(Effect.provideService(effect, CurrentAutoOpsPrincipal, principal)),
        ),
      ),
    );
  });
