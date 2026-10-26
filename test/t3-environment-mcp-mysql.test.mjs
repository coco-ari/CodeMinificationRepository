import assert from 'node:assert/strict'
import { test } from 'node:test'
import mysql from 'mysql2'
import { createMysqlReadonlyDriver } from '../agent-demo/t3-adapters/environment-mcp/drivers/mysql.ts'

// 显式指定隔离端口才连接；默认 CI 不访问开发者或服务器数据库。
const port = process.env.AUTOOPS_MCP_MYSQL_TEST_PORT
for (const mode of ['', 'NO_BACKSLASH_ESCAPES']) {
  test(`真实 MySQL ${mode || '标准转义'} 保留绑定参数字面值和只读流`, { skip: !port }, async () => {
    const driver = createMysqlReadonlyDriver({
      connect(options) {
        const connection = mysql.createConnection(options)
        const connect = connection.connect.bind(connection)
        connection.connect = (callback) =>
          connect((error) => {
            if (error) return callback(error)
            connection.query('SET SESSION sql_mode = ?', [mode], (setupError) =>
              callback(setupError),
            )
          })
        return connection
      },
    })
    const configuration = {
      type: 'mysql',
      name: '隔离参数验证',
      host: '127.0.0.1',
      port: Number(port),
      database: 'autoops_mcp_fixture',
      tls: 'disabled',
      credentialId: 'fixture-reader',
    }
    const credential = {
      username: process.env.AUTOOPS_MCP_MYSQL_TEST_USER,
      password: process.env.AUTOOPS_MCP_MYSQL_TEST_PASSWORD,
    }
    assert.equal(credential.username, 'autoops-reader')
    assert.ok(credential.password)
    const context = {
      signal: new AbortController().signal,
      limits: { timeoutMs: 10000, maxRows: 5, maxKeys: 100, maxBytes: 262144 },
    }
    try {
      for (const value of ["O'Reilly", '\\路径', '只读参数', null, 37]) {
        const result = await driver.execute(
          configuration,
          {
            connectionId: 'fixture',
            action: 'mysql.query',
            sql: 'SELECT ? AS value',
            params: [value],
          },
          credential,
          context,
        )
        assert.equal(result.data[0].value, value)
        assert.equal(result.truncated, false)
      }
    } finally {
      await driver.close()
    }
  })
}
