import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { AutoOpsRequestError, autoOpsApiUrl, autoOpsRequest, errorDetails } from "./apiClient";
import { readAutoOpsHost } from "./hostConfig";
import type { WorkspaceTask } from "./workspaces";
import type {
  WorkspaceAuthoringOverview,
  WorkspaceAuthoringResult,
  WorkspaceCredentialMetadata,
  WorkspaceMaterialContent,
  WorkspaceSourceInput,
  WorkspaceUploadInput,
} from "../../../../../../autoops/contracts/workspace-authoring";
export type * from "../../../../../../autoops/contracts/workspace-authoring";

export type AuthoringCommand =
  | { kind: "source"; action: "save"; source: WorkspaceSourceInput }
  | { kind: "source"; action: "remove"; id: string }
  | {
      kind: "credential";
      action: "save";
      id?: string;
      name: string;
      username: string;
      secret: string;
      expectedCredentialRevision?: number;
    }
  | { kind: "credential"; action: "revoke"; id: string; expectedCredentialRevision: number }
  | { kind: "document"; action: "mkdir"; path: string }
  | {
      kind: "document";
      action: "save";
      path: string;
      expectedContentRevision: string;
      contents: string;
    }
  | {
      kind: "document";
      action: "move";
      path: string;
      destination: string;
      expectedContentRevision: string;
    }
  | { kind: "document"; action: "delete"; path: string; expectedContentRevision: string }
  | { kind: "document"; action: "extract"; path: string; expectedContentRevision: string }
  | { kind: "version"; name: string }
  | {
      kind: "upload";
      path: string;
      size: number;
      sha256: string;
      conflict: WorkspaceUploadInput["conflict"];
    };
export type AuthoringReceipt =
  | WorkspaceAuthoringResult
  | { requestId: string; task: WorkspaceTask }
  | { requestId: string; credential: WorkspaceCredentialMetadata };
export type AuthoringSubmission = {
  requestId: string;
  expectedRevision: number;
  command: AuthoringCommand;
};

export const authoringPath = (projectId: string) =>
  `/api/v1/projects/${encodeURIComponent(projectId)}/workspace`;
const request = <T>(projectId: string, suffix: string, body?: object, signal?: AbortSignal) =>
  autoOpsRequest<T>(authoringPath(projectId) + suffix, {
    label: "工作区资料",
    ...(body ? { body } : {}),
    ...(signal ? { signal } : {}),
  });
export const loadAuthoring = (projectId: string, signal?: AbortSignal) =>
  request<WorkspaceAuthoringOverview>(projectId, "/authoring", undefined, signal);
export const loadAuthoringCredentials = (projectId: string, signal?: AbortSignal) =>
  request<{ credentials: WorkspaceCredentialMetadata[] }>(
    projectId,
    "/credentials",
    undefined,
    signal,
  );
export const loadAuthoringTree = (projectId: string, path: string) =>
  request<{
    entries: Array<{ path: string; name: string; kind: "file" | "directory"; size: number }>;
    truncated: boolean;
  }>(projectId, `/current/tree?path=${encodeURIComponent(path)}`);
export const searchAuthoringFiles = (projectId: string, query: string, limit: number) =>
  request<{ entries: Array<{ path: string; kind: "file" | "directory" }>; truncated: boolean }>(
    projectId,
    `/current/search?query=${encodeURIComponent(query)}&limit=${limit}`,
  );
export const loadAuthoringContent = (projectId: string, path: string, signal?: AbortSignal) =>
  request<WorkspaceMaterialContent>(
    projectId,
    `/current/metadata?path=${encodeURIComponent(path)}`,
    undefined,
    signal,
  );
export const authoringFileUrl = (projectId: string, path: string, revision: string) =>
  autoOpsApiUrl(
    `${authoringPath(projectId)}/current/file?path=${encodeURIComponent(path)}&revision=${encodeURIComponent(revision)}&inline=1`,
  );
export async function inspectAuthoringRequest(
  projectId: string,
  requestId: string,
  credential: boolean,
  signal?: AbortSignal,
): Promise<AuthoringReceipt | null> {
  if (credential) {
    const { result } = await request<{ result: WorkspaceCredentialMetadata | null }>(
      projectId,
      `/credentials/requests/${encodeURIComponent(requestId)}`,
      undefined,
      signal,
    );
    return result ? { requestId, credential: result } : null;
  }
  const { result, task, capture } = await request<{
    result: WorkspaceAuthoringResult | null;
    task?: WorkspaceTask;
    capture?: { resolution: string; resolutionError?: { code: string; message: string } };
  }>(projectId, `/requests/${encodeURIComponent(requestId)}`, undefined, signal);
  if (capture?.resolution === "failed")
    throw new AutoOpsRequestError(
      capture.resolutionError?.message ?? "固定版本输入准备失败，请修正后重新提交。",
      "CAPTURE_FAILED",
      409,
      false,
    );
  return task ? { requestId, task } : result;
}

export async function submitAuthoring(
  projectId: string,
  submission: AuthoringSubmission,
  signal?: AbortSignal,
): Promise<AuthoringReceipt> {
  const { command, requestId, expectedRevision } = submission;
  if (command.kind === "upload") throw new Error("请重新选择原文件后继续上传。");
  if (command.kind === "version") {
    const result = await request<{ task: WorkspaceTask }>(
      projectId,
      "/versions",
      { requestId, expectedRevision },
      signal,
    );
    return { requestId, task: result.task };
  }
  if (command.kind === "credential") {
    const input =
      command.action === "revoke"
        ? { id: command.id, requestId, expectedRevision: command.expectedCredentialRevision }
        : {
            ...(command.id
              ? { id: command.id, expectedRevision: command.expectedCredentialRevision }
              : {}),
            requestId,
            name: command.name,
            username: command.username,
            password: command.secret,
          };
    const credential = await request<WorkspaceCredentialMetadata>(
      projectId,
      "/credentials",
      { action: command.action === "revoke" ? "revoke" : command.id ? "replace" : "create", input },
      signal,
    );
    return { requestId, credential };
  }
  if (command.kind === "source") {
    const input = command.action === "save" ? command.source : { id: command.id };
    return request<WorkspaceAuthoringResult>(
      projectId,
      "/sources",
      { action: command.action, input: { ...input, requestId, expectedRevision } },
      signal,
    );
  }
  const { kind: _kind, action, ...input } = command;
  return request<WorkspaceAuthoringResult>(
    projectId,
    "/documents",
    {
      action: action === "mkdir" ? "directory" : action,
      input: { ...input, requestId, expectedRevision },
    },
    signal,
  );
}

export function authoringDigest(command: AuthoringCommand) {
  // 待核对摘要会写入浏览器存储，不能留下可离线猜测凭证秘密的校验值。
  const value =
    command.kind === "credential" && command.action === "save"
      ? {
          kind: command.kind,
          action: command.action,
          id: command.id,
          name: command.name,
          username: command.username,
          expectedCredentialRevision: command.expectedCredentialRevision,
        }
      : command;
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
}
export async function uploadDigest(file: Blob) {
  return bytesToHex(sha256(new Uint8Array(await file.arrayBuffer())));
}
export function validMaterialPath(value: string) {
  return (
    !!value &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f]/.test(value) &&
    value.split("/").every((part) => !!part && part !== "." && part !== "..")
  );
}

/** 浏览器上传需要真实字节进度；只在此传输边界使用原生 XHR，收据仍由业务模块拥有。 */
export function uploadAuthoringFile(
  projectId: string,
  submission: AuthoringSubmission,
  file: File,
  onProgress: (value: number) => void,
  signal: AbortSignal,
): Promise<AuthoringReceipt> {
  if (submission.command.kind !== "upload") return Promise.reject(new Error("上传输入无效。"));
  signal.throwIfAborted();
  const host = readAutoOpsHost();
  if (!host) return Promise.reject(new Error("项目工作台未连接。"));
  const { kind: _kind, ...metadata } = submission.command;
  const input = {
    ...metadata,
    requestId: submission.requestId,
    expectedRevision: submission.expectedRevision,
  };
  const url = autoOpsApiUrl(
    `${authoringPath(projectId)}/uploads?input=${encodeURIComponent(JSON.stringify(input))}`,
  );
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const cleanup = () => signal.removeEventListener("abort", abort);
    const fail = (message: string, code: string, status?: number, uncertain = true) => {
      cleanup();
      reject(new AutoOpsRequestError(message, code, status, uncertain));
    };
    const abort = () => xhr.abort();
    xhr.open("POST", url);
    xhr.timeout = 120_000;
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Demo-CSRF", host.csrfToken);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && !signal.aborted)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => fail("上传结果尚未确认，请按原请求核对。", "CONNECTION_FAILED");
    xhr.ontimeout = () => fail("上传超时，保存结果尚未确认，请按原请求核对。", "REQUEST_TIMEOUT");
    xhr.onabort = () => fail("已停止传输；服务端是否保存仍须按原请求核对。", "UPLOAD_ABORTED");
    xhr.onload = () => {
      cleanup();
      const current = readAutoOpsHost();
      if (
        current?.principal.id !== host.principal.id ||
        current.csrfToken !== host.csrfToken ||
        signal.aborted
      ) {
        reject(new DOMException("上传范围已经改变", "AbortError"));
        return;
      }
      let result: AuthoringReceipt;
      try {
        result = JSON.parse(xhr.responseText);
        if (!result || typeof result !== "object") throw new Error("无效上传响应");
      } catch {
        fail(
          "上传结果无法识别，请按原请求核对。",
          "INVALID_RESPONSE",
          xhr.status,
          xhr.status >= 500 || xhr.status === 408 || (xhr.status >= 200 && xhr.status < 300),
        );
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const details = errorDetails(result);
        fail(
          details.message ?? "上传未完成。",
          details.code ?? "UPLOAD_FAILED",
          xhr.status,
          xhr.status >= 500 || xhr.status === 408,
        );
        return;
      }
      resolve(result);
    };
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
