const { readdirSync } = require('node:fs')
const modules = readdirSync('autoops/server/modules', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
module.exports = {
  forbidden: [
    { name: '禁止循环依赖', severity: 'error', from: {}, to: { circular: true } },
    { name: '禁止未解析依赖', severity: 'error', from: {}, to: { couldNotResolve: true } },
    {
      name: '新产品不依赖历史宿主',
      severity: 'error',
      from: { path: '^autoops/' },
      to: { path: '^(agent-demo|src|web|vendor)/' },
    },
    {
      name: '公共合同不依赖服务端',
      severity: 'error',
      from: { path: '^autoops/contracts/' },
      to: { path: '^autoops/server/|^node:' },
    },
    {
      name: '基础设施不反向依赖业务',
      severity: 'error',
      from: { path: '^autoops/server/platform/' },
      to: { path: '^autoops/server/modules/' },
    },
    {
      name: '领域规则保持纯粹',
      severity: 'error',
      from: { path: '/domain\\.ts$' },
      to: { path: '^autoops/server/.*(?:sqlite|service|index|app)\\.ts$|^node:|^hono' },
    },
    ...modules.map((name) => ({
      name: `${name}只通过公开入口被调用`,
      severity: 'error',
      from: { path: '^autoops/server/', pathNot: `^autoops/server/modules/${name}/` },
      to: { path: `^autoops/server/modules/${name}/`, pathNot: '/index\\.ts$' },
    })),
  ],
  options: {
    parser: 'swc',
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.mjs', '.json'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default'],
    },
    exclude: '\\.test\\.ts$',
  },
}
