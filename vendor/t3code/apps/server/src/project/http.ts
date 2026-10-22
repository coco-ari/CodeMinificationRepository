import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
  requiredScopesForProjectMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentAuthInvalid,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProjectService from "./ProjectService.ts";
import { projectMutationOperation } from "./ProjectMutation.ts";
import { configuredAutoOpsAccess } from "../../../../../../agent-demo/t3-adapters/access.mjs";
import { filterAutoOpsShell } from "../../../../../../agent-demo/t3-adapters/rpc-policy.mjs";

export const failProjectMutation = Effect.fn("environment.projects.failMutation")(function* (
  cause: ProjectService.ProjectServiceError | ServerRuntimeStartup.ServerRuntimeStartupError,
) {
  if (
    cause._tag === "ProjectNotFoundError" ||
    cause._tag === "ProjectConflictError" ||
    cause._tag === "ProjectNotEmptyError"
  ) {
    return yield* failEnvironmentInvalidRequest("invalid_command");
  }
  return yield* failEnvironmentInternal("project_mutation_failed", cause);
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "projects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectService.ProjectService;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.projects.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projects.snapshot.pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) => failEnvironmentInternal("project_snapshot_failed", cause)),
          );
          const access = configuredAutoOpsAccess();
          if (!access) return snapshot;
          const session = yield* EnvironmentAuthenticatedPrincipal;
          return yield* Effect.try(() => filterAutoOpsShell(access, access.principalForNativeSession(session.sessionId), snapshot))
            .pipe(Effect.catch(() => failEnvironmentAuthInvalid("invalid_credential")));
        }),
      )
      .handle(
        "mutate",
        Effect.fn("environment.projects.mutate")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          for (const scope of requiredScopesForProjectMutation(args.payload)) {
            yield* requireEnvironmentScope(scope);
          }
          const operation = projectMutationOperation(projects, args.payload);
          return yield* startup
            .enqueueCommand(operation)
            .pipe(traceLocalHandlerWork, Effect.catch(failProjectMutation));
        }),
      );
  }),
);
