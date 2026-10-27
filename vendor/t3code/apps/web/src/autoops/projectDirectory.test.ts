import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => values.clear(),
  };
}
function receipt(
  original: {
    actorId?: string;
    body: { requestId: string; expectedRevision: number } & Record<string, unknown>;
  },
  patch: Record<string, unknown> = {},
) {
  const { requestId, ...publicIntent } = original.body;
  return {
    state: "completed",
    requestId,
    actorId: original.actorId,
    projectId: "p",
    environmentId: null,
    operation: "project.delete",
    saved: true,
    available: true,
    publicIntent,
    createdAt: "2026-10-27T00:00:00Z",
    nativeSynchronization: "not-required",
    result: { deleted: true, projectId: "p" },
    ...patch,
  }
}
const bootstrap = (csrfToken = 'delete-csrf') => ({
  principal: { id: 'deletion-protocol-user', displayName: '删除协议测试' },
  csrfToken,
  gatewayBasePath: '/api/agent-demo/t3',
  fixedModel: { instanceId: 'codex', model: 'test-model' },
  runtimeMode: 'approval-required' as const,
  projects: [],
  capabilities: {},
})
beforeEach(async () => {
  vi.stubGlobal('window', {
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    location: { origin: 'https://work.test' },
  })
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(bootstrap(), 'https://work.test')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it("删除未知收据保存 method、范围和修订，模块重开只GET原收据而不重发DELETE", async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation(
    '/api/v1/projects/p/environments/test',
    4,
    {},
    'DELETE',
  );
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("隔离原响应丢失")));
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  vi.resetModules()
  const reopened = await import('./projectDirectory')
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(bootstrap(), 'https://work.test')
  expect(reopened.readPendingProjectWrite()).toEqual(original)
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json(
        receipt(original, {
          environmentId: "test",
          operation: "environment.delete",
          result: { deleted: true, projectId: 'p', environmentId: 'test' },
        }),
      ),
    )
  vi.stubGlobal('fetch', fetcher)
  expect(await reopened.submitProjectWrite(original)).toMatchObject({ deleted: true })
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `/api/agent-demo/t3/api/v1/projects/receipts/${original.body.requestId}`,
    expect.objectContaining({
      method: "GET" }),
  );
  expect(fetcher.mock.calls[0]?.[1].body).toBeUndefined()
  expect(reopened.readPendingProjectWrite()).toBeNull()
})

it("断线保留删除原请求并阻止同项目其他配置，显式核对不更换requestId或执行DELETE", async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 2, {}, 'DELETE')
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('隔离断线'))
    .mockResolvedValueOnce(Response.json(receipt(original)))
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  expect(directory.readPendingProjectWrite()).toEqual(original)
  expect(() => directory.prepareProjectMutation('/api/v1/projects/p/assistant-allocations', 0, {
    target: { kind: 'member', id: 'member' }, assistantIds: ['helper'], defaultAssistantId: null,
  })).toThrow(
    '请先核对上一次保存结果',
  )
  await directory.recoverProjectWrite(directory.readPendingProjectWrite()!)
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(["DELETE", "GET"]);
  expect(fetcher.mock.calls[1]?.[1].body).toBeUndefined()
  expect(directory.readPendingProjectWrite()).toBeNull()
})

it.each([403, 409])('删除收到明确 %s 拒绝时保留业务错误并释放已拒绝收据', async (status) => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 2, {}, 'DELETE')
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        {
          code: status === 403 ? 'PROJECT_FORBIDDEN' : 'PROJECT_DELETE_BLOCKED',
          error: '真实删除拒绝',
        },
        { status },
      ),
    )
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({
    status,
    uncertain: false,
    message: '真实删除拒绝',
  })
  expect(directory.readPendingProjectWrite()).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('旧配置 POST 原收据继续沿原协议恢复，不被删除新增 method 改写', async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectWrite('/api/v1/projects/p/settings', 7, {
    name: '原配置',
  })
  expect(original).not.toHaveProperty('method')
  const fetcher = vi.fn().mockResolvedValue(Response.json({ revision: 8 }))
  vi.stubGlobal('fetch', fetcher)
  await directory.submitProjectWrite(original)
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify(original.body),
  })
})

it('删除等待期间登录上下文变化拒绝迟到结果，不交付删除成功', async () => {
  const directory = await import('./projectDirectory')
  const { installAutoOpsHost } = await import('./hostConfig')
  let resolve!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 1, {}, 'DELETE')
  const pending = directory.submitProjectWrite(original)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  installAutoOpsHost(bootstrap('renewed-csrf'), 'https://work.test')
  resolve(Response.json({ deleted: true, projectId: 'p' }))
  await rejected
  expect(directory.readPendingProjectWrite()).toEqual(original);
});

it("未知删除再次核对只能 GET 原收据，null 不能放开原请求或再次 DELETE", async () => {
  const directory = await import("./projectDirectory");
  const original = directory.prepareProjectMutation("/api/v1/projects/p", 2, {}, "DELETE");
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("隔离原删除响应丢失"))
    .mockResolvedValueOnce(Response.json(null));
  vi.stubGlobal("fetch", fetcher);
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true });
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true });
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(["DELETE", "GET"]);
  expect(fetcher.mock.calls[1]?.[0]).toBe(
    `/api/agent-demo/t3/api/v1/projects/receipts/${original.body.requestId}`,
  );
  expect(fetcher.mock.calls[1]?.[1].body).toBeUndefined();
  expect(directory.readPendingProjectWrite()).toEqual(original);
});

it.each([
  { actorId: "other-actor" },
  { projectId: "other-project" },
  { environmentId: "other-env" },
  { operation: "project.save" },
  { publicIntent: { expectedRevision: 99 } },
  { saved: false },
  { result: { deleted: true, projectId: "other-project" } },
  { nativeSynchronization: "unverified" },
])("原收据的操作者、scope、参数或结果被改动时保持未知且不再发送写入：%j", async (patch) => {
  const directory = await import("./projectDirectory");
  const original = directory.prepareProjectMutation("/api/v1/projects/p", 2, {}, "DELETE");
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("原响应丢失"))
    .mockResolvedValueOnce(Response.json(receipt(original, patch)));
  vi.stubGlobal("fetch", fetcher);
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true });
  await expect(directory.recoverProjectWrite(original)).rejects.toMatchObject({
    code: "PROJECT_RECEIPT_MISMATCH",
    uncertain: true,
  });
  expect(directory.readPendingProjectWrite()).toEqual(original);
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(["DELETE", "GET"]);
});

it.each([401, 403, 404, 503])("原收据读取 %s 不能当原写入失败，仍保留原标识", async (status) => {
  const directory = await import("./projectDirectory");
  const original = directory.prepareProjectMutation("/api/v1/projects/p", 2, {}, "DELETE");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError("原响应丢失"))
      .mockResolvedValueOnce(Response.json({ error: "当前无法核对" }, { status })),
  );
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true });
  await expect(directory.recoverProjectWrite(original)).rejects.toMatchObject({ status });
  expect(directory.readPendingProjectWrite()).toEqual(original);
});

it("原删除pending仅保留核对入口，明确blocked才解锁并显示已拒绝事实", async () => {
  const directory = await import("./projectDirectory");
  const original = directory.prepareProjectMutation("/api/v1/projects/p", 2, {}, "DELETE");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError("原响应丢失"))
      .mockResolvedValueOnce(
        Response.json(receipt(original, { state: "pending", result: undefined })),
      )
      .mockResolvedValueOnce(
        Response.json(receipt(original, { state: "blocked", result: undefined })),
      ),
  );
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true });
  await expect(directory.recoverProjectWrite(original)).rejects.toMatchObject({
    code: "PROJECT_REQUEST_PENDING",
    uncertain: true,
  });
  expect(directory.readPendingProjectWrite()).toEqual(original);
  await expect(directory.recoverProjectWrite(original)).rejects.toMatchObject({
    code: "PROJECT_DELETE_BLOCKED",
    status: 409,
    uncertain: false,
  });
  expect(directory.readPendingProjectWrite()).toBeNull()
});

it("原项目保存撤权只交付本人已保存事实，原生入口未核验不得包装成就绪", async () => {
  const directory = await import("./projectDirectory");
  const original = directory.prepareProjectWrite("/api/v1/projects/p/settings", 2, {
    name: "原项目",
    description: "",
  });
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("原响应丢失"))
    .mockResolvedValueOnce(
      Response.json(
        receipt(original, {
          operation: "project.save",
          available: false,
          result: undefined,
          nativeSynchronization: "unverified",
        }),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true });
  expect(await directory.recoverProjectWrite(original)).toEqual({ saved: true, available: false });
  expect(directory.readPendingProjectWrite()).toBeNull();
});

it.each(["unverified", "current-verified"])(
  "原创建保存事实的运行入口状态只沿后端公开核验交付：%s",
  async (nativeSynchronization) => {
    const directory = await import("./projectDirectory");
    const original = directory.prepareProjectWrite("/api/v1/projects", 0, {
      name: "原新项目",
      description: "",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("原响应丢失"))
        .mockResolvedValueOnce(
          Response.json(
            receipt(original, {
              operation: "project.create",
              nativeSynchronization,
              result: {
                id: "p",
                name: "原新项目",
                description: "",
                revision: 1,
                createdBy: "deletion-protocol-user",
                createdAt: "2026-10-27T00:00:00Z",
                environments: [],
              },
            }),
          ),
        ),
    );
    await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true });
    expect(await directory.recoverProjectWrite(original)).toMatchObject({
      id: "p",
      nativeSynchronization,
    });
    expect(directory.readPendingProjectWrite()).toBeNull();
  },
);

it('仓库未知结果转原owner GET，缺失仍不能再POST或解除原请求', async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectWrite('/api/v1/projects/p/repositories/repo', 2, { name: '项目仓库', url: 'https://github.com/example/repo.git' })
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('原响应丢失')).mockResolvedValueOnce(Response.json(null))
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ code: 'PROJECT_REQUEST_UNCONFIRMED', uncertain: true })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET'])
  expect(fetcher.mock.calls[1]?.[0]).toBe(`/api/agent-demo/t3/api/v1/projects/p/repositories/receipts/${original.body.requestId}`)
  expect(directory.readPendingProjectWrite()).toEqual(original)
})

it("原收据读取期间登录上下文刷新，迟到GET不能解锁或交付其他上下文结果", async () => {
  const directory = await import("./projectDirectory");
  const { installAutoOpsHost } = await import("./hostConfig");
  const original = directory.prepareProjectMutation("/api/v1/projects/p", 2, {}, "DELETE");
  let deliver!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("原响应丢失"))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true });
  const checking = directory.recoverProjectWrite(original);
  const rejected = expect(checking).rejects.toMatchObject({ name: "AbortError" });
  installAutoOpsHost(bootstrap("changed-csrf"), "https://work.test");
  deliver(Response.json(receipt(original)));
  await rejected;
  expect(directory.readPendingProjectWrite()).toEqual(original);
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(["DELETE", "GET"]);
});

it("既有用户隔离记录缺发送标记时只GET，不能升级为新写请求", async () => {
  const directory = await import("./projectDirectory");
  const { autoOpsStorage, autoOpsStorageKey } = await import("./hostConfig");
  const legacy = {
    path: "/api/v1/projects/p",
    method: "DELETE" as const,
    body: { requestId: "old-request", expectedRevision: 2 },
  };
  autoOpsStorage(window.sessionStorage).setItem(
    autoOpsStorageKey("project-directory:pending"),
    JSON.stringify(legacy),
  );
  const original = directory.readPendingProjectWrite()!;
  const fetcher = vi.fn().mockResolvedValue(Response.json(receipt(original)));
  vi.stubGlobal("fetch", fetcher);
  expect(await directory.submitProjectWrite(original)).toMatchObject({ deleted: true });
  expect(fetcher.mock.calls[0]?.[1].method).toBe("GET");
  expect(directory.readPendingProjectWrite()).toBeNull();
});


it('损坏或跨操作者的本地原记录不能被新UUID覆盖', async () => {
  const directory = await import('./projectDirectory')
  const { autoOpsStorage, autoOpsStorageKey } = await import('./hostConfig')
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  for (const raw of ['not-json', JSON.stringify({ actorId: 'another', path: '/api/v1/projects/p', body: { requestId: 'original-id', expectedRevision: 1 } })]) {
    autoOpsStorage(window.sessionStorage).setItem(autoOpsStorageKey('project-directory:pending'), raw)
    expect(() => directory.prepareProjectWrite('/api/v1/projects', 0, { name: '不能覆盖' })).toThrow('请先核对上一次保存结果')
    expect(autoOpsStorage(window.sessionStorage).getItem(autoOpsStorageKey('project-directory:pending'))).toBe(raw)
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('仓库原owner真实指纹fixture在无subtle的HTTP能力下GET恢复，参数或scope冲突仍未知', async () => {
  vi.resetModules()
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost({ ...bootstrap(), principal: { id: 'admin', displayName: '原仓库管理员' } }, 'https://work.test')
  const directory = await import('./projectDirectory')
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  vi.stubGlobal('crypto', { getRandomValues })
  const original = directory.prepareProjectWrite('/api/v1/projects/p/repositories', 0, { name: '项目仓库', url: 'https://github.com/example/repo.git' })
  const received = { state: 'completed', actorId: 'admin', projectId: 'p', requestId: original.body.requestId, operation: 'save-repository', saved: true, available: true, createdAt: '2026-10-27T00:00:00Z', publicIntent: { algorithm: 'sha256', digest: 'cc9f80c505fbb2dbd1c709d15562ddcb12e5b0c5aaff27535a49b8e4c3ff058f' }, result: { requestId: original.body.requestId, revision: 1, repository: { id: 'repo', name: '项目仓库', url: 'https://github.com/example/repo.git' } } }
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('原响应丢失')).mockResolvedValueOnce(Response.json({ ...received, actorId: 'another' })).mockResolvedValueOnce(Response.json({ ...received, publicIntent: { algorithm: 'sha256', digest: '0'.repeat(64) } })).mockResolvedValueOnce(Response.json(received))
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  for (let i = 0; i < 2; i++) {
    await expect(directory.recoverProjectWrite(original)).rejects.toMatchObject({ code: 'PROJECT_RECEIPT_MISMATCH', uncertain: true })
    expect(directory.readPendingProjectWrite()).toEqual(original)
  }
  expect(await directory.recoverProjectWrite(original)).toMatchObject({ revision: 1, repository: { id: 'repo' } })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET', 'GET', 'GET'])
  expect(directory.readPendingProjectWrite()).toBeNull()
})

it('仓库原保存后撤权只确认本人已保存事实，不交付仓库配置或再次写入', async () => {
  vi.resetModules()
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost({ ...bootstrap(), principal: { id: 'admin', displayName: '原仓库管理员' } }, 'https://work.test')
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectWrite('/api/v1/projects/p/repositories', 0, { name: '项目仓库', url: 'https://github.com/example/repo.git' })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('原响应丢失')).mockResolvedValueOnce(Response.json({ state: 'completed', actorId: 'admin', projectId: 'p', requestId: original.body.requestId, operation: 'save-repository', saved: true, available: false, createdAt: '2026-10-27T00:00:00Z', publicIntent: { algorithm: 'sha256', digest: 'cc9f80c505fbb2dbd1c709d15562ddcb12e5b0c5aaff27535a49b8e4c3ff058f' } })))
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  expect(await directory.recoverProjectWrite(original)).toEqual({ saved: true, available: false })
  expect(directory.readPendingProjectWrite()).toBeNull()
})

it('项目助手分配沿原owner GET核完整原命令，null和摘要冲突不会重复授权', async () => {
  const directory = await import('./projectDirectory')
  const { createHash } = await import('node:crypto')
  const original = directory.prepareProjectMutation('/api/v1/projects/p/assistant-allocations', 0, { target: { kind: 'member', id: 'member' }, assistantIds: ['helper'], defaultAssistantId: 'helper' })
  const encoded = JSON.stringify(original.body, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
  const received = { state: 'completed', actorId: original.actorId, projectId: 'p', requestId: original.body.requestId, operation: 'allocation.save:member:member', saved: true, available: true, createdAt: '2026-10-27T00:00:00Z', publicIntent: { algorithm: 'sha256', digest: createHash('sha256').update(encoded).digest('hex') }, result: { revision: 1, assistantIds: ['helper'], defaultAssistantId: 'helper' } }
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('原响应丢失')).mockResolvedValueOnce(Response.json(null)).mockResolvedValueOnce(Response.json({ ...received, publicIntent: { algorithm: 'sha256', digest: '0'.repeat(64) } })).mockResolvedValueOnce(Response.json(received))
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  await expect(directory.recoverProjectWrite(original)).rejects.toMatchObject({ code: 'PROJECT_REQUEST_UNCONFIRMED' })
  await expect(directory.recoverProjectWrite(original)).rejects.toMatchObject({ code: 'PROJECT_RECEIPT_MISMATCH' })
  expect(await directory.recoverProjectWrite(original)).toMatchObject({ assistantIds: ['helper'], defaultAssistantId: 'helper' })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET', 'GET', 'GET'])
  expect(fetcher.mock.calls[3]?.[0]).toBe(`/api/agent-demo/t3/api/v1/projects/p/assistants/receipts/${original.body.requestId}`)
  expect(directory.readPendingProjectWrite()).toBeNull()
})


it('服务端确认待完成删除后仅显式继续原请求，响应丢失回到GET且不重发DELETE', async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 2, {}, 'DELETE')
  const pendingReceipt = receipt(original, { state: 'pending', available: false, canResume: true, result: undefined })
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('原删除响应丢失'))
    .mockResolvedValueOnce(Response.json(pendingReceipt))
    .mockResolvedValueOnce(Response.json(pendingReceipt))
    .mockRejectedValueOnce(new TypeError('继续删除响应丢失'))
    .mockResolvedValueOnce(Response.json(receipt(original)))
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  await expect(directory.recoverProjectWrite(original)).rejects.toMatchObject({ code: 'PROJECT_REQUEST_PENDING', canResume: true })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['DELETE', 'GET'])
  await expect(directory.resumeProjectDeletion(original)).rejects.toMatchObject({ uncertain: true })
  expect(directory.readPendingProjectWrite()).toEqual(original)
  expect(fetcher.mock.calls[3]?.[0]).toBe(`/api/agent-demo/t3/api/v1/projects/receipts/${original.body.requestId}/resume`)
  expect(JSON.parse(fetcher.mock.calls[3]?.[1].body)).toEqual({ operation: 'project.delete', projectId: 'p', publicIntent: { expectedRevision: 2 } })
  expect(await directory.recoverProjectWrite(original)).toMatchObject({ deleted: true })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['DELETE', 'GET', 'GET', 'POST', 'GET'])
  expect(directory.readPendingProjectWrite()).toBeNull()
})

it.each(['missing', 'pending-unavailable', 'mismatched'] as const)('继续删除前的%s原收据不能授权任何恢复写入', async (mode) => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 2, {}, 'DELETE')
  const response = mode === 'missing' ? null : receipt(original, { state: 'pending', result: undefined, canResume: mode === 'mismatched', ...(mode === 'mismatched' ? { projectId: 'another' } : {}) })
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('原响应丢失')).mockResolvedValueOnce(Response.json(response))
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  await expect(directory.resumeProjectDeletion(original)).rejects.toMatchObject({ uncertain: true })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['DELETE', 'GET'])
  expect(directory.readPendingProjectWrite()).toEqual(original)
})

it('继续原删除收到当前权限拒绝仍保留原请求，下一步只核对GET', async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 2, {}, 'DELETE')
  const pendingReceipt = receipt(original, { state: 'pending', available: false, canResume: true, result: undefined })
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('原响应丢失'))
    .mockResolvedValueOnce(Response.json(pendingReceipt))
    .mockResolvedValueOnce(Response.json({ code: 'PROJECT_FORBIDDEN', error: '当前权限不足' }, { status: 403 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  await expect(directory.resumeProjectDeletion(original)).rejects.toMatchObject({ code: 'PROJECT_FORBIDDEN' })
  expect(directory.readPendingProjectWrite()).toEqual(original)
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['DELETE', 'GET', 'POST'])
})


it('显式继续原删除成功后核同scope收据清理原记录；已完成时仅GET不再恢复写入', async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectMutation('/api/v1/projects/p', 2, {}, 'DELETE')
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('原响应丢失'))
    .mockResolvedValueOnce(Response.json(receipt(original, { state: 'pending', available: false, canResume: true, result: undefined })))
    .mockResolvedValueOnce(Response.json(receipt(original)))
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(original)).rejects.toMatchObject({ uncertain: true })
  expect(await directory.resumeProjectDeletion(original)).toMatchObject({ deleted: true, projectId: 'p' })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['DELETE', 'GET', 'POST'])
  expect(directory.readPendingProjectWrite()).toBeNull()
  const next = directory.prepareProjectMutation('/api/v1/projects/p', 3, {}, 'DELETE')
  fetcher.mockRejectedValueOnce(new TypeError('原响应丢失')).mockResolvedValueOnce(Response.json(receipt(next)))
  await expect(directory.submitProjectWrite(next)).rejects.toMatchObject({ uncertain: true })
  expect(await directory.resumeProjectDeletion(next)).toMatchObject({ deleted: true })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['DELETE', 'GET', 'POST', 'DELETE', 'GET'])
})

it('项目A保存未知后项目B仍能保存，分别核原收据且不覆盖或重发A', async () => {
  const directory = await import('./projectDirectory')
  const first = directory.prepareProjectWrite('/api/v1/projects/p/settings', 2, {
    name: '项目A',
    description: '',
  })
  const originals = [first]
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === 'POST') throw new TypeError('隔离保存响应丢失')
    const original = originals.find((value) => path.endsWith('/' + value.body.requestId))!
    const projectId = original === first ? 'p' : 'other'
    return Response.json(
      receipt(original, {
        projectId,
        operation: 'project.save',
        nativeSynchronization: 'current-verified',
        result: {
          id: projectId,
          name: (original.body.value as { name: string }).name,
          description: '',
          environments: [],
          revision: 5,
          createdBy: original.actorId,
          createdAt: '2026-10-27T00:00:00Z',
        },
      }),
    )
  })
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(first)).rejects.toMatchObject({ uncertain: true })
  const second = directory.prepareProjectWrite('/api/v1/projects/other/settings', 4, {
    name: '项目B',
    description: '',
  })
  originals.push(second)
  await expect(directory.submitProjectWrite(second)).rejects.toMatchObject({ uncertain: true })
  expect(await directory.recoverProjectWrite(second)).toMatchObject({ id: 'other', name: '项目B' })
  expect(directory.readPendingProjectWrite()).toEqual(first)
  expect(await directory.recoverProjectWrite(first)).toMatchObject({ id: 'p', name: '项目A' })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'POST', 'GET', 'GET'])
  expect(directory.readPendingProjectWrite()).toBeNull()
})

it('同项目名称保存未知不阻塞助手分配，助手保存后原项目请求仍只能GET核对', async () => {
  const directory = await import('./projectDirectory')
  const first = directory.prepareProjectWrite('/api/v1/projects/p/settings', 2, {
    name: '原名称',
    description: '',
  })
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('隔离项目响应丢失'))
    .mockResolvedValueOnce(
      Response.json({ revision: 1, assistantIds: ['helper'], defaultAssistantId: null }),
    )
    .mockResolvedValueOnce(
      Response.json(
        receipt(first, {
          operation: 'project.save',
          nativeSynchronization: 'current-verified',
          result: {
            id: 'p',
            name: '原名称',
            description: '',
            environments: [],
            revision: 3,
            createdBy: first.actorId,
            createdAt: '2026-10-27T00:00:00Z',
          },
        }),
      ),
    )
  vi.stubGlobal('fetch', fetcher)
  await expect(directory.submitProjectWrite(first)).rejects.toMatchObject({ uncertain: true })
  const allocation = directory.prepareProjectMutation(
    '/api/v1/projects/p/assistant-allocations',
    0,
    {
      target: { kind: 'member', id: 'member' },
      assistantIds: ['helper'],
      defaultAssistantId: null,
    },
  )
  expect(await directory.submitProjectWrite(allocation)).toMatchObject({ assistantIds: ['helper'] })
  expect(directory.readPendingProjectWrite()).toEqual(first)
  expect(await directory.submitProjectWrite(first)).toMatchObject({ id: 'p' })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'POST', 'GET'])
  expect(directory.readPendingProjectWrite()).toBeNull()
})

it('同目标未知请求仍互锁，项目删除与本项目其他owner双向互锁而不阻塞其他项目', async () => {
  const directory = await import('./projectDirectory')
  const first = directory.prepareProjectWrite('/api/v1/projects/p/settings', 2, {
    name: '待核对项目',
  })
  expect(() =>
    directory.prepareProjectWrite('/api/v1/projects/p/settings', 2, { name: '重复保存' }),
  ).toThrow('请先核对上一次保存结果')
  expect(() => directory.prepareProjectMutation('/api/v1/projects/p', 2, {}, 'DELETE')).toThrow(
    '请先核对上一次保存结果',
  )
  const deletion = directory.prepareProjectMutation('/api/v1/projects/other', 1, {}, 'DELETE')
  expect(() =>
    directory.prepareProjectMutation('/api/v1/projects/other/assistant-allocations', 0, {
      target: { kind: 'member', id: 'member' },
      assistantIds: [],
      defaultAssistantId: null,
    }),
  ).toThrow('请先核对上一次保存结果')
  expect(directory.readPendingProjectWrite({ projectId: 'p', owner: 'directory' })).toEqual(first)
  expect(directory.readPendingProjectWrite({ projectId: 'p', owner: 'assistant' })).toBeNull()
  expect(directory.readPendingProjectWrite({ projectId: 'other', owner: 'assistant' })).toEqual(
    deletion,
  )
})

it('旧单条未知记录保持原字节，独立owner保存不会覆盖它且重开仍GET原UUID', async () => {
  const directory = await import('./projectDirectory')
  const { autoOpsStorage, autoOpsStorageKey } = await import('./hostConfig')
  const key = autoOpsStorageKey('project-directory:pending')
  const raw = JSON.stringify({
    path: '/api/v1/projects/p',
    method: 'DELETE',
    body: { requestId: 'legacy-pending-id', expectedRevision: 2 },
  })
  autoOpsStorage(window.sessionStorage).setItem(key, raw)
  const original = directory.readPendingProjectWrite()!
  const second = directory.prepareProjectWrite('/api/v1/projects/other/settings', 1, {
    name: '独立项目',
  })
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ id: 'other', name: '独立项目' }))
    .mockResolvedValueOnce(Response.json(receipt(original)))
  vi.stubGlobal('fetch', fetcher)
  await directory.submitProjectWrite(second)
  expect(autoOpsStorage(window.sessionStorage).getItem(key)).toBe(raw)
  vi.resetModules()
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(bootstrap(), 'https://work.test')
  const reopened = await import('./projectDirectory')
  expect(await reopened.submitProjectWrite(original)).toMatchObject({
    deleted: true,
    projectId: 'p',
  })
  expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET'])
  expect(fetcher.mock.calls[1]?.[0]).toBe(
    '/api/agent-demo/t3/api/v1/projects/receipts/legacy-pending-id',
  )
  expect(reopened.readPendingProjectWrite()).toBeNull()
})

it('切换实际登录账号后不读取或提交原actor的未知请求，恢复原账号仍保留原UUID', async () => {
  const directory = await import('./projectDirectory')
  const original = directory.prepareProjectWrite('/api/v1/projects/p/settings', 2, {
    name: '原账号项目',
  })
  vi.resetModules()
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(
    { ...bootstrap(), principal: { id: 'other-actor', displayName: '另一账号' } },
    'https://work.test',
  )
  const next = await import('./projectDirectory')
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  expect(next.readPendingProjectWrite()).toBeNull()
  await expect(next.submitProjectWrite(original)).rejects.toMatchObject({
    code: 'PROJECT_REQUEST_CONTEXT_CHANGED',
  })
  const own = next.prepareProjectWrite('/api/v1/projects/p/settings', 2, {
    name: '另一账号独立请求',
  })
  expect(own.body.requestId).not.toBe(original.body.requestId)
  expect(fetcher).not.toHaveBeenCalled()
  vi.resetModules()
  const currentHost = await import('./hostConfig')
  currentHost.installAutoOpsHost(bootstrap(), 'https://work.test')
  const reopened = await import('./projectDirectory')
  expect(reopened.readPendingProjectWrite()).toEqual(original)
})
