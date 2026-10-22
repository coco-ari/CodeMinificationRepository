import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  enabled: true,
  state: 'draft' as 'draft' | 'submitting' | 'locked',
  principal: { id: 'actor-a' },
  binding: {projectId:'project-a',environmentId:'env-test',agentId:'agent-a',ownerId:'actor-a',visibility:'private',workspaceType:'internal',workspaceVersionId:'version-a'},
  begin: vi.fn(),
  finish: vi.fn(),
}));
vi.mock('../../../../../../agent-demo/t3-adapters/access.mjs', () => ({
  configuredAutoOpsAccess: () => mocks.enabled ? {
    principalForNativeSession: () => mocks.principal,
    getThreadBinding: () => ({...mocks.binding,scopeState:mocks.state}),
    requireThread: () => ({...mocks.binding,scopeState:mocks.state}),
    beginThreadSubmission: mocks.begin,
    finishThreadSubmission: mocks.finish,
  } : undefined,
}));
import { hasAcceptedUserMessage, withThreadLaunchReservation, isThreadSubmissionActive, getThreadSubmissionGeneration } from './threadReservations.ts';

const input = { threadId: 'thread-a', commandId: 'command-a' };
const launchResult = { projection: { messages: [{ role: 'user' }] } };

describe('AutoOps first message scope reservation', () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.state = 'draft';
    mocks.binding = {projectId:'project-a',environmentId:'env-test',agentId:'agent-a',ownerId:'actor-a',visibility:'private',workspaceType:'internal',workspaceVersionId:'version-a'};
    mocks.begin.mockReset().mockImplementation(() => { mocks.state = 'submitting'; });
    mocks.finish.mockReset().mockImplementation((_thread: string, _command: string, accepted: boolean) => { mocks.state = accepted ? 'locked' : 'draft'; });
  });

  it('locks a successful launch using its committed user message without another projection read', async () => {
    const read = vi.fn(() => false);
    const result = await Effect.runPromise(withThreadLaunchReservation(Effect.succeed(launchResult), 'session-a', input, Effect.sync(read), hasAcceptedUserMessage));
    expect(result).toEqual(launchResult);
    expect(mocks.begin).toHaveBeenCalledWith(mocks.principal, input.threadId, input.commandId);
    expect(mocks.finish).toHaveBeenCalledWith(input.threadId, input.commandId, true);
    expect(mocks.state).toBe('locked');
    expect(read).not.toHaveBeenCalled();
  });

  it('checks native acceptance for a message.dispatch result containing only a sequence', async () => {
    const result = await Effect.runPromise(withThreadLaunchReservation(Effect.succeed({ sequence: 42 }), 'session-a', input, Effect.succeed(true)));
    expect(result).toEqual({ sequence: 42 });
    expect(mocks.state).toBe('locked');
  });

  it('unlocks a definite rejection and preserves the original operation failure', async () => {
    const result = await Effect.runPromise(Effect.exit(withThreadLaunchReservation(Effect.fail('validation-rejected'), 'session-a', input, Effect.succeed(false), hasAcceptedUserMessage)));
    expect(Exit.isFailure(result)).toBe(true);
    expect(mocks.state).toBe('draft');
    expect(mocks.finish).toHaveBeenCalledWith(input.threadId, input.commandId, false);
  });

  it('keeps an accepted message locked when transport fails after commit', async () => {
    const result = await Effect.runPromise(Effect.exit(withThreadLaunchReservation(Effect.fail('response-lost'), 'session-a', input, Effect.succeed(true), hasAcceptedUserMessage)));
    expect(Exit.isFailure(result)).toBe(true);
    expect(mocks.state).toBe('locked');
  });

  it('keeps an uncertain result submitting when the native projection cannot be read', async () => {
    const result = await Effect.runPromise(Effect.exit(withThreadLaunchReservation(Effect.fail('connection-lost'), 'session-a', input, Effect.fail('projection-unavailable'), hasAcceptedUserMessage)));
    expect(Exit.isFailure(result)).toBe(true);
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.state).toBe('submitting');
  });

  it.each([false, true])('reconciles cancellation against native acceptance=%s', async (accepted) => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const operation = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      const fiber = yield* withThreadLaunchReservation(operation, 'session-a', input, Effect.succeed(accepted)).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
    }));
    expect(mocks.finish).toHaveBeenCalledWith(input.threadId, input.commandId, accepted);
    expect(mocks.state).toBe(accepted ? 'locked' : 'draft');
  });

  it('keeps canceled work frozen if the final native acceptance check is unavailable', async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const operation = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      const fiber = yield* withThreadLaunchReservation(operation, 'session-a', input, Effect.fail('offline')).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
    }));
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.state).toBe('submitting');
  });

  it('does not turn a committed success into another failure when reservation persistence fails', async () => {
    mocks.finish.mockImplementation(() => { throw new Error('reservation-write-failed'); });
    const result = await Effect.runPromise(withThreadLaunchReservation(Effect.succeed(launchResult), 'session-a', input, Effect.succeed(true), hasAcceptedUserMessage));
    expect(result).toEqual(launchResult);
    expect(mocks.state).toBe('submitting');
  });

  it('does not begin another first-message reservation for an already locked conversation', async () => {
    mocks.state = 'locked';
    expect(await Effect.runPromise(withThreadLaunchReservation(Effect.succeed({sequence:99}), 'session-a', {...input,commandId:'later-message'}, Effect.succeed(true)))).toEqual({sequence:99});
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(isThreadSubmissionActive(input.threadId)).toBe(false);
  });

  it('tracks native work until the acceptance finalizer finishes and then removes it', async () => {
    const observed: boolean[] = [];
    await Effect.runPromise(withThreadLaunchReservation(Effect.sync(() => { observed.push(isThreadSubmissionActive(input.threadId)); return {sequence:1}; }), 'session-a', input, Effect.sync(() => { observed.push(isThreadSubmissionActive(input.threadId)); return true; })));
    expect(observed).toEqual([true,true]);
    expect(isThreadSubmissionActive(input.threadId)).toBe(false);
  });

  it('does not unlock a duplicate submission while another attempt for that thread is active', async () => {
    const before = getThreadSubmissionGeneration(input.threadId);
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)));
      const fiber = yield* withThreadLaunchReservation(first, 'session-a', input, Effect.succeed(false)).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Effect.exit(withThreadLaunchReservation(Effect.fail('duplicate-failed'), 'session-a', input, Effect.succeed(false)));
      expect(mocks.state).toBe('submitting');
      expect(isThreadSubmissionActive(input.threadId)).toBe(true);
      expect(getThreadSubmissionGeneration(input.threadId)).toBe(before + 3);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
    }));
    expect(mocks.state).toBe('draft');
    expect(isThreadSubmissionActive(input.threadId)).toBe(false);
    expect(getThreadSubmissionGeneration(input.threadId)).toBe(before + 4);
  });

  it('invalidates old idle evidence when a complete submission occurs during a native snapshot read', async () => {
    const idleBefore = !isThreadSubmissionActive(input.threadId);
    const generationBefore = getThreadSubmissionGeneration(input.threadId);
    // The operation commits, but the binding write fails: HTTP must not use an
    // older empty projection as permission to reopen the still-submitting scope.
    mocks.finish.mockImplementation(() => { throw new Error('binding-write-unavailable'); });
    await Effect.runPromise(withThreadLaunchReservation(Effect.succeed(launchResult), 'session-a', input, Effect.succeed(true), hasAcceptedUserMessage));
    const mayReleaseUsingOldSnapshot = idleBefore && !isThreadSubmissionActive(input.threadId) && generationBefore === getThreadSubmissionGeneration(input.threadId);
    expect(mocks.state).toBe('submitting');
    expect(isThreadSubmissionActive(input.threadId)).toBe(false);
    expect(getThreadSubmissionGeneration(input.threadId)).toBe(generationBefore + 2);
    expect(mayReleaseUsingOldSnapshot).toBe(false);
  });

  it('leaves the standalone T3 execution unchanged', async () => {
    mocks.enabled = false;
    expect(await Effect.runPromise(withThreadLaunchReservation(Effect.succeed('standalone'), 'session-a', input, Effect.succeed(true)))).toBe('standalone');
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it.each(['projectId','environmentId','agentId','ownerId','visibility','workspaceType','workspaceVersionId'] as const)('rejects a queued message when %s changes before its native worker starts', async (key) => {
    const operation = vi.fn(() => 'unexpected execution');
    const queued = withThreadLaunchReservation(Effect.sync(operation), 'session-a', input, Effect.succeed(false));
    mocks.binding[key] = 'changed-after-enqueue';
    await expect(Effect.runPromise(queued)).rejects.toThrow('排队期间会话范围发生变化');
    expect(operation).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(isThreadSubmissionActive(input.threadId)).toBe(false);
  });

  it('allows an unchanged queued scope to execute after another acceptance locks the same conversation', async () => {
    const operation = vi.fn(() => ({sequence:88}));
    const queued = withThreadLaunchReservation(Effect.sync(operation), 'session-a', input, Effect.succeed(true));
    mocks.state = 'locked';
    expect(await Effect.runPromise(queued)).toEqual({sequence:88});
    expect(operation).toHaveBeenCalledOnce();
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});
