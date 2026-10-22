import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { configuredAutoOpsAccess, type ThreadBinding } from '../../../../../../agent-demo/t3-adapters/access.mjs';

type LaunchProjection = { readonly projection: { readonly messages: ReadonlyArray<{readonly role:string}> } };
export const hasAcceptedUserMessage = (value: LaunchProjection) => value.projection.messages.some((message) => message.role === 'user');
const activeSubmissions = new Map<string, number>();
const submissionGenerations = new Map<string, number>();
export const isThreadSubmissionActive = (threadId: string) => (activeSubmissions.get(threadId) ?? 0) > 0;
export const getThreadSubmissionGeneration = (threadId: string) => submissionGenerations.get(threadId) ?? 0;
const advanceSubmissionGeneration = (threadId: string) => submissionGenerations.set(threadId, getThreadSubmissionGeneration(threadId) + 1);
const scopeKeys = ['projectId','environmentId','agentId','ownerId','visibility','workspaceType','workspaceVersionId'] as const;
const scopeFingerprint = (binding: ThreadBinding) => JSON.stringify(scopeKeys.map((key) => binding[key] ?? null));

/** Runs inside T3's queued command fiber so an HTTP reservation cannot change a launch in flight. */
export function withThreadLaunchReservation<A, E, R, E2, R2>(
  operation: Effect.Effect<A, E, R>,
  sessionId: string,
  input: {readonly threadId:string;readonly commandId:string},
  readAccepted: Effect.Effect<boolean, E2, R2>,
  acceptedByResult?: (value: A) => boolean,
): Effect.Effect<A, E, R | R2> {
  // Capture before enqueue: an editable draft may change while T3's startup
  // worker is busy, but a queued message must retain the scope it was sent to.
  const queuedBinding = configuredAutoOpsAccess()?.getThreadBinding(input.threadId);
  const queuedScope = queuedBinding === undefined ? undefined : scopeFingerprint(queuedBinding);
  return Effect.suspend(() => {
    const access = configuredAutoOpsAccess();
    if (!access) return operation;
    const principal = access.principalForNativeSession(sessionId);
    const binding = access.requireThread(principal, input.threadId);
    if (queuedScope !== undefined && queuedScope !== scopeFingerprint(binding))
      throw new Error('排队期间会话范围发生变化，请确认后重新发送。');
    if (binding.scopeState === 'locked') return operation;
    let acquired = false;
    const reconcile = (exit: Exit.Exit<A, E>) => {
        const accepted = Exit.isSuccess(exit) && acceptedByResult ? Effect.sync(() => acceptedByResult(exit.value)) : readAccepted;
        // A missing response is not proof of rejection. Keep the reservation frozen
        // when the native projection cannot be read, rather than permit a scope swap.
        return accepted.pipe(
          Effect.flatMap((value) => Effect.sync(() => {
            if (value || (activeSubmissions.get(input.threadId) ?? 0) <= 1) access.finishThreadSubmission(input.threadId, input.commandId, value);
          })),
          Effect.ignoreCause,
        );
      };
    return Effect.sync(() => {
      access.beginThreadSubmission(principal, input.threadId, input.commandId);
      activeSubmissions.set(input.threadId, (activeSubmissions.get(input.threadId) ?? 0) + 1);
      advanceSubmissionGeneration(input.threadId);
      acquired = true;
    }).pipe(
      Effect.andThen(operation.pipe(Effect.onExit(reconcile))),
      Effect.ensuring(Effect.sync(() => {
        if (!acquired) return;
        const remaining = (activeSubmissions.get(input.threadId) ?? 1) - 1;
        if (remaining > 0) activeSubmissions.set(input.threadId, remaining);
        else activeSubmissions.delete(input.threadId);
        advanceSubmissionGeneration(input.threadId);
      })),
    );
  });
}
