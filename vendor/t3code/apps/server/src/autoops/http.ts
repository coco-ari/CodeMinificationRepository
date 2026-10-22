// AutoOps host adapter. Conversation execution remains in the original T3 core.
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { configuredBusinessArtifactStore } from "../../../../../../agent-demo/t3-adapters/business-tools.mjs";
import { configuredBusinessResourceCatalog } from "../../../../../../agent-demo/t3-adapters/resources.mjs";
import { readImportedDrafts } from "../../../../../../agent-demo/t3-adapters/legacy-drafts.mjs";
import { saveAuthorizedPlan } from "../../../../../../agent-demo/t3-adapters/plan-materials.mjs";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { businessSkillsResponse, parseBusinessSkillMarkdown } from './skills.ts';
import { readBusinessSkillRegistry, manageBusinessSkills } from '../../../../../../agent-demo/t3-adapters/skills.mjs';
import {
  configuredAutoOpsAccess,
  type ThreadBinding,
} from "../../../../../../agent-demo/t3-adapters/access.mjs";

const safeMimes = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);
const resourceHeaders = (url: URL, name: string, mime: string) => ({
  "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
  "content-type": safeMimes.has(mime) ? mime : "application/octet-stream",
  "content-disposition": `${url.searchParams.get("inline") === "1" && safeMimes.has(mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
});
const resourceMetadata = (url: URL, file: {id:string;name:string;mime:string;size:number}) =>
  HttpServerResponse.jsonUnsafe({ ...file, sourceUrl: `/api/agent-demo/t3${url.pathname}` }, { headers: { "cache-control": "no-store" } });

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
  return Layer.mergeAll(
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
    HttpRouter.add("GET", "/autoops/skills", Effect.gen(function* () {
      const current = yield* principal;
      const value = yield* Effect.try(() => businessSkillsResponse(process.env.AUTOOPS_T3_DATA_DIR!, current.role === 'admin'));
      return HttpServerResponse.jsonUnsafe(value, {headers:{'cache-control':'no-store'}});
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("POST", "/autoops/skills", Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* Effect.try(() => access.requireCsrf(current, request.headers['x-demo-csrf']));
      const raw = yield* request.json;
      if(typeof raw !== 'object' || raw === null || Array.isArray(raw)) return HttpServerResponse.empty({status:400});
      const input = raw as Record<string, unknown>;
      const directory = process.env.AUTOOPS_T3_DATA_DIR!;
      yield* Effect.try(() => {
        const action = input.action === 'import'
          ? {action:'import' as const,revision:String(input.revision ?? ''),skill:parseBusinessSkillMarkdown(input.contents)}
          : {action:'toggle' as const,revision:String(input.revision ?? ''),name:String(input.name ?? ''),enabled:input.enabled as boolean};
        if(input.action !== 'import' && input.action !== 'toggle') throw {status:400,code:'INVALID_SKILL_ACTION',message:'技能操作无效'};
        manageBusinessSkills(directory, process.env.AUTOOPS_T3_CODEX_HOME || `${directory}/t3/codex-home`, access, current, action);
      });
      return HttpServerResponse.jsonUnsafe(businessSkillsResponse(directory,current.role==='admin'), {headers:{'cache-control':'no-store'}});
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("GET", "/autoops/skills/:name", Effect.gen(function* () {
      yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url,'http://localhost');
      const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '').replace(/^autoops-/,'');
      const skill = yield* Effect.try(() => readBusinessSkillRegistry(process.env.AUTOOPS_T3_DATA_DIR!).skills.find((entry)=>entry.name===name));
      if(!skill) return HttpServerResponse.empty({status:404});
      const contents = `# ${skill.displayName ?? name}\n\n${skill.description}\n\n${skill.instructions.replace(/^# ([^\n]+)/u, '## $1')}\n\n> 此技能沿用当前会话的项目、环境与工具权限，不执行附带脚本或安装依赖。\n`;
      const bytes = new TextEncoder().encode(contents);
      if(url.searchParams.get('metadata')==='1') return resourceMetadata(url,{id:`autoops-${name}`,name:`${skill.displayName ?? name}.md`,mime:'text/markdown',size:bytes.byteLength});
      return HttpServerResponse.uint8Array(bytes,{headers:resourceHeaders(url,`${skill.displayName ?? name}.md`,'text/markdown')});
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
    HttpRouter.add("GET", "/autoops/thread-bindings/:threadId", Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const threadId = decodeURIComponent(new URL(request.url, "http://localhost").pathname.split("/").at(-1) ?? "");
      const binding = yield* Effect.try(() => access.requireThread(current, threadId));
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
      if (typeof binding.threadId === "string" && access.getThreadBinding(binding.threadId) === undefined) {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const exists = yield* threads.getThreadSnapshot(ThreadId.make(binding.threadId)).pipe(
          Effect.as(true),
          Effect.catch((error) => {
            const cause = error as { _tag?: string; cause?: { _tag?: string } };
            return cause._tag === "ThreadManagementThreadNotFoundError" || cause.cause?._tag === "ProjectionStoreThreadNotFoundError"
              ? Effect.succeed(false)
              : Effect.fail(error);
          }),
        );
        if (exists) return HttpServerResponse.jsonUnsafe({ code: "THREAD_ALREADY_EXISTS", error: "该会话需先完成授权数据迁移" }, { status: 409 });
      }
      const saved = yield* Effect.try(() => access.bindThread(current, binding));
      return HttpServerResponse.jsonUnsafe({ binding: saved }, { headers: { "cache-control": "no-store" } });
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))),
  );
}));
