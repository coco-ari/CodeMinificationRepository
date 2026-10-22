import { autoOpsFeature } from "~/autoops/capabilities";
import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: "已达到用量限制",
    description: resetAt
      ? `重置于 ${new Date(resetAt).toLocaleString()}`
      : "重置时间未知，请手动重试",
    actions: autoOpsFeature("automaticRecovery") && canSchedule ? <RecoveryActions key={`${runId}:${resetAt}`} {...props} /> : null,
  };
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const [pending, setPending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = Date.parse(resetAt ?? "") - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (!autoOpsFeature("automaticRecovery") || resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: "无法暂时搁置对话",
        description: "重置时间已过，请手动重试对话。",
      });
      setNowMs(Date.now());
      return;
    }
    setPending(true);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "resume" ? "无法更改自动恢复设置" : "无法暂时搁置对话",
        description: cause instanceof Error ? cause.message : "发生错误。",
      });
    }
    setPending(false);
  }
  // Failures go to a toast: the actions column is auto-sized, so inline error
  // text would widen it and crush the title.
  return (
    <>
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? "正在保存…" : scheduled ? "取消自动恢复" : "额度重置时恢复"}
      </Button>
      {!snoozed ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || Date.parse(resetAt!) <= nowMs}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "正在保存…" : "暂时搁置至额度重置"}
        </Button>
      ) : null}
    </>
  );
}
