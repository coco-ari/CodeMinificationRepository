import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  configuredAutoOpsAccess,
  type AutoOpsPrincipal,
} from "../../../../../../agent-demo/t3-adapters/access.mjs";
import { authorizeAutoOpsRpc } from "../../../../../../agent-demo/t3-adapters/rpc-policy.mjs";

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
): Effect.Effect<A, E, R> => Effect.suspend(() => {
  const access = configuredAutoOpsAccess();
  if (!access) return effect;
  // The RPC authorization middleware reports authorization errors before enqueue.
  // A revoked session while queued must fail closed, never reach the command core.
  return Effect.sync(() => {
    const principal = access.principalForNativeSession(sessionId);
    authorizeAutoOpsRpc(access, principal, method, payload);
    return principal;
  }).pipe(Effect.flatMap((principal) => Effect.provideService(effect, CurrentAutoOpsPrincipal, principal)));
});
