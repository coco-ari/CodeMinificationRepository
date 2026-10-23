import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { responseError } from './responses.ts'
import type { BusinessHttpContext } from './context.ts'
import { ThreadId } from '@t3tools/contracts'
import * as ThreadManagement from '../../orchestration-v2/ThreadManagementService.ts'
import { hasAcceptedUserMessage, isThreadSubmissionActive, getThreadSubmissionGeneration } from '../threadReservations.ts'
import { readImportedDrafts } from '../../../../../../../agent-demo/t3-adapters/legacy-drafts.mjs'
import type { ThreadBinding } from '../../../../../../../agent-demo/t3-adapters/access.mjs'

export function conversationsRoutes({ access, principal }: BusinessHttpContext) {
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
return Layer.mergeAll(
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
HttpRouter.add("POST", "/autoops/thread-bindings", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const current = yield* principal;
      yield* Effect.try(() => access.requireCsrf(current, request.headers["x-demo-csrf"]));
      const input = yield* request.json;
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return HttpServerResponse.jsonUnsafe({ code: "INVALID_BINDING", error: "会话绑定格式无效" }, { status: 400 });
      }
      const binding = input as Omit<ThreadBinding, "ownerId" | "createdAt">;
      // 未完成业务绑定的原生会话不能由当前用户自行认领。
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
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))))
)
}
