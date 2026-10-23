import { describe, expect, it, vi } from "vite-plus/test";
import {
  inspectAuthoringRequest,
  submitAuthoring,
  uploadAuthoringFile,
  uploadDigest,
  validMaterialPath,
  type AuthoringSubmission,
} from "./workspaceAuthoring";

const state = vi.hoisted(() => ({
  host: {
    gatewayBasePath: "/api/agent-demo/t3",
    httpBaseUrl: "http://work.test",
    csrfToken: "isolated-csrf",
    principal: { id: "isolated-author" },
  },
}));
vi.mock("./hostSnapshot", () => ({ readAutoOpsHost: () => state.host }));
vi.mock("./hostConfig", () => ({ readAutoOpsHost: () => state.host }));
function setup() {
  state.host = {
    gatewayBasePath: "/api/agent-demo/t3",
    httpBaseUrl: "http://work.test",
    csrfToken: "isolated-csrf",
    principal: { id: "isolated-author" },
  };
}

function uploadFixture() {
  setup();
  const instances: FakeXHR[] = [];
  class FakeXHR {
    upload: {
      onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void;
    } = {};
    headers: Record<string, string> = {};
    url = "";
    body: unknown;
    timeout = 0;
    withCredentials = false;
    status = 200;
    responseText = "";
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    ontimeout?: () => void;
    constructor() {
      instances.push(this);
    }
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader(key: string, value: string) {
      this.headers[key] = value;
    }
    send(body: unknown) {
      this.body = body;
    }
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  const submission: AuthoringSubmission = {
    requestId: "original-request",
    expectedRevision: 4,
    command: {
      kind: "upload",
      path: "docs/说明.txt",
      size: 5,
      sha256: "a".repeat(64),
      conflict: "keep-both",
    },
  };
  return {
    instances,
    submission,
    file: new File(["hello"], "说明.txt"),
    abort: new AbortController(),
  };
}

describe("工作区资料传输与收据边界", () => {
  it.each([
    [409, "AUTHORING_PATH_EXISTS", "该路径已有资料，请选择覆盖或保留两份"],
    [413, "WORKSPACE_UPLOAD_SIZE", "上传超过 8 MiB 上限，原有资料未修改"],
    [403, "WORKSPACE_MANAGE_FORBIDDEN", "当前成员无权管理工作区"],
  ] as const)("保留服务端%s拒绝上传的具体错误和原请求", async (status, code, message) => {
    const fixture = uploadFixture();
    try {
      const operation = uploadAuthoringFile(
        "p",
        fixture.submission,
        fixture.file,
        vi.fn(),
        fixture.abort.signal,
      );
      const assertion = expect(operation).rejects.toMatchObject({
        status,
        code,
        message,
        uncertain: false,
      });
      const xhr = fixture.instances[0]!;
      xhr.status = status;
      xhr.responseText = JSON.stringify({ error: message, code });
      xhr.onload?.();
      await assertion;
      expect(
        JSON.parse(new URL(xhr.url, "http://work.test").searchParams.get("input")!).requestId,
      ).toBe("original-request");
      expect(fixture.instances).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("原始字节上传保留项目、原请求、条件修订和真实进度", async () => {
    const fixture = uploadFixture();
    try {
      const progress = vi.fn();
      const operation = uploadAuthoringFile(
        "项目甲",
        fixture.submission,
        fixture.file,
        progress,
        fixture.abort.signal,
      );
      const xhr = fixture.instances[0]!;
      const url = new URL(xhr.url, "http://work.test");
      expect(decodeURIComponent(url.pathname)).toBe(
        "/api/agent-demo/t3/api/v1/projects/项目甲/workspace/uploads",
      );
      expect(JSON.parse(url.searchParams.get("input")!)).toMatchObject({
        requestId: "original-request",
        expectedRevision: 4,
        path: "docs/说明.txt",
      });
      expect(xhr.body).toBe(fixture.file);
      expect(xhr.headers["X-Demo-CSRF"]).toBe("isolated-csrf");
      xhr.upload.onprogress?.({ loaded: 3, total: 5, lengthComputable: true });
      expect(progress).toHaveBeenCalledWith(60);
      xhr.responseText = JSON.stringify({ requestId: "original-request", revision: 5 });
      xhr.onload?.();
      await expect(operation).resolves.toMatchObject({
        requestId: "original-request",
        revision: 5,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("取消传输保留未知保存结果，不把中止当作服务端撤销", async () => {
    const fixture = uploadFixture();
    try {
      const operation = uploadAuthoringFile(
        "p",
        fixture.submission,
        fixture.file,
        vi.fn(),
        fixture.abort.signal,
      );
      const assertion = expect(operation).rejects.toMatchObject({
        code: "UPLOAD_ABORTED",
        uncertain: true,
      });
      fixture.abort.abort();
      await assertion;
      expect(fixture.instances).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("切登录身份后拒绝迟到的成功上传响应", async () => {
    const fixture = uploadFixture();
    try {
      const operation = uploadAuthoringFile(
        "p",
        fixture.submission,
        fixture.file,
        vi.fn(),
        fixture.abort.signal,
      );
      const assertion = expect(operation).rejects.toMatchObject({ name: "AbortError" });
      state.host = { ...state.host, principal: { id: "another-author" } };
      fixture.instances[0]!.responseText = JSON.stringify({
        requestId: "original-request",
        revision: 5,
      });
      fixture.instances[0]!.onload?.();
      await assertion;
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("明确拒绝与损坏成功响应分别表达失败和未知", async () => {
    for (const status of [403, 200]) {
      const fixture = uploadFixture();
      try {
        const operation = uploadAuthoringFile(
          "p",
          fixture.submission,
          fixture.file,
          vi.fn(),
          fixture.abort.signal,
        );
        const assertion = expect(operation).rejects.toMatchObject({ uncertain: status === 200 });
        fixture.instances[0]!.status = status;
        fixture.instances[0]!.responseText =
          status === 403
            ? JSON.stringify({ error: { code: "FORBIDDEN", message: "授权已撤回" } })
            : "<html>gateway</html>";
        fixture.instances[0]!.onload?.();
        await assertion;
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
  it("核对版本接受收据时识别仍在准备及已失败的固定输入", async () => {
    setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: null, capture: { id: "capture", resolution: "pending" } }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: null,
            capture: {
              id: "capture",
              resolution: "failed",
              resolutionError: { code: "SOURCE_FAILED", message: "仓库引用不存在" },
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await inspectAuthoringRequest("p", "same-request", false)).toBeNull();
      await expect(inspectAuthoringRequest("p", "same-request", false)).rejects.toMatchObject({
        code: "CAPTURE_FAILED",
        uncertain: false,
        message: "仓库引用不存在",
      });
      expect(fetcher.mock.calls.every(([url]) => url.endsWith("/requests/same-request"))).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("凭证替换只向专用写入接口提交秘密，读取仅返回元数据", async () => {
    setup();
    const metadata = {
      id: "credential",
      name: "测试凭证",
      revision: 2,
      version: 2,
      revoked: false,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: metadata })));
    vi.stubGlobal("fetch", fetcher);
    try {
      const submission: AuthoringSubmission = {
        requestId: "credential-request",
        expectedRevision: 4,
        command: {
          kind: "credential",
          action: "save",
          id: "credential",
          name: "测试凭证",
          username: "fixture-user",
          secret: "fictional-test-token",
          expectedCredentialRevision: 1,
        },
      };
      const result = await submitAuthoring("p", submission);
      expect(result).toEqual({ requestId: "credential-request", credential: metadata });
      expect(fetcher.mock.calls[0]![0]).not.toContain("fictional-test-token");
      expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({
        action: "replace",
        input: {
          requestId: "credential-request",
          expectedRevision: 1,
          password: "fictional-test-token",
        },
      });
      expect(await inspectAuthoringRequest("p", "credential-request", true)).toEqual(result);
      expect(fetcher.mock.calls[1]![0]).toContain("/credentials/requests/credential-request");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("内网 HTTP 无 SubtleCrypto 时仍能计算上传内容摘要", async () => {
    expect(await uploadDigest(new Blob(["hello"]))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
  it.each(["/etc/file", "../file", "docs/../file", "docs\\file", "docs//file", "docs/\u0000.txt"])(
    "拒绝不能作为项目相对路径的输入 %s",
    (path) => expect(validMaterialPath(path)).toBe(false),
  );
});
