import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { unzipSync } from "fflate";
import { CONNECTOR_VERSION } from './connection.ts';
import { CustomerAgentStore } from './store.ts';
import { writeCredentials } from './cli.ts';
import type { CustomerAgentCommand } from '../../vendor/t3code/packages/contracts/src/autoopsRemote.ts';

test("完整ZIP可在没有仓库和node_modules的目录中运行且哈希清单匹配", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "autoops-customer-distribution-")));
  try {
    const zip = readFileSync(new URL("../../dist/customer-agent.zip", import.meta.url));
    const expectedZipHash = readFileSync(new URL("../../dist/customer-agent.zip.sha256", import.meta.url), "utf8").split(" ")[0];
    assert.equal(createHash("sha256").update(zip).digest("hex"), expectedZipHash);
    const entries = unzipSync(zip);
    assert.ok(!Object.keys(entries).some((entry) => entry.endsWith(".map")));
    for (const [name, bytes] of Object.entries(entries)) {
      const target = resolve(directory, name);
      assert.ok(target.startsWith(`${resolve(directory)}${sep}`));
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
    }
    const artifact = join(directory, "customer-agent");
    const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8"));
    assert.equal(manifest.connectorVersion, CONNECTOR_VERSION);
    for (const [filename, metadata] of Object.entries(manifest.files) as Array<[string, { bytes: number; sha256: string }]>) {
      const bytes = readFileSync(join(artifact, filename));
      assert.equal(bytes.length, metadata.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), metadata.sha256);
    }
    const binary = join(artifact, "autoops-customer-agent.mjs");
    const options = { cwd: directory, encoding: "utf8" as const, env: { ...process.env, PATH: "", NODE_PATH: "" } };
    assert.match(execFileSync(process.execPath, [binary, "--help"], options), /connect --url/);
    assert.match(execFileSync(process.execPath, [binary, "--help"], options), /validate-profile --shared-profile/);
    assert.match(execFileSync(process.execPath, [binary, "--help"], options), /resolve --command-file/);
    assert.ok(manifest.files['shared-container-entry.mjs']);
    const status = JSON.parse(execFileSync(process.execPath, [binary, "status", "--state-dir", join(directory, "state")], options));
    assert.equal(status.deviceId, null); assert.deepEqual(status.workspaces, []);
    const source = join(directory, 'source'); mkdirSync(source);
    const state = join(directory, 'state'), store = new CustomerAgentStore(state);
    try {
      const workspace = store.register(source, 'fixture-source', '发行包隔离目录');
      const target = { registeredWorkspaceId: workspace.registeredWorkspaceId, workspaceBindingRevision: 1, runtimeId: 'codex' as const };
      const executionScope = {
        grantId: 'fixture-grant', actorId: 'fixture-caller', providerId: 'fixture-provider', projectId: 'fixture-project', sourceProjectId: 'fixture-source', threadId: 'fixture-thread', runId: 'fixture-run', assistantId: 'fixture-assistant', presetRevision: 1, shareRevision: 1,
        allocation: { kind: 'member' as const, id: 'fixture-caller', revision: 1 }, capabilityRevision: 'fixture-capability',
        profile: { id: 'fixture-profile', revision: 1, digest: 'a'.repeat(64), imageDigest: `sha256:${'b'.repeat(64)}`, policy: 'linux-docker-readonly-v1' as const },
        target: { kind: 'customer' as const, deviceId: 'fixture-device', ...target }, model: { instanceId: 'customer-fixture-device-codex', model: 'fixture-model', reasoningEffort: 'medium' as const }, skillIds: [],
      };
      const command: CustomerAgentCommand = { type: 'command', commandId: 'fixture-original-open', sessionId: 'fixture-original-session', method: 'openSession', target, executionScope, input: { privateInput: 'fixture-never-exported' } };
      const commandFingerprint = store.commandHash(command), file = join(directory, 'original.json');
      writeCredentials(state, { deviceId: 'fixture-device', token: 'fictional-device-token', baseUrl: 'http://127.0.0.1:1' });
      writeFileSync(file, JSON.stringify({ format: 'autoops-unseen-open-command-v1', method: 'openSession', receipt: 'missing', commandId: command.commandId, sessionId: command.sessionId, deviceId: 'fixture-device', providerId: 'fixture-provider', threadId: 'fixture-thread', grantId: 'fixture-grant', commandFingerprint, executionScope, exportedAt: new Date().toISOString() }), { mode: 0o600 });
      const output = execFileSync(process.execPath, [binary, 'resolve', '--state-dir', state, '--command-file', file, '--command', command.commandId, '--session', command.sessionId, '--provider', 'fixture-provider', '--thread', 'fixture-thread', '--grant', 'fixture-grant', '--workspace', workspace.registeredWorkspaceId, '--fingerprint', commandFingerprint, '--confirm-stopped'], options);
      assert.match(output, /结果不完整/); assert.doesNotMatch(output, /fictional-device-token|fixture-never-exported/);
      assert.equal(store.receipt(command)?.error?.code, 'CUSTOMER_MANUALLY_RECONCILED'); assert.deepEqual(store.sessions(), []);
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
