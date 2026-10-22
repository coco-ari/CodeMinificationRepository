import { resolveProductProfile } from "../../../../../../../../agent-demo/t3-adapters/product-profile.mjs";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit, type HtmlToolkit } from "./tools.ts";
import { requireToolThread } from "../../../../../../../../agent-demo/t3-adapters/access.mjs";

const authorizeBusinessCaller = Effect.gen(function* () {
  if (!process.env.AUTOOPS_T3_DATA_DIR) return;
  if (!resolveProductProfile().capabilities.interactiveArtifacts) return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: "精简版暂不开放交互作品。" });
  const scope = yield* McpInvocationContext.requireMcpCapability("autoops").pipe(Effect.mapError(() => new OrchestratorMcpFailure({ code: "capability_denied", message: "业务工具未授权。" })));
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "AutoOps HTML");
  yield* Effect.try({ try: () => requireToolThread(thread.threadId), catch: () => new OrchestratorMcpFailure({ code: "capability_denied", message: "业务会话授权已失效。" }) });
});

const INVALID_PAGE_ERRORS = new Set([
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
  "HtmlRenderPageTooLargeError",
  "HtmlRenderViewportHeightError",
]);

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: INVALID_PAGE_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const handlers = {
  // The headless browser runs on the host and can open local files, so only
  // agents T3 launched, which already work on this machine, get it.
  html_preview: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* authorizeBusinessCaller;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const { png, ...preview } = yield* htmlRender.preview(input).pipe(Effect.mapError(toFailure));
      return {
        ...preview,
        screenshot: {
          mimeType: "image/png" as const,
          data: png,
          width: preview.width,
          height: preview.capturedHeight,
        },
      };
    }),
  ),
  html_render: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* authorizeBusinessCaller;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "html_render");
      const htmlRender = yield* HtmlRender.HtmlRender;
      const reference = yield* htmlRender
        .publish({ threadId: thread.threadId, ...input })
        .pipe(Effect.mapError(toFailure));
      return {
        htmlRender: reference,
        message:
          "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof HtmlToolkit.tools>;

export const layerPreview = McpToolAccess.toLayer(HtmlPreviewToolkit, {
  html_preview: handlers.html_preview,
});

export const layerRender = McpToolAccess.toLayer(HtmlRenderToolkit, {
  html_render: handlers.html_render,
});
