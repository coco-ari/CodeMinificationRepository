import { refreshBusinessSkillLaunchArgs } from "../../../../../../agent-demo/t3-adapters/native-catalog.mjs";
import { resolveCodexLaunchArgs as resolveLocalLaunchArgs } from "./codexLaunchArgsCore.ts";
export * from "./codexLaunchArgsCore.ts";
export const resolveCodexLaunchArgs = (launchArgs?: string, environment: NodeJS.ProcessEnv = process.env) => refreshBusinessSkillLaunchArgs(resolveLocalLaunchArgs(launchArgs, environment), environment);
