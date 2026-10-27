import { useSyncExternalStore, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { SidebarProvider } from "~/components/ui/sidebar";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { WorkspaceConversationLauncher } from "./WorkspaceConversationLauncher";
import { AutoOpsWorkspacesPage } from "./WorkspacesPage";
import { startWorkspaceConversation, type WorkspaceOverview } from "./workspaces";
import "../index.css";

type Projects = ReturnType<typeof import("../state/entities").readProjects>;
const mocks = vi.hoisted(() => ({
  projects: [] as Projects,
  listeners: new Set<() => void>(),
  create: vi.fn(),
  toast: vi.fn(),
  host: vi.fn(),
  scope: vi.fn(),
  setScope: vi.fn(),
  selectedProjectId: "p-one",
  overview: vi.fn(),
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readProjects: () => mocks.projects,
  useProjects: () =>
    useSyncExternalStore(
      (listener) => {
        mocks.listeners.add(listener);
        return () => {
          mocks.listeners.delete(listener);
        };
      },
      () => mocks.projects,
    ),
}));
vi.mock(import("../hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: () => mocks.create,
  useHandleNewThread: vi.fn(),
}));
vi.mock(import("./hostConfig"), async (original) => ({
  ...(await original()),
  readAutoOpsHost: mocks.host,
  readAutoOpsThreadScope: mocks.scope,
  setAutoOpsThreadScope: mocks.setScope,
}));
vi.mock(import("./projectNavigation"), async (original) => ({
  ...(await original()),
  useAutoOpsProjectId: () =>
    useSyncExternalStore(
      (listener) => {
        mocks.listeners.add(listener);
        return () => {
          mocks.listeners.delete(listener);
        };
      },
      () => mocks.selectedProjectId,
    ),
}));
vi.mock(import("../components/ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { ...(await original()).toastManager, add: mocks.toast },
}));
const overview: WorkspaceOverview = {
  projectId: "p-one",
  internalVersions: [],
  externalVersions: [],
  releases: [],
  tasks: [],
  import: { supported: true, hosts: [], maxBytes: 100, maxFiles: 10 },
};
vi.mock(import("./useWorkspaceOverview"), () => ({
  useWorkspaceOverview: () => ({
    overview: useSyncExternalStore(
      (listener) => {
        mocks.listeners.add(listener);
        return () => {
          mocks.listeners.delete(listener);
        };
      },
      () => mocks.overview(),
    ),
    loadError: null,
    refreshOverview: vi.fn(),
  }),
}));
vi.mock(import("./WorkspaceFileBrowser"), () => ({ WorkspaceFileBrowser: () => <></> }));
vi.mock(import("./WorkspaceAuthoringPanel"), () => ({
  WorkspaceAuthoring: ({
    menuItems,
    navigation,
  }: {
    menuItems?: ReactNode;
    navigation?: ReactNode;
  }) => (
    <>
      {navigation}
      <Menu>
        <MenuTrigger>工作区操作</MenuTrigger>
        <MenuPopup>{menuItems}</MenuPopup>
      </Menu>
    </>
  ),
}));

const project = { id: "p-one", environmentId: "native-one" } as Projects[number];
function setup(ready: boolean) {
  sessionStorage.clear();
  mocks.projects = ready ? [project] : [];
  mocks.selectedProjectId = "p-one";
  mocks.overview.mockReturnValue(overview);
  mocks.listeners.clear();
  mocks.create.mockReset().mockResolvedValue({ draftId: "draft-one", threadId: "thread-one" });
  mocks.toast.mockReset();
  mocks.scope.mockReset();
  mocks.setScope.mockReset();
  mocks.host.mockReturnValue({
    principal: { id: "workspace-owner" },
    projects: ["p-one", "p-two"].map((id) => ({
      id,
      name: id,
      capabilities: { "workspace.read": true },
      membership: { workspaceAccess: "internal" },
    })),
  });
}
function App() {
  return (
    <SidebarProvider>
      <WorkspaceConversationLauncher />
      <AutoOpsWorkspacesPage />
    </SidebarProvider>
  );
}
async function publishProject(next = project) {
  await act(() => {
    mocks.projects = [...mocks.projects, next];
    for (const notify of [...mocks.listeners]) notify();
  });
}

it("冷连接等待当前项目就绪后，原工作区入口单击正常启动", async () => {
  setup(false);
  await using _screen = await render(<App />, { router: "/workspaces?projectId=p-one" });
  await page.getByRole("button", { name: "工作区操作", exact: true }).click();
  const launch = page.getByRole("menuitem", { name: "新建对话", exact: true });
  await expect.element(launch).toBeDisabled();
  expect(mocks.create).not.toHaveBeenCalled();
  await publishProject();
  await expect.element(launch).toBeEnabled();
  expect(mocks.create).not.toHaveBeenCalled();
  await launch.click();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("项目缺失的直接事件明确提示恢复，项目到达不自动重放", async () => {
  setup(false);
  await using _screen = await render(<App />, { router: "/workspaces?projectId=p-one" });
  await act(() => startWorkspaceConversation("p-one", "internal"));
  expect(mocks.toast).toHaveBeenCalledWith({
    type: "error",
    title: "无法新建工作区对话",
    description: "对话服务尚未就绪，请稍后重试。",
  });
  expect(mocks.create).not.toHaveBeenCalled();
  await publishProject();
  expect(mocks.create).not.toHaveBeenCalled();
});

it("未接入工作台时保留原边界，不启动草稿或显示连接错误", async () => {
  setup(true);
  mocks.host.mockReturnValue(undefined);
  await using _screen = await render(<WorkspaceConversationLauncher />);
  await act(() => startWorkspaceConversation("p-one", "internal"));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("项目就绪也不能绕过已撤回的内部工作区读取权", async () => {
  setup(true);
  mocks.host.mockReturnValue({
    principal: { id: "workspace-owner" },
    projects: [{ id: "p-one", capabilities: { "workspace.read": false } }],
  });
  await using _screen = await render(<WorkspaceConversationLauncher />);
  await act(() => startWorkspaceConversation("p-one", "internal"));
  await vi.waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith({
      type: "error",
      title: "无法新建工作区对话",
      description: "当前项目没有此工作区读取权限。",
    }),
  );
  expect(mocks.create).not.toHaveBeenCalled();
});

it("切换项目不能借用另一项目的对话就绪状态", async () => {
  setup(true);
  await using _screen = await render(<App />, { router: "/workspaces?projectId=p-one" });
  await act(() => {
    mocks.selectedProjectId = "p-two";
    for (const notify of [...mocks.listeners]) notify();
  });
  await page.getByRole("button", { name: "工作区操作", exact: true }).click();
  const launch = page.getByRole("menuitem", { name: "新建对话", exact: true });
  await expect.element(launch).toBeDisabled();
  await publishProject({ ...project, id: "p-two" } as Projects[number]);
  await expect.element(launch).toBeEnabled();
  await launch.click();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.create).toHaveBeenCalledWith(
    { environmentId: "native-one", projectId: "p-two" },
    { envMode: "local", forceNew: true },
  );
});

it("外部对话同时保留已发布资料与当前项目就绪两个条件", async () => {
  setup(true);
  await using _screen = await render(<App />, { router: "/workspaces?projectId=p-one" });
  await page.getByRole("radio", { name: "外部工作区", exact: true }).click();
  const launch = page.getByRole("button", { name: "新建对话", exact: true });
  await expect.element(launch).toBeDisabled();
  await act(() => {
    mocks.overview.mockReturnValue({
      ...overview,
      externalVersions: [
        {
          id: "external-one",
          name: "已发布外部资料",
          type: "external",
          status: "published",
          createdAt: "2026-10-28T00:00:00Z",
          fileCount: 0,
          byteLength: 0,
          source: { repositories: [], contentHash: "isolated-external" },
        },
      ],
    });
    for (const notify of [...mocks.listeners]) notify();
  });
  await expect.element(launch).toBeEnabled();
  await act(() => {
    mocks.projects = [];
    for (const notify of [...mocks.listeners]) notify();
  });
  await expect.element(launch).toBeDisabled();
  expect(mocks.create).not.toHaveBeenCalled();
});

it("已有原生项目时真实工作区入口正常启动一次原T3新草稿", async () => {
  setup(true);
  await using _screen = await render(<App />, { router: "/workspaces?projectId=p-one" });
  await page.getByRole("button", { name: "工作区操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建对话", exact: true }).click();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.create).toHaveBeenCalledWith(
    { environmentId: "native-one", projectId: "p-one" },
    { envMode: "local", forceNew: true },
  );
  expect(mocks.toast).not.toHaveBeenCalled();
});
