import { useDelayedStatus } from "../../hooks/useDelayedStatus";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

import { Spinner } from "~/components/ui/spinner";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export function useComposerSyncPhase(
  key: string,
  phase: ThreadSyncPhase | null,
  banners: readonly ComposerBannerStackItem[],
  environmentUnavailable: boolean,
) {
  const connectionActive = environmentUnavailable || banners.some((item) => item.replacesSync);
  // 连接状态接管时立即收起同步条，并清除最短显示计时，恢复后不闪回旧状态。
  const shown = useDelayedStatus(
    `${connectionActive ? "connection" : "sync"}:${key}`,
    connectionActive ? null : phase,
  );
  return connectionActive ? null : shown;
}

export function ComposerActivityRow({ phase }: { readonly phase: ThreadSyncPhase }) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        <Spinner />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span
          className="shrink-0 whitespace-nowrap text-muted-foreground"
          data-composer-sync-status={phase}
          role="status"
        >
          {threadSyncLabel(phase)}
        </span>
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}
