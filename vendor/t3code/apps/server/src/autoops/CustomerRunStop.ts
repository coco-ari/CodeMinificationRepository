import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import { OrchestrationV2ProviderThreadJson } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { RemoteDeviceHub } from "./RemoteDeviceService.ts";
import { isCustomerProviderInstanceId } from "../../../../../../agent-demo/t3-adapters/customer-target.mjs";

/** An admitted remote start outlives the center's in-memory ProviderSessionManager entry. */
export function requestCustomerRunStop(input: {
  hub: RemoteDeviceHub | undefined;
  run: Pick<OrchestrationV2Run, "id" | "threadId" | "providerInstanceId" | "activeAttemptId">;
  providerThread: OrchestrationV2ProviderThread;
  providerTurn: OrchestrationV2ProviderTurn | undefined;
  requestedAt: string;
}): { state: "pending" | "unknown"; message: string } | null {
  const { hub, run, providerThread, providerTurn, requestedAt } = input;
  if (!isCustomerProviderInstanceId(run.providerInstanceId)) return null;
  const sessionId = providerThread.providerSessionId;
  // With affirmative evidence that no remote start was admitted, native before-start cancellation is safe.
  if (
    sessionId &&
    hub &&
    run.activeAttemptId &&
    !providerTurn &&
    !hub.hasDispatchedRun(sessionId, run.id, run.activeAttemptId)
  )
    return null;
  if (hub && sessionId && providerTurn && providerTurn.runAttemptId === run.activeAttemptId) {
    try {
      hub.enqueueInterrupt(
        sessionId,
        Schema.encodeSync(OrchestrationV2ProviderThreadJson)(providerThread),
        providerTurn.id,
      );
      return {
        state: "pending",
        message: "停止请求已保存，等待客户设备确认；当前执行尚未视为结束。",
      };
    } catch {
      // A missing or stale native identity must never take the local settlement fallback.
    }
  }
  if (hub && sessionId && run.activeAttemptId && hub.session(sessionId))
    hub.update(sessionId, {
      state: "unknown",
      pendingInterrupt: { runId: run.id, attemptId: run.activeAttemptId, requestedAt },
    });
  return {
    state: "unknown",
    message: "停止请求已记录，客户执行状态待核实；重新连接后继续处理，请勿重复发起任务。",
  };
}
