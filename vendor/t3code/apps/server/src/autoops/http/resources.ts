import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as FileSystem from 'effect/FileSystem'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { responseError } from './responses.ts'
import type { BusinessHttpContext } from './context.ts'
import { ThreadId } from '@t3tools/contracts'
import * as ThreadManagement from '../../orchestration-v2/ThreadManagementService.ts'
import { configuredBusinessArtifactStore } from '../../../../../../../agent-demo/t3-adapters/business-tools.mjs'
import { configuredHostResourceCatalog as configuredBusinessResourceCatalog } from '../resourceCatalog.ts'
import { saveAuthorizedPlan } from '../../../../../../../agent-demo/t3-adapters/plan-materials.mjs'
import { resolveAttachmentPathById } from '../../attachmentStore.ts'
import * as ServerConfig from '../../config.ts'
import { resourceHeaders, resourceMetadata } from './responses.ts'
import { decodeContract } from '../../../../../../../autoops/contracts/index.ts'
import { WorkspaceFileReferenceRequest } from '../../../../../../../autoops/contracts/workspace-file-reference.ts'

export function resourcesRoutes({ access, principal }: BusinessHttpContext) {

return Layer.mergeAll(
HttpRouter.add('GET', '/api/v1/projects/:projectId/workspace/file-reference', Effect.gen(function* () {
      const current = yield* principal;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, 'http://localhost');
      let input;
      try {
        if (url.searchParams.size !== new Set(url.searchParams.keys()).size) throw new Error('duplicate');
        input = decodeContract(WorkspaceFileReferenceRequest, Object.fromEntries(url.searchParams));
      } catch { return HttpServerResponse.jsonUnsafe({code:'WORKSPACE_REFERENCE_REQUEST_INVALID',error:'普通文件定位参数无效'},{status:400}); }
      const projectId = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      const catalog = configuredBusinessResourceCatalog();
      if (!catalog) return HttpServerResponse.jsonUnsafe({code:'WORKSPACE_UNAVAILABLE',error:'工作区暂时不可用'},{status:503});
      const value = yield* Effect.try(() => catalog.resolveWorkspaceFileReference(current, {...input,projectId}));
      // 回复前再次核实际登录、会话范围和原引用，不继承输入所有者权限。
      const final = yield* principal;
      if (final.id !== current.id) return HttpServerResponse.jsonUnsafe({code:'WORKSPACE_REFERENCE_ACTOR_CHANGED',error:'登录身份已改变，请重新打开'},{status:403});
      const checked = yield* Effect.try(() => catalog.resolveWorkspaceFileReference(final, {...input,projectId}));
      if (checked.resourcePath !== value.resourcePath || checked.sha256 !== value.sha256) return HttpServerResponse.jsonUnsafe({code:'WORKSPACE_REFERENCE_CHANGED',error:'当前文件已更新，请重新打开'},{status:409});
      return HttpServerResponse.jsonUnsafe(checked,{headers:{'cache-control':'private, no-store'}});
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
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const catalog = configuredBusinessResourceCatalog({ attachmentsDir: config.attachmentsDir, readFile: path => Effect.runPromise(fs.readFile(path)) });
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
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))))
)
}
