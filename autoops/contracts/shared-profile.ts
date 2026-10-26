import * as S from 'effect/Schema'
import { RunnerReferenceId } from './customer-source.ts'

const Revision = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(1))
const Digest = S.String.check(S.isPattern(/^[a-f0-9]{64}$/))
export const SharedProfileDescriptor = S.Struct({
  id: RunnerReferenceId,
  revision: Revision,
  digest: Digest,
  imageDigest: S.String.check(S.isPattern(/^sha256:[a-f0-9]{64}$/)),
  policy: S.Literal('linux-docker-readonly-v1'),
})
export type SharedProfileDescriptor = typeof SharedProfileDescriptor.Type

/** 此目录由隔离运行器实际发现；不从提供者默认 HOME 或平台模型目录补齐。 */
export const SharedProfileCapability = S.Struct({
  ...SharedProfileDescriptor.fields,
  models: S.Array(S.Struct({
    id: S.String.check(S.isMinLength(1), S.isMaxLength(128)),
    name: S.optionalKey(S.String.check(S.isMaxLength(200))),
    supportedReasoningEfforts: S.Array(S.String.check(S.isMinLength(1), S.isMaxLength(40))).check(S.isMaxLength(16)),
    defaultReasoningEffort: S.optionalKey(S.String.check(S.isMinLength(1), S.isMaxLength(40))),
  })).check(S.isMaxLength(1000)),
  skills: S.Array(S.Struct({
    id: RunnerReferenceId,
    name: S.String.check(S.isMinLength(1), S.isMaxLength(200)),
    description: S.String.check(S.isMaxLength(4000)),
  })).check(S.isMaxLength(2000)),
})
export type SharedProfileCapability = typeof SharedProfileCapability.Type
