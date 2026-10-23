import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { decodeCustomerAgentClientFrame } from "../../../../packages/contracts/src/autoopsRemote.ts";
import { RemoteDeviceService } from "./RemoteDeviceService.ts";

/** Independent device bearer authentication; never accepts a browser/session cookie. */
export const layer = HttpRouter.add(
  "GET",
  "/autoops/customer/connect",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { hub } = yield* RemoteDeviceService;
    if (!hub) return HttpServerResponse.empty({ status: 404 });
    const accepting = yield* Effect.try(() => hub.access.assertAccepting()).pipe(Effect.result);
    if (accepting._tag === "Failure")
      return HttpServerResponse.jsonUnsafe({ error: "业务服务正在停止，请稍后重试", code: "AUTOOPS_STOPPING" }, { status: 503 });
    const principal = yield* Effect.try(() => {
      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer ")) throw new Error("缺少设备凭据");
      return hub.access.customerRegistry.authenticateToken(header.slice(7));
    }).pipe(Effect.result);
    if (principal._tag === "Failure")
      return HttpServerResponse.jsonUnsafe({ error: "设备凭据无效，请重新配对" }, { status: 401 });
    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const writer = yield* socket.writer;
        const reader = yield* socket.reader;
        const outgoing = yield* Queue.bounded<string>(128);
        const closed = yield* Deferred.make<void>();
        let pendingBytes = 0;
        const connection = hub.connect(
          principal.success,
          async (frame) => {
            const encoded = JSON.stringify(frame),
              size = new TextEncoder().encode(encoded).length;
            if (pendingBytes + size > 8 * 1024 * 1024 || !Queue.offerUnsafe(outgoing, encoded)) {
              Deferred.doneUnsafe(closed, Effect.void);
              throw new Error("客户发送缓冲区已满");
            }
            pendingBytes += size;
          },
          () => {
            Deferred.doneUnsafe(closed, Effect.void);
          },
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => connection.disconnect()));
        const write = Effect.gen(function* () {
          while (true) {
            const frame = yield* Queue.take(outgoing);
            pendingBytes -= new TextEncoder().encode(frame).length;
            yield* writer.writeAll([frame]);
          }
        });
        const read = Effect.gen(function* () {
          while (true) {
            const frames = yield* reader.pull.pipe(Effect.timeout("45 seconds"));
            for (const bytes of frames) {
              const raw =
                typeof bytes === "string"
                  ? bytes
                  : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              const frame = yield* Effect.try(() => decodeCustomerAgentClientFrame(raw));
              yield* Effect.tryPromise(() => connection.accept(frame)).pipe(
                Effect.tapError((error) => {
                  const cause = error.cause;
                  const code =
                    typeof cause === "object" &&
                    cause !== null &&
                    "code" in cause &&
                    typeof cause.code === "string" &&
                    /^[A-Z_]{1,64}$/.test(cause.code)
                      ? cause.code
                      : "FRAME_REJECTED";
                  // Never log the frame, prompt, tool output or bearer credential.
                  return Effect.logWarning("Customer device frame rejected", {
                    deviceId: principal.success.deviceId,
                    frameType: frame.type,
                    code,
                  });
                }),
              );
            }
          }
        });
        yield* Effect.raceFirst(Effect.raceFirst(read, write), Deferred.await(closed));
      }),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  }),
);
