import * as Schema from 'effect/Schema'
import * as SchemaRepresentation from 'effect/SchemaRepresentation'
import { EnvironmentMcpOperationDocument, isEnvironmentMcpOperation, type EnvironmentMcpOperation } from '../../../../../../autoops/contracts/environment-mcp.ts'

// 纯合同导出的受信任文档由 T3 自身运行时重建；业务所有者仍严格解码实际输入。
export const environmentMcpOperation = SchemaRepresentation.fromJsonSchemaDocument(
  EnvironmentMcpOperationDocument,
  { patterns: 'apply' },
).check(Schema.makeFilter(isEnvironmentMcpOperation)) as Schema.Codec<EnvironmentMcpOperation>
