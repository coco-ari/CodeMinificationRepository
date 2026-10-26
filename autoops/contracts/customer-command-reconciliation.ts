import * as S from 'effect/Schema'
import { SharedExecutionScope } from './shared-execution.ts'

const Identity = S.String.check(
  S.isMinLength(1),
  S.isMaxLength(512),
  S.isPattern(/^[^\x00-\x1f\x7f]+$/),
)
export const UnseenOpenCommandExport = S.Struct({
  format: S.Literal('autoops-unseen-open-command-v1'),
  method: S.Literal('openSession'),
  receipt: S.Literal('missing'),
  commandId: Identity,
  sessionId: Identity,
  deviceId: Identity,
  providerId: Identity,
  threadId: Identity,
  grantId: Identity,
  commandFingerprint: S.String.check(S.isPattern(/^[a-f0-9]{64}$/)),
  executionScope: SharedExecutionScope,
  exportedAt: S.String.check(S.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)),
})
export type UnseenOpenCommandExport = typeof UnseenOpenCommandExport.Type
export type UnseenOpenCommandIdentity = Pick<
  UnseenOpenCommandExport,
  | 'commandId'
  | 'sessionId'
  | 'deviceId'
  | 'providerId'
  | 'threadId'
  | 'grantId'
  | 'commandFingerprint'
>
export type UnseenOpenCommandLocator = Omit<UnseenOpenCommandIdentity, 'commandFingerprint'>
export const decodeUnseenOpenCommandExport = S.decodeUnknownSync(UnseenOpenCommandExport, {
  onExcessProperty: 'error',
})

/** 与既有本机账本保持相同排序；哈希由各 Node 所属模块计算，不向合同引入运行时依赖。 */
export function canonicalCustomerCommand(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered)
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, ordered(child)]),
      )
    return item
  }
  return JSON.stringify(ordered(value))
}

export function matchesUnseenOpenIdentity(
  value: UnseenOpenCommandExport,
  expected: UnseenOpenCommandIdentity,
): boolean {
  return (
    [
      'commandId',
      'sessionId',
      'deviceId',
      'providerId',
      'threadId',
      'grantId',
      'commandFingerprint',
    ] as const
  ).every((key) => value[key] === expected[key])
}
