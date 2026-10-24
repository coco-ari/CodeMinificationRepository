import {
  RelayAuthInvalidError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentEndpointUnavailableError,
  type RelayProtectedError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import { connectionDiagnosisText, presentConnectionDiagnosis } from "./diagnosis.ts";
import {
  credentialMissingError,
  mapManagedRelayError,
  mapRemoteEnvironmentError,
} from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionAttemptError,
  ConnectionBlockedError,
  type SupervisorConnectionState,
} from "./model.ts";
import { ManagedRelayRequestFailedError } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const fromRelay = (relayError: RelayProtectedError) =>
  mapManagedRelayError(
    new ManagedRelayRequestFailedError({
      action: "connect relay environment",
      cause: relayError,
      relayError,
    }),
  );

const unavailable = (endpointFailure: "tunnel_down" | "origin_unreachable") =>
  fromRelay(
    new RelayEnvironmentEndpointUnavailableError({
      code: "environment_endpoint_unavailable",
      reason: "endpoint_request_failed",
      endpointFailure,
      endpointStatus: endpointFailure === "tunnel_down" ? 530 : 502,
      traceId: "trace-1",
    }),
  );

const diagnose = (state: SupervisorConnectionState, via: "relay" | "direct" = "relay") =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state, via });

const results = (state: SupervisorConnectionState, via?: "relay" | "direct") =>
  diagnose(state, via)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("names a dead tunnel and points the fix at the host", () => {
    const diagnosis = diagnose(backoff(unavailable("tunnel_down")));
    expect(diagnosis?.headline).toBe("Mac mini 的连接通道已断开");
    expect(results(backoff(unavailable("tunnel_down")))).toEqual([
      "device:ok",
      "relay:ok",
      "tunnel:failed",
      "server:unchecked",
    ]);
    expect(diagnosis?.steps.join(" ")).toContain("Mac mini 的 VPN 或 Tailscale 出口节点");
    expect(diagnosis?.facts).toContainEqual(["HTTP 状态", "530"]);
    expect(diagnosis?.facts).toContainEqual(["追踪标识", "trace-1"]);
    expect(diagnosis?.moreInfoUrl).toMatch(
      /t3-connect-troubleshooting\.md#the-hosts-tunnel-is-offline$/,
    );
  });

  it("links a host that rejects this device to the sign-in section", () => {
    const failure = new ConnectionBlockedError({
      reason: "authentication",
      detail: "rejected",
      hop: "server",
      via: "relay",
    });
    expect(diagnose(backoff(failure))?.moreInfoUrl).toMatch(/#sign-in-account-or-link-problems$/);
  });

  it("links the guide only for T3 Connect routes", () => {
    const failure = credentialMissingError("direct-1");
    expect(diagnose(backoff(failure), "direct")?.moreInfoUrl).toBeNull();
  });

  it("tells a working tunnel apart from T3 Code not answering", () => {
    expect(diagnose(backoff(unavailable("origin_unreachable")))?.headline).toBe(
      "连接通道正常，但 Mac mini 的服务未响应",
    );
    expect(results(backoff(unavailable("origin_unreachable")), "direct")).toEqual([
      "device:ok",
      "relay:ok",
      "tunnel:ok",
      "server:failed",
    ]);
  });

  it("blames this device when it cannot reach a tunnel the relay already reached", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
      "relay",
    );
    // A learned LAN route makes the environment's usual route direct; the failure still names the relay.
    const diagnosis = diagnose(backoff(failure), "direct");
    expect(diagnosis?.headline).toBe("当前设备无法连接 Mac mini 的通道");
    expect(diagnosis?.hops).toHaveLength(4);
    expect(diagnosis?.steps.join(" ")).not.toContain("在 Mac mini");
  });

  it("points a relay timeout at the host, not this device", () => {
    const failure = fromRelay(
      new RelayEnvironmentEndpointTimedOutError({
        code: "environment_endpoint_timed_out",
        traceId: "trace-3",
      }),
    );
    const diagnosis = diagnose(backoff(failure));
    expect(diagnosis?.headline).toBe("Mac mini 响应超时");
    expect(diagnosis?.steps.join(" ")).toContain("在 Mac mini");
    expect(diagnosis?.steps.join(" ")).not.toContain("当前设备");
  });

  it("stops at T3 Connect when this device cannot reach the relay", () => {
    const failure = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        transportFailed: true,
        cause: new TypeError("Failed to fetch"),
      }),
    );
    expect(diagnose(backoff(failure))?.headline).toBe("当前设备无法连接 T3 Connect");
    expect(results(backoff(failure))).toEqual([
      "device:ok",
      "relay:failed",
      "tunnel:unchecked",
      "server:unchecked",
    ]);
  });

  it("does not blame this device's network when T3 Connect answered with an error", () => {
    const failure = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: new Error("Bad Gateway"),
        status: 502,
      }),
    );
    const diagnosis = diagnose(backoff(failure));
    expect(diagnosis?.headline).toBe("T3 Connect 连接服务出错");
    expect(diagnosis?.steps.join(" ")).not.toContain("当前设备");
  });

  it("blames this device when its saved credential is missing", () => {
    const diagnosis = diagnose(backoff(credentialMissingError("connection-1")), "direct");
    expect(diagnosis?.hops[0]).toMatchObject({ hop: "device", result: "failed" });
  });

  it("names clock skew from a DPoP time window rejection", () => {
    const failure = fromRelay(
      new RelayAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_dpop",
        dpopFailureReason: "time_window",
        traceId: "trace-2",
      }),
    );
    expect(diagnose(backoff(failure))?.headline).toBe("当前设备的时间不准确");
  });

  it("reports this device as offline before any other hop", () => {
    const state = { ...backoff(unavailable("tunnel_down")), network: "offline" as const };
    expect(diagnose(state)?.headline).toBe("当前设备未连接网络");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("uses the relay health check before any connect attempt fails", () => {
    const diagnosis = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "relay",
      relayStatus: { status: "offline", endpointFailure: "tunnel_down", endpointStatus: 530 },
    });
    expect(diagnosis?.headline).toBe("Mac mini 的连接通道已断开");
    const origin = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "direct",
      relayStatus: { status: "offline", endpointFailure: "origin_unreachable" },
    });
    expect(origin?.hops.map((hop) => hop.hop)).toEqual(["device", "relay", "tunnel", "server"]);
  });

  it("keeps the relay health status out of a failure that has its own cause", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
    );
    const diagnosis = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: backoff(failure),
      via: "direct",
      relayStatus: { status: "offline", endpointFailure: "tunnel_down", endpointStatus: 530 },
    });
    expect(diagnosis?.facts.map(([label]) => label)).not.toContain("HTTP 状态");
  });

  it("has nothing to say when nothing failed", () => {
    expect(diagnose(AVAILABLE_CONNECTION_STATE)).toBeNull();
  });

  it("writes every hop and fact into the copied diagnostics", () => {
    const diagnosis = diagnose(backoff(unavailable("tunnel_down")));
    if (diagnosis === null) throw new Error("expected a diagnosis");
    const text = connectionDiagnosisText("Mac mini", diagnosis);
    expect(text).toContain("Mac mini 的连接通道: 失败");
    expect(text).toContain("Mac mini 的服务: 未检查");
    expect(text).toContain("原因: tunnel_down");
    expect(text).toContain("尝试次数: 3");
  });
});
