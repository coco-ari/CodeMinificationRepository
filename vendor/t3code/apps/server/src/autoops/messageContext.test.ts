import { OrchestrationMessageContext } from '@t3tools/contracts'
import { serializeComposerFileLink } from '@t3tools/shared/composerTrigger'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'
import { prepareBusinessMessagePayload } from './messageContext.ts'

const access = { getThreadBinding: () => undefined }
const path = 'autoops/p-autoops/inputs/selected/demo/src/产品 (1).ts'
const text = `${serializeComposerFileLink(path)} 分析这个文件`
const contextOf = (value: unknown) =>
  Schema.decodeUnknownSync(OrchestrationMessageContext)((value as { context: unknown }).context)

describe('业务文件标签的消息授权上下文', () => {
  it('当前文件别名从原生标签进入本轮授权上下文，原别名及文字逐字保留', () => {
    const alias = 'autoops/p-autoops/current-input-files/thread/picker/selected-revision/docs/current.txt'
    const body = `${serializeComposerFileLink(alias)} 读取刚添加的文件`
    for (const type of ['message.dispatch', 'queued-run.edit']) {
      const command = { threadId: 'thread', type, text: body }
      const normalized = prepareBusinessMessagePayload(access, 'orchestration.dispatchCommand', command)
      expect(contextOf(normalized).records).toEqual([
        expect.objectContaining({ kind: 'mention', path: alias, label: 'current.txt' }),
      ])
      expect((normalized as typeof command).text).toBe(body)
      expect(prepareBusinessMessagePayload(access, 'orchestration.dispatchCommand', normalized)).toBe(normalized)
    }
    const launch = prepareBusinessMessagePayload(access, 'orchestration.launchThread', {
      threadId: 'thread', initialMessage: { text: body },
    }) as { initialMessage: { text: string; context: unknown } }
    expect(contextOf(launch.initialMessage).records).toHaveLength(1)
    const customer: Parameters<typeof prepareBusinessMessagePayload>[0] = {
      getThreadBinding: () => ({
        threadId: 'thread', projectId: 'project', environmentId: 'test', agentId: 'helper', ownerId: 'owner',
        executionBinding: { kind: 'customer', deviceId: 'device', registeredWorkspaceId: 'workspace', workspaceBindingRevision: 1, runtimeId: 'codex' },
        visibility: 'private', createdAt: '2026-10-26T00:00:00Z', scopeState: 'locked', scopeLocked: true,
        compatibilityReadOnly: false, continuationVerified: false,
      }),
    }
    const command = { threadId: 'thread', type: 'message.dispatch', text: body }
    expect(prepareBusinessMessagePayload(customer, 'orchestration.dispatchCommand', command)).toBe(command)
  })

  it('首次发送、继续对话和编辑待发消息保存同一文件身份，原生文字保持不变', () => {
    const message = { text, context: { version: 1, records: [] } }
    const launch = prepareBusinessMessagePayload(access, 'orchestration.launchThread', {
      threadId: 'thread',
      initialMessage: message,
    }) as { initialMessage: typeof message }
    const expected = contextOf(launch.initialMessage)
    expect(expected.records).toHaveLength(1)
    expect(expected.records[0]).toMatchObject({ kind: 'mention', path, label: '产品 (1).ts' })
    expect(launch.initialMessage.text).toBe(text)
    for (const type of ['message.dispatch', 'queued-run.edit']) {
      const command = { threadId: 'thread', type, text }
      const normalized = prepareBusinessMessagePayload(
        access,
        'orchestration.dispatchCommand',
        command,
      )
      expect(contextOf(normalized)).toEqual(expected)
      expect(
        prepareBusinessMessagePayload(access, 'orchestration.dispatchCommand', normalized),
      ).toBe(normalized)
    }
    expect(message.context.records).toEqual([])
  })

  it('末尾标签、重复标签和已有上下文不会丢失或重复引用', () => {
    const terminal = {
      version: 1,
      kind: 'terminal',
      contextId: 'terminal-one',
      label: '输出',
      terminalId: 'one',
      terminalLabel: '终端',
      lineStart: 0,
      lineEnd: 0,
      text: '原始输出',
    }
    const command = {
      threadId: 'thread',
      type: 'message.dispatch',
      text: `${text} ${serializeComposerFileLink(path)}`,
      context: { version: 1, records: [terminal] },
    }
    const context = contextOf(
      prepareBusinessMessagePayload(access, 'orchestration.dispatchCommand', command),
    )
    expect(context.records).toHaveLength(2)
    expect(context.records[0]).toMatchObject(terminal)
    expect(context.records[1]).toMatchObject({ kind: 'mention', path })
  })

  it('普通链接、本机路径和非发送命令不产生平台资源授权', () => {
    for (const command of [
      {
        threadId: 'thread',
        type: 'message.dispatch',
        text: '[网页](https://example.invalid/a.ts) [a.ts](src/a.ts)',
      },
      { threadId: 'thread', type: 'thread.metadata.update', text },
    ])
      expect(prepareBusinessMessagePayload(access, 'orchestration.dispatchCommand', command)).toBe(
        command,
      )
  })

  it('超过原生上下文数量限制时明确拒绝，不能截断后遗漏授权', () => {
    const command = {
      threadId: 'thread',
      type: 'message.dispatch',
      text: Array.from({ length: 201 }, (_, index) =>
        serializeComposerFileLink(`autoops/p-autoops/inputs/selected/${index}.ts`),
      ).join(' '),
    }
    expect(() =>
      prepareBusinessMessagePayload(access, 'orchestration.dispatchCommand', command),
    ).toThrow()
  })
})
