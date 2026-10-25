import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  CUSTOMER_FILE_LIMITS,
  decodeCustomerFileInput,
  customerFilePathForTarget,
  type CustomerFileResult,
  validCustomerRelativePath,
} from "../../vendor/t3code/packages/contracts/src/customerFiles.ts";
import { collectComposerInlineTokens } from "../../vendor/t3code/packages/shared/src/composerInlineTokens.ts";
import { serializeComposerFileLink } from "../../vendor/t3code/packages/shared/src/composerTrigger.ts";
import { ConnectorError, type CustomerAgentStore, type LocalWorkspace } from "./store.ts";
import type { CustomerAgentTarget } from "../../vendor/t3code/packages/contracts/src/autoopsRemote.ts";

const skipped = new Set([
  ".git",
  "node_modules",
  ".next",
  ".cache",
  ".venv",
  "dist",
  "build",
  "coverage",
]);
const fail = () => new ConnectorError("file_scope", "文件不存在或不属于已登记目录");

/** 每段都拒绝符号链接；登记目录身份仍由本机 store 校验。 */
export async function resolveCustomerFile(
  store: CustomerAgentStore,
  target: CustomerAgentTarget,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!validCustomerRelativePath(path, true)) throw fail();
  const workspace = store.resolveWorkspace(target);
  let current = workspace.realPath;
  for (const part of path ? path.split("/") : []) {
    signal?.throwIfAborted();
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw fail();
  }
  const resolved = await realpath(current);
  const rel = relative(workspace.realPath, resolved);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw fail();
  store.resolveWorkspace(target);
  return resolved;
}

/** 执行时解析当前本机文件，原消息和中心历史仍保存登记身份引用。 */
export async function resolveCustomerFileReferences(
  store: CustomerAgentStore,
  deviceId: string,
  target: CustomerAgentTarget,
  raw: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!raw || typeof raw !== "object") return raw;
  const message = raw as {
    text?: string;
    context?: { records?: Array<{ kind: string; path?: string }> };
  };
  const tokens = collectComposerInlineTokens((message.text ?? "") + "\n").filter(
    (token) => token.type === "mention" && token.value.startsWith("autoops-customer/"),
  );
  const paths = new Set([
    ...tokens.map((token) => token.value),
    ...(message.context?.records ?? []).flatMap((record) =>
      record.kind === "mention" && record.path ? [record.path] : [],
    ),
  ]);
  if (paths.size > 20)
    throw new ConnectorError("file_reference_limit", "一次最多引用 20 个电脑文件");
  const resolved = new Map<string, string>();
  for (const reference of paths) {
    const path = customerFilePathForTarget(reference, { deviceId, ...target });
    if (!path) throw fail();
    const absolute = await resolveCustomerFile(store, target, path, signal);
    if (!(await lstat(absolute)).isFile()) throw fail();
    resolved.set(reference, absolute);
  }
  let text = message.text ?? "";
  for (const token of [...tokens].reverse())
    text =
      text.slice(0, token.start) +
      serializeComposerFileLink(resolved.get(token.value)!) +
      text.slice(token.end);
  return {
    ...message,
    text,
    ...(message.context
      ? {
          context: {
            ...message.context,
            records: message.context.records?.map((record) =>
              record.kind === "mention" && record.path
                ? { ...record, path: resolved.get(record.path)! }
                : record,
            ),
          },
        }
      : {}),
  };
}

export class CustomerWorkspaceFiles {
  private readonly store: CustomerAgentStore;
  constructor(store: CustomerAgentStore) {
    this.store = store;
  }
  async read(
    target: CustomerAgentTarget,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<CustomerFileResult> {
    const input = decodeCustomerFileInput(raw);
    const path = input.path ?? "";
    const absolute = await resolveCustomerFile(this.store, target, path, signal);
    const result =
      input.operation === "preview"
        ? await this.preview(target, path, absolute, signal)
        : await this.entries(
            this.store.resolveWorkspace(target),
            path,
            input.operation === "search" ? (input.query ?? "") : null,
            signal,
          );
    signal.throwIfAborted();
    this.store.resolveWorkspace(target);
    if (Buffer.byteLength(JSON.stringify(result)) > CUSTOMER_FILE_LIMITS.responseBytes)
      throw new ConnectorError("file_response_limit", "文件结果过大，请缩小搜索范围");
    return result;
  }
  private async entries(
    workspace: LocalWorkspace,
    parent: string,
    query: string | null,
    signal: AbortSignal,
  ): Promise<CustomerFileResult> {
    const entries: CustomerFileResult["entries"][number][] = [];
    const directories = [parent];
    const limit =
      query === null ? CUSTOMER_FILE_LIMITS.entries : CUSTOMER_FILE_LIMITS.searchEntries;
    const needle = query?.toLocaleLowerCase() ?? "";
    let visited = 0,
      bytes = 0,
      truncated = false;
    const deadline = Date.now() + 1500;
    outer: for (let index = 0; index < directories.length; index++) {
      const directory = directories[index]!;
      let handle;
      try {
        handle = await opendir(await resolveCustomerFile(this.store, workspace, directory, signal));
      } catch (error) {
        if (directory === parent || signal.aborted) throw error;
        continue;
      }
      for await (const item of handle) {
        signal.throwIfAborted();
        if (++visited > 20_000 || Date.now() > deadline) {
          truncated = true;
          break outer;
        }
        if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
        const path = directory ? `${directory}/${item.name}` : item.name;
        if (!validCustomerRelativePath(path)) continue;
        const ignored = skipped.has(item.name);
        if (query !== null && item.isDirectory() && !ignored) directories.push(path);
        if (query !== null && !path.toLocaleLowerCase().includes(needle)) continue;
        const entry = {
          path,
          kind: item.isDirectory() ? ("directory" as const) : ("file" as const),
          ...(ignored ? { ignored: true } : {}),
        };
        bytes += Buffer.byteLength(JSON.stringify(entry));
        if (entries.length >= limit || bytes > 24 * 1024) {
          truncated = true;
          break outer;
        }
        entries.push(entry);
      }
      if (query === null) break;
    }
    entries.sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.path.localeCompare(b.path),
    );
    return { entries, truncated };
  }
  private async preview(
    target: CustomerAgentTarget,
    path: string,
    absolute: string,
    signal: AbortSignal,
  ): Promise<CustomerFileResult> {
    signal.throwIfAborted();
    if (!(await lstat(absolute)).isFile()) throw fail();
    const handle = await open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw fail();
      const buffer = Buffer.alloc(Math.min(stat.size, CUSTOMER_FILE_LIMITS.previewBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const checked = await lstat(await resolveCustomerFile(this.store, target, path, signal));
      if (checked.dev !== stat.dev || checked.ino !== stat.ino) throw fail();
      let contents: string | undefined;
      try {
        if (!bytes.includes(0))
          contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
            stream: stat.size > bytesRead,
          });
      } catch {
        /* 二进制及未知编码只返回元数据，引用仍由本机运行器读取。 */
      }
      return {
        entries: [],
        truncated: stat.size > bytesRead,
        preview: {
          path,
          size: stat.size,
          binary: contents === undefined,
          ...(contents === undefined ? {} : { contents }),
        },
      };
    } finally {
      await handle.close();
    }
  }
}
