// @effect-diagnostics globalFetch:off - The MCP SDK fetch hook exercises its real HTTP transport and negotiated wire version.
import { assert, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { McpServer, McpSchema, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

for (const protocolVersion of ["2025-06-18", "2025-11-25"])
  it.effect(`preserves actual form enum options over HTTP for MCP ${protocolVersion}`, () =>
    Effect.gen(function* () {
      const toolkit = Toolkit.make(
        Tool.make("question_probe", {
          description: "Transport-only question probe",
          success: Schema.Struct({ answer: Schema.String }),
          failure: McpSchema.ElicitationDeclined,
          parameters: Tool.EmptyParams,
        }),
      );
      const serverLayer = McpHttpServer.toolkitRegistration(
        toolkit,
        McpToolAccess.toLayer(toolkit, {
          question_probe: McpToolAccess.reads(() =>
            Effect.gen(function* () {
              const caller = yield* Effect.serviceOption(McpSchema.McpServerClient);
              if (Option.isNone(caller)) return yield* Effect.die("Missing actual HTTP MCP client");
              return yield* McpServer.elicit({
                message: "Choose a release scope",
                schema: Schema.Struct({ answer: Schema.Literals(["test", "production"]) }),
              }).pipe(Effect.provideService(McpSchema.McpServerClient, caller.value));
            }),
          ),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make("metadata"),
                requestNamespace: "metadata",
                thread: {
                  threadId: ThreadId.make("metadata"),
                  providerSessionId: "metadata",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["autoops"]),
                issuedAt: 1,
              }),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const server = yield* HttpServer.HttpServer;
      const client = new Client(
        { name: "native-question-test", version: "1" },
        { capabilities: { elicitation: { form: {} } } },
      );
      const forms: Array<unknown> = [];
      const negotiatedVersions: Array<string> = [];
      const protocolFetch: typeof fetch = async (input, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (body?.method === "initialize") {
          body.params.protocolVersion = protocolVersion;
          const response = await fetch(input, { ...init, body: JSON.stringify(body) });
          const payload = (await response.clone().json()) as {
            result?: { protocolVersion?: string };
          };
          if (payload.result?.protocolVersion)
            negotiatedVersions.push(payload.result.protocolVersion);
          return response;
        }
        return fetch(input, init);
      };
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        forms.push(request.params);
        return { action: "accept" as const, content: { answer: "test" } };
      });
      yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          client.connect(
            // @ts-expect-error The SDK Transport callbacks include explicit undefined under exactOptionalPropertyTypes.
            new StreamableHTTPClientTransport(
              new URL(HttpServer.formatAddress(server.address) + "/mcp"),
              {
                fetch: protocolFetch,
                requestInit: { headers: { Authorization: "Bearer test-only" } },
              },
            ),
          ),
        ),
        () => Effect.promise(() => client.close()),
      );
      const result = yield* Effect.tryPromise(() =>
        client.callTool({ name: "question_probe", arguments: {} }),
      );
      assert.equal(forms.length, 1);
      assert.deepEqual(negotiatedVersions, [protocolVersion]);
      const form = forms[0] as { message: string; requestedSchema: unknown };
      assert.equal(form.message, "Choose a release scope");
      assert.deepEqual(form.requestedSchema, {
        type: "object",
        properties: { answer: { type: "string", enum: ["test", "production"] } },
        required: ["answer"],
      });
      assert.notEqual(result.isError, true);
      assert.match(JSON.stringify(result), /test/);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );
