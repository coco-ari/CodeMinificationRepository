import { EnvironmentId, MessageId, ThreadId } from '@t3tools/contracts'
import { serializeAssistantCitation } from '@t3tools/shared/assistantCitations'
import '../../index.css'
import { createRef, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { page } from 'vite-plus/test/browser'

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
}))

vi.mock(import('@t3tools/client-runtime/state/thread-workflows'), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}))

vi.mock(import('../../state/entities'), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
}))

vi.mock(import('../../state/use-atom-command'), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => undefined) as never,
}))

vi.mock(import('../../assets/assetUrls'), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}))

import { render as renderUi } from '../../../test/render'
import { QueuedRunsControl, type QueuedRunsControlHandle } from './QueuedRunsControl'
import { ComposerBanner } from './ComposerBanner'
import { ComposerSurface } from './ComposerSurface'

function setup() {
  state.projection = null
  state.workflow = null
}

const baseProps = {
  environmentId: 'environment:test' as never,
  optimisticMessages: [],
  threadId: 'thread:test' as never,
  editingRunId: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>

async function renderQueue(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  return renderUi(<QueuedRunsControl {...baseProps} {...props} />)
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll('[aria-label]')].map((element) =>
    element.getAttribute('aria-label'),
  )

describe('QueuedRunsControl automatic completion delivery', () => {
  it('does not render a queue control when only hidden delivery remains', async () => {
    setup()
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: 'run:parent',
              generation: 1,
              taskIds: ['task:child'],
            },
            id: 'message:completion',
          },
        ],
      },
    }
    state.workflow = {
      activeRun: { id: 'run:active' },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    }

    await using screen = await renderQueue()

    expect(screen.container.childElementCount).toBe(0)
  })
})

describe('QueuedRunsControl attachments and edit mode', () => {
  const workflowWithAttachment = () => ({
    activeRun: { id: 'run:active' },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: 'run:queued', userMessageId: 'message:queued' },
        text: 'Queued with a screenshot',
        attachments: [
          {
            type: 'image',
            id: 'attachment-1',
            name: 'screenshot.png',
            mimeType: 'image/png',
            sizeBytes: 128,
          },
        ],
      },
    ],
  })

  it('renders an attachment thumbnail on the queued row', async () => {
    setup()
    state.projection = { projection: { messages: [] } }
    state.workflow = workflowWithAttachment()

    await using screen = await renderQueue()

    expect(screen.container.querySelector('img')?.getAttribute('src')).toBe(
      'https://assets.test/attachment-1',
    )
    expect(screen.container.textContent).toContain('Queued with a screenshot')
    expect(labels(screen.container)).toContain('Edit queued message')
    expect(labels(screen.container)).toContain(
      'Reorder queued message (drag, or press the arrow keys)',
    )
    expect(labels(screen.container)).not.toContain('Move queued message up')
  })

  it('retains native queue geometry and read-only behavior without a permission wrapper', async () => {
    setup()
    state.projection = { projection: { messages: [] } }
    state.workflow = workflowWithAttachment()
    const handle = createRef<QueuedRunsControlHandle>()
    const onEditQueuedRun = vi.fn()
    const view = (inert: boolean) => (
      <ComposerSurface.Shell style={{ width: 400 }}>
        <ComposerSurface.Host>
          <form>
            <ComposerBanner.Dock>
              <ComposerBanner.Column>
                <QueuedRunsControl
                  {...baseProps}
                  ref={handle}
                  inert={inert}
                  onEditQueuedRun={onEditQueuedRun}
                />
              </ComposerBanner.Column>
            </ComposerBanner.Dock>
            <ComposerSurface.Main>
              <div data-chat-composer-body style={{ height: 180 }}>
                Composer
              </div>
            </ComposerSurface.Main>
          </form>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    )
    await using screen = await renderUi(view(false))
    const action = screen.container.querySelector<HTMLElement>(
      '[aria-label="Edit queued message"]',
    )!
    const body = screen.container.querySelector<HTMLElement>('[data-chat-composer-body]')!
    const rect = action.getBoundingClientRect()
    expect(body.getBoundingClientRect().top).toBeGreaterThanOrEqual(rect.bottom)
    expect(
      action.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ),
    ).toBe(true)
    await page.getByRole('button', { name: 'Edit queued message', exact: true }).click()
    expect(onEditQueuedRun).toHaveBeenCalledTimes(1)
    await screen.rerender(view(true))
    expect(
      screen.container.querySelector('[data-slot="composer-banner-attachment"][inert]'),
    ).not.toBeNull()
    expect(handle.current?.editLatest(false)).toBe(false)
    expect(handle.current?.steerNext(false)).toBe(false)
    expect(onEditQueuedRun).toHaveBeenCalledTimes(1)
  })

  it('drops the optimistic pending row once the projection holds its message', async () => {
    setup()
    state.projection = {
      projection: { messages: [{ id: 'message:acknowledged', text: 'hello' }] },
    }
    state.workflow = {
      activeRun: { id: 'run:active' },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    }

    await using screen = await renderQueue({
      optimisticMessages: [
        {
          id: 'message:acknowledged' as never,
          inputIntent: 'queued_turn',
          text: 'hello',
          attachments: [],
        },
      ],
    })

    expect(screen.container.childElementCount).toBe(0)
  })

  it('keeps the original queued message visible while editing', async () => {
    setup()
    state.projection = { projection: { messages: [] } }
    state.workflow = workflowWithAttachment()

    await using screen = await renderQueue({ editingRunId: 'run:queued' as never })

    expect(screen.container.textContent).toContain('Queued with a screenshot')
  })
})

it('previews assistant quotes as readable text and preserves the citation when editing', async () => {
  setup()
  const quotedText = 'Cache the parsed config per worktree.'
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make('environment:test'),
    threadId: ThreadId.make('thread:test'),
    messageId: MessageId.make('message:assistant'),
    text: quotedText,
    start: 0,
    end: quotedText.length,
    prefix: '',
    suffix: '',
  })
  const quoteAndText = `${quote}\n\nWhy per worktree?`
  state.projection = { projection: { messages: [] } }
  state.workflow = {
    activeRun: { id: 'run:active' },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: 'run:quote-only', userMessageId: 'message:quote-only' },
        text: quote,
        attachments: [],
      },
      {
        run: { id: 'run:quote-and-text', userMessageId: 'message:quote-and-text' },
        text: quoteAndText,
        attachments: [],
      },
    ],
  }
  const onEditQueuedRun = vi.fn()
  await using _screen = await renderQueue({ onEditQueuedRun })

  await expect.element(page.getByText(quotedText, { exact: true })).toBeVisible()
  await expect
    .element(page.getByText(`${quotedText} Why per worktree?`, { exact: true }))
    .toBeVisible()

  await page.getByRole('button', { name: 'Edit queued message', exact: true }).nth(1).click()
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: quoteAndText }),
  )
})
