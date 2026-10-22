import * as C from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import { RemoteDeviceService } from "./RemoteDeviceService.ts";
import { makeRemoteProviderAdapter } from "./RemoteProviderAdapter.ts";
import { customerProviderInstanceId } from "../../../../../../agent-demo/t3-adapters/customer-target.mjs";
import type { CustomerDevice } from "../../../../../../agent-demo/t3-adapters/customer-registry.mjs";
import { isCustomerAgentsEnabled } from "../../../../../../agent-demo/t3-adapters/customer-registry.mjs";
import { ProviderInstanceAvailability } from "../provider/ProviderInstanceAvailability.ts";

export const availabilityLayer = Layer.effect(
  ProviderInstanceAvailability,
  Effect.gen(function* () {
    const { hub } = yield* RemoteDeviceService;
    return {
      resolve: ({ projectId, instanceId }) =>
        Effect.sync(() => {
          if (!instanceId.startsWith("customer-")) return undefined;
          if (!hub || !isCustomerAgentsEnabled()) return false;
          const registry = hub.access.customerRegistry;
          const device = registry
            .listRegisteredDevices()
            .find(
              (item) =>
                customerProviderInstanceId({ deviceId: item.id, runtimeId: "codex" }) ===
                instanceId,
            );
          if (!device || device.status !== "active") return false;
          try {
            return registry
              .listWorkspaces(device.ownerId, projectId)
              .some(
                (workspace) => workspace.deviceId === device.id && workspace.status === "active",
              );
          } catch {
            return false;
          }
        }),
    };
  }),
);

/** Decorates T3's existing registry. No remote executable runs on the center. */
export const layer = Layer.effect(
  ProviderInstances.ProviderInstanceRegistry,
  Effect.gen(function* () {
    const base = yield* ProviderInstances.ProviderInstanceRegistry;
    const { hub } = yield* RemoteDeviceService;
    if (!hub) return base;
    const changes = yield* PubSub.unbounded<void>();
    const unsubscribe = hub.access.customerRegistry.subscribeChanges(() => {
      PubSub.publishUnsafe(changes, undefined);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const baseChanges = yield* base.subscribeChanges;
    yield* Stream.fromSubscription(baseChanges).pipe(
      Stream.runForEach(() => PubSub.publish(changes, undefined)),
      Effect.forkScoped,
    );
    const instances = new Map<string, ProviderInstance>();
    const snapshotFor = (deviceId: string): C.ServerProvider => {
      const registry = hub.access.customerRegistry;
      const device = registry.listRegisteredDevices().find((item) => item.id === deviceId)!;
      const models = new Map<string, C.ServerProviderModel>();
      // This is an aggregate discovery view only. Per-workspace selection is validated
      // again against its own cached capability revision immediately before dispatch.
      if (device.status === "active")
        for (const workspace of registry
          .listWorkspaces(device.ownerId)
          .filter((w) => w.deviceId === deviceId && w.status === "active")) {
          const catalog = registry.getCapabilities(device.ownerId, {
            kind: "customer",
            deviceId: workspace.deviceId,
            registeredWorkspaceId: workspace.registeredWorkspaceId,
            workspaceBindingRevision: workspace.workspaceBindingRevision,
            runtimeId: workspace.runtimeId,
          });
          for (const model of catalog?.models ?? [])
            models.set(model.id, {
              slug: model.id,
              name: model.name ?? model.id,
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: model.supportedReasoningEfforts.length
                  ? [
                      {
                        id: "reasoningEffort",
                        label: "思考强度",
                        type: "select",
                        options: model.supportedReasoningEfforts.map((id) => ({ id, label: id })),
                      },
                    ]
                  : [],
              }),
            });
        }
      return {
        ...buildServerProvider({
          presentation: {
            displayName: device.label,
            supportedRuntimeModes: ["approval-required"],
            showInteractionModeToggle: false,
            supportsConversationRollback: false,
          },
          enabled: true,
          checkedAt: device.lastSeenAt ?? device.createdAt,
          models: [...models.values()],
          skills: [],
          probe: {
            installed: true,
            // The connector package version is not the Codex CLI version.
            // Only a workspace capability snapshot may report a runtime version.
            version: null,
            status: device.online && device.status === "active" ? "ready" : "error",
            auth: { status: "authenticated" },
            ...(!device.online ? { message: "客户设备离线，历史仍可查看" } : {}),
          },
        }),
        instanceId: C.ProviderInstanceId.make(
          customerProviderInstanceId({ deviceId, runtimeId: "codex" }),
        ),
        driver: C.ProviderDriverKind.make("codex"),
      };
    };
    const get = (device: CustomerDevice): ProviderInstance => {
      const instanceId = C.ProviderInstanceId.make(
        customerProviderInstanceId({ deviceId: device.id, runtimeId: "codex" }),
      );
      const existing = instances.get(instanceId);
      if (existing) return existing;
      const read = Effect.sync(() => snapshotFor(device.id));
      const unsupported = () =>
        Effect.fail(
          new C.TextGenerationError({ operation: "customer", detail: "客户首版未开放此操作" }),
        );
      const instance: ProviderInstance = {
        instanceId,
        driverKind: C.ProviderDriverKind.make("codex"),
        continuationIdentity: {
          driverKind: C.ProviderDriverKind.make("codex"),
          continuationKey: `customer:${device.id}:codex`,
        },
        displayName: device.label,
        enabled: true,
        snapshot: {
          getSnapshot: read,
          refresh: read,
          streamChanges: Stream.fromPubSub(changes).pipe(Stream.mapEffect(() => read)),
          resolveMaintenance: () =>
            Effect.succeed({
              provider: C.ProviderDriverKind.make("codex"),
              packageName: null,
              update: null,
            }),
          applyUsageLimits: () => Effect.void,
        },
        orchestrationAdapter: makeRemoteProviderAdapter(hub, instanceId),
        textGeneration: {
          generateCommitMessage: unsupported,
          generatePrContent: unsupported,
          generateBranchName: unsupported,
          generateReviewGuide: unsupported,
          generateThreadTitle: (input) =>
            Effect.succeed({
              title: input.message.trim().split("\n")[0]?.slice(0, 64) || "客户对话",
            }),
        },
      };
      instances.set(instanceId, instance);
      return instance;
    };
    const all = Effect.sync(() => hub.access.customerRegistry.listRegisteredDevices().map(get));
    return {
      getInstance: (id) =>
        base
          .getInstance(id)
          .pipe(
            Effect.flatMap((found) =>
              found
                ? Effect.succeed(found)
                : all.pipe(Effect.map((values) => values.find((value) => value.instanceId === id))),
            ),
          ),
      listInstances: Effect.all([base.listInstances, all]).pipe(
        Effect.map(([platform, remote]) => [...platform, ...remote]),
      ),
      listUnavailable: base.listUnavailable,
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    };
  }),
);
