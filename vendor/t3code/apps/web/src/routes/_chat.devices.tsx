import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProjectId } from "@t3tools/contracts";

export const Route = createFileRoute("/_chat/devices")({
  validateSearch: (search: Record<string, unknown>): { projectId?: ProjectId } => ({
    // This is return-navigation context, never device ownership or a list filter.
    ...(Object.hasOwn(search, "projectId")
      ? { projectId: ProjectId.make(typeof search.projectId === "string" ? search.projectId : "") }
      : {}),
  }),
  beforeLoad: ({ search }) => {
    const project = Object.hasOwn(search, "projectId")
      ? `&projectId=${encodeURIComponent(search.projectId ?? "")}`
      : "";
    throw redirect({ href: `/assistants?assistantView=provided${project}`, replace: true });
  },
});
