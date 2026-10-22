import * as Effect from 'effect/Effect';
import * as CodexClient from 'effect-codex-app-server/client';
import * as CodexErrors from 'effect-codex-app-server/errors';
import { isAutoOpsEnabled } from '../../../../../../agent-demo/t3-adapters/access.mjs';
import { assertBusinessNativeConfig } from '../../../../../../agent-demo/t3-adapters/native-catalog.mjs';

export const verifyNativePolicy = Effect.fn('AutoOps.verifyNativePolicy')(function* (client: CodexClient.CodexAppServerClient['Service']) {
  if (!isAutoOpsEnabled()) return;
  const response = yield* client.request('config/read', {includeLayers:false});
  yield* Effect.try({
    try: () => assertBusinessNativeConfig(response),
    catch: (cause) => new CodexErrors.CodexAppServerRequestError({
      code: -32600, method:'config/read', errorMessage:'AutoOps 原生配置验证失败；未启动模型请求。', cause,
    }),
  });
});
