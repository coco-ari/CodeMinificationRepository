import {
  t3ConnectTroubleshootingUrl,
  type T3ConnectTroubleshootingSection,
} from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";

import type {
  ConnectionAttemptError,
  ConnectionFailureCause,
  ConnectionHop,
  SupervisorConnectionState,
} from "./model.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Mac mini's tunnel is offline". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** The troubleshooting guide section for this failure. Null for direct routes. */
  readonly moreInfoUrl: string | null;
}

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  /** The environment's usual route, used when the failure does not name one. */
  readonly via: "relay" | "direct";
  /** The relay's last health check, which can name a cause before any connect attempt. */
  readonly relayStatus?: Pick<
    RelayEnvironmentStatusResponse,
    "status" | "endpointFailure" | "endpointStatus" | "offlineReason"
  > | null;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
}

interface Located {
  readonly hop: ConnectionHop;
  readonly cause: ConnectionFailureCause | "offline" | "outdated" | "released" | null;
}

const NOT_ANSWERING: ReadonlySet<ConnectionFailureCause> = new Set([
  "origin_unreachable",
  "invalid_response",
]);

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: failure.failureCause ?? null };
  }
  if (failure !== null) {
    const unreachable =
      failure.reason === "network" ||
      failure.reason === "timeout" ||
      failure.reason === "transport";
    const via = failure.via ?? input.via;
    return { hop: unreachable && via === "relay" ? "tunnel" : "server", cause: null };
  }
  const status = input.relayStatus;
  if (status?.status !== "offline") return null;
  if (status.offlineReason === "tunnel_released") return { hop: "tunnel", cause: "released" };
  const cause = status.endpointFailure ?? null;
  return { hop: cause !== null && NOT_ANSWERING.has(cause) ? "server" : "tunnel", cause };
}

function headline(host: string, located: Located, failure: ConnectionAttemptError | null): string {
  switch (located.cause) {
    case "offline":
      return "当前设备未连接网络";
    case "outdated":
      return `${host} 的服务版本需要更新`;
    case "clock_skew":
      return "当前设备的时间不准确";
    case "not_linked":
      return `${host} 尚未关联当前 T3 Connect 账号`;
    case "relay_error":
      return "T3 Connect 连接服务出错";
    case "tunnel_pending":
      return `正在建立 ${host} 的连接通道`;
    case "tunnel_not_enabled":
      return `${host} 尚未启用 T3 Connect`;
    case "released":
    case "tunnel_down":
      return `${host} 的连接通道已断开`;
    case "origin_unreachable":
      return `连接通道正常，但 ${host} 的服务未响应`;
    case "invalid_response":
      return `${host} 的服务返回了异常响应`;
    case "dns":
      return `无法解析 ${host} 的通道地址`;
    case "tls":
      return `无法与 ${host} 的通道建立安全连接`;
    case "refused":
      return `${host} 的通道拒绝连接`;
    case "timeout":
      return `${host} 响应超时`;
    case "unknown":
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return "当前设备无法建立连接";
    case "relay":
      return failure?.reason === "authentication"
        ? "T3 Connect 登录验证失败"
        : "当前设备无法连接 T3 Connect";
    case "tunnel":
      // The relay already reached the host when this device fails on its own (#17629).
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? `当前设备无法连接 ${host} 的通道`
        : `T3 Connect 无法连接 ${host} 的通道`;
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? `${host} 拒绝了当前设备的访问`
        : `${host} 的服务未响应`;
  }
}

function steps(host: string, located: Located, failure: ConnectionAttemptError | null): string[] {
  const checkHost = `在 ${host} 上检查“设置 > 连接”，或运行 \`t3 connect status\`。`;
  switch (located.cause) {
    case "offline":
      return ["请检查当前设备的网络，恢复后会自动重连。"];
    case "outdated":
      return [`请联系管理员更新 ${host} 的服务。`];
    case "clock_skew":
      return [`请校准当前设备与 ${host} 的日期和时间后重试。`];
    case "not_linked":
      return [
        "请确认当前设备与服务器使用同一 T3 Connect 账号。",
        `在 ${host} 上打开“设置 > 连接”，启用 T3 Connect。`,
      ];
    case "tunnel_pending":
      return ["请稍候，系统会自动重试。", checkHost];
    case "relay_error":
      return [
        "请稍候，系统会自动重试。",
        "如果持续失败，请复制诊断并联系管理员。",
      ];
    case "tunnel_not_enabled":
      return [`在 ${host} 上打开“设置 > 连接”，启用 T3 Connect。`];
    case "released":
    case "tunnel_down":
      return [
        `请确认 ${host} 在线且服务正在运行。`,
        checkHost,
        `请检查 ${host} 的 VPN 或 Tailscale 出口节点是否阻断通道（端口 7844）。`,
      ];
    case "origin_unreachable":
    case "invalid_response":
      return [`请联系管理员检查或重启 ${host} 的服务。`, checkHost];
    // The relay saw these on its way to the host, so the fix is on the host.
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return [`请确认 ${host} 在线且未休眠。`, checkHost];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        "请刷新页面后重试。",
        `如果持续失败，请复制诊断并联系管理员检查 ${host} 的连接配置。`,
      ];
    case "relay":
      return failure?.reason === "authentication"
        ? ["请重新登录 T3 Connect。"]
        : [
            "请检查当前设备的网络连接。",
            "请检查当前设备的 VPN、防火墙或拦截插件是否阻断 T3 Connect。",
          ];
    case "tunnel":
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? [
            "请检查当前设备的 VPN、防火墙或 DNS 设置是否阻断连接通道。",
            "可切换网络重试，或使用 Tailscale 等直连地址。",
          ]
        : [`请确认 ${host} 在线且未休眠。`, checkHost];
    case "server":
      return [
        `请联系管理员确认 ${host} 的服务正在运行。`,
        "请重试；如果持续失败，可复制诊断并联系管理员。",
      ];
  }
}

function helpSection(
  located: Located,
  failure: ConnectionAttemptError | null,
): T3ConnectTroubleshootingSection {
  switch (located.cause) {
    case "offline":
      return "this-device-cant-reach-t3-connect";
    case "outdated":
      return "the-host-runs-an-older-t3-code";
    case "clock_skew":
      return "the-clock-is-off";
    case "not_linked":
    case "tunnel_not_enabled":
      return "sign-in-account-or-link-problems";
    case "relay_error":
      return "t3-connect-returned-an-error";
    case "released":
    case "tunnel_down":
    case "tunnel_pending":
      return "the-hosts-tunnel-is-offline";
    case "origin_unreachable":
    case "invalid_response":
      return "the-tunnel-works-but-t3-code-does-not-answer";
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return "the-t3-connect-address-does-not-resolve-or-answer";
    case null:
      break;
  }
  const onThisDevice =
    failure?.reason === "network" ||
    failure?.reason === "transport" ||
    failure?.reason === "timeout";
  switch (located.hop) {
    case "device":
      return "this-device-cant-reach-t3-connect";
    case "relay":
      return failure?.reason === "authentication"
        ? "sign-in-account-or-link-problems"
        : "this-device-cant-reach-t3-connect";
    case "tunnel":
      return onThisDevice ? "this-device-cant-reach-t3-connect" : "the-hosts-tunnel-is-offline";
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? "sign-in-account-or-link-problems"
        : "the-tunnel-works-but-t3-code-does-not-answer";
  }
}

const HOP_ORDER = {
  relay: ["device", "relay", "tunnel", "server"],
  direct: ["device", "server"],
} as const;

function hopLabel(hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device":
      return "当前设备";
    case "relay":
      return "T3 Connect";
    case "tunnel":
      return `${host} 的连接通道`;
    case "server":
      return `${host} 的服务`;
  }
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  const relayPath =
    located.hop === "relay" ||
    located.hop === "tunnel" ||
    (failure === null && input.relayStatus?.status === "offline") ||
    (failure?.via ?? input.via) === "relay";
  const order: ReadonlyArray<ConnectionHop> = HOP_ORDER[relayPath ? "relay" : "direct"];
  const failedIndex = order.indexOf(located.hop);
  const hops = order.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host),
    result: index < failedIndex ? "ok" : index === failedIndex ? "failed" : "unchecked",
  }));

  // The relay health check only explains the state when no attempt has failed yet.
  const httpStatus = failure !== null ? failure.httpStatus : input.relayStatus?.endpointStatus;
  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("原因", located.cause ?? failure?.reason);
  add("HTTP 状态", httpStatus);
  add("尝试次数", input.state.attempt > 0 ? input.state.attempt : null);
  add(
    "下次重试",
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add("连接方式", relayPath ? "T3 Connect" : "直连");
  add("应用版本", input.clientVersion);
  add("服务版本", input.serverVersion);
  add("原始错误", failure?.detail);
  add("追踪标识", failure?.traceId);

  return {
    headline: headline(host, located, failure),
    hops,
    steps: steps(host, located, failure),
    facts,
    moreInfoUrl: relayPath ? t3ConnectTroubleshootingUrl(helpSection(located, failure)) : null,
  };
}

const HOP_MARK = { ok: "正常", failed: "失败", unchecked: "未检查" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `连接 ${hostLabel}： ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
    ...(diagnosis.moreInfoUrl ? ["", `更多信息：${diagnosis.moreInfoUrl}`] : []),
  ].join("\n");
}
