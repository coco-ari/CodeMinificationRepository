import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { isAutoOpsHosted } from "../../autoops/capabilities";
import { readAutoOpsHost } from "../../autoops/hostConfig";
import {
  autoOpsProjectHref,
  readAutoOpsChatProjectId,
  readAutoOpsProjectId,
  useAutoOpsProjectId,
} from "../../autoops/projectNavigation";
import {
  captureAutoOpsMainLocation,
  resolveAutoOpsSettingsReturnHref,
  type AutoOpsMainLocation,
} from "./mainAppLocation.logic";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/workspaces" ||
    pathname === "/deployments" ||
    pathname === "/pull-requests"
  );
}

let mainAppHref: string | null = null;
let hostedMainLocation: { principalId: string; location: AutoOpsMainLocation | null } | null = null;

export function MainAppLocationTracker() {
  const projectId = useAutoOpsProjectId();
  const href = useLocation({
    select: (location) => (
      isSidebarUtilityPage(location.pathname) &&
      !(isAutoOpsHosted() && (location.pathname === '/workspaces' || location.pathname === '/deployments'))
        ? null : location.href
    ),
  });
  useEffect(() => {
    if (href === null) return;
    mainAppHref = href;
    const host = readAutoOpsHost();
    if (host) hostedMainLocation = {
      principalId: host.principal.id,
      location: captureAutoOpsMainLocation(href, projectId, host.projects),
    };
  }, [href, projectId]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => {
    const host = readAutoOpsHost();
    if (!host) return navigate({ href: mainAppHref ?? "/" });
    const href = resolveAutoOpsSettingsReturnHref({
      location: hostedMainLocation?.principalId === host.principal.id ? hostedMainLocation.location : null,
      projectId: readAutoOpsProjectId(),
      projects: host.projects,
      projectHref: autoOpsProjectHref,
      chatProjectId: readAutoOpsChatProjectId,
    });
    return navigate({ href });
  };
}
