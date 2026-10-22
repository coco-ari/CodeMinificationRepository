import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProjectService from "../project/ProjectService.ts";
import { configuredAutoOpsProjects, isAutoOpsEnabled } from "../../../../../../agent-demo/t3-adapters/access.mjs";

/** Core ProjectService owns project creation/events; AutoOps fixes the permitted roots. */
export const initializeProjects = Effect.gen(function* () {
  if (!isAutoOpsEnabled()) return;
  const projects = yield* ProjectService.ProjectService;
  const path = yield* Path.Path;
  const dataDir = process.env.AUTOOPS_T3_DATA_DIR;
  const model = process.env.AUTOOPS_T3_MODEL || process.env.AGENT_DEMO_MODEL;
  if (!dataDir?.trim() || !model?.trim()) return yield* Effect.die(new Error("AutoOps data directory and fixed model must be configured."));
  for (const project of configuredAutoOpsProjects()) {
    const projectId = ProjectId.make(project.id);
    const workspaceRoot = path.resolve(dataDir, "t3", "workspaces", project.id);
    const current = yield* projects.getById(projectId, { includeDeleted: true });
    if (Option.isSome(current)) {
      if (current.value.deletedAt !== null || current.value.workspaceRoot !== workspaceRoot)
        return yield* Effect.die(new Error(`AutoOps project ${project.id} conflicts with its registered workspace.`));
    } else {
      yield* projects.create({
        commandId: CommandId.make(`autoops:project:create:${project.id}:v1`), projectId,
        title: project.name, workspaceRoot, createWorkspaceRootIfMissing: true, scripts: [],
      });
    }
    if (Option.isNone(current) || current.value.defaultModelSelection?.model !== model || current.value.defaultModelSelection?.instanceId !== "codex" || current.value.autoPull !== false) {
      yield* projects.update({
        commandId: CommandId.make(`autoops:project:model:${project.id}:${model}:v1`), projectId,
        defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model }, autoPull: false, scripts: [],
      });
    }
  }
});
