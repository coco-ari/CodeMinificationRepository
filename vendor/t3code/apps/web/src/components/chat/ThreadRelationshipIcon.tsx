import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { BotIcon, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function threadRelationshipStatusLabel(status: string | null): string {
  switch (status) {
    case "preparing":
    case "starting":
      return "正在启动";
    case "running":
    case "in_progress":
      return "执行中";
    case "pending":
    case "queued":
      return "已排队";
    case "waiting":
    case "blocked":
      return "等待中";
    case "completed":
      return "已完成";
    case "failed":
    case "error":
      return "失败";
    case "cancelled":
    case "interrupted":
      return "已停止";
    case "rolled_back":
      return "已回退";
    case "resolved_native":
      return "已解决（原生）";
    case "resolved_portable":
      return "已解决（可移植）";
    case "consumed":
      return "已使用";
    case "superseded":
      return "已替代";
    case "idle":
      return "空闲";
    default:
      return "未知";
  }
}

export function ThreadRelationshipIcon({
  driver,
  provider,
  status,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  status: string | null;
  fallbackIcon?: LucideIcon;
}) {
  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}
          acpRegistryIconUrl={provider?.iconUrl}
          iconClassName={iconClassName}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={iconClassName} />
      )}
      <span
        className={cn(
          "absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-card",
          status === "running" ||
            status === "in_progress" ||
            status === "pending" ||
            status === "waiting"
            ? "bg-info"
            : status === "failed" || status === "error"
              ? "bg-destructive"
              : status === "completed"
                ? "bg-success"
                : "bg-muted-foreground/45",
        )}
        aria-hidden="true"
      />
    </span>
  );
}
