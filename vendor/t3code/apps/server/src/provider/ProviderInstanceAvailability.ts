import type { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Optional host policy for dynamically registered providers. Undefined keeps
 * the existing T3 settings policy, including explicit project disables. */
export class ProviderInstanceAvailability extends Context.Service<
  ProviderInstanceAvailability,
  {
    readonly resolve: (input: {
      readonly projectId: ProjectId;
      readonly instanceId: ProviderInstanceId;
      /** 仅由原生启动/命令核心传入，用于核对原固定来源。 */
      readonly threadId?: ThreadId;
    }) => Effect.Effect<boolean | undefined>;
  }
>()("t3/provider/ProviderInstanceAvailability") {}
