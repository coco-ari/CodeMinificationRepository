import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { RemoteDeviceService } from "./RemoteDeviceService.ts";

export const layer = HttpRouter.add(
  "GET",
  "/autoops/customer/thread-status/:threadId",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { hub } = yield* RemoteDeviceService;
    if (!hub) return HttpServerResponse.empty({ status: 404 });
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const native = yield* auth.authenticateHttpRequest(request);
    const principal = yield* Effect.try(() =>
      hub.access.principalForNativeSession(native.sessionId),
    );
    const id = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname.split("/").at(-1) ?? "",
    );
    const binding = yield* Effect.try(() => hub.access.requireThread(principal, id));
    if (binding.executionBinding.kind !== "customer")
      return HttpServerResponse.empty({ status: 404 });
    const target = binding.executionBinding;
    const sessions = hub.journal
      .sessions(target.deviceId)
      .filter((session) => session.threadId === id);
    const session =
      sessions.find((item) => item.state === "unknown") ??
      sessions.find((item) => item.state === "active") ??
      sessions.at(-1);
    const device = hub.access.customerRegistry
      .listDevices(principal.id)
      .find((item) => item.id === target.deviceId);
    return HttpServerResponse.jsonUnsafe(
      {
        online: Boolean(device?.online && hub.online(device.id)),
        deviceStatus: device?.status ?? "revoked",
        state: session?.state ?? "idle",
        pendingStop: Boolean(
          session &&
          (session.pendingInterrupt ||
            hub.journal
              .pendingCommands(session.sessionId)
              .some((command) => command.method === "interruptTurn")),
        ),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: "无法读取此客户对话状态" }, { status: 403 }),
      ),
    ),
  ),
);
