import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { configuredAutoOpsAccess } from "../../../../../../agent-demo/t3-adapters/access.mjs";
import { normalizeExecutionBinding } from "../../../../../../agent-demo/t3-adapters/customer-registry.mjs";
import { CustomerFileInput } from "../../../../packages/contracts/src/customerFiles.ts";
import { RemoteDeviceService } from "./RemoteDeviceService.ts";

class CustomerFileReadError extends Data.TaggedError("CustomerFileReadError")<{
  status: number;
  code: string;
  message: string;
}> {}
const readFailure = (cause: unknown): CustomerFileReadError => {
  const known = (cause && typeof cause === "object" ? cause : {}) as {
    status?: number;
    code?: string;
    message?: string;
    _tag?: string;
  };
  const status =
    known.status ??
    (known._tag?.startsWith("ServerAuth")
      ? 401
      : known.code === "DEVICE_OFFLINE"
        ? 409
        : known.code === "FILES_TIMEOUT"
          ? 504
          : 400);
  const expected =
    known.status !== undefined || /^(?:FILES_|DEVICE_|CONNECTOR_)/u.test(known.code ?? "");
  return new CustomerFileReadError({
    status,
    code: expected ? (known.code ?? "CUSTOMER_FILES_UNAVAILABLE") : "CUSTOMER_FILES_UNAVAILABLE",
    message: expected ? (known.message ?? "电脑文件读取失败，请重试") : "电脑文件读取失败，请重试",
  });
};

export const layer = HttpRouter.add(
  "GET",
  "/autoops/customer/files",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const native = yield* auth.authenticateHttpRequest(request);
    const { hub } = yield* RemoteDeviceService;
    const query = new URL(request.url, "http://localhost").searchParams;
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CustomerFileInput))(
      query.get("input") ?? "{}",
    );
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const access = configuredAutoOpsAccess();
        if (!access || !hub) throw { status: 404, message: "客户文件不可用" };
        const principal = access.principalForNativeSession(native.sessionId);
        const projectId = query.get("projectId") ?? "",
          environmentId = query.get("environmentId");
        const target = normalizeExecutionBinding({
          kind: "customer",
          deviceId: query.get("deviceId"),
          registeredWorkspaceId: query.get("registeredWorkspaceId"),
          workspaceBindingRevision: Number(query.get("workspaceBindingRevision")),
          runtimeId: "codex",
        });
        if (target.kind !== "customer") throw { status: 400, message: "请选择客户工作区" };
        let fileOwnerId = principal.id;
        const authorize = () => {
          access.refresh(principal);
          access.requireMembership(principal, projectId);
          const threadId = query.get("threadId");
          const binding = threadId ? access.requireThread(principal, threadId) : undefined;
          if (!binding && environmentId !== null) access.requireEnvironment(principal, projectId, environmentId);
          if (binding) {
            const owned = access.requireThreadExecution(principal, binding.threadId);
            const source = access.customerExecutionSource(binding.threadId, principal.id);
            if (source.ownerId !== binding.ownerId || binding.question?.configuration.customerProfile)
              throw { status: 403, message: "此提供者来源未开放文件浏览" };
            fileOwnerId = source.ownerId;
            const current = owned.executionBinding;
            if (
              owned.projectId !== projectId ||
              owned.environmentId !== environmentId ||
              current.kind !== "customer" ||
              current.deviceId !== target.deviceId ||
              current.registeredWorkspaceId !== target.registeredWorkspaceId ||
              current.workspaceBindingRevision !== target.workspaceBindingRevision ||
              current.runtimeId !== target.runtimeId
            )
              throw { status: 403, message: "文件不属于当前对话的电脑目录" };
          }
        };
        authorize();
        const result = await hub.readFiles(
          fileOwnerId,
          projectId,
          target,
          input,
          signal,
          authorize,
        );
        return HttpServerResponse.jsonUnsafe(result, {
          headers: { "cache-control": "private, no-store" },
        });
      },
      catch: readFailure,
    });
  }).pipe(
    Effect.catch((cause: unknown) => {
      const error = cause instanceof CustomerFileReadError ? cause : readFailure(cause);
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: error.message, code: error.code },
          { status: error.status, headers: { "cache-control": "private, no-store" } },
        ),
      );
    }),
  ),
);
