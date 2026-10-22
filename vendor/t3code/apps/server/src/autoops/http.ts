// AutoOps host adapter. Conversation execution remains in the original T3 core.
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { hasAcceptedUserMessage, isThreadSubmissionActive, getThreadSubmissionGeneration } from './threadReservations.ts';
import { configuredBusinessArtifactStore } from "../../../../../../agent-demo/t3-adapters/business-tools.mjs";
import { configuredBusinessResourceCatalog } from "../../../../../../agent-demo/t3-adapters/resources.mjs";
import { configuredWorkspaceStore } from "../../../../../../agent-demo/t3-adapters/workspaces.mjs";
import { handleSkillLibraryRequest } from '../../../../../../agent-demo/t3-adapters/skill-library-http.mjs';
import { resolveBusinessSkillContext, readScopedSkillResource } from '../../../../../../agent-demo/t3-adapters/scoped-skills.mjs';
import { handleWorkspaceRequest } from "../../../../../../agent-demo/t3-adapters/workspace-http.mjs";
import { readImportedDrafts } from "../../../../../../agent-demo/t3-adapters/legacy-drafts.mjs";
import { saveAuthorizedPlan } from "../../../../../../agent-demo/t3-adapters/plan-materials.mjs";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  configuredAutoOpsAccess,
  type ThreadBinding,
} from "../../../../../../agent-demo/t3-adapters/access.mjs";

const safeMimes = new Set(["text/plain", "text/markdown", "text/csv", "text/html", "application/json", "application/pdf", "image/svg+xml", "image/png", "image/jpeg", "image/webp", "image/gif"]);
const resourceHeaders = (url: URL, name: string, mime: string) => ({
  "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": mime === 'text/html' ? "default-src 'none'; sandbox; style-src 'unsafe-inline'; img-src data:; font-src data:" : "default-src 'none'; sandbox",
  "content-type": safeMimes.has(mime) ? mime : "application/octet-stream",
  "content-disposition": `${url.searchParams.get("inline") === "1" && safeMimes.has(mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
});
const resourceMetadata = (url: URL, file: {id:string;name:string;mime:string;size:number}) => {
  const source = new URL(url); source.searchParams.delete('metadata'); source.searchParams.delete('inline');
  return HttpServerResponse.jsonUnsafe({ ...file, sourceUrl: `/api/agent-demo/t3${source.pathname}${source.search}` }, { headers: { "cache-control": "no-store" } });
};

export const responseError = (error: unknown) => {
  const wrapped = error as { cause?: unknown; _tag?: string };
  const inner = wrapped?._tag === "UnknownError" || wrapped?._tag === "UnknownException" ? wrapped.cause : error;
  const known = (typeof inner === "object" && inner !== null ? inner : {}) as { status?: number; code?: string; message?: string; _tag?: string };
  const status = known.status ?? (known._tag === "ServerAuthInvalidCredentialError" || known._tag === "ServerAuthMissingCredentialError" ? 401 : 500);
  return HttpServerResponse.jsonUnsafe({
    error: known.status ? known.message : status === 401 ? "请先登录" : "AutoOps 请求未完成",
    code: known.code ?? "AUTOOPS_REQUEST_FAILED",
  }, { status, headers: { "cache-control": "no-store" } });
};

export const layer = Layer.unwrap(Effect.sync(() => {
  const access = configuredAutoOpsAccess();
  if (access === undefined) return Layer.empty;
  const principal = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const native = yield* auth.authenticateHttpRequest(request);
    return yield* Effect.try(() => access.principalForNativeSession(native.sessionId));
  });
  const nativeSubmissionState = (threadId: string) => Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return yield* threads.getThreadSnapshot(ThreadId.make(threadId)).pipe(
      Effect.map((snapshot) => hasAcceptedUserMessage(snapshot) ? 'accepted' as const : 'empty' as const),
      Effect.catch((error) => {
        const cause = error as { _tag?: string; cause?: { _tag?: string } };
        return cause._tag === 'ThreadManagementThreadNotFoundError' || cause.cause?._tag === 'ProjectionStoreThreadNotFoundError'
          ? Effect.succeed('missing' as const) : Effect.fail(error);
      }),
    );
  });
  const workspaceRequest = Effect.gen(function* () {
    const current = yield* principal;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== 'GET') yield* Effect.try(() => access.requireCsrf(current, request.headers['x-demo-csrf']));
    const input = request.method === 'GET' ? undefined : yield* request.json;
    const result = yield* Effect.tryPromise(() => handleWorkspaceRequest({access, store:configuredWorkspaceStore(), principal:current, url:new URL(request.url,'http://localhost'), method:request.method, input}));
    if (result.file) {
      const url = new URL(request.url,'http://localhost');
      if (url.searchParams.get('metadata') === '1') return HttpServerResponse.jsonUnsafe({name:result.file.name,mime:result.file.mime,size:result.file.bytes.byteLength}, {headers:{'cache-control':'private, no-store'}});
      return HttpServerResponse.uint8Array(result.file.bytes, {status:result.status, headers:resourceHeaders(url,result.file.name,result.file.mime)});
    }
    return HttpServerResponse.jsonUnsafe(result.body, {status:result.status, headers:{'cache-control':'private, no-store'}});
  }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))));
  const skillLibraryRequest = Effect.gen(function* () {
    const current = yield* principal;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== 'GET') yield* Effect.try(() => access.requireCsrf(current, request.headers['x-demo-csrf']));
    const input = request.method === 'GET' ? undefined : yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(24)),
      Effect.mapError(() => ({status:400,code:'SKILL_REQUEST_INVALID',message:'技能请求正文无效或超过大小限制，请上传不超过 16 MiB 的 ZIP。'})),
    );
    const url = new URL(request.url, 'http://localhost');
    const result = yield* Effect.tryPromise(() => handleSkillLibraryRequest({access, principal:current, url, method:request.method, input, dataDirectory:process.env.AUTOOPS_T3_DATA_DIR!}));
    if (result.file) return HttpServerResponse.uint8Array(result.file.bytes, {status:result.status, headers:resourceHeaders(url,result.file.name,result.file.mime)});
    return HttpServerResponse.jsonUnsafe(result.body, {status:result.status, headers:{'cache-control':'private, no-store'}});
  }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))));
  const scopedSkillFile = Effect.gen(function* () {
    const current = yield* principal;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const file = yield* Effect.try(() => readScopedSkillResource(process.env.AUTOOPS_T3_DATA_DIR!, decodeURIComponent(parts[4] ?? ''), decodeURIComponent(parts[6] ?? ''), url.searchParams.get('path') ?? 'SKILL.md', {access, principal:current}));
    if (url.searchParams.get('metadata') === '1') return resourceMetadata(url, {id:file.path,name:file.name,mime:file.mime,size:file.bytes.byteLength});
    return HttpServerResponse.uint8Array(file.bytes, {headers:resourceHeaders(url,file.name,file.mime)});
  }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))));
  return Layer.mergeAll(
    HttpRouter.add('GET', '/autoops/skill-library', skillLibraryRequest),
    HttpRouter.add('POST', '/autoops/skill-library', skillLibraryRequest),
    HttpRouter.add('GET', '/autoops/skill-library/:id/versions/:versionId/content', skillLibraryRequest),
    HttpRouter.add('GET', '/autoops/skill-library/contexts/:snapshotId/files/:name', scopedSkillFile),
    HttpRouter.add('GET', '/autoops/skill-library/context', Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, 'http://localhost');
      const query = Object.fromEntries(url.searchParams);
      if (query.workspaceType && query.workspaceType !== 'internal' && query.workspaceType !== 'external') return HttpServerResponse.jsonUnsafe({error:'工作区类型无效'}, {status:400});
      const input = query.threadId ? {threadId:query.threadId} : {
        ...(query.projectId ? {projectId:query.projectId} : {}), ...(query.agentId ? {agentId:query.agentId} : {}),
        ...(query.environmentId ? {environmentId:query.environmentId} : {}),
        ...(query.workspaceType ? {workspaceType:query.workspaceType as 'internal' | 'external'} : {}),
        ...(query.workspaceVersionId ? {workspaceVersionId:query.workspaceVersionId} : {}),
      };
      const value = yield* Effect.try(() => resolveBusinessSkillContext(process.env.AUTOOPS_T3_DATA_DIR!, input, {access,principal:current}));
      return HttpServerResponse.jsonUnsafe(value, {headers:{'cache-control':'private, no-store'}});
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces', workspaceRequest),
    HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/versions/:versionId/tree', workspaceRequest),
    HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/versions/:versionId/search', workspaceRequest),
    HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/versions/:versionId/content', workspaceRequest),
    HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/versions/:versionId/download', workspaceRequest),
    HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/packages/:releaseId/:service/download', workspaceRequest),
    HttpRouter.add('GET', '/autoops/projects/:projectId/workspaces/packages/:releaseId/manifest', workspaceRequest),
    HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/external', workspaceRequest),
    HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/packages', workspaceRequest),
    HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/import', workspaceRequest),
    HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/versions/:versionId/publish', workspaceRequest),
    HttpRouter.add('POST', '/autoops/projects/:projectId/workspaces/tasks/:taskId/cancel', workspaceRequest),
    HttpRouter.middleware((handler) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://localhost").pathname;
      const read = request.method === "GET" || request.method === "HEAD";
      const permitted = (read && (path === "/.well-known/t3/environment" || path === "/api/auth/session" || path === "/api/projects" || path === "/ws" || path.startsWith("/api/orchestration/") || path.startsWith("/api/assets/"))) ||
        path.startsWith("/autoops/") || path === "/mcp" || path.startsWith("/mcp/") ||
        (request.method === "POST" && (path === "/api/auth/websocket-ticket" || path.startsWith("/api/attachments/upload/")));
      return permitted ? yield* handler : HttpServerResponse.jsonUnsafe({ error: "AutoOps route not available" }, { status: 404 });
    }), { global: true }),
    HttpRouter.add("GET", "/autoops/bootstrap", Effect.gen(function* () {
      const current = yield* principal;
      return HttpServerResponse.jsonUnsafe(access.bootstrap(current), {
        headers: { "cache-control": "no-store" },
      });
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    ...(['GET','POST'] as const).map(method => HttpRouter.add(method, '/autoops/skills', Effect.gen(function* () {
      const current = yield* principal;
      if (method === 'POST') { const request = yield* HttpServerRequest.HttpServerRequest; yield* Effect.try(() => access.requireCsrf(current,request.headers['x-demo-csrf'])); }
      return HttpServerResponse.jsonUnsafe({error:'技能管理已迁移，请刷新页面并打开技能库。',code:'SKILL_LIBRARY_MIGRATED'}, {status:410,headers:{'cache-control':'no-store'}});
    }).pipe(Effect.catch(error => Effect.succeed(responseError(error)))))),
    HttpRouter.add("GET", "/autoops/skills/:name", Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url,'http://localhost');
      const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      const contextId = url.searchParams.get('contextId');
      if (!contextId) return HttpServerResponse.jsonUnsafe({error:'请从当前对话的技能菜单打开说明',code:'SKILL_SCOPE_REQUIRED'},{status:403});
      const file = yield* Effect.try(() => readScopedSkillResource(process.env.AUTOOPS_T3_DATA_DIR!,contextId,name,'SKILL.md',{access,principal:current}));
      if (url.searchParams.get('metadata') === '1') return resourceMetadata(url,{id:file.path,name:file.name,mime:file.mime,size:file.bytes.byteLength});
      return HttpServerResponse.uint8Array(file.bytes,{headers:resourceHeaders(url,file.name,file.mime)});
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("GET", "/autoops/thread-bindings/:threadId", Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const threadId = decodeURIComponent(new URL(request.url, "http://localhost").pathname.split("/").at(-1) ?? "");
      let binding = yield* Effect.try(() => access.requireThread(current, threadId));
      if (binding.scopeState !== 'locked') {
        const generation = getThreadSubmissionGeneration(threadId), wasInactive = !isThreadSubmissionActive(threadId);
        const state = yield* nativeSubmissionState(threadId).pipe(Effect.catch(() => Effect.succeed('unavailable' as const)));
        if (state === 'accepted') yield* Effect.sync(() => access.markThreadAccepted(threadId));
        else if (state !== 'unavailable' && binding.scopeState === 'submitting')
          yield* Effect.sync(() => {
            if (wasInactive && !isThreadSubmissionActive(threadId) && getThreadSubmissionGeneration(threadId) === generation)
              access.reconcileThreadSubmission(threadId, false);
          });
        binding = yield* Effect.try(() => access.requireThread(current, threadId));
      }
      return HttpServerResponse.jsonUnsafe({ binding }, { headers: { "cache-control": "no-store" } });
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("GET", "/autoops/legacy-drafts", Effect.gen(function* () {
      const current = yield* principal;
      const drafts = yield* Effect.try(() => readImportedDrafts(access, current, process.env.AUTOOPS_T3_DATA_DIR!));
      return HttpServerResponse.jsonUnsafe({drafts}, {headers:{"cache-control":"no-store"}});
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("POST", "/autoops/plan-materials", Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* Effect.try(() => access.requireCsrf(current, request.headers["x-demo-csrf"]));
      const raw = yield* request.json;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw) || typeof (raw as {threadId?:unknown}).threadId !== "string")
        return HttpServerResponse.jsonUnsafe({code:"INVALID_PLAN_FILE",error:"计划资料格式无效"},{status:400});
      const input = raw as {threadId:string;name:string;contents:string};
      yield* Effect.try(() => access.requireThread(current,input.threadId));
      const threads = yield* ThreadManagement.ThreadManagementService;
      const projection = yield* threads.getThreadProjection(ThreadId.make(input.threadId));
      const store = configuredBusinessArtifactStore();
      if (!store) return HttpServerResponse.empty({status:503});
      const file = yield* Effect.try(() => saveAuthorizedPlan({access,principal:current,input,projection,store}));
      return HttpServerResponse.jsonUnsafe(file,{headers:{"cache-control":"no-store"}});
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("GET", "/autoops/files/:id", Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://localhost");
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const file = configuredBusinessArtifactStore()?.read(id);
      if (!file) return HttpServerResponse.empty({ status: 404 });
      yield* Effect.try(() => access.requireThread(current, file.threadId));
      if (url.searchParams.get("metadata") === "1") return resourceMetadata(url, {id, name:file.name, mime:file.mime, size:file.bytes.byteLength});
      return HttpServerResponse.uint8Array(file.bytes, {
        headers: resourceHeaders(url, file.name, file.mime),
      });
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("GET", "/autoops/resources", Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://localhost");
      const path = url.searchParams.get("path") ?? "";
      const catalog = configuredBusinessResourceCatalog();
      if (!catalog) return HttpServerResponse.empty({status:503});
      const file = yield* Effect.tryPromise(() => catalog.resource(current, path));
      const sourceUrl = `/api/agent-demo/t3/autoops/resources?path=${encodeURIComponent(path)}`;
      if (url.searchParams.get("metadata") === "1") return HttpServerResponse.jsonUnsafe({id:path,name:file.name,mime:file.mime,size:file.bytes.byteLength,sourceUrl}, {headers:{"cache-control":"no-store"}});
      return HttpServerResponse.uint8Array(file.bytes, {headers:resourceHeaders(url, file.name, file.mime)});
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("GET", "/autoops/attachments/:id", Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://localhost");
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const file = yield* Effect.try(() => access.requireAttachment(current, id));
      const metadata = {id,name:file.name ?? id,mime:file.mimeType ?? "application/octet-stream",size:file.sizeBytes ?? 0};
      if (url.searchParams.get("metadata") === "1") return resourceMetadata(url, metadata);
      const config = yield* ServerConfig.ServerConfig;
      const path = resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId: id, fileName: metadata.name });
      if (!path) return HttpServerResponse.empty({ status: 404 });
      return yield* HttpServerResponse.file(path, {
        headers: resourceHeaders(url, metadata.name, metadata.mime),
      });
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("GET", "/autoops/projects/:projectId/documents/:documentId", Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://localhost");
      const segments = url.pathname.split("/").map(decodeURIComponent);
      const project = yield* Effect.try(() => access.requireProject(current, segments.at(-3) ?? ""));
      yield* Effect.try(() => access.requireWorkspace(current, project.id, 'internal'));
      const document = project.documents.find((entry) => entry.id === segments.at(-1));
      if (!document) return HttpServerResponse.empty({status:404});
      const bytes = new TextEncoder().encode(document.content);
      if (url.searchParams.get("metadata") === "1") return resourceMetadata(url, {id:document.id,name:document.name,mime:document.mime,size:bytes.byteLength});
      return HttpServerResponse.uint8Array(bytes, {headers:resourceHeaders(url, document.name, document.mime)});
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("POST", "/autoops/thread-bindings", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const current = yield* principal;
      yield* Effect.try(() => access.requireCsrf(current, request.headers["x-demo-csrf"]));
      const input = yield* request.json;
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return HttpServerResponse.jsonUnsafe({ code: "INVALID_BINDING", error: "会话绑定格式无效" }, { status: 400 });
      }
      const binding = input as Omit<ThreadBinding, "ownerId" | "createdAt">;
      // Do not let a user claim an existing, as-yet-unmigrated native T3 thread.
      if (typeof binding.threadId === "string") {
        const existing = access.getThreadBinding(binding.threadId);
        if (existing) yield* Effect.try(() => access.requireThread(current, binding.threadId));
        if (!existing || existing.scopeState !== 'locked') {
          const generation = getThreadSubmissionGeneration(binding.threadId), wasInactive = !isThreadSubmissionActive(binding.threadId);
          const state = yield* nativeSubmissionState(binding.threadId);
          if (!existing && state !== 'missing') return HttpServerResponse.jsonUnsafe({ code: "THREAD_ALREADY_EXISTS", error: "该会话需先完成授权数据迁移" }, { status: 409 });
          if (existing && state === 'accepted') yield* Effect.sync(() => access.markThreadAccepted(binding.threadId));
          else if (existing?.scopeState === 'submitting')
            yield* Effect.sync(() => {
              if (wasInactive && !isThreadSubmissionActive(binding.threadId) && getThreadSubmissionGeneration(binding.threadId) === generation)
                access.reconcileThreadSubmission(binding.threadId, false);
            });
        }
      }
      const saved = yield* Effect.try(() => access.reserveThread(current, binding));
      return HttpServerResponse.jsonUnsafe({ binding: saved }, { headers: { "cache-control": "no-store" } });
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
  );
}));
