import { describe, expect, it, vi } from 'vite-plus/test';
import { ProviderInstanceId, ThreadId, RunId } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { buildCodexTurnStartParams } from '../orchestration-v2/Adapters/CodexAdapterV2.ts';
import { makeSweep } from '../orchestration-v2/UsageLimitRecoveryWorker.ts';
import { continueRestartedRun } from '../orchestration-v2/RestartContinuation.ts';
import * as ProjectionStore from '../orchestration-v2/ProjectionStore.ts';
import * as ThreadManagement from '../orchestration-v2/ThreadManagementService.ts';
import * as Orchestrator from '../orchestration-v2/Orchestrator.ts';
import * as ServerSettings from '../serverSettings.ts';

describe('AutoOps product profile runtime boundaries', () => {
  it('runs an existing plan thread in default mode without mutating its stored policy', async () => {
    vi.stubEnv('AUTOOPS_T3_DATA_DIR', '/unused-profile-test');
    vi.stubEnv('AUTOOPS_DEMO_PROFILE', 'project-assistant-lite-v1');
    try {
      const runtimePolicy = { runtimeMode: 'approval-required', interactionMode: 'plan', cwd: null } as const;
      const params = await Effect.runPromise(buildCodexTurnStartParams({
        nativeThreadId: 'existing-plan-native', codexInput: [{ type: 'text', text: '继续普通问答' }],
        runtimePolicy, modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'grok-4.6' }, hasT3Mcp: true,
      }));
      expect(params.collaborationMode?.mode).toBe('default');
      expect(params.collaborationMode?.settings.developer_instructions).not.toContain('## Plan mode');
      expect(runtimePolicy.interactionMode).toBe('plan');
      vi.stubEnv('AUTOOPS_DEMO_PROFILE', 't3-demo-full-v1');
      const restored = await Effect.runPromise(buildCodexTurnStartParams({
        nativeThreadId: 'existing-plan-native', codexInput: [{ type: 'text', text: '继续' }],
        runtimePolicy, modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'grok-4.6' }, hasT3Mcp: true,
      }));
      expect(restored.collaborationMode?.mode).toBe('plan');
    } finally { vi.unstubAllEnvs(); }
  });

  it('does not consume or resume already armed limit recoveries in lite; full keeps the worker', async () => {
    vi.stubEnv('AUTOOPS_T3_DATA_DIR', '/unused-profile-test');
    vi.stubEnv('AUTOOPS_DEMO_PROFILE', 'project-assistant-lite-v1');
    try {
      const readCandidates = vi.fn(() => Effect.succeed([]));
      const dispatch = vi.fn(() => Effect.die('must not dispatch'));
      const layer = Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({ getLimitRecoveryCandidates: readCandidates }),
        Layer.mock(ThreadManagement.ThreadManagementService)({ dispatch }),
        Layer.mock(Orchestrator.OrchestratorV2)({ autoArmLimitRecovery: dispatch }),
        ServerSettings.layerTest({ autoResumeLimitedThreads: true, snoozeLimitedThreads: true }),
      );
      const sweep = makeSweep.pipe(Effect.flatMap(run => run()), Effect.provide(layer));
      await Effect.runPromise(sweep);
      expect(readCandidates).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      vi.stubEnv('AUTOOPS_DEMO_PROFILE', 't3-demo-full-v1');
      await Effect.runPromise(sweep);
      expect(readCandidates).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it('holds persisted restart intents even when old shared/project settings opted in', async () => {
    vi.stubEnv('AUTOOPS_T3_DATA_DIR', '/unused-profile-test');
    vi.stubEnv('AUTOOPS_DEMO_PROFILE', 'project-assistant-lite-v1');
    try {
      const read = vi.fn(() => Effect.die('must not read or continue old intent'));
      await Effect.runPromise(continueRestartedRun({ threadId: ThreadId.make('old'), sourceRunId: RunId.make('old-run') }).pipe(Effect.provide(Layer.mergeAll(
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        Layer.mock(ThreadManagement.ThreadManagementService)({ getThreadRecords: read }),
      ))));
      expect(read).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
