import { resolveProductProfile } from '../../../../../../agent-demo/t3-adapters/product-profile.mjs';
import { ServerSettingsError, type ServerSettings, type ServerSettingsPatch } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import * as Stream from 'effect/Stream';
import { configuredAutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs';
import { configuredSettingsPreferences } from '../../../../../../agent-demo/t3-adapters/settings-preferences.mjs';

export const applyProductSettings = (settings:ServerSettings):ServerSettings =>
  process.env.AUTOOPS_T3_DATA_DIR ? {...settings,...resolveProductProfile().serverSettingsOverrides} : settings;

export const forPrincipal = (principalId:string, settings:ServerSettings):ServerSettings =>
  applyProductSettings(configuredSettingsPreferences()?.overlay(principalId,settings) ?? settings);
export const forSession = (sessionId:string, settings:ServerSettings):ServerSettings => {
  const access=configuredAutoOpsAccess();
  return access ? forPrincipal(access.principalForNativeSession(sessionId).id,settings) : settings;
};
/** Shared run policy belongs to the thread owner, never the current observer. */
export const forThread = (threadId:string, settings:ServerSettings):ServerSettings => {
  const access=configuredAutoOpsAccess();
  if (!access) return settings;
  const binding=access.getThreadBinding(threadId);
  if (!binding || binding.revokedAt || binding.compatibilityReadOnly) return {...settings,continueThreadsAfterServerUpdate:false,compactIdleThreads:false,autoResumeLimitedThreads:false,snoozeLimitedThreads:false};
  if (binding.executionBinding.kind === 'customer') {
    // 共享来源先核对实际调用者的当前授权，再由公开入口校验提供者原设备与目录。
    access.customerExecutionSource(threadId,binding.ownerId);
    // These platform background workers cannot own the customer's process lifecycle.
    return {...forPrincipal(binding.ownerId,settings),continueThreadsAfterServerUpdate:false,compactIdleThreads:false,autoResumeLimitedThreads:false,snoozeLimitedThreads:false};
  }
  access.requireToolThread(threadId);
  return forPrincipal(binding.ownerId,settings);
};
export const update = (sessionId:string, patch:ServerSettingsPatch, settings:ServerSettings) => Effect.try({
  try:() => {
    const access=configuredAutoOpsAccess(); const store=configuredSettingsPreferences();
    if (!access || !store) throw new Error('AutoOps personal settings are unavailable');
    const principal=access.principalForNativeSession(sessionId);
    store.update(principal.id,patch);
    return store.overlay(principal.id,settings);
  },
  catch:(cause) => new ServerSettingsError({settingsPath:'AutoOps personal conversation settings',operation:'write-file',cause}),
});
export const subscribeChanges = (sessionId:string) => Effect.gen(function* () {
  const queue=yield* Queue.sliding<void>(1);
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const access=configuredAutoOpsAccess(); const store=configuredSettingsPreferences();
      return access && store ? store.subscribe(access.principalForNativeSession(sessionId).id,() => Queue.offerUnsafe(queue,undefined)) : () => {};
    }),
    (remove) => Effect.sync(remove),
  );
  return Stream.fromQueue(queue);
});
