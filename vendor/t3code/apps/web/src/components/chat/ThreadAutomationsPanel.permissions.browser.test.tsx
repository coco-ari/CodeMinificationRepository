import { EnvironmentId, ThreadId, ScheduledTaskId, type ScheduledTask } from '@t3tools/contracts'
import { expect, it, vi } from 'vite-plus/test'

const state = vi.hoisted(() => ({
  allowed: true,
  scheduledTasks: true,
  query: vi.fn(),
  toggle: vi.fn(),
  run: vi.fn(),
}))
vi.mock(import('../../autoops/capabilities'), async (importOriginal) => ({
  ...(await importOriginal()),
  autoOpsFeature: () => state.scheduledTasks,
}))
vi.mock(import('../../state/session'), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}))
// The panel reads the run permission through an atom; the grant is the boundary under test.
vi.mock(import('@effect/atom-react'), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => state.allowed) as never,
}))
vi.mock(import('@tanstack/react-router'), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}))
vi.mock(import('../../state/use-atom-command'), async (importOriginal) => {
  const { serverEnvironment } = await import('../../state/server')
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.setScheduledTaskEnabled ? state.toggle : state.run) as never,
  }
})
vi.mock(import('../../state/query'), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => {
    state.query()
    return { data: { tasks: [task] }, error: null }
  }) as never,
}))

import { act, render as renderUi } from '../../../test/render'
import { ThreadAutomationsPanel } from './ThreadAutomationsPanel'
const environmentId = EnvironmentId.make('remote')
const threadId = ThreadId.make('thread')
const task = {
  id: ScheduledTaskId.make('task'),
  threadId,
  title: 'Daily review',
  enabled: true,
  schedule: { type: 'interval', everyMs: 60000 },
  lastRunStatus: 'never',
} as ScheduledTask

async function setup() {
  state.allowed = true
  state.scheduledTasks = true
  state.query.mockReset()
  state.toggle.mockReset().mockResolvedValue({ _tag: 'Success' })
  state.run.mockReset().mockResolvedValue({ _tag: 'Success' })

  await using stack = new AsyncDisposableStack()
  const screen = stack.use(await renderUi(null))
  const container = screen.container
  async function renderPanel() {
    await act(
      async () =>
        await screen.rerender(
          <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
        ),
    )
  }

  const byLabel = (label: string) =>
    container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!

  const environment = stack.move()
  return { renderPanel, byLabel, [Symbol.asyncDispose]: () => environment.disposeAsync() }
}
it.each([true, false])('runs scheduled work only with task permission (%s)', async (allowed) => {
  await using fixture = await setup()
  const { renderPanel, byLabel } = fixture
  state.allowed = allowed
  await renderPanel()
  await act(async () => byLabel('Run Daily review now').click())
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0)
})

it('rejects a retained toggle after task permission is revoked', async () => {
  await using fixture = await setup()
  const { renderPanel, byLabel } = fixture
  await renderPanel()
  state.allowed = false
  await act(async () => byLabel('Pause Daily review').click())
  expect(state.toggle).not.toHaveBeenCalled()

  state.allowed = true
  await act(async () => byLabel('Pause Daily review').click())
  expect(state.toggle).toHaveBeenCalledOnce()
})

it('explains unavailable hosted automations without starting a forbidden scheduler query', async () => {
  await using fixture = await setup()
  state.scheduledTasks = false
  await fixture.renderPanel()
  expect(state.query).not.toHaveBeenCalled()
  expect(fixture.byLabel('Manage scheduled tasks').hasAttribute('disabled')).toBe(true)
  expect(document.body.textContent).toContain('当前业务环境尚未开放定时任务。')
  expect(state.run).not.toHaveBeenCalled()
})
