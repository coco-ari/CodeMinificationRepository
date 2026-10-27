import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CustomerPlatformToolRequest } from "../../../../../../autoops/contracts/customer-platform-tools.ts";
import { decodeContractJson } from "../../../../../../autoops/contracts/index.ts";
import {
  configuredAutoOpsAccess,
  AutoOpsAccessError,
} from "../../../../../../agent-demo/t3-adapters/access.mjs";
import { createCustomerPlatformTools } from "../../../../../../agent-demo/t3-adapters/customer-platform-tools.ts";
import { configuredWorkspaceManagement } from "../../../../../../agent-demo/t3-adapters/workspace-management.ts";
import { configuredEnvironmentMcp } from "../../../../../../agent-demo/t3-adapters/environment-mcp-runtime.ts";
import { EnvironmentMcpError } from "../../../../../../agent-demo/t3-adapters/environment-mcp/index.ts";
import { CustomerTransportError } from "../../../../../../agent-demo/t3-adapters/customer-transport.mjs";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { RemoteDeviceService } from "./RemoteDeviceService.ts";
import { responseError } from "./customerHttp.ts";

/** 只接四个所属只读工具；不转发任意 MCP/原生 RPC，也不信任模型提供的运行范围。 */
export const layer = Layer.unwrap(
  Effect.sync(() => {
    const access = configuredAutoOpsAccess();
    if (!access) return Layer.empty;
    return HttpRouter.add(
      "POST",
      "/autoops/customer/connector/platform-tools",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const principal = () => {
          const authorization = request.headers.authorization;
          if (!authorization?.startsWith("Bearer "))
            throw new AutoOpsAccessError(
              401,
              "CUSTOMER_DEVICE_UNAUTHENTICATED",
              "缺少独立设备凭据",
            );
          access.assertAccepting();
          return access.customerRegistry.authenticateToken(authorization.slice(7));
        };
        yield* Effect.try(principal);
        const input = yield* request.stream.pipe(
          Stream.runFoldEffect(
            () => ({ buffer: new Uint8Array(128 * 1024), bytes: 0 }),
            (state, chunk) =>
              chunk.byteLength > state.buffer.byteLength - state.bytes
                ? Effect.fail("body-limit")
                : Effect.sync(() => {
                    state.buffer.set(chunk, state.bytes);
                    state.bytes += chunk.byteLength;
                    return state;
                  }),
          ),
          Effect.flatMap((state) =>
            Effect.try(() =>
              decodeContractJson(
                CustomerPlatformToolRequest,
                new TextDecoder("utf-8", { fatal: true }).decode(
                  state.buffer.subarray(0, state.bytes),
                ),
              ),
            ),
          ),
          Effect.mapError(
            () =>
              new AutoOpsAccessError(
                400,
                "CUSTOMER_PLATFORM_TOOL_REQUEST_INVALID",
                "平台工具请求字段或大小无效",
              ),
          ),
        );
        const { hub } = yield* RemoteDeviceService;
        if (!hub)
          return yield* Effect.fail(
            new AutoOpsAccessError(
              503,
              "CUSTOMER_PLATFORM_TOOLS_UNAVAILABLE",
              "客户工具传输尚未配置",
            ),
          );
        const threads = yield* Threads.ThreadManagementService;
        const authorize = Effect.gen(function* () {
          const original = yield* Effect.try({
            try: () => hub.authorizePlatformTool(principal(), input),
            catch: (cause) =>
              cause instanceof CustomerTransportError
                ? new AutoOpsAccessError(403, cause.code, "原客户工具命令范围已失效")
                : cause instanceof AutoOpsAccessError
                  ? cause
                  : new AutoOpsAccessError(
                      503,
                      "CUSTOMER_PLATFORM_TOOL_UNAVAILABLE",
                      "客户工具授权暂不可用",
                    ),
          });
          const projection = yield* threads.getThreadProjection(
            ThreadId.make(original.authorized.context.threadId),
          );
          const run = Threads.latestActiveRun(projection);
          if (
            projection.thread.deletedAt !== null ||
            run?.id !== original.runId ||
            run.activeAttemptId !== original.attemptId ||
            run.providerInstanceId !== `customer-${original.session.deviceId}-codex`
          )
            return yield* Effect.fail(
              new AutoOpsAccessError(
                403,
                "CUSTOMER_PLATFORM_TOOL_RUN_INACTIVE",
                "原客户任务已结束或不再是当前轮次",
              ),
            );
          yield* Effect.try(() =>
            access.requireQuestionForActor(
              original.authorized.actorId,
              original.authorized.context.threadId,
              run.modelSelection,
            ),
          );
          return original;
        });
        yield* authorize;
        const tools = createCustomerPlatformTools(
          access,
          configuredWorkspaceManagement(access),
          configuredEnvironmentMcp(access),
        );
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            tools.invoke(
              input.reference,
              input.call,
              () => Effect.runPromise(authorize).then(() => {}),
              signal,
            ),
          catch: (error) =>
            error instanceof AutoOpsAccessError || error instanceof EnvironmentMcpError
              ? error
              : new AutoOpsAccessError(
                  503,
                  "CUSTOMER_PLATFORM_TOOL_UNAVAILABLE",
                  "平台工具未完成，请检查授权及资源状态",
                ),
        });
        yield* authorize;
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result);
        if (new TextEncoder().encode(encoded).byteLength > 1024 * 1024)
          return yield* Effect.fail(
            new AutoOpsAccessError(
              413,
              "CUSTOMER_PLATFORM_TOOL_RESULT_LIMIT",
              "平台工具结果超过大小限制",
            ),
          );
        return HttpServerResponse.jsonUnsafe(result, {
          headers: { "cache-control": "private, no-store" },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
    );
  }),
);
