import * as S from 'effect/Schema'
import { QuestionConfiguration } from '../../../../../../../autoops/contracts/assistants.ts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { responseError } from './responses.ts'
import type { BusinessHttpContext } from './context.ts'
import * as ByteSize from 'effect/ByteSize'
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage'
import { handleSkillLibraryRequest } from '../../../../../../../agent-demo/t3-adapters/skill-library-http.mjs'
import { resolveBusinessSkillContext, readScopedSkillResource } from '../../../../../../../agent-demo/t3-adapters/scoped-skills.mjs'
import { resourceHeaders, resourceMetadata } from './responses.ts'

export function skillsRoutes({ access, principal }: BusinessHttpContext) {
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
      if (query.skillIds && query.skillIds.length > 8192) return HttpServerResponse.jsonUnsafe({code:'SKILL_INPUT_INVALID',error:'技能选择超过大小限制'}, {status:400});
      const skillIds = query.skillIds === undefined ? undefined : yield* S.decodeUnknownEffect(S.fromJsonString(QuestionConfiguration.fields.skillIds))(query.skillIds).pipe(Effect.mapError(() => ({status:400,code:'SKILL_INPUT_INVALID',message:'技能选择格式无效'})));
      const input = query.threadId ? {threadId:query.threadId} : {
        ...(query.projectId ? {projectId:query.projectId} : {}), ...(query.agentId ? {agentId:query.agentId} : {}),
        ...(query.environmentId ? {environmentId:query.environmentId} : {}),
        ...(query.workspaceType ? {workspaceType:query.workspaceType as 'internal' | 'external'} : {}),
        ...(query.workspaceVersionId ? {workspaceVersionId:query.workspaceVersionId} : {}),
        ...(skillIds === undefined ? {} : {skillIds}),
      };
      const value = yield* Effect.try(() => resolveBusinessSkillContext(process.env.AUTOOPS_T3_DATA_DIR!, input, {access,principal:current}));
      return HttpServerResponse.jsonUnsafe(value, {headers:{'cache-control':'private, no-store'}});
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
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))))
)
}
