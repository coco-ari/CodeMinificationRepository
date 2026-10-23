import * as S from 'effect/Schema'
import { errorStatuses, type ErrorCode } from '../../contracts/index.ts'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: (typeof errorStatuses)[ErrorCode]
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.status = errorStatuses[code]
  }
}
export function requireCondition(
  condition: unknown,
  code: ErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new AppError(code, message)
}
export function decode<Scheme extends S.ConstraintDecoder<unknown>>(
  schema: Scheme,
  input: unknown,
): Scheme['Type'] {
  try {
    return S.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
  } catch {
    throw new AppError('INVALID_INPUT', '输入字段、格式或长度无效')
  }
}
