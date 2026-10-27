// @effect-diagnostics nodeBuiltinImport:off -- 缺省消息身份按原命令确定，授权与原生持久化使用同一身份。
import { createHash } from 'node:crypto'
import { OrchestrationMessageContext } from '@t3tools/contracts'
import { collectComposerInlineTokens } from '@t3tools/shared/composerInlineTokens'
import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from '@t3tools/shared/composerContextReferences'
import * as Schema from 'effect/Schema'
import type { AutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// 原生文件标签保存为 Markdown；在授权和持久化共同入口补齐业务引用，保持显示文本不变。
export function prepareBusinessMessagePayload(
  access: Pick<AutoOpsAccess, 'getThreadBinding'>,
  method: string,
  payload: unknown,
): unknown {
  let command = object(payload)
  if (!command || typeof command.threadId !== 'string') return payload
  const launch = method === 'orchestration.launchThread'
  if (
    !launch &&
    !(
      method === 'orchestration.dispatchCommand' &&
      (command.type === 'message.dispatch' || command.type === 'queued-run.edit')
    )
  )
    return payload
  if (
    launch &&
    object(command.initialMessage)?.messageId === undefined &&
    typeof command.commandId === 'string' &&
    object(command.initialMessage)
  ) {
    command = {
      ...command,
      initialMessage: {
        ...object(command.initialMessage),
        messageId:
          'autoops-message-' + createHash('sha256').update(command.commandId).digest('hex'),
      },
    }
    payload = command
  }
  if (access.getThreadBinding(String(command.threadId))?.executionBinding?.kind === 'customer')
    return payload
  const message = launch ? object(command.initialMessage) : command
  if (!message || typeof message.text !== 'string') return payload
  const context = Schema.decodeUnknownSync(OrchestrationMessageContext)(
    message.context ?? { version: 1, records: [] },
  )
  const records = [...context.records]
  const paths = new Set(
    records.flatMap((record) =>
      record.kind === 'mention' && 'path' in record && typeof record.path === 'string'
        ? [record.path]
        : [],
    ),
  )
  for (const token of collectComposerInlineTokens(message.text + '\n')) {
    if (
      token.type !== 'mention' ||
      !/^autoops\/[^/]+\/(?:inputs|current-input-files|workspaces|documents|environments|threads)\//.test(
        token.value,
      ) ||
      paths.has(token.value)
    )
      continue
    paths.add(token.value)
    records.push({
      version: 1,
      kind: 'mention',
      contextId: toKindScopedComposerContextId('mention', token.value),
      label: sanitizeComposerContextLabel(token.value.split('/').at(-1) ?? token.value, 'mention'),
      path: token.value,
    })
  }
  if (records.length === context.records.length) return payload
  const normalized = {
    ...message,
    context: Schema.decodeUnknownSync(OrchestrationMessageContext)({ version: 1, records }),
  }
  return launch ? { ...command, initialMessage: normalized } : normalized
}
