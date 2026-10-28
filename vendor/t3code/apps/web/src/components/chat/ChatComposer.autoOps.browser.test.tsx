import { createRef, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { prepareHostThreadLaunch } from "@t3tools/client-runtime/host-integration";
import { fakeTimers, render, stubGlobal } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { makeThreadFixture } from "~/test-fixtures";
import { ComposerHandleContext } from "~/composerHandleContext";
import {
  installAutoOpsHost,
  readAutoOpsHost,
  readAutoOpsThreadScope,
  scopeFromAssistant,
  setAutoOpsThreadScope,
} from "~/autoops/hostConfig";
import {
  customerInstanceId,
  customerScopedProviders,
  useCustomerRuntime,
  type CustomerRuntime,
} from "~/autoops/customerAgents";
import { useAutoOpsThreadScope } from "~/autoops/useThreadScope";
import { AutoOpsThreadScopeControl } from "~/autoops/ThreadScopeControl";
import type { AssistantPreset } from "~/autoops/projectAssistants";
import { ChatComposer, type ChatComposerHandle, type ChatComposerProps } from "./ChatComposer";
import { useChatShortcuts } from "./useChatShortcuts";
import { ComposerSurface } from "./ComposerSurface";
import "../../index.css";

const mocks = vi.hoisted(() => ({ createThread: vi.fn() }));
vi.mock(import("~/hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: () => mocks.createThread,
}));
// 原生会话已认证的测试边界；业务授权仍通过真实宿主预约合同。
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
const keybindings = compileResolvedKeybindingsConfig([
  { key: "ctrl+alt+m", command: "modelPicker.toggle" },
  { key: "ctrl+alt+arrowup", command: "composer.increaseEffort" },
  { key: "ctrl+alt+arrowdown", command: "composer.decreaseEffort" },
]);
const noop = () => {};
function setup(id: string, adjust: boolean, customer = false, assistantName = "当前助手") {
  mocks.createThread
    .mockReset()
    .mockResolvedValue({ threadId: `${id}-clean`, draftId: DraftId.make(`${id}-clean`) });
  const target = {
    kind: "customer" as const,
    deviceId: "composer-device",
    registeredWorkspaceId: "composer-directory",
    workspaceBindingRevision: 2,
    runtimeId: "codex" as const,
  };
  const instanceId = customer ? customerInstanceId(target) : ProviderInstanceId.make("codex");
  const preset: AssistantPreset = {
    id: "preset-one",
    projectId: "composer-project",
    name: assistantName,
    description: "",
    instructions: "",
    enabled: true,
    revision: 1,
    createdBy: "admin",
    updatedAt: "now",
    configuration: {
      agentId: "a-project",
      executionBinding: customer ? target : { kind: "platform" },
      environmentId: null,
      workspaceType: customer ? null : "internal",
      visibility: "private",
      model: { instanceId, model: "selected-actual-model", reasoningEffort: "high" },
      skillIds: [],
    },
  };
  const second: AssistantPreset = {
    ...preset,
    id: "preset-two",
    name: "另一个来源",
    configuration: {
      ...preset.configuration,
      executionBinding: { kind: "platform" },
      workspaceType: "external",
      model: { instanceId: "codex", model: "second-actual-model", reasoningEffort: "low" },
    },
  };
  installAutoOpsHost(
    {
      principal: { id: "actual-composer-user", displayName: "真实输入器验收" },
      gatewayBasePath: "/api/agent-demo/t3",
      csrfToken: "composer-csrf",
      fixedModel: { instanceId: "codex", model: "wrong-platform-default" },
      runtimeMode: "approval-required",
      assistantDirectoryEnabled: true,
      customerAgentsEnabled: true,
      capabilities: {},
      projects: [
        {
          id: preset.projectId,
          name: "问答验收项目",
          agents: [{ id: "a-project", name: "项目助手" }],
          environments: [],
          capabilities: {
            "project.manage": adjust,
            "chat.configure": adjust,
            "chat.use": true,
            "workspace.read": true,
            "workspace.manage": false,
            "deployment.read": false,
            "deployment.execute": false,
          },
          membership: {
            role: "reader",
            workspaceAccess: "internal",
            environmentIds: [],
            canAdjustChat: adjust,
          },
          assistants: {
            items: [preset, second].map((preset) => ({ preset, available: true })),
            canAdjust: adjust,
            ready: true,
            defaultAssistantId: preset.id,
          },
        },
      ],
    },
    window.location.origin,
  );
  const environmentId = EnvironmentId.make("composer-native-runtime"),
    threadId = ThreadId.make(id),
    draftId = DraftId.make(id);
  const selected: ModelSelection = {
    instanceId,
    model: preset.configuration.model.model,
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  setAutoOpsThreadScope(id, scopeFromAssistant(preset));
  useComposerDraftStore.getState().clearComposerContent(draftId);
  useComposerDraftStore.getState().setModelSelection(draftId, selected, { replaceOptions: true });
  const models: ServerProvider["models"] = ["selected-actual-model", "surviving-first-model"].map(
    (slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "思考强度",
            type: "select",
            options: [
              { id: "low", label: "低" },
              { id: "high", label: "高" },
            ],
          },
        ],
      },
    }),
  );
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-26T08:00:00Z",
    models,
    skills: [],
    slashCommands: [],
  };
  const sent: Array<ReturnType<ChatComposerHandle["getSendContext"]>> = [],
    bindings: Array<Record<string, unknown>> = [],
    errors: unknown[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path.includes("/skill-library/context"))
      return Response.json({ skills: [], cwd: "/isolated/composer", workspace: null });
    if (path.includes("/skill-library"))
      return Response.json({
        revision: "empty",
        canManage: false,
        skills: [],
        assignments: [],
        projects: [],
        agents: [],
      });
    if (path.endsWith("/thread-bindings") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bindings.push(body);
      return Response.json({ binding: { ...body, scopeState: "draft" } });
    }
    if (path.includes("/thread-bindings/"))
      return Response.json(
        { code: "THREAD_NOT_FOUND", error: "隔离草稿尚未预约" },
        { status: 404 },
      );
    throw new Error(`未处理实际 Composer 测试请求 ${path}`);
  });
  return {
    id,
    environmentId,
    threadId,
    draftId,
    instanceId,
    preset,
    provider,
    selected,
    sent,
    bindings,
    errors,
    fetcher,
    target,
    handle: createRef<ChatComposerHandle>(),
  };
}
type Fixture = ReturnType<typeof setup>;
function Harness({
  fixture: f,
  providers = [f.provider],
  reason = null,
  customerRuntime,
}: {
  fixture: Fixture;
  providers?: ServerProvider[];
  reason?: string | null;
  customerRuntime?: CustomerRuntime | undefined;
}) {
  const promptRef = useRef("");
  const thread = makeThreadFixture({
    environmentId: f.environmentId,
    id: f.threadId,
    projectId: ProjectId.make("composer-project"),
    modelSelection: f.selected,
  });
  const focus = () => f.handle.current?.focusAtEnd();
  useChatShortcuts({
    enabled: true,
    keybindings,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      editableFocus: true,
      composerFocus: true,
      draftThreadRoute: true,
      turnRunning: false,
      composerRequiresModifier: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: f.handle.current?.isModelPickerOpen() ?? false,
    }),
    threadFindActive: false,
    typeIntoComposer: () => false,
    closeThreadFind: noop,
    fallback: () => undefined,
    commands: {
      "modelPicker.toggle": () => f.handle.current?.toggleModelPicker(),
      "composer.increaseEffort": () => f.handle.current?.stepReasoningEffort(1),
      "composer.decreaseEffort": () => f.handle.current?.stepReasoningEffort(-1),
    },
  });
  const props: ChatComposerProps = {
    composerDraftTarget: f.draftId,
    environmentId: f.environmentId,
    canOperateThread: true,
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: true,
    supportsQuestionAttachments: false,
    maxFileAttachmentBytes: 1024 * 1024,
    routeKind: "draft",
    routeThreadRef: scopeThreadRef(f.environmentId, f.threadId),
    draftId: f.draftId,
    multipleModelSelections: null,
    supportsMultipleModels: false,
    onMultipleModelSelectionsChange: noop,
    activeThreadId: f.threadId,
    activeThreadEnvironmentId: f.environmentId,
    activeThread: thread,
    activeThreadShell: thread,
    promptHistoryMessages: [],
    isServerThread: false,
    isLocalDraftThread: true,
    forceExpandedOnMobile: true,
    projectSelectionRequired: false,
    phase: "ready",
    canInterrupt: false,
    isConnecting: false,
    isSendBusy: false,
    canResume: false,
    sendDisabledReason: reason,
    isPreparingWorktree: false,
    isCompacting: false,
    bannerItems: [],
    resumeCompactionTokens: null,
    keepFullHistory: false,
    onToggleKeepFullHistory: noop,
    environmentUnavailable: null,
    activePendingApproval: null,
    pendingApprovals: [],
    pendingUserInputs: [],
    activePendingProgress: null,
    activePendingResolvedAnswers: null,
    activePendingIsResponding: false,
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    activeTasksProgress: null,
    activeTaskSteps: null,
    threadSyncPhase: null,
    runtimeMode: "approval-required",
    interactionMode: "default",
    lockedProvider: null,
    providerStatuses: providers,
    providerCatalogKnown: true,
    activeProjectDefaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "wrong-platform-default",
    },
    activeThreadModelSelection: f.selected,
    activeProjectId: ProjectId.make("composer-project"),
    activeContextWindow: null,
    compactThreadUnavailable: true,
    compactDisabled: true,
    compactDisabledReason: null,
    resolvedTheme: "light",
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings,
    terminalOpen: false,
    gitCwd: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    restingControlsHost: null,
    restingControlsHaveLeadingContext: false,
    onRestingControlsVisibilityChange: noop,
    getTimelineScrollableNode: () => null,
    isTimelineAtLogicalEnd: () => true,
    timelineOverflows: false,
    onComposerOverlayHeightChange: noop,
    onRestingChange: noop,
    promptRef,
    composerImagesRef: useRef([]),
    composerFilesRef: useRef([]),
    composerTerminalContextsRef: useRef([]),
    composerRef: f.handle,
    onPageScrollKeyDown: noop,
    onPageScrollKeyUp: noop,
    onPageScrollRelease: noop,
    editingQueuedAttachments: null,
    onRemoveEditingQueuedAttachment: noop,
    onCompactContext: noop,
    onSend: () => {
      const context = f.handle.current!.getSendContext();
      f.sent.push(context);
      void prepareHostThreadLaunch({
        threadId: f.id,
        projectId: "composer-project",
        modelSelection: context.selectedModelSelection,
      }).catch((cause) => f.errors.push(cause));
    },
    onResume: noop,
    onInterrupt: noop,
    onImplementPlanInNewThread: noop,
    onRespondToApproval: async () => {},
    onSelectActivePendingUserInputOption: noop,
    onAdvanceActivePendingUserInput: noop,
    onDismissActivePendingUserInput: noop,
    onPreviousActivePendingUserInputQuestion: noop,
    onChangeActivePendingUserInputCustomAnswer: noop,
    onProviderModelSelect: (instanceId, model) =>
      useComposerDraftStore
        .getState()
        .setModelSelection(
          f.draftId,
          { instanceId, model },
          { explicit: true, replaceOptions: true },
        ),
    onOpenProviderSetup: noop,
    getModelDisabledReason: () => null,
    toggleInteractionMode: noop,
    handleRuntimeModeChange: noop,
    handleInteractionModeChange: noop,
    focusComposer: focus,
    scheduleComposerFocus: focus,
    setThreadError: noop,
    onExpandImage: noop,
    onFileOpen: noop,
  };
  return (
    <ComposerHandleContext value={f.handle}>
      <div className="mx-auto w-full max-w-2xl p-4">
        <ComposerSurface.Shell contextStrip>
          <ComposerSurface.Host>
            <ChatComposer {...props} />
          </ComposerSurface.Host>
          <AutoOpsThreadScopeControl
            threadId={f.id}
            projectId="composer-project"
            isDraft
            runtimeEnvironmentId={f.environmentId}
            draftTarget={f.draftId}
            submitting={false}
            hasAcceptedMessage={false}
            customerRuntime={customerRuntime}
          />
        </ComposerSurface.Shell>
      </div>
    </ComposerHandleContext>
  );
}
const editor = () => page.getByTestId("composer-editor");

function ConnectedHarness({ fixture }: { fixture: Fixture }) {
  const scope = useAutoOpsThreadScope(fixture.id);
  const runtime = useCustomerRuntime(scope);
  const reason =
    runtime.error ??
    (runtime.loading
      ? "正在读取客户运行器…"
      : !runtime.device?.online
        ? "客户设备离线，草稿保留；恢复连接后再发送。"
        : null);
  return (
    <Harness
      fixture={fixture}
      providers={[...customerScopedProviders([fixture.provider], scope, runtime.catalog)]}
      reason={reason}
      customerRuntime={runtime}
    />
  );
}

it("受限参数在实际输入器可见，/model 与真实快捷键不能调整，点击发送带入原助手模型合同", async () => {
  await page.viewport(1280, 800);
  const f = setup("actual-composer-limited", false);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} />);
  await editor().click();
  await expect
    .element(page.getByLabelText("模型", { exact: true }).first())
    .toHaveTextContent("selected-actual-model");
  await expect
    .element(page.getByLabelText("思考强度", { exact: true }).first())
    .toHaveTextContent("high");
  expect(
    [...screen.container.querySelectorAll<HTMLElement>("[data-autoops-model-readonly]")].some(
      (element) =>
        element.checkVisibility({ visibilityProperty: true }) &&
        element.textContent?.includes("selected-actual-model") &&
        element.textContent.includes("high"),
    ),
  ).toBe(true);
  await userEvent.keyboard("{Control>}{Alt>}m{/Alt}{/Control}");
  await userEvent.keyboard("{Control>}{Alt>}{ArrowDown}{/Alt}{/Control}");
  expect(f.handle.current?.isModelPickerOpen()).toBe(false);
  expect(f.handle.current?.getSendContext().selectedModelSelection).toMatchObject(f.selected);
  await editor().fill("/model");
  await expect.element(page.getByRole("option", { name: /\/model/ })).not.toBeInTheDocument();
  await editor().fill("读取已同步资料");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await vi.waitFor(() => expect(f.bindings).toHaveLength(1));
  expect(f.bindings[0]).toMatchObject({
    question: {
      assistantId: "preset-one",
      configuration: {
        model: { instanceId: "codex", model: "selected-actual-model", reasoningEffort: "high" },
      },
    },
  });
  expect(f.errors).toEqual([]);
  expect(screen.container.textContent).not.toContain("wrong-platform-default");
});

it.each([false, true])(
  "实际 %s 来源模型下线后阻止点击发送，目录恢复才继续原参数",
  async (customer) => {
    await page.viewport(1280, 800);
    const f = setup(`actual-composer-catalog-${customer}`, true, customer);
    using _fetch = stubGlobal("fetch", f.fetcher);
    await using screen = await render(<Harness fixture={f} />);
    await editor().fill("保留草稿");
    await screen.rerender(
      <Harness fixture={f} providers={[{ ...f.provider, models: f.provider.models.slice(1) }]} />,
    );
    expect(f.handle.current?.getSendContext().selectedModelSelection.model).toBe(
      "selected-actual-model",
    );
    expect(f.handle.current?.getSendContext().providerAvailable).toBe(false);
    await expect
      .element(
        page.getByRole("button", {
          name: "所选模型暂不可用，请等待目录恢复或手动选择。",
          exact: true,
        }),
      )
      .toBeDisabled();
    expect(f.sent).toHaveLength(0);
    expect(f.bindings).toHaveLength(0);
    await screen.rerender(<Harness fixture={f} />);
    await expect.element(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await vi.waitFor(() => expect(f.bindings).toHaveLength(1));
    expect(f.sent[0]?.selectedModelSelection).toMatchObject(f.selected);
    expect(f.bindings[0]).toMatchObject({
      executionBinding: f.preset.configuration.executionBinding,
    });
  },
);

it("有调整权者使用实际思考快捷键，点击发送使用改后的值，切换预设再装载原值", async () => {
  await page.viewport(1280, 800);
  const f = setup("actual-composer-adjust", true);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<Harness fixture={f} />);
  await editor().click();
  await userEvent.keyboard("{Control>}{Alt>}{ArrowDown}{/Alt}{/Control}");
  await vi.waitFor(() =>
    expect(f.handle.current?.getSendContext().selectedModelSelection.options).toContainEqual({
      id: "reasoningEffort",
      value: "low",
    }),
  );
  await editor().fill("使用调整后的参数");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await vi.waitFor(() => expect(f.bindings).toHaveLength(1));
  expect(f.bindings[0]).toMatchObject({
    question: {
      configuration: { model: { model: "selected-actual-model", reasoningEffort: "low" } },
    },
  });
  expect(f.preset.configuration.model.reasoningEffort).toBe("high");
  await page.getByRole("button", { name: "助手", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "当前助手", exact: true }).click();
  await vi.waitFor(() =>
    expect(f.handle.current?.getSendContext().selectedModelSelection.options).toContainEqual({
      id: "reasoningEffort",
      value: "high",
    }),
  );
});

it("有调整权者从实际模型菜单显式更换模型，发送只改变本草稿且保持原执行来源", async () => {
  await page.viewport(1280, 800);
  const f = setup("actual-composer-model-menu", true, true);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} />);
  await editor().fill("显式使用另一可用模型");
  const trigger = [
    ...screen.container.querySelectorAll<HTMLElement>('[data-chat-provider-model-picker="true"]'),
  ].find((element) => element.checkVisibility({ visibilityProperty: true }));
  if (!trigger) throw new Error("实际模型菜单入口不可见");
  await page.elementLocator(trigger).click();
  await page.getByRole("option", { name: /surviving-first-model/ }).click();
  await vi.waitFor(() =>
    expect(f.handle.current?.getSendContext().selectedModelSelection.model).toBe(
      "surviving-first-model",
    ),
  );
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await vi.waitFor(() => expect(f.bindings).toHaveLength(1));
  expect(f.bindings[0]).toMatchObject({
    executionBinding: f.preset.configuration.executionBinding,
    question: {
      configuration: {
        model: { instanceId: f.instanceId, model: "surviving-first-model", reasoningEffort: null },
      },
    },
  });
  expect(f.preset.configuration.model.model).toBe("selected-actual-model");
});

it("管理员选择助手后仍可调整范围和可见性，停用助手显示原因且不能选用", async () => {
  const f = setup("actual-composer-scope-menu", true);
  const provider = { ...f.provider, models: [...f.provider.models,
    { ...f.provider.models[0]!, slug: "second-actual-model", name: "另一个模型" }] };
  const host = readAutoOpsHost()!;
  const project = host.projects[0]!;
  installAutoOpsHost({ ...host, projects: [{ ...project, assistants: {
    ...project.assistants!,
    items: [...project.assistants!.items, {
      preset: { ...f.preset, id: "paused-preset", name: "暂停助手", enabled: false },
      available: false,
      reason: { code: "ASSISTANT_DISABLED", message: "助手已停用" },
    }],
  } }] }, window.location.origin);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} providers={[provider]} />);
  await page.getByRole("button", { name: "助手", exact: true }).click();
  await expect.element(page.getByRole("menuitemradio", { name: "暂停助手 · 助手已停用", exact: true }))
    .toHaveAttribute("aria-disabled", "true");
  await page.getByRole("menuitemradio", { name: "另一个来源", exact: true }).click();
  await vi.waitFor(() => expect(readAutoOpsThreadScope(f.id, "composer-project")?.question?.assistantId).toBe("preset-two"));
  const workspace = screen.getByRole("button", { name: "资料范围", exact: true }).element();
  const visibility = screen.getByRole("button", { name: "会话可见范围", exact: true }).element();
  await userEvent.click(workspace);
  await userEvent.click(visibility);
  await expect.poll(() => document.querySelectorAll('[role="menu"]').length).toBe(1);
  await screen.getByRole("button", { name: "技能", exact: true }).click();
  await expect.poll(() => document.querySelectorAll('[role="menu"]').length).toBe(1);
  await userEvent.click(visibility);
  await expect.poll(() => document.querySelectorAll('[role="menu"]').length).toBe(1);
  await page.getByRole("menuitemradio", { name: "项目共享", exact: true }).click();
  await userEvent.click(workspace);
  await page.getByRole("menuitemradio", { name: "内部当前资料", exact: true }).click();
  await vi.waitFor(() => expect(readAutoOpsThreadScope(f.id, "composer-project")).toMatchObject({
    workspaceType: "internal", visibility: "project", question: {
      assistantId: "preset-two", configuration: { workspaceType: "internal", visibility: "project",
        model: { model: "second-actual-model", reasoningEffort: "low" } },
    },
  }));
  expect(project.assistants!.items[1]!.preset.configuration).toMatchObject({workspaceType: "external", visibility: "private"});
  expect(f.bindings).toHaveLength(0);
});

it("紧凑问答栏仍显示当前助手，菜单明确标记已选项并可重新选择", async () => {
  await page.viewport(390, 600);
  const f = setup("actual-composer-current-assistant", true, false,
    "当前已选的项目助手与长名称验收".repeat(4));
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} />);
  const assistant = screen.getByRole("button", { name: "助手", exact: true });
  const label = assistant.element().querySelector<HTMLElement>("[data-composer-label]")!;
  await expect.poll(() => assistant.element().closest("[data-autoops-thread-scope]")?.hasAttribute("data-compact"))
    .toBe(true);
  await expect.poll(() => label.getBoundingClientRect().width).toBeGreaterThan(0);
  await expect.poll(() => getComputedStyle(label.firstElementChild!).opacity).toBe("1");
  const strip = assistant.element().closest<HTMLElement>("[data-autoops-thread-scope]")!;
  for (const control of strip.querySelectorAll<HTMLElement>("[data-composer-context-control]")) {
    expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(strip.getBoundingClientRect().right);
  }
  await assistant.click();
  const selected = page.getByRole("menuitemradio", { name: f.preset.name, exact: true });
  await expect.element(selected).toHaveAttribute("aria-checked", "true");
  expect(selected.element().querySelector("[data-slot=menu-radio-item-indicator]")?.getBoundingClientRect().width ?? 0)
    .toBeGreaterThan(0);
  await selected.click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  expect(readAutoOpsThreadScope(f.id, "composer-project")?.question?.assistantId).toBe(f.preset.id);
  await assistant.click();
  await page.getByRole("menuitemradio", { name: "另一个来源", exact: true }).click();
  await expect.element(assistant).toHaveAttribute("aria-description", "另一个来源");
  await expect.poll(() => label.getBoundingClientRect().width).toBeGreaterThan(0);
  await assistant.click();
  const changed = page.getByRole("menuitemradio", { name: "另一个来源", exact: true });
  await expect.element(changed).toHaveAttribute("aria-checked", "true");
  expect(changed.element().querySelector("[data-slot=menu-radio-item-indicator]")!.getBoundingClientRect().width)
    .toBeGreaterThan(0);
  await userEvent.keyboard("{Escape}");
  await expect.element(editor()).toHaveFocus();
  expect(f.bindings).toHaveLength(0);
});

it("实际输入器已有文本和未上传图片时切换来源新建干净草稿，原附件与选择保留", async () => {
  await page.viewport(1280, 800);
  const f = setup("actual-composer-dirty", true);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} />);
  await editor().fill("原来源的必要输入");
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ),
    (value) => value.charCodeAt(0),
  );
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('实际附件选择控件未呈现');
  await page.elementLocator(input).upload(new File([bytes], "isolated.png", { type: "image/png" }));
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getComposerDraft(f.draftId)?.images).toHaveLength(1),
  );
  const originalImage = useComposerDraftStore.getState().getComposerDraft(f.draftId)!.images[0];
  const originalPrompt = f.handle.current!.getSendContext().prompt;
  expect(originalPrompt).toContain("原来源的必要输入");
  await page.getByRole("button", { name: "助手", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "另一个来源", exact: true }).click();
  await vi.waitFor(() => expect(mocks.createThread).toHaveBeenCalledOnce());
  const clean = useComposerDraftStore.getState().getComposerDraft(DraftId.make(`${f.id}-clean`));
  expect(clean?.prompt ?? "").toBe("");
  expect(clean?.images ?? []).toEqual([]);
  expect(useComposerDraftStore.getState().getComposerDraft(f.draftId)?.images).toEqual([originalImage]);
  expect(readAutoOpsThreadScope(f.id, "composer-project")?.question?.assistantId).toBe(
    "preset-one",
  );
  expect(readAutoOpsThreadScope(`${f.id}-clean`, "composer-project")?.question?.assistantId).toBe(
    "preset-two",
  );
  expect(f.handle.current?.getSendContext().prompt).toBe(originalPrompt);
  await expect.element(editor()).toBeVisible();
  await vi.waitFor(() => expect(editor().element().textContent).toContain("原来源的必要输入"));
});

it("本机离线期间保留原模型及草稿，不选平台或其他本机来源", async () => {
  await page.viewport(1280, 800);
  const f = setup("actual-composer-offline", true, true);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} />);
  await editor().fill("离线后继续保留");
  const other = {
    ...f.provider,
    instanceId: ProviderInstanceId.make("codex"),
    models: [
      {
        slug: "wrong-platform-default",
        name: "wrong-platform-default",
        isCustom: false,
        capabilities: {},
      },
    ],
  };
  await screen.rerender(
    <Harness
      fixture={f}
      reason="客户设备离线，草稿保留；恢复连接后再发送。"
      providers={[{ ...f.provider, status: "error" }, other]}
    />,
  );
  expect(f.handle.current?.getSendContext().selectedModelSelection).toMatchObject(f.selected);
  expect(f.handle.current?.getSendContext().providerAvailable).toBe(false);
  await editor().click();
  await userEvent.keyboard("{Enter}");
  await expect.element(editor()).toHaveTextContent("离线后继续保留");
  expect(f.sent).toHaveLength(0);
  expect(readAutoOpsThreadScope(f.id, "composer-project")?.executionBinding).toEqual(
    f.preset.configuration.executionBinding,
  );
});

it("真实客户能力读取迟到并报告离线后，输入器保留原模型和草稿且不按新首项发送", async () => {
  using _timers = fakeTimers({ shouldAdvanceTime: true });
  await page.viewport(1280, 800);
  const f = setup("actual-composer-late-catalog", true, true);
  const original = f.fetcher.getMockImplementation()!;
  let hold = false,
    online = true;
  const pending: Array<(value: Response) => void> = [];
  const capabilities = {
    ...f.target,
    revision: "live-catalog",
    protocolVersion: 1,
    updatedAt: "2026-10-26T08:00:00Z",
    models: f.provider.models.map((model) => ({
      id: model.slug,
      supportedReasoningEfforts: ["low", "high"],
    })),
    skills: [],
  };
  f.fetcher.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith("/customer/assistant-runtime"))
      return hold
        ? await new Promise<Response>((resolve) => pending.push(resolve))
        : Response.json({
            target: f.target, profile: "self", available: true, capabilities,
            workspace: { label: "隔离目录", status: "active" },
            device: { id: f.target.deviceId, label: "隔离本机", status: "active", online },
          });
    return await original(input, init);
  });
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using _screen = await render(<ConnectedHarness fixture={f} />);
  await editor().fill("迟到读取不能搬动此草稿");
  await expect.element(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  hold = true;
  online = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  expect(f.handle.current?.getSendContext().selectedModelSelection).toMatchObject(f.selected);
  pending[0]!(
    Response.json({
      target: f.target, profile: "self", available: false,
      reason: { code: "CUSTOMER_DEVICE_OFFLINE", message: "客户设备离线，草稿保留；恢复连接后再发送。" },
      capabilities: { ...capabilities, models: capabilities.models.slice(1) },
      workspace: { label: "隔离目录", status: "active" },
      device: { id: f.target.deviceId, label: "隔离本机", status: "active", online },
    }),
  );
  await expect
    .element(
      page.getByRole("button", { name: "客户设备离线，草稿保留；恢复连接后再发送。", exact: true }),
    )
    .toBeDisabled();
  expect(f.handle.current?.getSendContext().selectedModelSelection).toMatchObject(f.selected);
  expect(f.handle.current?.getSendContext().providerAvailable).toBe(false);
  await expect.element(editor()).toHaveTextContent("迟到读取不能搬动此草稿");
  expect(f.sent).toHaveLength(0);
  expect(f.bindings).toHaveLength(0);
});

it.each([{ width: 1280, dark: false }, { width: 390, dark: true }])("$width px 实际输入器名称更新不移动相邻范围或模型控件", async ({ width, dark }) => {
  await page.viewport(width, 600);
  document.documentElement.classList.toggle("dark", dark);
  const f = setup(`stable-composer-${width}`, true);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} />);
  await expect.element(editor()).toBeVisible();
  await editor().fill("保留当前草稿");
  const assistant = screen.getByRole("button", { name: "助手", exact: true });
  const controls = () => [...screen.container.querySelectorAll<HTMLElement>('[data-composer-context-control]')]
    .filter((element) => element.checkVisibility({ visibilityProperty: true }))
    .map((element) => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width }; });
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  await expect.poll(() => screen.container.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length).toBe(0);
  const before = controls();
  const host = readAutoOpsHost()!;
  const longName = "助手名称很长仍然不应该挤动其他控件";
  installAutoOpsHost({ ...host, projects: host.projects.map((project) => project.assistants ? ({ ...project,
    assistants: { ...project.assistants, items: project.assistants.items.map((item) => ({ ...item,
      preset: { ...item.preset, name: item.preset.id === f.preset.id ? longName : item.preset.name },
    })) },
  }) : project) }, window.location.origin);
  await expect.element(assistant).toHaveAttribute("aria-description", longName);
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  await expect.poll(() => screen.container.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length).toBe(0);
  expect(controls()).toEqual(before);
  await expect.element(editor()).toHaveTextContent("保留当前草稿");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  document.documentElement.classList.toggle("dark", dark);
  await page.screenshot({ path: `../../.test-artifacts/adaptive-navigation/composer-${width}.png` });
  document.documentElement.classList.remove("dark");
});


it.each([1280, 390])("无助手的长提示独占反馈行，不挤动范围控件，宽度 %s", async (width) => {
  await page.viewport(width, 780);
  const f = setup(`empty-assistants-${width}`, true);
  const host = readAutoOpsHost()!;
  const reason = "尚无可用助手，请在项目管理中配置";
  installAutoOpsHost(
    {
      ...host,
      projects: host.projects.map((project) => ({
        ...project,
        assistants: {
          items: [],
          defaultAssistantId: null,
          ready: false,
          canAdjust: true,
          reason: { code: "ASSISTANT_REQUIRED", message: reason },
        },
      })),
    },
    window.location.origin,
  );
  const { question: _question, ...scope } = readAutoOpsThreadScope(f.id, "composer-project")!;
  setAutoOpsThreadScope(f.id, scope);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} reason={reason} />);
  await expect.element(screen.getByText(reason, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "刷新助手", exact: true })).toBeVisible();
  await expect
    .poll(() => {
      const strip = screen.container.querySelector<HTMLElement>("[data-autoops-thread-scope]")!;
      const feedback = strip.querySelector<HTMLElement>('[role="status"]')!.getBoundingClientRect();
      const controls = [...strip.querySelectorAll<HTMLElement>("button[aria-label]")].map((e) =>
        e.getBoundingClientRect(),
      );
      return Math.max(...controls.map((r) => r.bottom)) <= feedback.top;
    })
    .toBe(true);
  if (width === 1280) {
    const controls = [
      ...screen.container.querySelectorAll<HTMLElement>(
        "[data-autoops-thread-scope] button[aria-label]",
      ),
    ];
    await expect.poll(() => new Set(controls.map((e) => Math.round(e.getBoundingClientRect().top))).size).toBe(1);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await editor().fill("连接恢复前保留草稿");
  await expect.element(editor()).toHaveTextContent("连接恢复前保留草稿");
});
