import {
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  hasCompleteProviderWorkspaceSnapshot,
  hasCurrentProviderWorkspaceSnapshot,
} from "@t3tools/client-runtime/providerSkills";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const RETRY_DELAY_MS = 10_000;
const REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_ERROR = "skill加载失败，请重试。";

/** 复用原生目录刷新；缺失目录也会重试，并限制本次等待的总时间。 */
export function useProviderWorkspaceSnapshotRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly selectedProviderStatus: ServerProvider | null;
}) {
  const { environmentId, gitCwd, instanceId, selectedProviderStatus } = input;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const key = gitCwd && instanceId ? JSON.stringify([environmentId, instanceId, gitCwd]) : null;
  const complete = hasCompleteProviderWorkspaceSnapshot(selectedProviderStatus, gitCwd);
  const [state, setState] = useState<{
    key: string;
    phase: "loading" | "ready" | "error";
  } | null>(null);
  const lastSuccess = useRef<{ key: string; at: number } | null>(null);
  const active = useRef<{ key: string; dispose: () => void } | null>(null);

  const refresh = useStableCallback((fresh: boolean = false) => {
    if (!key || !gitCwd || !instanceId || active.current?.key === key) return;
    if (!fresh) {
      if (state?.key === key && state.phase === "error") return;
      if (hasCurrentProviderWorkspaceSnapshot(selectedProviderStatus, gitCwd, Date.now())) return;
      const last = lastSuccess.current;
      // 使用本地请求完成时间，避免客户端时钟领先服务器时反复扫描。
      if (last?.key === key && Date.now() - last.at < PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS) return;
    }
    active.current?.dispose();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const request = {
      key,
      dispose: () => {
        clearTimeout(deadline);
        clearTimeout(retryTimer);
        if (active.current === request) active.current = null;
      },
    };
    const finish = (phase: "ready" | "error") => {
      if (active.current !== request) return;
      request.dispose();
      if (phase === "ready") lastSuccess.current = { key, at: Date.now() };
      setState({ key, phase });
    };
    // 目录读取由共享 RPC 管理；到期结束界面等待，迟到结果不得恢复旧范围。
    const deadline = setTimeout(() => finish("error"), REFRESH_TIMEOUT_MS);
    active.current = request;
    setState({ key, phase: "loading" });
    const retryLater = () => {
      if (active.current !== request) return;
      retryTimer = setTimeout(() => scan(false), RETRY_DELAY_MS);
    };
    const scan = (force: boolean) => {
      if (active.current !== request) return;
      void refreshProviders({
        environmentId,
        input: { instanceId, cwd: gitCwd, ...(force ? { fresh: true } : {}) },
      }).then((result) => {
        if (active.current !== request) return;
        const provider =
          result._tag === "Success"
            ? result.value.providers.find((value) => value.instanceId === instanceId)
            : null;
        if (hasCompleteProviderWorkspaceSnapshot(provider, gitCwd)) finish("ready");
        else retryLater();
      }, retryLater);
    };
    scan(fresh);
  });

  const reset = useStableCallback(() => {
    active.current?.dispose();
    lastSuccess.current = null;
    setState(null);
    // 旧范围的错误不能阻止新范围读取，也不能阻止服务器丢弃目录后的恢复。
    refresh(true);
  });

  useEffect(() => {
    lastSuccess.current = null;
    setState(null);
    refresh();
    return () => active.current?.dispose();
  }, [key, refresh]);

  const previous = useRef({ key, complete });
  useEffect(() => {
    const lost = previous.current.key === key && previous.current.complete && !complete;
    const arrived = previous.current.key === key && !previous.current.complete && complete;
    previous.current = { key, complete };
    if (lost && active.current?.key !== key) reset();
    else if (key && arrived && active.current?.key === key) {
      active.current.dispose();
      lastSuccess.current = { key, at: Date.now() };
      setState({ key, phase: "ready" });
    } else if (key && arrived) {
      setState((current) =>
        current?.key === key && current.phase === "error" ? { key, phase: "ready" } : current,
      );
    }
  }, [key, complete, reset]);

  const retry = useStableCallback(() => refresh(true));
  const reconnect = useStableCallback(() => {
    if (state?.key === key && state.phase === "error") retry();
    else refresh();
  });
  useEffect(() => {
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [reconnect]);

  return {
    refreshIfStale: refresh,
    retry,
    isRefreshing: key !== null && (state?.key === key ? state.phase === "loading" : !complete),
    error: state?.key === key && state.phase === "error" ? REFRESH_ERROR : null,
  };
}
