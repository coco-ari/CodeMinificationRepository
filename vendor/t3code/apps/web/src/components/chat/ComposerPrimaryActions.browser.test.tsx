import "~/index.css";

import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const profile = vi.hoisted(() => ({ lite: false }));
vi.mock("~/autoops/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/autoops/capabilities")>();
  return { ...actual, autoOpsFeature: (feature: Parameters<typeof actual.autoOpsFeature>[0]) =>
    feature === "planMode" && profile.lite ? false : actual.autoOpsFeature(feature) };
});
afterEach(() => { profile.lite = false; });

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { render } from "../../../test/render";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

it("opens implementation actions with a mouse while the composer is resting", async () => {
  const onImplementPlanInNewThread = vi.fn();
  await using _screen = await render(
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning={false}
      canInterrupt={false}
      showPlanFollowUpPrompt
      promptHasText={false}
      isSendBusy={false}
      sendDisabledReason={null}
      isConnecting={false}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={false}
      preserveComposerFocusOnPointerDown
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={onImplementPlanInNewThread}
    />,
  );

  await userEvent.click(page.getByRole("button", { name: "执行计划选项" }));
  const item = page.getByRole("menuitem", { name: "在新对话中执行计划" });
  await expect.element(item).toBeVisible();
  await userEvent.click(item);
  expect(onImplementPlanInNewThread).toHaveBeenCalledTimes(1);
});


it("keeps ordinary sending available when a historic plan is supplied to the lite composer", async () => {
  profile.lite = true;
  const onSubmitMessage = vi.fn((event) => event.preventDefault());
  const onImplementPlanInNewThread = vi.fn();
  await using _screen = await render(
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning={false}
      canInterrupt={false}
      showPlanFollowUpPrompt
      promptHasText
      isSendBusy={false}
      sendDisabledReason={null}
      isConnecting={false}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent
      onSubmitMessage={onSubmitMessage}
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={onImplementPlanInNewThread}
    />,
  );
  await expect.element(page.getByRole("button", {name: "执行计划选项"})).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", {name: "发送消息"})).toBeVisible();
  await userEvent.click(page.getByRole("button", {name: "发送消息"}));
  expect(onSubmitMessage).toHaveBeenCalledTimes(1);
  expect(onImplementPlanInNewThread).not.toHaveBeenCalled();
});
