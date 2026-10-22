import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { isAutoOpsHosted } from "../../autoops/capabilities";

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

export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (
      isSidebarUtilityPage(location.pathname) &&
      !(isAutoOpsHosted() && (location.pathname === '/workspaces' || location.pathname === '/deployments'))
        ? null : location.href
    ),
  });
  useEffect(() => {
    if (href !== null) mainAppHref = href;
  }, [href]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}
