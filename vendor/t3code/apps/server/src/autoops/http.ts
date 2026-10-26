// 只负责装配业务路由；业务规则和状态分别由所属模块维护。
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { configuredAutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { createBusinessHttpContext } from './http/context.ts'
import { responseError } from './http/responses.ts'
import { workspacesRoutes } from './http/workspaces.ts'
import { workspaceAuthoringRoutes } from './http/workspaceAuthoring.ts'
import { deploymentsRoutes } from './http/deployments.ts'
import { skillsRoutes } from './http/skills.ts'
import { conversationsRoutes } from './http/conversations.ts'
import { resourcesRoutes } from './http/resources.ts'
import { projectDirectoryRoutes } from './http/projectDirectory.ts'
import { assistantsRoutes } from './http/assistants.ts'
export { responseError } from './http/responses.ts'

export const layer = Layer.unwrap(Effect.sync(() => {
  const access = configuredAutoOpsAccess()
  if (access === undefined) return Layer.empty
  const context = createBusinessHttpContext(access)
  const { principal } = context
  return Layer.mergeAll(
    workspacesRoutes(context), workspaceAuthoringRoutes(context), deploymentsRoutes(context), skillsRoutes(context),
    conversationsRoutes(context), resourcesRoutes(context), projectDirectoryRoutes(context), assistantsRoutes(context),
    HttpRouter.middleware((handler) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://localhost").pathname;
      const read = request.method === "GET" || request.method === "HEAD";
      const permitted = (read && (path === "/.well-known/t3/environment" || path === "/api/auth/session" || path === "/api/projects" || path === "/ws" || path.startsWith("/api/orchestration/") || path.startsWith("/api/assets/"))) ||
        path.startsWith("/autoops/") || path === "/api/v1/projects" || path.startsWith('/api/v1/projects/') || path === "/mcp" || path.startsWith("/mcp/") ||
        (request.method === "POST" && (path === "/api/auth/websocket-ticket" || path.startsWith("/api/attachments/upload/")));
      return permitted ? yield* handler : HttpServerResponse.jsonUnsafe({ error: "AutoOps route not available" }, { status: 404 });
    }), { global: true }),
HttpRouter.add("GET", "/autoops/bootstrap", Effect.gen(function* () {
      const current = yield* principal;
      return HttpServerResponse.jsonUnsafe(access.bootstrap(current), {
        headers: { "cache-control": "no-store" },
      });
    }).pipe(Effect.catch((error) => Effect.succeed(responseError(error)))))
  )
}))
