import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { unzipSync } from "fflate";

test("完整ZIP可在没有仓库和node_modules的目录中运行且哈希清单匹配", () => {
  const directory = mkdtempSync(join(tmpdir(), "autoops-customer-distribution-"));
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
    for (const [filename, metadata] of Object.entries(manifest.files) as Array<[string, { bytes: number; sha256: string }]>) {
      const bytes = readFileSync(join(artifact, filename));
      assert.equal(bytes.length, metadata.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), metadata.sha256);
    }
    const binary = join(artifact, "autoops-customer-agent.mjs");
    const options = { cwd: directory, encoding: "utf8" as const, env: { ...process.env, PATH: "", NODE_PATH: "" } };
    assert.match(execFileSync(process.execPath, [binary, "--help"], options), /connect --url/);
    assert.match(execFileSync(process.execPath, [binary, "--help"], options), /validate-profile --shared-profile/);
    assert.ok(manifest.files['shared-container-entry.mjs']);
    const status = JSON.parse(execFileSync(process.execPath, [binary, "status", "--state-dir", join(directory, "state")], options));
    assert.equal(status.deviceId, null); assert.deepEqual(status.workspaces, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
