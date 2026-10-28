import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

async function installHost() {
  const { installAutoOpsHost } = await import('./hostConfig')
  installAutoOpsHost(
    {
      principal: { id: 'request-owner', displayName: '请求测试' },
      gatewayBasePath: '/api/agent-demo/t3',
      csrfToken: 'request-csrf',
      fixedModel: { instanceId: 'codex', model: 'test-model' },
      runtimeMode: 'approval-required',
      projects: [],
      capabilities: {},
    },
    'https://work.test',
  )
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('业务 JSON 公开入口', () => {
  it('计划保存保留原负载和 CSRF，网络失败不自动重复保存', async () => {
    await installHost()
    const { saveAutoOpsPlan } = await import('./planMaterials')
    const fetch = vi.fn().mockRejectedValue(new TypeError('network unavailable'))
    vi.stubGlobal('fetch', fetch)
    await expect(saveAutoOpsPlan('thread-one', '重建计划', '计划内容')).rejects.toMatchObject({
      uncertain: true,
      code: 'CONNECTION_FAILED',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      '/api/agent-demo/t3/autoops/plan-materials',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Demo-CSRF': 'request-csrf' }),
        body: JSON.stringify({ threadId: 'thread-one', name: '重建计划', contents: '计划内容' }),
      }),
    )
  })
  it('skill范围只读取当前网关对应的范围键，并透传取消信号', async () => {
    await installHost()
    const { loadSkillContext } = await import('./skillLibrary')
    const fetch = vi.fn(async () =>
      Response.json({ cwd: 'scope-cwd', snapshotId: 'snapshot', skills: [] }),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(
      loadSkillContext('/other-gateway/autoops/skill-library/context?threadId=one'),
    ).rejects.toThrow(/地址无效/)
    expect(fetch).not.toHaveBeenCalled()
    const controller = new AbortController()
    await expect(
      loadSkillContext(
        '/api/agent-demo/t3/autoops/skill-library/context?threadId=one',
        controller.signal,
      ),
    ).resolves.toMatchObject({ snapshotId: 'snapshot' })
    expect(fetch).toHaveBeenCalledWith(
      '/api/agent-demo/t3/autoops/skill-library/context?threadId=one',
      expect.objectContaining({ credentials: 'same-origin', signal: expect.any(AbortSignal) }),
    )
    controller.abort()
    await expect(
      loadSkillContext(
        '/api/agent-demo/t3/autoops/skill-library/context?threadId=one',
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('资源元数据保留地址白名单和内容检查，拒绝撤权或畸形响应', async () => {
    await installHost()
    const { loadAutoOpsResourceMetadata } = await import('./resources')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ name: 'notes.md', mime: 'text/markdown', size: 42 }))
      .mockResolvedValueOnce(Response.json({ error: '资料权限已撤销' }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ name: 'notes.md', mime: 'text/markdown', size: -1 }))
    vi.stubGlobal('fetch', fetch)
    await expect(loadAutoOpsResourceMetadata('https://outside.test/file')).rejects.toThrow(/不可用/)
    expect(fetch).not.toHaveBeenCalled()
    const url = '/api/agent-demo/t3/autoops/attachments/file-one'
    await expect(loadAutoOpsResourceMetadata(url)).resolves.toEqual({
      name: 'notes.md',
      mime: 'text/markdown',
      size: 42,
    })
    expect(fetch).toHaveBeenLastCalledWith(
      url + '?metadata=1',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    await expect(loadAutoOpsResourceMetadata(url)).rejects.toMatchObject({
      status: 403,
      message: '资料权限已撤销',
    })
    await expect(loadAutoOpsResourceMetadata(url)).rejects.toThrow(/文件信息不可用/)
  })
})
