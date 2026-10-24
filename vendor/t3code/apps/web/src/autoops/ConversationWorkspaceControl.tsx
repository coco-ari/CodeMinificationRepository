import { useEffect, useState } from "react";
import { ScopeReadError } from "./ScopeReadError";
import { autoOpsAreaAvailable } from "./projectNavigation.logic";
import { autoOpsProjectHref } from "./projectNavigation";
import { useNavigate } from "@tanstack/react-router";
import { FolderGit2Icon, LaptopIcon } from "lucide-react";
import { MenuItem } from "~/components/ui/menu";
import { ScopeComposerChoice, availableWorkspaceScopes } from "./scopeSelection";
import {
  customerRequest,
  loadCustomerWorkspaces,
  type CustomerWorkspace,
  type CustomerDevice,
} from "./customerAgents";
import { readAutoOpsHost, type AutoOpsThreadScope } from "./hostConfig";
const localKey = (workspace: CustomerWorkspace) =>
  `customer:${workspace.deviceId}:${workspace.registeredWorkspaceId}`;
export function ConversationWorkspaceControl({
  projectId,
  scope,
  locked,
  disabled,
  onChange,
}: {
  projectId: string;
  scope: AutoOpsThreadScope;
  locked: boolean;
  disabled: boolean;
  onChange: (patch: Partial<AutoOpsThreadScope>) => void;
}) {
  const navigate = useNavigate();
  const host = readAutoOpsHost();
  const canReadPlatform = autoOpsAreaAvailable("workspaces", host, projectId);
  const [loaded, setData] = useState<{
    projectId: string;
    workspaces: CustomerWorkspace[];
    devices: CustomerDevice[];
  } | null>(null);
  const data = loaded?.projectId === projectId ? loaded : null;
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      loadCustomerWorkspaces(projectId, controller.signal),
      customerRequest<{ devices: CustomerDevice[] }>("devices", undefined, controller.signal),
    ]).then(([customer, devices]) => {
      if (controller.signal.aborted) return;
      setData({
        projectId,
        workspaces: customer.status === "fulfilled" ? customer.value.workspaces : [],
        devices: devices.status === "fulfilled" ? devices.value.devices : [],
      });
      const failed = [customer, devices].find((result) => result.status === "rejected");
      setError(failed?.status === "rejected" ? "部分工作区未能加载，请刷新重试" : null);
    });
    return () => controller.abort();
  }, [projectId, attempt, canReadPlatform]);
  const target = scope.executionBinding?.kind === "customer" ? scope.executionBinding : null;
  const currentWorkspace = target
    ? data?.workspaces.find(
        (entry) =>
          entry.deviceId === target.deviceId &&
          entry.registeredWorkspaceId === target.registeredWorkspaceId,
      )
    : undefined;
  const platformOptions = availableWorkspaceScopes(projectId);
  const currentType =
    scope.workspaceType ??
    (host?.projects.find((entry) => entry.id === projectId)?.membership?.workspaceAccess ===
    "external"
      ? "external"
      : "internal");
  const selected = target
    ? `customer:${target.deviceId}:${target.registeredWorkspaceId}`
    : `platform:${currentType}`;
  const currentDevice = target ? data?.devices.find((entry) => entry.id === target.deviceId) : null;
  const summary = target
    ? `${currentDevice?.label ?? "客户电脑"} · ${currentWorkspace?.label ?? "已登记工作区"}`
    : `${currentType === "external" ? "外部脱敏" : "内部原始"} · 当前工作区`;
  const options = [
    ...platformOptions.map((entry) => ({
      value: `platform:${entry.value}`,
      label: `平台 · ${entry.label}`,
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
  const workspaceChoice = (
    <ScopeComposerChoice
      label="对话工作区"
      summary={summary}
      icon={target ? LaptopIcon : FolderGit2Icon}
      value={selected}
      options={options}
      locked={locked}
      disabled={disabled || (!options.length && !data && !error)}
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
        const choice = platformOptions.find((entry) => `platform:${entry.value}` === value);
        if (choice)
          onChange({
            executionBinding: { kind: "platform" },
            workspaceType: choice.value,
            workspaceVersionId: undefined,
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
            <MenuItem
              onClick={() => void navigate({ href: autoOpsProjectHref("workspaces", projectId) })}
            >
              查看平台工作区
            </MenuItem>
          ) : null}
          {readAutoOpsHost()?.customerAgentsEnabled ? (
            <MenuItem
              onClick={() => void navigate({ href: autoOpsProjectHref("devices", projectId) })}
            >
              连接我的电脑…
            </MenuItem>
          ) : null}
          <MenuItem disabled>本机目录由连接程序登记，网页不浏览任意目录</MenuItem>
        </>
      }
    />
  );
  return (
    <>
      {workspaceChoice}
      {locked && error ? (
        <ScopeReadError
          label="工作区读取失败"
          error={error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : null}
    </>
  );
}
