// Owner-facing registration and device-only metadata transport. No chat/run state lives here.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Serve a fixed administrator-configured build artifact; never accept a client path.
import { readFile } from 'node:fs/promises'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import * as EnvironmentAuth from '../auth/EnvironmentAuth.ts'
import {
  configuredAutoOpsAccess,
  configuredAutoOpsAssistantDirectory,
} from '../../../../../../agent-demo/t3-adapters/access.mjs'
import {
  normalizeExecutionBinding,
  type CustomerCapabilityInput,
} from "../../../../../../agent-demo/t3-adapters/customer-registry.mjs";
import { SharedExecutionScope } from '../../../../../../autoops/contracts/shared-execution.ts';
import { CustomerAssistantRuntimeRequest } from '../../../../../../autoops/contracts/customer-assistant-runtime.ts';
import { decodeContractJson } from '../../../../../../autoops/contracts/index.ts';
import * as Stream from 'effect/Stream';

const responseError = (error: unknown) => {
  const wrapped = error as { _tag?: string; cause?: unknown };
  const inner =
    wrapped?._tag === "UnknownError" || wrapped?._tag === "UnknownException"
      ? wrapped.cause
      : error;
  const known = (inner && typeof inner === "object" ? inner : {}) as {
    status?: number;
    code?: string;
    message?: string;
    _tag?: string;
  };
  const status =
    known.status ??
    (known._tag === "ServerAuthMissingCredentialError" ||
    known._tag === "ServerAuthInvalidCredentialError"
      ? 401
      : 500);
  return HttpServerResponse.jsonUnsafe(
    {
      error: known.status ? known.message : status === 401 ? "请先登录" : "客户设备请求未完成",
      code: known.code ?? "CUSTOMER_REQUEST_FAILED",
    },
    { status, headers: { "cache-control": "private, no-store" } },
  );
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw { status: 400, code: "INVALID_CUSTOMER_METADATA", message: "客户设备请求格式无效" };
  return value as Record<string, unknown>;
};
const bodyResponse = (body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { headers: { "cache-control": "private, no-store" } });
const trailingId = (url: URL, suffix: string) =>
  decodeURIComponent(url.pathname.slice(0, -suffix.length).split("/").at(-1) ?? "");

export const layer = Layer.unwrap(
  Effect.sync(() => {
    const access = configuredAutoOpsAccess();
    if (!access) return Layer.empty;
    const registry = access.customerRegistry;
    const owner = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const native = yield* auth.authenticateHttpRequest(request);
      const current = yield* Effect.try(() => access.principalForNativeSession(native.sessionId));
      if (request.method !== "GET")
        yield* Effect.try(() => access.requireCsrf(current, request.headers["x-demo-csrf"]));
      return current;
    });
    const device = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* Effect.try(() => {
        access.assertAccepting();
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith("Bearer "))
          throw {
            status: 401,
            code: "CUSTOMER_DEVICE_UNAUTHENTICATED",
            message: "缺少独立设备凭据",
          };
        return registry.authenticateToken(authorization.slice(7));
      });
    });
    return Layer.mergeAll(
      HttpRouter.add('POST','/autoops/customer/assistant-runtime',Effect.gen(function* () {
        const initial=yield* owner,request=yield* HttpServerRequest.HttpServerRequest;
        const input=yield* request.stream.pipe(Stream.runFoldEffect(()=>({buffer:new Uint8Array(128*1024),bytes:0}),
          (state,chunk)=>chunk.byteLength>state.buffer.byteLength-state.bytes?Effect.fail('body-limit'):Effect.sync(()=>{state.buffer.set(chunk,state.bytes);state.bytes+=chunk.byteLength;return state})),
          Effect.flatMap(state=>Effect.try(()=>new TextDecoder('utf-8',{fatal:true}).decode(state.buffer.subarray(0,state.bytes)))),
          Effect.flatMap(text=>Effect.try(()=>decodeContractJson(CustomerAssistantRuntimeRequest,text))),
          Effect.mapError(()=>({status:400,code:'CUSTOMER_RUNTIME_REQUEST_INVALID',message:'助手目录请求字段或大小无效'})));
        const current=yield* owner;
        if(current.id!==initial.id)return yield* Effect.fail({status:403,code:'CUSTOMER_ACTOR_CHANGED',message:'登录身份已改变，请重新载入'});
        yield* Effect.try(()=>access.customerAssistantRuntime(current,input));
        // 原生登录与中心成员事实都在返回前重查，目录读取不签发执行许可。
        const final=yield* owner;
        if(final.id!==current.id)return yield* Effect.fail({status:403,code:'CUSTOMER_ACTOR_CHANGED',message:'登录身份已改变，请重新载入'});
        return bodyResponse(yield* Effect.try(()=>access.customerAssistantRuntime(final,input)));
      }).pipe(Effect.catch(error=>Effect.succeed(responseError(error))))),
      HttpRouter.add('POST','/autoops/customer/connector/shared-admission',Effect.gen(function* () {
        const current=yield* device, request=yield* HttpServerRequest.HttpServerRequest;
        const scope=yield* request.stream.pipe(Stream.runFoldEffect(()=>({buffer:new Uint8Array(128*1024),bytes:0}),
          (state,chunk)=>chunk.byteLength>state.buffer.byteLength-state.bytes?Effect.fail('body-limit'):Effect.sync(()=>{state.buffer.set(chunk,state.bytes);state.bytes+=chunk.byteLength;return state})),
          Effect.flatMap(state=>Effect.try(()=>new TextDecoder('utf-8',{fatal:true}).decode(state.buffer.subarray(0,state.bytes)))),
          Effect.flatMap(text=>Effect.try(()=>decodeContractJson(SharedExecutionScope,text))),
          Effect.mapError(()=>({status:400,code:'CUSTOMER_SHARED_SCOPE_INVALID',message:'共享执行范围格式或大小无效'})));
        const refreshed=yield* device;
        const admitted=yield* Effect.try(()=>access.requireSharedExecutionScope(scope,refreshed));
        if(refreshed.deviceId!==current.deviceId)return yield* Effect.fail({status:403,code:'CUSTOMER_DEVICE_CHANGED',message:'设备身份已改变'});
        return bodyResponse({grantId:admitted.grantId,available:true});
      }).pipe(Effect.catch(error=>Effect.succeed(responseError(error))))),
      HttpRouter.add(
        "GET",
        "/autoops/customer/download",
        Effect.gen(function* () {
          yield* owner;
          const unavailable = {
            status: 503,
            code: "CUSTOMER_BUNDLE_UNAVAILABLE",
            message: "连接程序尚未发布，请联系管理员。",
          };
          const bundlePath = process.env.AUTOOPS_CUSTOMER_AGENT_BUNDLE;
          if (!bundlePath) return yield* Effect.fail(unavailable);
          const bundle = yield* Effect.tryPromise({
            try: () => readFile(bundlePath),
            catch: () => unavailable,
          });
          return HttpServerResponse.uint8Array(bundle, {
            headers: {
              "content-type": "application/zip",
              "content-disposition": 'attachment; filename="autoops-customer-agent.zip"',
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
            },
          });
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "GET",
        "/autoops/customer/devices",
        Effect.gen(function* () {
          const current = yield* owner;
          return bodyResponse({
            devices: yield* Effect.try(() => registry.listDevices(current.id)),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "GET",
        "/autoops/customer/workspaces",
        Effect.gen(function* () {
          const current = yield* owner,
            request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://localhost");
          return bodyResponse({
            workspaces: yield* Effect.try(() =>
              registry.listWorkspaces(current.id, url.searchParams.get("projectId") ?? undefined),
            ),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "POST",
        "/autoops/customer/pairings",
        Effect.gen(function* () {
          const current = yield* owner,
            request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.json;
          return bodyResponse(
            yield* Effect.try(() =>
              registry.createPairing(current.id, record(input) as { label?: string }),
            ),
          );
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "POST",
        "/autoops/customer/devices/:deviceId/status",
        Effect.gen(function* () {
          const current = yield* owner,
            request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.json,
            url = new URL(request.url, "http://localhost");
          return bodyResponse({
            device: yield* Effect.try(() =>
              registry.setDeviceStatus(
                current.id,
                trailingId(url, "/status"),
                record(input).status as "active" | "disabled",
              ),
            ),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "POST",
        "/autoops/customer/devices/:deviceId/revoke",
        Effect.gen(function* () {
          const current = yield* owner,
            request = yield* HttpServerRequest.HttpServerRequest;
          return bodyResponse({
            device: yield* Effect.try(() =>
              registry.revokeCredential(
                current.id,
                trailingId(new URL(request.url, "http://localhost"), "/revoke"),
              ),
            ),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "GET",
        "/autoops/customer/capabilities",
        Effect.gen(function* () {
          const current = yield* owner,
            request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://localhost");
          return bodyResponse({
            capabilities: yield* Effect.try(() => {
              const target = normalizeExecutionBinding({
                kind: "customer",
                deviceId: url.searchParams.get("deviceId"),
                registeredWorkspaceId: url.searchParams.get("registeredWorkspaceId"),
                workspaceBindingRevision: Number(url.searchParams.get("workspaceBindingRevision")),
                runtimeId: url.searchParams.get("runtimeId"),
              });
              if (target.kind !== "customer")
                throw {
                  status: 400,
                  code: "CUSTOMER_TARGET_REQUIRED",
                  message: "请选择客户工作区",
                };
              return registry.getCapabilities(current.id, target) ?? null;
            }),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "POST",
        "/autoops/customer/connector/pair",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest,
            raw = yield* request.json;
          return bodyResponse(
            yield* Effect.try(() => {
              const input = record(raw),
                { pairingCode, ...metadata } = input;
              return registry.consumePairing(
                pairingCode as string,
                metadata as { label: string; platform?: string; connectorVersion?: string },
              );
            }),
          );
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "GET",
        "/autoops/customer/connector/state",
        Effect.gen(function* () {
          const current = yield* device;
          return bodyResponse(
            yield* Effect.try(() => ({
              device: registry
                .listDevices(current.ownerId)
                .find((entry) => entry.id === current.deviceId),
              workspaces: registry
                .listWorkspaces(current.ownerId)
                .filter((entry) => entry.deviceId === current.deviceId),
            })),
          );
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "POST",
        "/autoops/customer/connector/workspaces",
        Effect.gen(function* () {
          const current = yield* device,
            request = yield* HttpServerRequest.HttpServerRequest,
            input = yield* request.json;
          return bodyResponse({
            workspace: yield* Effect.try(() =>
              registry.registerWorkspace(
                current,
                record(input) as Parameters<typeof registry.registerWorkspace>[1],
              ),
            ),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "POST",
        "/autoops/customer/connector/capabilities",
        Effect.gen(function* () {
          const current = yield* device,
            request = yield* HttpServerRequest.HttpServerRequest,
            input = yield* request.json;
          return bodyResponse({
            capabilities: yield* Effect.try(() =>
              registry.updateCapabilities(
                current,
                record(input) as unknown as CustomerCapabilityInput,
              ),
            ),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
      HttpRouter.add(
        "POST",
        "/autoops/customer/connector/workspaces/:workspaceId/revoke",
        Effect.gen(function* () {
          const current = yield* device,
            request = yield* HttpServerRequest.HttpServerRequest;
          return bodyResponse({
            workspace: yield* Effect.try(() =>
              registry.revokeWorkspace(
                current,
                trailingId(new URL(request.url, "http://localhost"), "/revoke"),
              ),
            ),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))),
      ),
    );
  }),
);
