import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomerAgentStore } from "./store.ts";
import { CustomerWorkspaceFiles, resolveCustomerFileReferences } from "./files.ts";
import {
  CUSTOMER_FILE_LIMITS,
  customerFileReference,
} from "../../vendor/t3code/packages/contracts/src/customerFiles.ts";
import { serializeComposerFileLink } from "../../vendor/t3code/packages/shared/src/composerTrigger.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "autoops-files-")),
    directory = join(root, "project");
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src", "中文 (测试).ts"), "export const code = '原始内容';\n");
  const store = new CustomerAgentStore(join(root, "state"));
  const target = store.register(directory, "project", "隔离文件目录");
  const files = new CustomerWorkspaceFiles(store);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, store, target, files, signal: new AbortController().signal };
}

test("按需目录与本机搜索只返回相对身份，跳过依赖目录", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, "node_modules"));
  await writeFile(join(f.directory, "node_modules", "hidden.ts"), "依赖");
  const listed = await f.files.read(f.target, { operation: "list" }, f.signal);
  assert.deepEqual(
    listed.entries.map((item) => item.path),
    ["node_modules", "src"],
  );
  const result = await f.files.read(f.target, { operation: "search", query: "测试" }, f.signal);
  assert.deepEqual(result.entries, [{ path: "src/中文 (测试).ts", kind: "file" }]);
  assert.equal(
    (await f.files.read(f.target, { operation: "search", query: "hidden" }, f.signal)).entries
      .length,
    0,
  );
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(f.store.sessions().length, 0);
});

test("大文件只传前16KiB，二进制只回元数据", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "large.txt"), "甲".repeat(100_000));
  const result = await f.files.read(
    f.target,
    { operation: "preview", path: "large.txt" },
    f.signal,
  );
  assert.equal(result.truncated, true);
  assert.equal(result.preview?.size, 300_000);
  assert(Buffer.byteLength(result.preview!.contents!) <= CUSTOMER_FILE_LIMITS.previewBytes);
  assert(Buffer.byteLength(JSON.stringify(result)) <= CUSTOMER_FILE_LIMITS.responseBytes);
  await writeFile(join(f.directory, "photo.png"), Buffer.from([0, 1, 2, 3]));
  const binary = await f.files.read(
    f.target,
    { operation: "preview", path: "photo.png" },
    f.signal,
  );
  assert.equal(binary.preview?.binary, true);
  assert.equal(binary.preview?.contents, undefined);
});

test("越界、链接和撤销目录均拒绝，取消不会创建执行状态", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "secret.txt"), "不可读取");
  await symlink(f.root, join(f.directory, "escape"), "dir");
  for (const path of [
    "../secret.txt",
    "/etc/passwd",
    "C:/secret",
    "src/../x",
    "escape/secret.txt",
    "src\\file",
  ]) {
    await assert.rejects(f.files.read(f.target, { operation: "preview", path }, f.signal));
  }
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.files.read(f.target, { operation: "search", query: "x" }, abort.signal));
  f.store.revoke(f.target.registeredWorkspaceId);
  await assert.rejects(f.files.read(f.target, { operation: "list" }, f.signal));
  assert.equal(f.store.sessions().length, 0);
});

test("引用在真正执行时读取当前文件，删除和跨登记身份拒绝", async (t) => {
  const f = await fixture(t),
    target = { deviceId: "device-a", ...f.target };
  const ref = customerFileReference(target, "src/中文 (测试).ts");
  const text = serializeComposerFileLink(ref) + " 分析这个文件";
  const message = {
    text,
    context: { version: 1, records: [{ kind: "mention", path: ref, label: "中文 (测试).ts" }] },
  };
  const resolved = (await resolveCustomerFileReferences(
    f.store,
    "device-a",
    f.target,
    message,
    f.signal,
  )) as typeof message;
  assert(resolved.text.includes(encodeURI(f.directory)));
  assert.equal(resolved.context.records[0]!.path, join(f.target.realPath, "src/中文 (测试).ts"));
  assert.equal(message.text, text);
  await assert.rejects(
    resolveCustomerFileReferences(f.store, "device-b", f.target, message, f.signal),
  );
  await rm(join(f.directory, "src/中文 (测试).ts"));
  await assert.rejects(
    resolveCustomerFileReferences(f.store, "device-a", f.target, message, f.signal),
  );
});

test("目录身份替换后不会读取新目录，列表数量有界", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 160; i++) await writeFile(join(f.directory, `${i}.txt`), "x");
  const result = await f.files.read(f.target, { operation: "list" }, f.signal);
  assert.equal(result.entries.length, CUSTOMER_FILE_LIMITS.entries);
  assert.equal(result.truncated, true);
  await rename(f.directory, f.directory + "-old");
  await mkdir(f.directory);
  await assert.rejects(f.files.read(f.target, { operation: "list" }, f.signal));
});
