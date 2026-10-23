import { useEffect, useState } from "react";
import { autoOpsAreaAvailable } from "./projectNavigation.logic";
import { autoOpsProjectHref } from "./projectNavigation";
import { useNavigate } from "@tanstack/react-router";
import { FolderGit2Icon, LaptopIcon } from "lucide-react";
import { MenuItem } from "~/components/ui/menu";
import { ScopeComposerChoice, availableWorkspaceVersions } from "./scopeSelection";
import { loadWorkspaces, type WorkspaceVersion } from "./workspaces";
import {
  customerRequest,
  loadCustomerWorkspaces,
  type CustomerWorkspace,
  type CustomerDevice,
} from "./customerAgents";
import { readAutoOpsThreadScope, readAutoOpsHost, type AutoOpsThreadScope } from "./hostConfig";
const localKey = (workspace: CustomerWorkspace) =>
  `customer:${workspace.deviceId}:${workspace.registeredWorkspaceId}`;
export function ConversationWorkspaceControl({
  threadId,
  projectId,
  scope,
  locked,
  disabled,
  onChange,
  onInitialize,
}: {
  threadId: string;
  projectId: string;
  scope: AutoOpsThreadScope;
  locked: boolean;
  disabled: boolean;
  onChange: (patch: Partial<AutoOpsThreadScope>) => void;
  onInitialize: (scope: AutoOpsThreadScope) => void;
}) {
  const navigate = useNavigate();
  const host = readAutoOpsHost();
  const canReadPlatform = autoOpsAreaAvailable("workspaces", host, projectId);
  const [loaded, setData] = useState<{
    projectId: string;
    versions: WorkspaceVersion[];
    workspaces: CustomerWorkspace[];
    devices: CustomerDevice[];
  } | null>(null);
  const data = loaded?.projectId === projectId ? loaded : null;
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      canReadPlatform ? loadWorkspaces(projectId, controller.signal) : Promise.resolve(null),
      loadCustomerWorkspaces(projectId, controller.signal),
      customerRequest<{ devices: CustomerDevice[] }>("devices", undefined, controller.signal),
    ]).then(([platform, customer, devices]) => {
      if (controller.signal.aborted) return;
      setData({
        projectId,
        versions:
          platform.status === "fulfilled" && platform.value
            ? availableWorkspaceVersions(projectId, platform.value)
            : [],
        workspaces: customer.status === "fulfilled" ? customer.value.workspaces : [],
        devices: devices.status === "fulfilled" ? devices.value.devices : [],
      });
      const failed = [platform, customer, devices].find((result) => result.status === "rejected");
      setError(failed?.status === "rejected" ? "部分工作区未能加载，请刷新重试" : null);
    });
    return () => controller.abort();
  }, [projectId, attempt, canReadPlatform]);
  useEffect(() => {
    if (locked || disabled || !data) return;
    const current = readAutoOpsThreadScope(threadId, projectId);
    if (!current || current.executionBinding?.kind === "customer" || current.workspaceVersionId)
      return;
    const initial = data.versions.find(
      (entry) => entry.type === (current.workspaceType ?? "internal"),
    );
    if (initial)
      onInitialize({ ...current, workspaceType: initial.type, workspaceVersionId: initial.id });
  }, [data, error, threadId, projectId, locked, disabled, onInitialize]);
  const target = scope.executionBinding?.kind === "customer" ? scope.executionBinding : null;
  const currentWorkspace = target
    ? data?.workspaces.find(
        (entry) =>
          entry.deviceId === target.deviceId &&
          entry.registeredWorkspaceId === target.registeredWorkspaceId,
      )
    : undefined;
  const currentVersion = data?.versions.find((entry) => entry.id === scope.workspaceVersionId);
  const selected = target
    ? `customer:${target.deviceId}:${target.registeredWorkspaceId}`
    : `platform:${scope.workspaceVersionId ?? ""}`;
  const currentDevice = target ? data?.devices.find((entry) => entry.id === target.deviceId) : null;
  const summary = target
    ? `${currentDevice?.label ?? "客户电脑"} · ${currentWorkspace?.label ?? "已登记工作区"}`
    : currentVersion
      ? `${currentVersion.type === "internal" ? "内部" : "外部"} · ${currentVersion.name}`
      : "选择工作区";
  const options = [
    ...(data?.versions ?? []).map((entry) => ({
      value: `platform:${entry.id}`,
      label: `平台 · ${entry.type === "internal" ? "内部原始" : "外部脱敏"} · ${entry.name}`,
    })),
    ...(data?.workspaces ?? [])
      .filter(
        (entry) =>
          entry.status === "active" &&
          data?.devices.some(
            (device) => device.id === entry.deviceId && device.status === "active",
          ),
      )
      .map((entry) => {
        const device = data?.devices.find((item) => item.id === entry.deviceId);
        return {
          value: localKey(entry),
          label: `${device?.label ?? "客户设备"} · ${entry.label}${device?.online ? "" : "（离线）"}`,
        };
      }),
  ];
  return (
    <ScopeComposerChoice
      label="对话工作区"
      summary={summary}
      icon={target ? LaptopIcon : FolderGit2Icon}
      value={selected}
      options={options}
      locked={locked}
      disabled={disabled || (!data && !error)}
      onChange={(value) => {
        const workspace = data?.workspaces.find((entry) => localKey(entry) === value);
        if (workspace) {
          onChange({
            executionBinding: {
              kind: "customer",
              deviceId: workspace.deviceId,
              registeredWorkspaceId: workspace.registeredWorkspaceId,
              workspaceBindingRevision: workspace.workspaceBindingRevision,
              runtimeId: workspace.runtimeId,
            },
            workspaceType: undefined,
            workspaceVersionId: undefined,
            visibility: "private",
            agentId: "a-project",
          });
          return;
        }
        const version = data?.versions.find((entry) => `platform:${entry.id}` === value);
        if (version)
          onChange({
            executionBinding: { kind: "platform" },
            workspaceType: version.type,
            workspaceVersionId: version.id,
          });
      }}
      footer={
        <>
          {!options.length ? <MenuItem disabled>暂无可用工作区</MenuItem> : null}
          {error ? (
            <MenuItem onClick={() => setAttempt((value) => value + 1)}>读取失败，点击重试</MenuItem>
          ) : null}
          <MenuItem onClick={() => setAttempt((value) => value + 1)}>刷新已登记工作区</MenuItem>
          {canReadPlatform ? (
            <MenuItem onClick={() => void navigate({ href: autoOpsProjectHref("workspaces", projectId) })}>查看平台工作区</MenuItem>
          ) : null}
          {readAutoOpsHost()?.customerAgentsEnabled ? (
            <MenuItem onClick={() => void navigate({ href: autoOpsProjectHref("devices", projectId) })}>
              连接我的电脑…
            </MenuItem>
          ) : null}
          <MenuItem disabled>本机目录由连接程序登记，网页不浏览任意目录</MenuItem>
        </>
      }
    />
  );
}
