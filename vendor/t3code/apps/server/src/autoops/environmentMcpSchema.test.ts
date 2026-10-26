import { expect, it } from 'vite-plus/test'
import * as Schema from 'effect/Schema'
import { environmentMcpOperation } from './environmentMcpSchema.ts'

const parse = Schema.decodeUnknownSync(environmentMcpOperation, {onExcessProperty: 'error'})
const samples = [
  {action: 'server.snapshot'},
  {action: 'server.service', unit: 'app.service'},
  {action: 'server.read', path: '/srv/日志.log', offset: 0, maxBytes: 262144},
  {action: 'mysql.tables'},
  {action: 'mysql.describe', table: 'orders'},
  {action: 'mysql.query', sql: 'SELECT value FROM settings WHERE id=?', params: [1, null, true, '只读']},
  {action: 'mysql.explain', sql: 'SELECT 1'},
  {action: 'redis.scan', pattern: 'app:*', cursor: '0', limit: 200},
  {action: 'redis.read', key: 'app:设置', field: '值'},
  {action: 'redis.ttl', key: 'app:设置'},
]

it('T3从纯合同重建全部环境只读操作，保留参数而不跨Effect实例传AST', () => {
  for (const sample of samples) {
    const input = {connectionId: 'connection_1', ...sample}
    expect(parse(input)).toEqual(input)
  }
})

it('拒绝执行身份、额外命令、无效操作、跨界数值和不完整参数', () => {
  for (const sample of samples)
    for (const extra of [{actorId: 'admin'}, {projectId: 'foreign'}, {environmentId: 'production'}, {command: 'rm -rf /'}])
      expect(() => parse({connectionId: 'connection_1', ...sample, ...extra})).toThrow()
  for (const input of [
    {action: 'server.exec', connectionId: 'connection_1'},
    {action: 'server.read', connectionId: '../foreign', path: '/srv/x', offset: 0, maxBytes: 1},
    {action: 'server.read', connectionId: 'connection_1', path: '/srv/x', offset: -1, maxBytes: 1},
    {action: 'server.read', connectionId: 'connection_1', path: '/srv/x', offset: 0, maxBytes: 262145},
    {action: 'mysql.query', connectionId: 'connection_1'},
    {action: 'mysql.query', connectionId: 'connection_1', sql: 'SELECT ?', params: [{}]},
    {action: 'redis.scan', connectionId: 'connection_1', pattern: '*', cursor: 'next', limit: 1},
    {action: 'redis.scan', connectionId: 'connection_1', pattern: '*', cursor: '0', limit: 201},
  ]) expect(() => parse(input)).toThrow()
})
