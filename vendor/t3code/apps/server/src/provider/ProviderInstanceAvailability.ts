import type { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
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
    }) => Effect.Effect<boolean | undefined>;
  }
>()("t3/provider/ProviderInstanceAvailability") {}
