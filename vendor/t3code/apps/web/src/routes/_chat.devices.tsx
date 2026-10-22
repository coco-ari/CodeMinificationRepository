import { createFileRoute } from "@tanstack/react-router";
import { ProjectId } from "@t3tools/contracts";
import { AutoOpsCustomerDevicesPage } from "../autoops/CustomerDevicesSettings";

export const Route = createFileRoute("/_chat/devices")({
  validateSearch: (search: Record<string, unknown>): { projectId?: ProjectId } => ({
    // This is return-navigation context, never device ownership or a list filter.
    ...(Object.hasOwn(search, "projectId")
      ? { projectId: ProjectId.make(typeof search.projectId === "string" ? search.projectId : "") }
      : {}),
  }),
  component: AutoOpsCustomerDevicesPage,
});
