import { BUSINESS_INSTRUCTIONS } from "../../../../../../agent-demo/t3-adapters/codex-policy.mjs";
import { buildCodexAdditionalContext as buildLocalContext } from "./CodexDeveloperInstructionsCore.ts";
export * from "./CodexDeveloperInstructionsCore.ts";
export const buildCodexAdditionalContext = (...args: Parameters<typeof buildLocalContext>): ReturnType<typeof buildLocalContext> => process.env.AUTOOPS_T3_DATA_DIR
  ? { autoops_business_scope: { kind: "application", value: BUSINESS_INSTRUCTIONS } }
  : buildLocalContext(...args);
