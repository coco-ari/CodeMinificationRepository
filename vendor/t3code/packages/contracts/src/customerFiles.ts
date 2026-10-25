import * as Schema from "effect/Schema";

export const CUSTOMER_FILE_LIMITS = {
  entries: 120,
  searchEntries: 40,
  previewBytes: 16 * 1024,
  responseBytes: 64 * 1024,
  timeoutMs: 8000,
} as const;
const Path = Schema.String.check(Schema.isMaxLength(2048));
export const CustomerFileInput = Schema.Struct({
  operation: Schema.Literals(["list", "search", "preview"]),
  path: Schema.optional(Path),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type CustomerFileInput = typeof CustomerFileInput.Type;
export const CustomerFileResult = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      path: Path,
      kind: Schema.Literals(["file", "directory"]),
      ignored: Schema.optional(Schema.Boolean),
    }),
  ).check(Schema.isMaxLength(CUSTOMER_FILE_LIMITS.entries)),
  truncated: Schema.Boolean,
  preview: Schema.optional(
    Schema.Struct({
      path: Path,
      size: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
      contents: Schema.optional(
        Schema.String.check(Schema.isMaxLength(CUSTOMER_FILE_LIMITS.previewBytes)),
      ),
      binary: Schema.Boolean,
    }),
  ),
});
export type CustomerFileResult = typeof CustomerFileResult.Type;
export const decodeCustomerFileInput = Schema.decodeUnknownSync(CustomerFileInput);
const decodeResult = Schema.decodeUnknownSync(CustomerFileResult);
export function decodeCustomerFileResult(value: unknown): CustomerFileResult {
  const result = decodeResult(value);
  if (
    result.entries.some((entry) => !validCustomerRelativePath(entry.path)) ||
    (result.preview && !validCustomerRelativePath(result.preview.path))
  )
    throw new Error("电脑返回的文件路径无效");
  return result;
}
export interface CustomerFileIdentity {
  deviceId: string;
  registeredWorkspaceId: string;
  workspaceBindingRevision: number;
}
const segment = /^[a-zA-Z0-9_-]{1,200}$/u;

export function validCustomerRelativePath(path: string, root = false): boolean {
  if (root && path === "") return true;
  return (
    path.length > 0 &&
    path.length <= 2048 &&
    !/[\\\p{Cc}\p{Cs}\u2028\u2029]/u.test(path) &&
    !/^[a-zA-Z]:/u.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** 引用保存登记身份及相对路径，不将客户绝对路径发送到网页。 */
export function customerFileReference(target: CustomerFileIdentity, path: string): string {
  if (
    !segment.test(target.deviceId) ||
    !segment.test(target.registeredWorkspaceId) ||
    !Number.isSafeInteger(target.workspaceBindingRevision) ||
    target.workspaceBindingRevision < 1 ||
    !validCustomerRelativePath(path)
  )
    throw new Error("客户文件引用无效");
  return `autoops-customer/${target.deviceId}/${target.registeredWorkspaceId}/${target.workspaceBindingRevision}/${path}`;
}

export function parseCustomerFileReference(
  value: string,
): (CustomerFileIdentity & { path: string }) | null {
  const [prefix, deviceId, registeredWorkspaceId, revision, ...parts] = value.split("/");
  const path = parts.join("/");
  if (
    prefix !== "autoops-customer" ||
    !deviceId ||
    !registeredWorkspaceId ||
    !revision ||
    !segment.test(deviceId) ||
    !segment.test(registeredWorkspaceId) ||
    !/^[1-9][0-9]*$/u.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    !validCustomerRelativePath(path)
  )
    return null;
  return { deviceId, registeredWorkspaceId, workspaceBindingRevision: Number(revision), path };
}

export function customerFilePathForTarget(
  value: string,
  target: CustomerFileIdentity,
): string | null {
  const ref = parseCustomerFileReference(value);
  return ref &&
    ref.deviceId === target.deviceId &&
    ref.registeredWorkspaceId === target.registeredWorkspaceId &&
    ref.workspaceBindingRevision === target.workspaceBindingRevision
    ? ref.path
    : null;
}
