import type { OrchestrationV2AppThread } from "@t3tools/contracts";
/** The operation lives in the native app-thread projection and event log. */
export const isRollbackFrozen = (thread: Pick<OrchestrationV2AppThread, "rollbackSafety">) =>
  thread.rollbackSafety !== undefined && thread.rollbackSafety.status !== "complete";
