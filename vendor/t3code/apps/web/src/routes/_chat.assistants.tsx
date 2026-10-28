import { createFileRoute } from "@tanstack/react-router";
import { ProjectId } from "@t3tools/contracts";
import { AssistantManagementPage } from "../autoops/AssistantManagementPage";

export const Route = createFileRoute("/_chat/assistants")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { projectId?: ProjectId; assistantView?: "project" | "provided"; from?: "projects" } => ({
    ...(Object.hasOwn(search, "projectId")
      ? { projectId: ProjectId.make(typeof search.projectId === "string" ? search.projectId : "") }
      : {}),
    ...(search.assistantView === "project" || search.assistantView === "provided"
      ? { assistantView: search.assistantView }
      : {}),
    ...(search.from === "projects" ? { from: "projects" } : {}),
  }),
  component: AssistantManagementPage,
});
