import { RefreshIcon } from "~/components/ui/refresh-icon";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, Navigate, useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  readProject,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { isAutoOpsHosted } from "../autoops/capabilities";
import { useAutoOpsHost } from "../autoops/hostConfig";
import { useAutoOpsProjectId } from "../autoops/projectNavigation";

function ChatIndexRouteView() {
  const host = useAutoOpsHost();
  const search = useLocation({ select: (location) => location.search });
  const selectedProjectId = useAutoOpsProjectId();
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  // 已认证的空项目目录进入配置引导；显式项目深链仍由原范围校验处理。
  if (
    authGateState.status === "authenticated" &&
    host?.projects.length === 0 &&
    !Object.hasOwn(search, "projectId")
  ) {
    return <Navigate to="/projects" replace />;
  }

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <IndexDraftLanding key={isAutoOpsHosted() ? selectedProjectId : 'upstream'} />;
}

function IndexDraftLanding() {
  const autoOpsProjectId = useAutoOpsProjectId();
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const router = useRouter();
  // Read at effect time: this page stays mounted while a navigation away from
  // "/" is still loading, but the router already points at the new location.
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const startedAttemptRef = useRef<number | null>(null);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject =
    sortScopedProjectsForSidebar(isAutoOpsHosted() ? projects.filter((project) => project.id === autoOpsProjectId) : projects, threads, "updated_at")[0] ?? null;
  const attempt = startState.retryRequest;

  useEffect(() => {
    // Starting a draft after the user has left would replace the page they picked.
    if (mostRecentProject === null || startedAttemptRef.current === attempt || !isStillOnIndex()) {
      return;
    }
    const projectRef = scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id);
    if (readProject(projectRef) === null) {
      return;
    }
    startedAttemptRef.current = attempt;
    void handleNewThread(projectRef, { replace: true })
      .then((opened) => {
        if (opened === null) {
          setStartState((state) => ({ ...state, retryRequest: state.retryRequest + 1 }));
        }
      })
      .catch(() => {
        setStartState((state) => ({ ...state, failed: true }));
      });
  }, [attempt, handleNewThread, mostRecentProject]);

  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // A pending environment cannot prove the workspace is empty.
  if (isAutoOpsHosted() && !autoOpsProjectId) return <SidebarInset className="h-dvh min-h-0 overflow-hidden"><WorkspacePageHeader><h1 className="text-sm font-medium">问答</h1></WorkspacePageHeader><Empty data-testid="project-unavailable"><EmptyHeader><EmptyTitle>项目不可用或无权访问</EmptyTitle></EmptyHeader></Empty></SidebarInset>;
  return bootstrapped ? <NoProjectsHero /> : null;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>无法开始新对话</EmptyTitle>
          <EmptyDescription>
            项目仍可用，请尝试重新打开草稿。
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              重试
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
