import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cruise } from 'dependency-cruiser'

export const runtimeRoots = [
  'agent-demo',
  'agent',
  'src',
  'autoops/contracts',
  'vendor/t3code/apps/server/src/autoops',
  'vendor/t3code/apps/web/src/autoops',
]

const server = 'vendor/t3code/apps/server/src/'
const web = 'vendor/t3code/apps/web/src/'
const adapters = 'agent-demo/t3-adapters/'
const scope = `^(?:${runtimeRoots.join('|')})/`
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const declaration = /\.d\.[cm]?ts$/
const sourceFile = /\.[cm]?[jt]sx?$/
const ignoredDirectories = new Set(['node_modules', 'data', 'dist', '.git'])
// 此文件会连接真实客户执行环境，是手动验收程序，不属于发行运行入口。
const manualHarnesses = new Set(['agent-demo/customer-agent/live-validation.mjs'])

export async function discoverRuntimeSources(root = process.cwd()) {
  const groups = []
  async function walk(directory) {
    const files = []
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name))
        files.push(...(await walk(file)))
      else if (
        entry.isFile() &&
        sourceFile.test(file) &&
        !testFile.test(file) &&
        !declaration.test(file) &&
        !manualHarnesses.has(file)
      )
        files.push(file)
    }
    return files
  }
  for (const directory of runtimeRoots) {
    const files = await walk(directory)
    if (!files.length) throw new Error(`运行模块检查没有找到源文件：${directory}`)
    groups.push({ directory, files: files.sort() })
  }
  return groups
}

// 所有者公开入口与内部实现一起维护；同模块内部允许直接协作。
const privateBoundaries = [
  {
    name: '账号存储只通过公开入口被调用',
    internal: '^agent-demo/t3-adapters/accounts/(?!index\\.ts$)',
    owner: '^agent-demo/t3-adapters/accounts/',
  },
  {
    name: '共享身份能力只通过公开入口被调用',
    internal: '^autoops/server/modules/identity/(?!index\\.ts$)',
    owner: '^autoops/server/modules/identity/',
  },
  {
    name: '助手存储及策略只通过公开入口被调用',
    internal: '^agent-demo/t3-adapters/assistants/(?!index\\.ts$)',
    owner: '^agent-demo/t3-adapters/assistants/',
  },
  {
    name: '项目目录存储只通过公开入口被调用',
    internal: '^agent-demo/t3-adapters/project-directory/(?!index\\.ts$)',
    owner: '^agent-demo/t3-adapters/project-directory/',
  },
  {
    name: '身份授权内部只能由授权门面装配',
    internal:
      '^agent-demo/t3-adapters/(?:access-(?:identity|bootstrap|service|runtime)|project-access)\\.mjs$',
    owner:
      '^agent-demo/t3-adapters/(?:access(?:-(?:identity|bootstrap|service|runtime))?|project-access)\\.mjs$',
  },
  {
    name: '工作区阅读偏好只由工作区模块使用',
    internal: '^' + web + 'autoops/workspaceViewState\\.ts$',
    owner:
      '^' +
      web +
      'autoops/(?:WorkspacesPage\\.tsx|WorkspaceFileBrowser\\.tsx|WorkspaceAuthoringPanel\\.tsx|useWorkspaceFileScroll\\.ts|workspaceViewState\\.ts)$',
  },
  {
    name: '工作区内部只能由工作区服务调用',
    internal: '^agent-demo/t3-adapters/workspace-(?:jobs|files|packages|package-worker)\\.mjs$',
    owner:
      '^agent-demo/t3-adapters/(?:workspaces|workspace-(?:jobs|files|packages|package-worker))\\.mjs$',
  },
  {
    name: '当前资料存储只通过公开入口被调用',
    internal: '^agent-demo/t3-adapters/workspace-authoring/(?!index\\.ts$)',
    owner: '^agent-demo/t3-adapters/workspace-authoring/',
  },
  {
    name: '定期资料更新存储只通过公开入口被调用',
    internal: '^agent-demo/t3-adapters/workspace-updates/(?!index\\.ts$)',
    owner: '^agent-demo/t3-adapters/workspace-updates/',
  },
  {
    name: '部署项目存储只由部署引擎调用',
    internal: '^src/deployment-projects\\.mjs$',
    owner: '^src/(?:deployment|deployment-projects)\\.mjs$',
  },
  {
    name: '工作区文件浏览内部只由工作区页面调用',
    internal: '^' + web + 'autoops/WorkspaceFileBrowser\\.tsx$',
    owner: '^' + web + 'autoops/(?:WorkspacesPage|WorkspaceFileBrowser)\\.tsx$',
  },
  {
    name: '技能目录控制器只由技能目录页面调用',
    internal: '^' + web + 'autoops/useSkillLibraryCatalog\\.ts$',
    owner: '^' + web + 'autoops/(?:SkillLibraryPage\\.tsx|useSkillLibraryCatalog\\.ts)$',
  },
]

export const runtimeRules = {
  forbidden: [
    ...privateBoundaries.map(({ name, internal, owner }) => ({
      name,
      severity: 'error',
      from: { path: scope, pathNot: owner },
      to: { path: internal },
    })),
    {
      name: '宿主快照不能反向依赖会话或业务客户端',
      severity: 'error',
      from: { path: `^${web}autoops/hostSnapshot\\.ts$` },
      to: { path: `^${web}` },
    },
    {
      name: '公共合同不能反向依赖运行实现',
      severity: 'error',
      from: { path: '^autoops/contracts/' },
      to: { path: `^(?:agent-demo|agent|src|web|autoops/server)/|^vendor/t3code/apps/` },
    },
    {
      name: '公共合同不能使用Node运行能力',
      severity: 'error',
      from: { path: '^autoops/contracts/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: '运行模块禁止循环依赖',
      severity: 'error',
      from: { path: scope },
      to: { circular: true },
    },
    {
      name: '运行模块禁止未解析依赖',
      severity: 'error',
      from: { path: scope },
      to: { couldNotResolve: true },
    },
    {
      name: '前端不能导入服务端实现',
      severity: 'error',
      from: { path: `^${web}autoops/` },
      to: { path: `^(?:agent-demo|agent|src|autoops/server)/|^${server}` },
    },
    {
      name: '前端不能使用Node运行能力',
      severity: 'error',
      from: { path: `^${web}autoops/` },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: '业务服务不能反向依赖T3入口',
      severity: 'error',
      from: { path: `^${adapters}` },
      to: { path: `^vendor/t3code/apps/(?:server|web)/src/` },
    },
    {
      name: '后端不能导入前端组件',
      severity: 'error',
      from: { path: `^(?:agent-demo|agent|src)/|^${server}autoops/` },
      to: { path: `^web/|^${web}` },
    },
    {
      name: '执行引擎不能反向依赖工作台',
      severity: 'error',
      from: { path: '^(?:src|agent)/' },
      to: { path: `^agent-demo/|^${server}autoops/` },
    },
    {
      name: '客户执行不能引入平台存储及业务',
      severity: 'error',
      from: { path: '^agent-demo/customer-agent/' },
      to: {
        path: `^autoops/server/|^src/|^${adapters}|^agent-demo/(?:server|fixtures)\\.mjs$|^${server}(?:autoops|persistence|secrets)/|^${server}(?:config|attachmentStore)\\.ts$`,
      },
    },
    {
      name: '部署展示只通过公开入口被调用',
      severity: 'error',
      from: { path: `^${web}`, pathNot: `^${web}autoops/deployment/` },
      to: { path: `^${web}autoops/deployment/`, pathNot: '/index\\.ts$' },
    },
    {
      name: '部署展示不能反向依赖页面',
      severity: 'error',
      from: { path: `^${web}autoops/deployment/` },
      to: { path: `^${web}(?:routes/|autoops/[^/]*(?:Page|Panel)\\.tsx$)` },
    },
    {
      name: 'HTTP内部模块只由公开入口装配',
      severity: 'error',
      from: { path: '^vendor/t3code/apps/server/src/', pathNot: '/autoops/http(?:/|\\.ts$)' },
      to: { path: '^vendor/t3code/apps/server/src/autoops/http/' },
    },
    {
      name: 'HTTP内部模块不能反向依赖入口',
      severity: 'error',
      from: { path: '^vendor/t3code/apps/server/src/autoops/http/' },
      to: { path: '^vendor/t3code/apps/server/src/autoops/(?:http|rpc|customerHttp)\\.ts$' },
    },
    {
      name: '共享请求边界不能依赖业务界面',
      severity: 'error',
      from: { path: `^${web}autoops/apiClient\\.ts$` },
      to: { path: `^${web}`, pathNot: `^${web}autoops/hostSnapshot\\.ts$` },
    },
  ],
}

export function assertRuntimeCoverage(files, modules) {
  const scanned = new Map(modules.map((module) => [module.source.replaceAll('\\', '/'), module]))
  const missing = files.filter((file) => {
    const module = scanned.get(file)
    return !module || module.matchesDoNotFollow || module.couldNotResolve
  })
  if (missing.length) throw new Error(`运行模块边界检查漏扫文件：${missing.join('、')}`)
}

export async function checkRuntimeBoundaries(root = process.cwd()) {
  const groups = await discoverRuntimeSources(root)
  const files = groups.flatMap((group) => group.files)
  // 不遍历锁定上游及依赖包的内部实现，但保留到它们的边，检查直接越界。
  const report = await cruise(files, {
    baseDir: root,
    parser: 'swc',
    tsPreCompilationDeps: true,
    doNotFollow: { path: `^(?!${scope.slice(1)})|(?:^|/)node_modules/` },
    exclude: '\\.(?:test|spec)\\.[cm]?[jt]sx?$|\\.d\\.[cm]?ts$',
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default'],
      alias: { '~': path.join(root, web), '@': path.join(root, 'web/src') },
    },
    ruleSet: runtimeRules,
    validate: true,
    outputType: 'json',
  })
  const result = typeof report.output === 'string' ? JSON.parse(report.output) : report.output
  assertRuntimeCoverage(files, result.modules)
  return {
    sourceFiles: files.length,
    groups: groups.map(({ directory, files: entries }) => ({
      directory,
      sourceFiles: entries.length,
    })),
    violations: result.summary.violations,
    errors: result.summary.error,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkRuntimeBoundaries()
    if (process.argv.includes('--json')) console.log(JSON.stringify(result))
    else {
      for (const group of result.groups)
        console.log(`${group.directory}：${group.sourceFiles} 个源文件`)
      for (const violation of result.violations)
        console.error(`${violation.rule.name}：${violation.from} → ${violation.to}`)
      console.log(
        `运行模块完整扫描 ${result.sourceFiles} 个源文件，${result.errors} 项错误；范围见 docs/runtime-modules.md`,
      )
    }
    if (result.errors > 0) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
