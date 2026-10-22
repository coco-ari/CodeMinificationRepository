import type { ServerEventLoopStall } from "@t3tools/contracts";

export interface HostFreezeNotice {
  readonly title: string;
  readonly description: string;
}

/**
 * Says why a host stopped answering, from the recent stall it reports on
 * connect. Web shows it as a toast, mobile in the environment's connection row.
 */
export function hostFreezeNotice(
  hostLabel: string,
  stall: ServerEventLoopStall | undefined,
): HostFreezeNotice | null {
  if (stall === undefined) return null;
  const { loadAverage, cpuCount } = stall;
  return {
    title: `${hostLabel} 无响应 ${Math.round(stall.durationMs / 1000)} 秒`,
    description:
      loadAverage !== undefined && loadAverage > cpuCount
        ? `CPU 负载过高（${cpuCount} 核，负载 ${Math.round(loadAverage)}）。`
        : `${hostLabel} 上的 T3 Code 繁忙，未能及时响应。`,
  };
}
