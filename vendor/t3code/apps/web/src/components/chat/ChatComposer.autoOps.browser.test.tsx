import { showThreadMenuWithVisibility } from "~/autoops/threadVisibilityMenu";
import { showContextMenuFallback } from "~/contextMenuFallback";
import { SidebarDraftBlock } from "../Sidebar";
import { SidebarProvider } from "../ui/sidebar";
import { createRef, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ContextMenuItem,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { prepareHostThreadLaunch } from "@t3tools/client-runtime/host-integration";
import { fakeTimers, render, stubGlobal } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { makeThreadFixture } from "~/test-fixtures";
import { applyThemeColorPreview, applyThemePalette, getStandardThemeColors } from "~/themePalette";
import { syncBrowserChromeTheme } from "~/hooks/useTheme";
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
vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
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
function setup(id: string, adjust: boolean, customer = false, assistantName = "当前助手", direct = false) {
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
      fixedModel: { instanceId: "codex", model: direct ? "selected-actual-model" : "wrong-platform-default", ...(direct ? { reasoningEffort: "high" as const } : {}) },
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
            items: direct ? [] : [preset, second].map((preset) => ({ preset, available: true })),
            canAdjust: adjust,
            ready: true,
            defaultAssistantId: direct ? null : preset.id,
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
  setAutoOpsThreadScope(id, direct ? readAutoOpsThreadScope(id, preset.projectId)! : scopeFromAssistant(preset));
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
  existing = false,
}: {
  fixture: Fixture;
  providers?: ServerProvider[];
  reason?: string | null;
  customerRuntime?: CustomerRuntime | undefined;
  existing?: boolean;
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
    contextControls: <AutoOpsThreadScopeControl
      threadId={f.id}
      projectId="composer-project"
      isDraft={!existing}
      runtimeEnvironmentId={f.environmentId}
      draftTarget={f.draftId}
      submitting={false}
      hasAcceptedMessage={existing}
      customerRuntime={customerRuntime}
    />,
    composerDraftTarget: f.draftId,
    environmentId: f.environmentId,
    canOperateThread: true,
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: true,
    supportsQuestionAttachments: false,
    maxFileAttachmentBytes: 1024 * 1024,
    routeKind: existing ? "server" : "draft",
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
    isServerThread: existing,
    isLocalDraftThread: !existing,
    forceExpandedOnMobile: !existing,
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
    resolvedTheme: existing ? "dark" : "light",
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
    timelineOverflows: existing,
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
      <div className="mx-auto w-full max-w-4xl p-4">
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <ChatComposer {...props} />
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </ComposerHandleContext>
  );
}
const editor = () => page.getByTestId("composer-editor");

it.each([1280, 390])("无任何助手时直接配置可发送中文问题，宽度 %s", async (width) => {
  await page.viewport(width, 600);
  const f = setup(`direct-composer-${width}`, true, false, "", true);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} />);
  await expect.element(screen.getByRole("button", { name: "助手预设", exact: true })).toHaveTextContent("助手预设");
  const host = screen.container.querySelector<HTMLElement>('[data-slot="composer-host"]')!;
  const scope = screen.container.querySelector<HTMLElement>('[data-autoops-thread-scope]')!;
  const models = screen.container.querySelector<HTMLElement>('[data-chat-composer-controls="left"]')!;
  const actions = screen.container.querySelector<HTMLElement>('[data-chat-composer-actions="right"]')!;
  expect(host.contains(scope)).toBe(true);
  expect(screen.container.querySelector('[data-slot="composer-context-strip"]')).toBeNull();
  const scopeBounds = scope.getBoundingClientRect(), modelBounds = models.getBoundingClientRect(), actionBounds = actions.getBoundingClientRect();
  expect(scopeBounds.right).toBeLessThanOrEqual(host.getBoundingClientRect().right);
  if (width > 720) expect(Math.abs(scopeBounds.top + scopeBounds.height / 2 - modelBounds.top - modelBounds.height / 2)).toBeLessThan(3);
  else expect(scopeBounds.bottom).toBeLessThanOrEqual(modelBounds.top);
  expect(Math.abs(actionBounds.top + actionBounds.height / 2 - modelBounds.top - modelBounds.height / 2)).toBeLessThan(3);
  expect([...scope.querySelectorAll('[data-composer-context-control]')].map(element => element.getAttribute('aria-label'))).toEqual(['业务环境', '资料范围', '助手预设']);
  await page.screenshot({ path: `__screenshots__/composer-layout-${width}.png` });
  await editor().fill("直接分析当前资料，不使用助手预设");
  await screen.getByRole("button", { name: "发送消息", exact: true }).click();
  await vi.waitFor(() => expect(f.bindings).toHaveLength(1));
  expect(f.bindings[0]).toMatchObject({ question: { assistantId: null, presetRevision: null,
    configuration: { executionBinding: { kind: "platform" }, environmentId: null, workspaceType: "internal",
      model: { instanceId: "codex", model: "selected-actual-model", reasoningEffort: "high" }, skillIds: [] } } });
  expect(f.errors).toEqual([]);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
});

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

it.each([1280, 390])("已有对话在 %s px 折叠和展开时持续显示固定范围，不重复读取或显示发送按钮", async (width) => {
  await page.viewport(width, 600);
  const root = document.documentElement, previousClass = root.className,
    previousStyle = root.getAttribute('style'), previousBodyStyle = document.body.getAttribute('style'), previousTheme = root.dataset.themeId;
  using _theme = { [Symbol.dispose]() {
    applyThemePalette('light'); root.className = previousClass;
    if (previousTheme === undefined) delete root.dataset.themeId; else root.dataset.themeId = previousTheme;
    if (previousStyle === null) root.removeAttribute('style'); else root.setAttribute('style', previousStyle);
    if (previousBodyStyle === null) document.body.removeAttribute('style'); else document.body.setAttribute('style', previousBodyStyle);
  } };
  const f = setup(`existing-composer-layout-${width}`, true);
  const binding = { ...readAutoOpsThreadScope(f.id, 'composer-project')!, threadId: f.id,
    ownerId: readAutoOpsHost()!.principal.id, scopeState: 'locked', scopeLocked: true };
  let reads = 0;
  using _fetch = stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/autoops/thread-bindings/') && init?.method !== 'POST') {
      reads++;
      return Promise.resolve(Response.json({ binding }));
    }
    return f.fetcher(input, init);
  });
  await using screen = await render(<Harness fixture={f} existing />);
  await expect.element(screen.getByLabelText('业务环境', { exact: true })).toHaveTextContent('无环境');
  await expect.element(screen.getByLabelText('助手预设', { exact: true })).toHaveTextContent(f.preset.name);
  applyThemeColorPreview(getStandardThemeColors('dark'), 'dark');
  syncBrowserChromeTheme();
  const visibleActions = () => [...screen.container.querySelectorAll<HTMLElement>('[data-chat-composer-transition-actions]')].filter(element => element.checkVisibility()).length;
  await expect.poll(visibleActions).toBe(1);
  if (width === 390) {
    await screen.getByRole('button', { name: '展开输入框', exact: true }).click();
    await expect.element(editor()).toBeVisible();
    await expect.element(editor()).toHaveFocus();
    await expect.poll(visibleActions).toBe(1);
  }
  expect(reads).toBe(1);
  expect(screen.container.querySelector('[data-slot="composer-host"]')?.contains(screen.container.querySelector('[data-autoops-thread-scope]'))).toBe(true);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await page.screenshot({ path: `__screenshots__/composer-existing-${width}.png` });
});

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
  await page.getByRole("button", { name: "助手预设", exact: true }).click();
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

it("管理员选择助手后仍可调整资料范围，停用助手不出现在候选中", async () => {
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
  await page.getByRole("button", { name: "助手预设", exact: true }).click();
  await expect.element(page.getByRole("menuitemradio", { name: "暂停助手 · 助手已停用", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("menuitemradio", { name: "另一个来源", exact: true }).click();
  await vi.waitFor(() => expect(readAutoOpsThreadScope(f.id, "composer-project")?.question?.assistantId).toBe("preset-two"));
  const workspace = screen.getByRole("button", { name: "资料范围", exact: true }).element();
  await expect.element(screen.getByRole("button", { name: "会话可见范围", exact: true })).not.toBeInTheDocument();
  await userEvent.click(workspace);
  await expect.poll(() => document.querySelectorAll('[role="menu"]').length).toBe(1);
  await screen.getByRole("button", { name: "业务环境", exact: true }).click();
  await expect.poll(() => document.querySelectorAll('[role="menu"]').length).toBe(1);
  await userEvent.click(workspace);
  await page.getByRole("menuitemradio", { name: "内部当前资料", exact: true }).click();
  await vi.waitFor(() => expect(readAutoOpsThreadScope(f.id, "composer-project")).toMatchObject({
    workspaceType: "internal", visibility: "private", question: {
      assistantId: "preset-two", configuration: { workspaceType: "internal", visibility: "private",
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
  const assistant = screen.getByRole("button", { name: "助手预设", exact: true });
  const label = assistant.element().querySelector<HTMLElement>("[data-composer-label]")!;
  expect(assistant.element().closest('[data-chat-composer-context-controls]')).not.toBeNull();
  expect(assistant.element().getAttribute('aria-description')).toBe(f.preset.name);
  await expect.poll(() => label.getBoundingClientRect().width).toBeGreaterThan(0);
  await expect.poll(() => getComputedStyle(label.firstElementChild!).opacity).toBe("1");
  const strip = assistant.element().closest<HTMLElement>("[data-autoops-thread-scope]")!;
  for (const control of strip.querySelectorAll<HTMLElement>("[data-composer-context-control]")) {
    expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(strip.getBoundingClientRect().right);
  }
  await assistant.click();
  const selected = page.getByRole("menuitemradio", { name: f.preset.name, exact: true });
  await expect.element(selected).toHaveAttribute("aria-checked", "true");
  expect(selected.element().querySelector("[data-slot=menu-radio-item-indicator]")).toBeNull();
  expect(getComputedStyle(selected.element()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
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
  expect(changed.element().querySelector("[data-slot=menu-radio-item-indicator]")).toBeNull();
  expect(getComputedStyle(changed.element()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
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
  await page.getByRole("button", { name: "助手预设", exact: true }).click();
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
  const assistant = screen.getByRole("button", { name: "助手预设", exact: true });
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


it.each([1280, 390])("无助手不显示额外提示，刷新归入菜单，宽度 %s", async (width) => {
  await page.viewport(width, 600);
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
  let refreshes = 0;
  using _fetch = stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/autoops/bootstrap")) {
      refreshes++;
      return Response.json(host);
    }
    return f.fetcher(input, init);
  });
  await using screen = await render(<Harness fixture={f} reason={reason} />);
  const assistant = screen.getByRole("button", { name: "助手预设", exact: true });
  await expect.element(assistant).toHaveTextContent("助手预设");
  await expect.element(screen.getByLabelText("会话可见范围", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText(reason, { exact: true })).not.toBeInTheDocument();
  expect(assistant.element().getBoundingClientRect().width).toBeLessThanOrEqual(140);
  await expect.element(screen.getByRole("button", { name: "刷新助手", exact: true })).not.toBeInTheDocument();
  const controls = () => [...screen.container.querySelectorAll<HTMLElement>(
    '[data-autoops-thread-scope] button[aria-label]',
  )];
  await expect.poll(() => new Set(controls().map((e) => Math.round(e.getBoundingClientRect().top))).size).toBe(1);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await editor().fill("刷新后保留这份草稿");
  await assistant.click();
  await expect.element(page.getByRole("menu").getByText(reason, { exact: true })).not.toBeInTheDocument();
  await page.getByRole("menuitem", { name: "刷新助手", exact: true }).click();
  await expect.poll(() => refreshes).toBe(1);
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(editor()).toHaveTextContent("刷新后保留这份草稿");
  await assistant.click();
  await expect.element(page.getByRole("menuitemradio", { name: "当前助手", exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(editor()).toHaveFocus();
});


it("助手候选隐藏停用项，保留启用但离线的真实状态，选中只用背景", async () => {
  const f = setup("composer-hidden-disabled", true);
  const host = readAutoOpsHost()!;
  installAutoOpsHost({ ...host, projects: host.projects.map(project => ({ ...project,
    assistants: { ...project.assistants!, items: [
      project.assistants!.items[0]!,
      { ...project.assistants!.items[1]!, preset: { ...project.assistants!.items[1]!.preset, enabled: false } },
      { preset: { ...f.preset, id: "offline", name: "离线助手" }, available: false,
        reason: { code: "CUSTOMER_DEVICE_OFFLINE", message: "设备离线" } },
    ] },
  })) }, window.location.origin);
  using _fetch = stubGlobal("fetch", f.fetcher);
  await using screen = await render(<Harness fixture={f} />);
  await screen.getByRole("button", { name: "助手预设", exact: true }).click();
  await expect.element(page.getByRole("menuitemradio", { name: "另一个来源", exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitemradio", { name: "离线助手 · 设备离线", exact: true })).toHaveAttribute("aria-disabled", "true");
  const selected = page.getByRole("menuitemradio", { name: "当前助手", exact: true });
  await expect.element(selected).toHaveAttribute("aria-checked", "true");
  expect(selected.element().querySelector("svg")).toBeNull();
  expect(getComputedStyle(selected.element()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await userEvent.keyboard("{Escape}");
});

it("刷新助手失败保留草稿，菜单可再次刷新恢复", async () => {
  const f = setup("composer-refresh-recovery", true);
  const host = readAutoOpsHost()!;
  let requests = 0;
  using _fetch = stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/autoops/bootstrap")) {
      requests++;
      return requests === 1 ? Response.json({ error: "测试读取失败" }, { status: 503 }) : Response.json(host);
    }
    return f.fetcher(input, init);
  });
  await using screen = await render(<Harness fixture={f} />);
  await editor().fill("错误后保留草稿");
  for (let attempt = 1; attempt <= 2; attempt++) {
    await screen.getByRole("button", { name: "助手预设", exact: true }).click();
    await page.getByRole("menuitem", { name: "刷新助手", exact: true }).click();
    await expect.poll(() => requests).toBe(attempt);
    await expect.element(editor()).toHaveTextContent("错误后保留草稿");
  }
  expect(readAutoOpsThreadScope(f.id, "composer-project")?.question?.assistantId).toBe(f.preset.id);
});

it.each(["more", "right-click", "narrow"])("会话 %s 菜单更改草稿可见范围，保留文本和模型且无勾选图标", async (entry) => {
  await page.viewport(entry === "narrow" ? 390 : 1280, 600);
  const f = setup(`visibility-${entry}`, true);
  installAutoOpsHost({ ...readAutoOpsHost()!, productProfile: { id: "project-assistant-lite-v1" } }, window.location.origin);
  useComposerDraftStore.getState().setProjectDraftThreadId(
    scopeProjectRef(f.environmentId, ProjectId.make("composer-project")), f.draftId, { threadId: f.threadId },
  );
  using _fetch = stubGlobal("fetch", f.fetcher);
  const open = () => void showThreadMenuWithVisibility(showContextMenuFallback, [{ id: "discard", label: "丢弃草稿" }],
    { x: entry === "narrow" ? 260 : 20, y: 20 }, { threadId: f.id, projectId: "composer-project", draftId: f.draftId, canOperate: () => true });
  await using screen = await render(<><SidebarProvider><SidebarDraftBlock
    projectByKey={new Map()} projectDisplayNameByKey={new Map()}
    scopedProjectKeys={new Set([`${f.environmentId}:composer-project`])}
    routeDraftId={f.draftId} onNavigateToDraft={noop} onDraftContextMenu={open}
  /></SidebarProvider><Harness fixture={f} /></>);
  await expect.element(screen.getByRole("button", { name: "新对话, 未发送的草稿", exact: true })).toBeVisible();
  await editor().fill("切换可见范围仍然保留");
  const row = screen.getByRole("button", { name: "新对话, 未发送的草稿", exact: true });
  if (entry === "right-click") await row.click({ button: "right" });
  else {
    await row.click();
    await row.getByRole("button", { name: "对话更多操作" }).click();
  }
  await page.getByRole("menuitem", { name: "会话可见范围", exact: true }).click();
  if (entry === "narrow") {
    const parent = page.getByRole("menuitem", { name: "会话可见范围", exact: true }).element().getBoundingClientRect();
    const child = page.getByRole("menuitemradio", { name: "项目共享", exact: true }).element().getBoundingClientRect();
    expect(child.right).toBeLessThan(parent.left);
  }
  const selected = page.getByRole("menuitemradio", { name: "仅自己", exact: true });
  await expect.element(selected).toHaveAttribute("aria-checked", "true");
  expect(selected.element().querySelector("svg")).toBeNull();
  await page.getByRole("menuitemradio", { name: "项目共享", exact: true }).click();
  await expect.poll(() => readAutoOpsThreadScope(f.id, "composer-project")?.visibility).toBe("project");
  expect(readAutoOpsThreadScope(f.id, "composer-project")?.question?.configuration.visibility).toBe("project");
  await expect.element(editor()).toHaveTextContent("切换可见范围仍然保留");
  expect(f.handle.current?.getSendContext().selectedModelSelection).toMatchObject(f.selected);
  expect(f.bindings).toHaveLength(0);
});

it.each(["locked", "permission", "submitting"])("可见范围遵守 %s 限制，菜单打开后也会重核", async (mode) => {
  const f = setup(`visibility-block-${mode}`, mode !== "permission", false);
  useComposerDraftStore.getState().setProjectDraftThreadId(
    scopeProjectRef(f.environmentId, ProjectId.make("composer-project")), f.draftId, { threadId: f.threadId },
  );
  const current = readAutoOpsThreadScope(f.id, "composer-project")!;
  const show = async <T extends string>(items: readonly ContextMenuItem<T>[]): Promise<T | null> => {
    if (mode === "locked" || mode === "submitting") setAutoOpsThreadScope(f.id, { ...current,
      scopeState: mode, scopeLocked: mode === "locked" });
    else expect(items[0]?.children?.every(item => item.disabled)).toBe(true);
    return "visibility:project" as T;
  };
  await showThreadMenuWithVisibility(show, [], { x: 0, y: 0 }, {
    threadId: f.id, projectId: "composer-project", draftId: f.draftId, canOperate: () => true,
  });
  expect(readAutoOpsThreadScope(f.id, "composer-project")?.visibility).toBe("private");
});


it.each(["locked", "submitting", "customer", "restricted"])("已保存会话在 %s 状态可往返调整可见性，保存失败不伪造成功", async (kind) => {
  const state = ["customer", "restricted"].includes(kind) ? "locked" : kind;
  const f = setup(`mutable-visibility-${kind}`, !["customer", "restricted"].includes(kind), kind === "customer");
  let saved = { ...readAutoOpsThreadScope(f.id, "composer-project")!, ownerId: "actual-composer-user",
    scopeState: state as "locked" | "submitting", scopeLocked: state === "locked" };
  const writes: unknown[] = [];
  let reject = false;
  using _fetch = stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith(`/thread-bindings/${f.id}/visibility`)) {
      const body = JSON.parse(String(init?.body));
      writes.push(body);
      if (reject) return Response.json({ code: "THREAD_VISIBILITY_CHANGED", error: "其他页面已修改" }, { status: 409 });
      saved = { ...saved, visibility: body.visibility, ...(saved.question ? { question: { ...saved.question,
        configuration: { ...saved.question.configuration, visibility: body.visibility } } } : {}) };
      return Response.json({ binding: saved });
    }
    if (String(input).endsWith(`/thread-bindings/${f.id}`)) return Response.json({ binding: saved });
    return f.fetcher(input, init);
  });
  const change = async (visibility: "private" | "project") => {
    await showThreadMenuWithVisibility(async <T extends string>(items: readonly ContextMenuItem<T>[]) => {
      expect(items[0]?.children?.every(item => !item.disabled)).toBe(true);
      return `visibility:${visibility}` as T;
    }, [], { x: 20, y: 20 }, { threadId: f.id, projectId: "composer-project", canOperate: () => true });
  };
  await change("project");
  expect(readAutoOpsThreadScope(f.id, "composer-project")?.visibility).toBe("project");
  reject = true;
  await change("private");
  expect(readAutoOpsThreadScope(f.id, "composer-project")?.visibility).toBe("project");
  reject = false;
  await change("private");
  expect(readAutoOpsThreadScope(f.id, "composer-project")?.visibility).toBe("private");
  expect(writes[0]).toEqual({ expectedVisibility: "private", visibility: "project" });
  expect(saved.scopeState).toBe(state);
  expect(saved.question?.configuration.model).toEqual(f.preset.configuration.model);
});
