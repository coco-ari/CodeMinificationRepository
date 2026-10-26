import { createFileRoute } from "@tanstack/react-router";
import { AccountManagementPage } from "../autoops/AccountManagementPage";

export const Route = createFileRoute("/_chat/accounts")({
  validateSearch: (search: Record<string, unknown>): { accountView?: "self" | "manage" } =>
    search.accountView === "self" || search.accountView === "manage"
      ? { accountView: search.accountView }
      : {},
  component: AccountManagementPage,
});
