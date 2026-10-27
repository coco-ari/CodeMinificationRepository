// @effect-diagnostics nodeBuiltinImport:off -- Tests own a temporary fake CLI process and its fixture files.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as C from "@t3tools/contracts";
import {
  customerScopedIds,
  createHeadlessCodexRunner,
  makeCustomerCodexHost,
  customerRuntimePolicy,
} from "./HeadlessCodexRunner.ts";

import {
  validateCustomerEvent,
  validateCustomerResult,
} from "../autoops/CustomerEventValidation.ts";
import type { TransportSession } from "../../../../../../agent-demo/t3-adapters/customer-transport.mjs";

describe("customer Codex execution", () => {
  it("keeps old plain MCP configuration and disables only its previously attached platform channel", async () => {
    let active = false;
    const host = makeCustomerCodexHost(undefined, (id) =>
      active && id === "thread-a"
        ? {
            endpoint: "http://127.0.0.1:18767/mcp",
            authorizationHeader: "Bearer fixture-only",
            contextId: "fixed-context",
          }
        : undefined,
    );
    const threadId = C.ThreadId.make("thread-a");
    expect(host.threadParameters(threadId).config?.["mcp_servers.t3-code"]).toBeUndefined();
    active = true;
    expect((await Effect.runPromise(host.mcpSessions.read(threadId)))?.providerSessionId).toBe(
      "fixed-context",
    );
    expect(
      await Effect.runPromise(host.mcpSessions.read(C.ThreadId.make("foreign-thread"))),
    ).toBeUndefined();
    active = false;
    expect(await Effect.runPromise(host.mcpSessions.read(threadId))).toBeUndefined();
    expect(host.threadParameters(threadId).config?.["mcp_servers.t3-code"]).toEqual({
      enabled: false,
      url: "http://127.0.0.1:18767/mcp",
    });
  });

  it("isolates identical native IDs across customer conversations", async () => {
    const base = await Effect.runPromise(
      IdAllocator.IdAllocatorV2.pipe(Effect.provide(IdAllocator.layer)),
    );
    const one = customerScopedIds(base, () => "customer:device-a:thread-one:");
    const two = customerScopedIds(base, () => "customer:device-a:thread-two:");
    const input = { driver: C.ProviderDriverKind.make("codex"), nativeItemId: "native-item" };
    expect(one.derive.nodeFromProviderItem(input)).not.toBe(two.derive.nodeFromProviderItem(input));
    expect(one.derive.messageFromProviderItem(input)).toContain(
      encodeURIComponent("customer:device-a:thread-one:"),
    );
    expect(one.derive.turnItemFromProviderItem(input)).not.toBe(
      base.derive.turnItemFromProviderItem(input),
    );
    const turn = { driver: input.driver, nativeTurnId: "native-turn" };
    expect(one.derive.providerTurn(turn)).not.toBe(two.derive.providerTurn(turn));
    const request = await Effect.runPromise(
      one.allocate.runtimeRequest({ driver: input.driver, nativeRequestId: "approval" }),
    );
    expect(request).toContain(encodeURIComponent("customer:device-a:thread-one:approval"));
  });

  it("never promotes a local policy to automatic approval or full access", () => {
    const policy = customerRuntimePolicy("/workspace", {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      networkAccess: false,
    });
    expect(policy.runtimeMode).toBe("auto-accept-edits");
    expect(policy.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
      networkAccess: false,
    });
    expect(() =>
      customerRuntimePolicy("/workspace", {
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        networkAccess: false,
      } as never),
    ).toThrow();
  });

  it.each([
    "foreground",
    "background",
    "approval-stop",
    "stop-unconfirmed",
    "platform-tools",
    "platform-tools-loaded",
    "platform-tools-name-failure",
    "platform-tools-unsubscribe-failure",
    "platform-tools-resume-failure",
  ] as const)(
    "reuses native events and %s terminal completion without platform services",
    async (mode) => {
      const platformMode = mode.startsWith("platform-tools");
      const platformFailure = mode.endsWith("-failure");
      const directory = await mkdtemp(join(tmpdir(), "autoops-headless-codex-"));
      const fixture = (
        await readFile(
          new URL(
            "../orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson",
            import.meta.url,
          ),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const responses = Object.fromEntries(
        fixture
          .filter(
            (entry) =>
              entry.type === "emit_inbound" && entry.frame?.id !== undefined && entry.frame?.result,
          )
          .map((entry) => [entry.label, entry.frame.result]),
      );
      responses["thread/resume"] = responses["thread/start"];
      const notifications = fixture
        .filter(
          (entry) =>
            entry.type === "emit_inbound" &&
            [
              "turn/started",
              "item/started",
              "item/agentMessage/delta",
              "item/completed",
              "turn/completed",
            ].includes(entry.frame?.method),
        )
        .map((entry) => entry.frame);
      // Exercise the real approval converter as well as text streaming, without executing a shell command.
      const approvalFixture = (
        await readFile(
          new URL(
            "../orchestration-v2/testkit/fixtures/subagent_v2_approval/codex_transcript.ndjson",
            import.meta.url,
          ),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const nativeApproval = approvalFixture.find(
        (entry) =>
          entry.type === "emit_inbound" &&
          entry.frame?.method === "item/commandExecution/requestApproval",
      ).frame;
      const mapApproval = (frame: Record<string, any>): Record<string, any> => ({
        ...frame,
        ...(frame.method === "item/commandExecution/requestApproval"
          ? { id: "approval-fixture" }
          : {}),
        params: {
          ...frame.params,
          threadId: responses["thread/start"].thread.id,
          ...(frame.params.turnId ? { turnId: responses["turn/start"].turn.id } : {}),
          ...(frame.method === "item/commandExecution/requestApproval"
            ? { reason: "Allow this fixture command outside the workspace?" }
            : {}),
          ...(frame.method === "serverRequest/resolved" ? { requestId: "approval-fixture" } : {}),
        },
      });
      const approvalNotifications = approvalFixture
        .filter(
          (entry) =>
            entry.type === "emit_inbound" &&
            (entry.frame?.params?.item?.id === nativeApproval.params.itemId ||
              entry.frame?.method === "item/commandExecution/requestApproval" ||
              entry.frame?.method === "serverRequest/resolved"),
        )
        .map((entry) => mapApproval(entry.frame));
      const beforeApproval = approvalNotifications.filter((frame) =>
        ["item/started", "item/commandExecution/requestApproval"].includes(frame.method),
      );
      const afterApproval = approvalNotifications.filter((frame) =>
        ["item/completed", "serverRequest/resolved"].includes(frame.method),
      );
      const backgroundItem =
        mode === "background"
          ? {
              ...beforeApproval.find((frame) => frame.method === "item/started")!,
              params: {
                ...beforeApproval.find((frame) => frame.method === "item/started")!.params,
                item: {
                  ...beforeApproval.find((frame) => frame.method === "item/started")!.params.item,
                  id: "customer-background",
                  processId: "bg-process",
                  status: "inProgress",
                },
              },
            }
          : null;
      if (backgroundItem) notifications.splice(notifications.length - 1, 0, backgroundItem);
      const approval = Promise.withResolvers<string>();
      const logPath = join(directory, "requests.jsonl");
      const pidPath = join(directory, "processes.jsonl");
      const binaryPath = writeFakeCli({
        directory,
        name: "codex",
        source: `
      import { createInterface } from 'node:readline';
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(pidPath)}, process.pid + '\\n');
      const responses = ${JSON.stringify(responses)};
      const notifications = ${JSON.stringify(notifications)};
      const approvalStart = ${JSON.stringify(beforeApproval)};
      const approvalEnd = ${JSON.stringify(afterApproval)};
      const background = ${JSON.stringify(backgroundItem)};
      const stopAtApproval = ${JSON.stringify(mode === "approval-stop")};
      const stopUnconfirmed = ${JSON.stringify(mode === "stop-unconfirmed")};
      const platformMode = ${JSON.stringify(platformMode)};
      const failAt = ${JSON.stringify(platformFailure ? `thread/${mode.split("-")[2] === "name" ? "name/set" : mode.split("-")[2]}` : null)};
      let materialized = ${JSON.stringify(mode === "platform-tools-loaded")};
      let historyMode = 'paginated';
      let subscribed = false;
      let appliedMcp;
      let turnOrdinal = 0;
      const send = value => {
        if (platformMode && turnOrdinal > 1 && value.params) {
          value = structuredClone(value);
          if (value.params.turn) value.params.turn.id = responses['turn/start'].turn.id + '-' + turnOrdinal;
          if (value.params.turnId) value.params.turnId = responses['turn/start'].turn.id + '-' + turnOrdinal;
          if (value.params.item?.id) value.params.item.id += '-' + turnOrdinal;
        }
        process.stdout.write(JSON.stringify(value) + '\\n');
      };
      createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line); appendFileSync(${JSON.stringify(logPath)}, line + '\\n');
        if (message.id === 'approval-fixture' && message.result) {
          if (!stopAtApproval) { approvalEnd.forEach(send); notifications.slice(1).forEach(send); }
          return;
        }
        if (message.id === undefined) return;
        // 对齐锁定0.159.2：空线程不能resume；仍有订阅者时成功响应也不会应用覆盖值。
        if (platformMode && message.method === failAt) {
          send({id:message.id,error:{code:-32600,message:'Fixture rejected ' + failAt}});return;
        }
        if (platformMode && message.method === 'thread/name/set') {
          if (message.params.threadId !== responses['thread/start'].thread.id || message.params.name !== 'Customer') {
            send({id:message.id,error:{code:-32600,message:'Fixture title or original thread identity changed'}});return;
          }
          if (historyMode === 'legacy') materialized = true;
          send({id:message.id,result:{}});return;
        }
        if (platformMode && message.method === 'thread/unsubscribe') {
          subscribed = false;send({id:message.id,result:{status:'unsubscribed'}});return;
        }
        if (platformMode && message.method === 'thread/start') {
          historyMode = message.params.historyMode ?? 'paginated';
          subscribed = true;appliedMcp = message.params.config?.['mcp_servers.t3-code'];
        }
        if (platformMode && message.method === 'thread/resume') {
          const mcp = message.params.config?.['mcp_servers.t3-code'];
          if (mcp?.enabled === false && (!mcp.url && !mcp.command)) {
            send({id:message.id,error:{code:-32600,message:'failed to load configuration: invalid transport in mcp_servers.t3-code'}});return;
          }
          if (mcp?.enabled === false && mcp.http_headers?.Authorization !== undefined) {
            send({id:message.id,error:{code:-32600,message:'Disabled platform channel retained Authorization'}});return;
          }
          if (!materialized) {
            send({id:message.id,error:{code:-32600,message:'no rollout found for thread id fixture'}});return;
          }
          if (!subscribed) appliedMcp = message.params.config?.['mcp_servers.t3-code'];
          subscribed = true;
        }
        if (platformMode && message.method === 'turn/start') {
          turnOrdinal++;
          const expected = turnOrdinal === 1 ? 'Bearer fixture-local-channel' : 'Bearer fixture-local-channel-2';
          if (turnOrdinal < 3 ? appliedMcp?.http_headers?.Authorization !== expected : appliedMcp?.enabled !== false) {
            send({id:message.id,error:{code:-32600,message:'Current platform channel was not applied'}});return;
          }
        }
        if (message.method === 'turn/interrupt' && stopUnconfirmed) {
          send({id:message.id,error:{code:-32603,message:'Interrupt outcome could not be confirmed'}});return;
        }
        if (message.method === 'turn/interrupt' && stopAtApproval) {
          send({id:message.id,result:{}});
          const terminal = notifications.find(frame => frame.method === 'turn/completed');
          send({...terminal,params:{...terminal.params,turn:{...terminal.params.turn,status:'interrupted'}}});return;
        }
        if (message.method === 'thread/backgroundTerminals/terminate') {
          // Deliver a terminal notification before the RPC response, as the real app-server can.
          send({...background,method:'item/completed',params:{...background.params,item:{...background.params.item,status:'completed',exitCode:0,durationMs:1}}});
          send({id:message.id,result:{terminated:true}});return;
        }
        let result;
        if (message.method === 'model/list') result = { data: [{ id:'gpt-6-luna',model:'gpt-6-luna',displayName:'GPT-6-Luna',description:'Fixture model',hidden:false,isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium'}]}], nextCursor:null };
        else if (message.method === 'skills/list') result = {data:[{cwd:${JSON.stringify(directory)},errors:[],skills:[{name:'local-build',path:${JSON.stringify(join(directory, "skills/local-build/SKILL.md"))},enabled:true,description:'Build locally',scope:'repo'}]}]};
        else result = responses[message.method];
        if (result === undefined) return send({id:message.id,error:{code:-32601,message:'Unsupported fixture method'}});
        if (platformMode && message.method === 'turn/start' && turnOrdinal > 1) {
          result = structuredClone(result);result.turn.id += '-' + turnOrdinal;
        }
        send({id:message.id,result});
        if (message.method === 'turn/start') setImmediate(() => {
          send(notifications[0]);
          if (turnOrdinal > 1) notifications.slice(1).forEach(send);
          else approvalStart.forEach(send);
        });
      });
    `,
      });
      const events: Array<Record<string, any>> = [];
      const completed = Promise.withResolvers<void>();
      let terminal = completed;
      const instanceId = "customer-fixture-codex";
      const transportSession: TransportSession = {
        sessionId: "session-customer",
        deviceId: "fixture",
        threadId: "thread-customer",
        ownerId: "owner",
        projectId: "project-customer",
        target: {
          registeredWorkspaceId: "workspace",
          workspaceBindingRevision: 1,
          runtimeId: "codex",
        },
        runs: [
          {
            runId: "run-customer",
            attemptId: "attempt-customer",
            rootNodeId: "node-customer",
            runOrdinal: 1,
            providerTurnOrdinal: 1,
          },
        ],
      };
      const modelSelection = {
        instanceId,
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "medium" }],
      };
      const runtimePolicy = {
        cwd: "/untrusted-central-path",
        runtimeMode: "full-access",
        interactionMode: "plan",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
      let closedCatalogs = 0;
      let platformToolsActive = false;
      let platformToolsNonce = "fixture-local-channel";
      const runner = await createHeadlessCodexRunner({
        instanceId,
        cwd: directory,
        binaryPath,
        ...(platformMode
          ? {
              readPlatformToolsSession: (id: string) =>
                platformToolsActive && id === "thread-customer"
                  ? {
                      endpoint: "http://127.0.0.1:18767/mcp",
                      authorizationHeader: `Bearer ${platformToolsNonce}`,
                      contextId: "context-fixed",
                    }
                  : undefined,
            }
          : {}),
        onEvent: (event) => {
          const value = event as Record<string, any>;
          events.push(value);
          if (value.type === "runtime_request.updated" && value.runtimeRequest.status === "pending")
            approval.resolve(value.runtimeRequest.id);
          if (value.type === "turn.terminal") terminal.resolve();
        },
        onError: (error) => terminal.reject(error),
        openCatalogProcess: async () => ({
          agentScope: {
            wrap: (input) => Effect.succeed(input),
            oomKilled: () => Effect.succeed(false),
            clear: () => Effect.void,
          },
          close: async () => {
            const pids = (await readFile(pidPath, "utf8")).trim().split("\n").map(Number);
            expect(() => process.kill(pids.at(-1)!, 0)).toThrow();
            closedCatalogs++;
          },
        }),
      });
      try {
        const catalog = await runner.catalog();
        expect(catalog.skills.map((skill) => skill.name)).toEqual(["local-build"]);
        expect(catalog.models[0]?.slug).toBe("gpt-6-luna");
        expect(closedCatalogs).toBe(1);
        const opened = (await runner.dispatch("openSession", {
          threadId: "thread-customer",
          providerSessionId: "session-customer",
          modelSelection,
          runtimePolicy,
        })) as Record<string, any>;
        expect(validateCustomerResult(transportSession, "openSession", opened)).toMatchObject({
          cwd: "customer://fixture/workspace",
        });
        expect(opened.providerInstanceId).toBe(instanceId);
        expect(closedCatalogs).toBe(2);
        expect(opened.capabilities.subagents.supportsSubagents).toBe(false);
        const providerThread = (await runner.dispatch("ensureThread", {
          threadId: "thread-customer",
          modelSelection,
          runtimePolicy,
        })) as Record<string, any>;
        expect(() =>
          validateCustomerResult(transportSession, "ensureThread", providerThread),
        ).not.toThrow();
        transportSession.providerThreadId = providerThread.id;
        const beforeActiveCatalog = closedCatalogs;
        await runner.catalog();
        expect(closedCatalogs).toBe(beforeActiveCatalog);
        await expect(
          runner.dispatch("ensureThread", {
            threadId: "thread-other",
            modelSelection,
            runtimePolicy,
          }),
        ).rejects.toThrow("immutable");
        const now = "2026-10-22T00:00:00.000Z";
        const turn = {
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: "thread-customer",
            projectId: "project-customer",
            title: "Customer",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: "thread-customer",
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId: "thread-customer",
          runId: "run-customer",
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: "attempt-customer",
          rootNodeId: "node-customer",
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: "message-customer",
            text: "Respond with the following text: fixture simple ok",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        };
        await expect(
          runner.dispatch("startTurn", {
            ...turn,
            modelSelection: { ...modelSelection, model: "missing-model" },
          }),
        ).rejects.toThrow("no longer available");
        await expect(
          runner.dispatch("startTurn", {
            ...turn,
            message: { ...turn.message, text: "$removed-skill" },
          }),
        ).rejects.toThrow();
        await expect(
          runner.dispatch("startTurn", {
            ...turn,
            message: { ...turn.message, text: "$local-build" },
            assistantConfiguration: { instructions: "", skillNames: [] },
          }),
        ).rejects.toThrow();
        platformToolsActive = platformMode;
        if (platformFailure) {
          await expect(
            runner.dispatch("startTurn", {
              ...turn,
              assistantConfiguration: {
                instructions: "只描述实际结果",
                skillNames: ["local-build"],
              },
            }),
          ).rejects.toThrow();
          const requests = (await readFile(logPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const boundary = `thread/${mode.split("-")[2] === "name" ? "name/set" : mode.split("-")[2]}`;
          const configurationMethods = ["thread/name/set", "thread/unsubscribe", "thread/resume"];
          expect(
            requests
              .filter((request) => configurationMethods.includes(request.method))
              .map((request) => request.method),
          ).toEqual(configurationMethods.slice(0, configurationMethods.indexOf(boundary) + 1));
          expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(0);
          expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
          return;
        }
        await runner.dispatch("startTurn", {
          ...turn,
          assistantConfiguration: { instructions: "只描述实际结果", skillNames: ["local-build"] },
        });
        const requestId = await approval.promise;
        if (mode === "approval-stop" || mode === "stop-unconfirmed") {
          const providerTurn = events.find(
            (event) => event.type === "provider_turn.updated",
          )!.providerTurn;
          const interruption = runner.dispatch("interruptTurn", {
            providerThread: turn.providerThread,
            providerTurnId: providerTurn.id,
          });
          if (mode === "stop-unconfirmed") {
            await expect(interruption).rejects.toThrow();
            expect(events.some((event) => event.type === "turn.terminal")).toBe(false);
          } else {
            await interruption;
          }
        } else {
          await runner.dispatch("respondToRuntimeRequest", { requestId, decision: "accept" });
        }
        if (mode !== "stop-unconfirmed") await completed.promise;
        if (mode === "approval-stop") {
          const cancelled = events.findIndex(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.id === requestId &&
              event.runtimeRequest.status === "cancelled",
          );
          expect(cancelled).toBeGreaterThan(-1);
          expect(cancelled).toBeLessThan(
            events.findIndex((event) => event.type === "turn.terminal"),
          );
          const cancelledRequest = events[cancelled]!.runtimeRequest;
          expect(
            events.some(
              (event) =>
                event.type === "node.updated" &&
                event.node.id === cancelledRequest.nodeId &&
                event.node.status === "cancelled",
            ),
          ).toBe(true);
          expect(
            events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.requestId === requestId &&
                event.turnItem.status === "cancelled",
            ),
          ).toBe(true);
          await expect(
            runner.dispatch("respondToRuntimeRequest", { requestId, decision: "accept" }),
          ).rejects.toThrow();
        }
        for (const event of events) {
          expect(
            () => validateCustomerEvent(transportSession, event),
            `native fixture event: ${JSON.stringify(event)}`,
          ).not.toThrow();
        }
        expect(
          events.some(
            (event) =>
              event.type === "message.updated" && event.message.text.includes("fixture simple ok"),
          ),
        ).toBe(mode === "foreground" || mode === "background" || platformMode);
        expect(
          events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "approval_request" &&
              event.turnItem.prompt?.includes(nativeApproval.params.command) &&
              event.turnItem.prompt?.includes(nativeApproval.params.cwd) &&
              event.turnItem.prompt?.includes("Allow this fixture command outside the workspace?"),
          ),
        ).toBe(true);
        const requests = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          requests.filter((request) => request.method === "thread/backgroundTerminals/terminate"),
        ).toHaveLength(mode === "background" ? 1 : 0);
        const start = requests.find((request) => request.method === "turn/start").params;
        expect(start.additionalContext?.autoops_assistant).toEqual({
          kind: "untrusted",
          value: "只描述实际结果",
        });
        expect(start.cwd).toBe(directory);
        expect(start.approvalPolicy).toBe("on-request");
        expect(start.approvalsReviewer).toBe("user");
        expect(start.sandboxPolicy.type).toBe("workspaceWrite");
        expect(
          start.input.some(
            (input: Record<string, any>) => input.type === "skill" && input.name === "local-build",
          ),
        ).toBe(true);
        const thread = requests.find((request) => request.method === "thread/start").params;
        expect(thread.config["features.multi_agent"]).toBe(false);
        if (platformMode) {
          expect(thread.config["mcp_servers.t3-code"]).toBeUndefined();
          expect(thread.historyMode).toBe("legacy");
          const resumed = requests.find((request) => request.method === "thread/resume");
          expect(resumed?.params.config["mcp_servers.t3-code"]).toMatchObject({
            enabled: true,
            url: "http://127.0.0.1:18767/mcp",
            http_headers: { Authorization: "Bearer fixture-local-channel" },
          });
          expect(requests.findIndex((request) => request.method === "thread/resume")).toBeLessThan(
            requests.findIndex((request) => request.method === "turn/start"),
          );
          // 下一轮必须换本轮nonce，再下一普通轮必须关闭旧桥，不能借稳定nonce逃避热配置。
          for (const ordinal of [2, 3]) {
            terminal = Promise.withResolvers<void>();
            platformToolsNonce = "fixture-local-channel-2";
            platformToolsActive = ordinal === 2;
            await runner.dispatch("startTurn", {
              ...turn,
              runId: `run-customer-${ordinal}`,
              attemptId: `attempt-customer-${ordinal}`,
              rootNodeId: `node-customer-${ordinal}`,
              runOrdinal: ordinal,
              providerTurnOrdinal: ordinal,
              message: { ...turn.message, messageId: `message-customer-${ordinal}` },
            });
            await terminal.promise;
          }
          const finalRequests = (await readFile(logPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(finalRequests.filter((request) => request.method === "thread/start")).toHaveLength(
            1,
          );
          expect(finalRequests.filter((request) => request.method === "turn/start")).toHaveLength(
            3,
          );
          expect(
            finalRequests.filter((request) => request.method === "thread/name/set"),
          ).toHaveLength(3);
          expect(
            finalRequests.filter((request) => request.method === "thread/unsubscribe"),
          ).toHaveLength(3);
          const plain = finalRequests
            .filter((request) => request.method === "thread/resume")
            .at(-1);
          expect(plain.params.config["mcp_servers.t3-code"]).toEqual({
            enabled: false,
            url: "http://127.0.0.1:18767/mcp",
          });
          expect(
            finalRequests
              .filter((request) => request.method === "thread/resume")
              .every((request) => request.params.historyMode === undefined),
          ).toBe(true);
        } else {
          expect(thread.config["mcp_servers.t3-code"]).toBeUndefined();
          expect(thread.historyMode).toBeUndefined();
        }
      } finally {
        await runner.close();
        await rm(directory, { recursive: true, force: true });
      }
      await expect(runner.catalog()).rejects.toThrow("closed");
    },
  );
});
