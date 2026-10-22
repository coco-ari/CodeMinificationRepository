import { autoOpsFeature } from "~/autoops/capabilities";
import type { ComposerSubmissionIntent } from "../../composer-logic";

/** Product availability only; execution and dispatch semantics stay native T3. */
export function chatSubmissionIntentAllowed(intent: ComposerSubmissionIntent | undefined): boolean {
  return intent !== "background" || autoOpsFeature("advancedSend");
}

export function chatSlashCommandAllowed(name: string): boolean {
  switch (name.replace(/^\//, "").toLowerCase()) {
    case "plan":
    case "default":
      return autoOpsFeature("planMode");
    case "usage-limits":
      return autoOpsFeature("usageDashboard");
    case "feedback":
      return autoOpsFeature("diagnostics");
    default:
      return true;
  }
}

export function unavailableChatSlashCommand(prompt: string): string | null {
  const name = /^\s*\/([^\s]+)(?:\s|$)/u.exec(prompt)?.[1];
  return name !== undefined && !chatSlashCommandAllowed(name) ? name : null;
}
