import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import {
  filterBusinessSkills,
  businessSlashCommands,
} from "../../../../../../agent-demo/t3-adapters/skills.mjs";
import { prepareAutoOpsCodexRequest } from "../../../../../../agent-demo/t3-adapters/codex-policy.mjs";
import { verifyNativePolicy } from "../autoops/nativePolicy.ts";
import * as Effect from "effect/Effect";
import * as Core from "./CodexProviderCore.ts";
export * from "./CodexProviderCore.ts";
const platformHost: Core.CodexCatalogHostShape = {
  resolveLaunchArgs: resolveCodexLaunchArgs,
  transformRequest: prepareAutoOpsCodexRequest,
  verifyInitialized: verifyNativePolicy,
  filterSkills: (skills, cwd) => filterBusinessSkills(skills, process.env, cwd),
  slashCommands: businessSlashCommands,
};
export const withCodexAppServerClient = (
  ...args: Parameters<typeof Core.withCodexAppServerClient>
) =>
  Core.withCodexAppServerClient(...args).pipe(
    Effect.provideService(Core.CodexCatalogHost, platformHost),
  );
export const probeCodexSkillsForCwd = (...args: Parameters<typeof Core.probeCodexSkillsForCwd>) =>
  Core.probeCodexSkillsForCwd(...args).pipe(
    Effect.provideService(Core.CodexCatalogHost, platformHost),
  );
export const checkCodexProviderStatus = (
  ...args: Parameters<typeof Core.checkCodexProviderStatus>
) =>
  Core.checkCodexProviderStatus(...args).pipe(
    Effect.provideService(Core.CodexCatalogHost, platformHost),
  );
