import * as S from 'effect/Schema'
import { DirectoryId } from './project-directory.ts'

const name = S.String.check(S.isMinLength(1), S.isMaxLength(120))
const host = S.String.check(S.isMinLength(1), S.isMaxLength(255))
const port = S.Number.check(S.isInt(), S.isBetween({ minimum: 1, maximum: 65535 }))
const list = (value: S.ConstraintDecoder<string>) => S.Array(value).check(S.isMaxLength(32))
const path = S.String.check(S.isMinLength(1), S.isMaxLength(1000))
const tls = S.Literals(['disabled', 'required'])

export const EnvironmentMcpConfiguration = S.Union([
  S.Struct({
    type: S.Literal('server'),
    name,
    host,
    port,
    credentialId: DirectoryId,
    hostKeySha256: S.String.check(S.isPattern(/^SHA256:[A-Za-z0-9+/]{43}=?$/)),
    readPaths: list(path),
    serviceUnits: list(S.String.check(S.isMinLength(1), S.isMaxLength(255))),
  }),
  S.Struct({
    type: S.Literal('mysql'),
    name,
    host,
    port,
    credentialId: DirectoryId,
    database: S.String.check(S.isMinLength(1), S.isMaxLength(128)),
    tls,
  }),
  S.Struct({
    type: S.Literal('redis'),
    name,
    host,
    port,
    credentialId: S.optionalKey(DirectoryId),
    database: S.Number.check(S.isInt(), S.isBetween({ minimum: 0, maximum: 15 })),
    tls,
    keyPatterns: list(S.String.check(S.isMinLength(1), S.isMaxLength(256))).check(S.isMinLength(1)),
  }),
])
export type EnvironmentMcpConfiguration = typeof EnvironmentMcpConfiguration.Type

export const EnvironmentMcpCommand = S.Struct({
  requestId: DirectoryId,
  expectedRevision: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
})
export const SaveEnvironmentMcp = S.Struct({
  ...EnvironmentMcpCommand.fields,
  value: EnvironmentMcpConfiguration,
})
export const SetEnvironmentMcpEnabled = S.Struct({
  ...EnvironmentMcpCommand.fields,
  enabled: S.Boolean,
})
export type EnvironmentMcpCommand = typeof EnvironmentMcpCommand.Type

const connection = { connectionId: DirectoryId }
const sql = S.String.check(S.isMinLength(1), S.isMaxLength(65536))
const parameters = S.optionalKey(
  S.Array(S.Union([S.String, S.Number, S.Boolean, S.Null])).check(S.isMaxLength(100)),
)
const key = S.String.check(S.isMinLength(1), S.isMaxLength(1024))
export const EnvironmentMcpOperation = S.Union([
  S.Struct({ ...connection, action: S.Literal('server.snapshot') }),
  S.Struct({
    ...connection,
    action: S.Literal('server.service'),
    unit: S.String.check(S.isMinLength(1), S.isMaxLength(255)),
  }),
  S.Struct({
    ...connection,
    action: S.Literal('server.read'),
    path,
    offset: S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0)),
    maxBytes: S.Number.check(S.isInt(), S.isBetween({ minimum: 1, maximum: 262144 })),
  }),
  S.Struct({ ...connection, action: S.Literal('mysql.tables') }),
  S.Struct({
    ...connection,
    action: S.Literal('mysql.describe'),
    table: S.String.check(S.isMinLength(1), S.isMaxLength(128)),
  }),
  S.Struct({ ...connection, action: S.Literal('mysql.query'), sql, params: parameters }),
  S.Struct({ ...connection, action: S.Literal('mysql.explain'), sql, params: parameters }),
  S.Struct({
    ...connection,
    action: S.Literal('redis.scan'),
    pattern: S.String.check(S.isMinLength(1), S.isMaxLength(256)),
    cursor: S.String.check(S.isPattern(/^\d{1,128}$/)),
    limit: S.Number.check(S.isInt(), S.isBetween({ minimum: 1, maximum: 200 })),
  }),
  S.Struct({
    ...connection,
    action: S.Literal('redis.read'),
    key,
    field: S.optionalKey(S.String.check(S.isMaxLength(1024))),
  }),
  S.Struct({ ...connection, action: S.Literal('redis.ttl'), key }),
])
export type EnvironmentMcpOperation = typeof EnvironmentMcpOperation.Type
// T3 使用自己的 Effect 运行时；仅以公开 JSON Schema 传递合同，避免跨实例 AST。
export const EnvironmentMcpOperationDocument = S.toJsonSchemaDocument(EnvironmentMcpOperation, {
  onExcessProperty: 'error',
})
const decodeOperation = S.decodeUnknownExit(EnvironmentMcpOperation, { onExcessProperty: 'error' })
export function isEnvironmentMcpOperation(value: unknown): value is EnvironmentMcpOperation {
  return decodeOperation(value)._tag === 'Success'
}
export type EnvironmentMcpAction = EnvironmentMcpOperation['action']

export interface EnvironmentMcpTestResult {
  connectionId: string
  revision: number
  testedAt: string
  status: 'passed' | 'failed'
  actions: EnvironmentMcpAction[]
  error?: { code: string; message: string }
}
export interface EnvironmentMcpConnection {
  id: string
  projectId: string
  environmentId: string
  revision: number
  enabled: boolean
  removed: boolean
  configuration: EnvironmentMcpConfiguration
  createdAt: string
  updatedAt: string
  lastTest?: EnvironmentMcpTestResult
}
export interface EnvironmentMcpResource {
  id: string
  name: string
  type: EnvironmentMcpConfiguration['type']
  revision: number
  actions: EnvironmentMcpAction[]
  scope: {
    readPaths?: string[]
    serviceUnits?: string[]
    database?: string | number
    keyPatterns?: string[]
  }
}
export interface EnvironmentMcpRunCatalog {
  status: 'active' | 'released'
  threadId: string
  runId: string
  projectId: string
  environmentId: string | null
  capturedAt: string
  connections: EnvironmentMcpResource[]
  unavailable: Array<{ id: string; name: string; code: string; message: string }>
}
export interface EnvironmentMcpQueryResult {
  source: 'environment_mcp'
  connectionId: string
  connectionName: string
  connectionType: EnvironmentMcpConfiguration['type']
  connectionRevision: number
  projectId: string
  environmentId: string
  observedAt: string
  data: unknown
  truncated: boolean
}
export interface EnvironmentMcpDeletion {
  id: string
  projectId: string
  environmentId: string
  revision: number
  removed: true
}
export interface EnvironmentMcpReceipt {
  status: 'pending' | 'completed' | 'failed'
  result?: EnvironmentMcpConnection | EnvironmentMcpTestResult | EnvironmentMcpDeletion
  error?: { code: string; message: string }
}
