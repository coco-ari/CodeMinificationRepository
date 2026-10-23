import * as Effect from 'effect/Effect'
import { HttpServerRequest } from 'effect/http'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import type { AutoOpsAccess } from '../../../../../../../agent-demo/t3-adapters/access.mjs'

/** 身份从原生会话取得，模块入口复用同一授权服务。 */
export function createBusinessHttpContext(access: AutoOpsAccess) {
  const principal = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const native = yield* auth.authenticateHttpRequest(request);
    return yield* Effect.try(() => access.principalForNativeSession(native.sessionId));
  });
  return { access, principal }
}
export type BusinessHttpContext = ReturnType<typeof createBusinessHttpContext>
