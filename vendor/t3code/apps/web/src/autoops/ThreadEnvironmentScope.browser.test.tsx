import { expect, it, vi } from 'vite-plus/test'
import { page, userEvent } from 'vite-plus/test/browser'
import { EnvironmentId } from '@t3tools/contracts'
import { render } from '../../test/render'
import { DraftId } from '~/composerDraftStore'
import { AutoOpsThreadScopeControl } from './ThreadScopeControl'
import { installAutoOpsHost, readAutoOpsThreadScope, setAutoOpsThreadScope } from './hostConfig'

const mocks = vi.hoisted(() => ({ createThread: vi.fn() }))
vi.mock(import('~/hooks/useHandleNewThread'), () => ({ useNewThreadHandler: () => mocks.createThread }))

function setup(external: boolean, threadId: string) {
  mocks.createThread.mockReset()
  installAutoOpsHost({
    principal: { id: 'scope-owner', displayName: '测试用户' },
    csrfToken: 'isolated-csrf', gatewayBasePath: '/api/agent-demo/t3',
    fixedModel: { instanceId: 'codex', model: 'isolated-model' },
    runtimeMode: 'approval-required', capabilities: {},
    projects: [{
      id: 'scope-project', name: '范围项目',
      environments: external ? [] : [{ id: 'test', name: '测试环境' }],
      agents: [{ id: 'assistant', name: '项目助手' }],
      capabilities: { 'workspace.read': true, 'workspace.manage': false, 'deployment.read': false, 'deployment.execute': false },
      membership: { role: external ? 'external' : 'reader', workspaceAccess: external ? 'external' : 'internal', environmentIds: external ? [] : ['test'] },
    }],
  }, window.location.origin)
  setAutoOpsThreadScope(threadId, {
    projectId: 'scope-project', environmentId: external ? null : 'test', agentId: 'assistant',
    visibility: 'private', workspaceType: external ? 'external' : 'internal',
  })
  return <AutoOpsThreadScopeControl threadId={threadId} projectId="scope-project" isDraft
    runtimeEnvironmentId={EnvironmentId.make('scope-runtime')} draftTarget={DraftId.make(threadId)}
    submitting={false} hasAcceptedMessage={false} />
}

it('空草稿可选择无环境再恢复原环境，不创建其他会话且菜单恢复焦点', async () => {
  await using screen = await render(setup(false, 'scope-empty-draft'))
  const trigger = screen.getByRole('button', { name: '业务环境' })
  await trigger.click()
  await page.getByRole('menuitemradio', { name: '无环境', exact: true }).click()
  await vi.waitFor(() => expect(readAutoOpsThreadScope('scope-empty-draft', 'scope-project')?.environmentId).toBeNull())
  await expect.element(trigger).toHaveTextContent('无环境')
  await trigger.click()
  await page.getByRole('menuitemradio', { name: '测试环境', exact: true }).click()
  await vi.waitFor(() => expect(readAutoOpsThreadScope('scope-empty-draft', 'scope-project')?.environmentId).toBe('test'))
  await trigger.click()
  await userEvent.keyboard('{Escape}')
  await expect.element(trigger).toHaveFocus()
  expect(mocks.createThread).not.toHaveBeenCalled()
})

it('外部成员无环境仍能呈现问答范围，不出现未分配环境或内部范围', async () => {
  await using screen = await render(setup(true, 'scope-external-draft'))
  await expect.element(screen.getByRole('button', { name: '业务环境' })).toHaveTextContent('无环境')
  await expect.element(screen.getByRole('button', { name: '对话工作区' })).toHaveTextContent('外部脱敏')
  await screen.getByRole('button', { name: '业务环境' }).click()
  await expect.element(page.getByRole('menuitemradio', { name: '无环境', exact: true })).toBeVisible()
  await expect.element(page.getByRole('menuitemradio', { name: '测试环境', exact: true })).not.toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  expect(readAutoOpsThreadScope('scope-external-draft', 'scope-project')).toMatchObject({ environmentId: null, workspaceType: 'external', visibility: 'private' })
})
