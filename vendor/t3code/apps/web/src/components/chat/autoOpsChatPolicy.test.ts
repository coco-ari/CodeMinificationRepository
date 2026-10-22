import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  host: undefined as undefined | {
    productProfile?: { id: string };
    capabilities: Record<string, boolean>;
  },
}));
vi.mock("~/autoops/hostConfig", () => ({ readAutoOpsHost: () => state.host }));

import { autoOpsFeature } from "~/autoops/capabilities";
import { resolveComposerInteractionMode, shouldShowPlanFollowUpPrompt } from "../ChatView.logic";
import { RunId } from "@t3tools/contracts";
import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  chatSlashCommandAllowed,
  chatSubmissionIntentAllowed,
  unavailableChatSlashCommand,
} from "./autoOpsChatPolicy";

afterEach(() => { state.host = undefined; });
function lite() {
  state.host = {productProfile: {id: "project-assistant-lite-v1"}, capabilities: {}};
}

describe("AutoOps compact chat action boundaries", () => {
  it("preserves native/full actions when the profile is absent", () => {
    for (const host of [undefined, {capabilities: {}}]) {
      state.host = host;
      expect(chatSubmissionIntentAllowed("background")).toBe(true);
      for (const name of ["plan", "default", "usage-limits", "feedback", "compact"])
        expect(chatSlashCommandAllowed(name)).toBe(true);
    }
  });

  it("blocks advanced send without changing the queue/steer shortcut semantics", () => {
    lite();
    expect(chatSubmissionIntentAllowed("background")).toBe(false);
    expect(chatSubmissionIntentAllowed(undefined)).toBe(true);
    expect(chatSubmissionIntentAllowed("foreground")).toBe(true);
    expect(chatSubmissionIntentAllowed("alternate")).toBe(true);
    expect(resolveComposerDispatchMode({running: true, alternateModifier: false, activeTurnDefault: "queue", canSteer: true})).toBe("queue");
    expect(resolveComposerDispatchMode({running: true, alternateModifier: true, activeTurnDefault: "queue", canSteer: true})).toBe("steer");
    expect(resolveComposerDispatchMode({running: true, alternateModifier: true, activeTurnDefault: "queue", canSteer: false})).toBe("queue");
  });

  it("filters unavailable slash actions but keeps manual compact and registered skills", () => {
    lite();
    for (const name of ["plan", "default", "usage-limits", "feedback"])
      expect(chatSlashCommandAllowed(name)).toBe(false);
    for (const name of ["compact", "skill:release-check", "release-check"])
      expect(chatSlashCommandAllowed(name)).toBe(true);
    expect(unavailableChatSlashCommand("  /plan 迁移步骤")).toBe("plan");
    expect(unavailableChatSlashCommand("/USAGE-LIMITS")).toBe("USAGE-LIMITS");
    expect(unavailableChatSlashCommand("请解释 /plan 的含义")).toBeNull();
    expect(unavailableChatSlashCommand("/compact")).toBeNull();
    expect(unavailableChatSlashCommand("/skill:release-check")).toBeNull();
  });

  it("keeps real usage-limit feedback while removing automatic recovery actions", () => {
    lite();
    const onChange = vi.fn();
    const banner = usageLimitRecoveryBannerItem({runId: RunId.make("run-limit"), resetAt: "2099-01-01T00:00:00.000Z", stoppedAt: "2026-10-22T00:00:00.000Z", snoozedUntil: null, recovery: null, onChange});
    expect(banner.title).toBe("已达到用量限制");
    expect(banner.actions).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not inherit a saved Plan mode or actionable historic plan into ordinary sending", () => {
    lite();
    const saved = {interactionMode: "plan" as const, planModeEnabled: true, draft: "继续整理资料"};
    const effective = resolveComposerInteractionMode({
      planModeEnabled: saved.planModeEnabled && autoOpsFeature("planMode"),
      provider: {showInteractionModeToggle: true},
      interactionMode: saved.interactionMode,
    });
    expect(effective).toEqual({enabled: false, interactionMode: "default"});
    expect(shouldShowPlanFollowUpPrompt({pendingUserInputCount: 0, interactionMode: effective.interactionMode, latestTurnSettled: true, hasActionableProposedPlan: true, hasComposerAttachments: false})).toBe(false);
    expect(saved).toEqual({interactionMode: "plan", planModeEnabled: true, draft: "继续整理资料"});
  });
});
