import { useEffect, useState } from "react";
import { AlertCircleIcon, WifiOffIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { customerRequest } from "./customerAgents";

type Status = {
  online: boolean;
  deviceStatus: string;
  state: "idle" | "active" | "unknown";
  pendingStop: boolean;
};

/** Connection health is separate from the canonical T3 run status. */
export function CustomerExecutionStatus({ threadId }: { threadId: string }) {
  const [result, setResult] = useState<{ threadId: string; value: Status | null }>({
    threadId,
    value: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading || document.hidden || controller.signal.aborted) return;
      reading = true;
      try {
        const value = await customerRequest<Status>(
          `thread-status/${encodeURIComponent(threadId)}`,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) setResult({ threadId, value });
      } catch {
        if (!controller.signal.aborted) setResult({ threadId, value: null });
      }
      reading = false;
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [threadId]);
  const value = result.threadId === threadId ? result.value : null;
  const message = !value
    ? ["状态待确认", "暂时无法确认客户设备状态，现有执行不会因此被视为已结束。"]
    : value.pendingStop
      ? [
          "等待停止确认",
          "停止请求已保留；重连后核实或补发，收到真实结束状态前不会结束本轮。若客户程序异常退出，请在本机检查旧进程并完成恢复。",
        ]
      : value.state === "unknown"
        ? ["结果待核实", "客户执行结果未知；请在本机检查旧进程并完成异常恢复，中心不会自动重做。"]
        : value.deviceStatus !== "active"
          ? ["设备已停用", "此设备不能开始新执行。已有执行仍需等待真实结果或在本机核实。"]
          : !value.online
            ? ["设备离线", "草稿与历史保留。客户本机可能仍在执行，重连后继续同步。"]
            : null;
  if (!message) return null;
  const Icon = value?.state === "unknown" || value?.online ? AlertCircleIcon : WifiOffIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="status"
            tabIndex={0}
            aria-label={message[0]}
            data-composer-context-control
            className="inline-flex h-7 min-w-0 items-center gap-1 px-1.75 text-muted-foreground text-xs sm:h-6"
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{message[0]}</span>
          </span>
        }
      />
      <TooltipPopup>{message[1]}</TooltipPopup>
    </Tooltip>
  );
}
