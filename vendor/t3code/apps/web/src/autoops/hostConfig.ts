import { ProviderInstanceId } from '@t3tools/contracts'
import { installClientHostIntegration } from '@t3tools/client-runtime/host-integration'
import { installAutoOpsHostSnapshot, type AutoOpsT3Bootstrap } from './hostSnapshot'
import { authorizeThreadLaunch, readKnownAutoOpsThreadScope } from './threadScopes'

// 保留既有宿主公开入口；快照不依赖业务，会话范围通过统一请求客户端读取。
export { readAutoOpsHost, autoOpsStorage, autoOpsStorageKey } from './hostSnapshot'
export type { AutoOpsT3Bootstrap } from './hostSnapshot'
export {
  subscribeAutoOpsThreadScopes,
  readKnownAutoOpsThreadScope,
  sameAutoOpsThreadScope,
  readAutoOpsThreadScope,
  setAutoOpsThreadScope,
  inheritAutoOpsThreadScope,
  reserveAutoOpsThreadScope,
  loadAutoOpsThreadScope,
  findAutoOpsThreadScope,
} from './threadScopes'
export type { AutoOpsExecutionBinding, AutoOpsThreadScope } from './threadScopes'

/** 组合已认证宿主与 T3 原生启动钩子，不持有业务请求或会话缓存。 */
export function installAutoOpsHost(input: AutoOpsT3Bootstrap, origin: string) {
  const host = installAutoOpsHostSnapshot(input, origin)
  installClientHostIntegration({
    beforeThreadLaunch: authorizeThreadLaunch,
    turnConfiguration: (context) => ({
      ...(host.modelSelectionEnabled ||
      (context &&
        readKnownAutoOpsThreadScope(context.threadId)?.executionBinding?.kind === 'customer')
        ? {}
        : {
            modelSelection: {
              ...host.fixedModel,
              instanceId: ProviderInstanceId.make(host.fixedModel.instanceId),
            },
          }),
      runtimeMode: host.runtimeMode,
    }),
  })
  return host
}
