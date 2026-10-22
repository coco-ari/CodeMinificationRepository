import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";

import {
  persistClientSettingsPatch,
  useMergedSettings,
  useMigrateModelPreferences,
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  useMigrateModelPreferences(target?.environmentId ?? null, target?.settings ?? null);
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return (plan: ReturnType<typeof planScopedSettingsPatch>) => {
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "未保存设置",
        description: plan.unavailableReason,
      });
      return;
    }
    void persistScopedSettingsPatch(
      plan,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        if (missing)
          return AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                requiredScope: missing,
                message: "当前连接没有修改这些设置的权限。",
              }),
            ),
          );
        return persistServer(request);
      },
      persistClientSettingsPatch,
    ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
      if (failedEnvironments.length === 0) return;
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0 ? "部分环境已保存设置" : "未保存设置",
        description: [
          ...failedEnvironments.map(
            ({ label, message }) => `${label} 保存失败：${message}`,
          ),
          ...(savedEnvironmentCount > 0
            ? [`已保存到 ${savedEnvironments.map(({ label }) => label).join('、')}。`]
            : []),
        ].join("\n"),
      });
    });
  };
}

export function useUpdateScopedSettings() {
  const { scope, environments } = useSettingsScope();
  const run = useRunScopedPlan();
  return (patch: ScopedSettingsPatch) => run(planScopedSettingsPatch(scope, environments, patch));
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(planScopedSettingsClear(context.scope, context.environments, keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(planProjectOverridesClear(context.environments, entries, keys));
  };
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
