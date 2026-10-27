import * as S from 'effect/Schema'
import * as Exit from 'effect/Exit'
import { EnvironmentMcpOperation } from './environment-mcp.ts'

const Identity = S.String.check(
  S.isMinLength(1),
  S.isMaxLength(512),
  S.isPattern(/^[^\x00-\x1f\x7f]+$/),
)
export const CUSTOMER_PLATFORM_TOOLS_VERSION = 1
export const CustomerPlatformToolName = S.Literals([
  'list_project_materials',
  'read_project_material',
  'query_environment',
  'read_environment',
])
export type CustomerPlatformToolName = typeof CustomerPlatformToolName.Type
/** 引用仅由中心原轮准备持久生成；本机模型不能指定调用者、资料输入或环境。 */
export const CustomerPlatformToolReference = S.Struct({
  version: S.Literal(1),
  contextId: Identity,
})
export type CustomerPlatformToolReference = typeof CustomerPlatformToolReference.Type
const EmptyParameters = S.Struct({}).check(S.makeFilter((value) => Object.keys(value).length === 0))
export const CustomerPlatformToolParameters = {
  list_project_materials: EmptyParameters,
  read_project_material: S.Struct({ path: S.String.check(S.isMinLength(1), S.isMaxLength(2048)) }),
  query_environment: EmptyParameters,
  read_environment: S.Struct({ operation: EnvironmentMcpOperation }),
} as const
export const CustomerPlatformToolCall = S.Union([
  S.Struct({
    tool: S.Literal('list_project_materials'),
    arguments: CustomerPlatformToolParameters.list_project_materials,
  }),
  S.Struct({
    tool: S.Literal('read_project_material'),
    arguments: CustomerPlatformToolParameters.read_project_material,
  }),
  S.Struct({
    tool: S.Literal('query_environment'),
    arguments: CustomerPlatformToolParameters.query_environment,
  }),
  S.Struct({
    tool: S.Literal('read_environment'),
    arguments: CustomerPlatformToolParameters.read_environment,
  }),
])
export type CustomerPlatformToolCall = typeof CustomerPlatformToolCall.Type
export const CustomerPlatformToolRequest = S.Struct({
  reference: CustomerPlatformToolReference,
  commandId: Identity,
  sessionId: Identity,
  runtimeEpoch: Identity,
  call: CustomerPlatformToolCall,
})
export type CustomerPlatformToolRequest = typeof CustomerPlatformToolRequest.Type

/** 不把所属Effect的AST交给另一实例解释，仍保留全部字段约束。 */
export function isCustomerPlatformToolReference(
  value: unknown,
): value is CustomerPlatformToolReference {
  return Exit.isSuccess(
    S.decodeUnknownExit(CustomerPlatformToolReference, { onExcessProperty: 'error' })(value),
  )
}
export const CustomerPlatformToolParameterDocuments = Object.fromEntries(
  Object.entries(CustomerPlatformToolParameters).map(([name, schema]) => [
    name,
    S.toJsonSchemaDocument(schema, { onExcessProperty: 'error' }),
  ]),
) as Record<CustomerPlatformToolName, ReturnType<typeof S.toJsonSchemaDocument>>
export function isCustomerPlatformToolCall(value: unknown): value is CustomerPlatformToolCall {
  return Exit.isSuccess(
    S.decodeUnknownExit(CustomerPlatformToolCall, { onExcessProperty: 'error' })(value),
  )
}
