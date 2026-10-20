import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Network, Braces, FileSearch } from 'lucide-react'
import { toast } from 'sonner'

const STORAGE_KEY = 'autoops:interactive-prototype:v1'
const PrototypeContext = createContext(null)

export const pluginCatalog = [
  { id: 'cabinet', name: '机柜迁移', description: '设备分组、接入路由与二维码管理', icon: Network },
  { id: 'api', name: '接口调试', description: '复用项目环境，组织接口调试用例', icon: Braces },
  { id: 'logs', name: '日志分析', description: '关联服务器日志，生成排查报告', icon: FileSearch },
]

function makeProject(id, name) {
  const config = {
    name,
    description:
      id === 'sol'
        ? '连接代码、资料和运行环境，让团队在同一个项目中协作。'
        : '用于体验项目隔离的第二个演示空间。',
    repository: `https://github.com/example/${id}-backend.git`,
    branch: 'main',
    resources: [
      {
        id: 'mysql-test',
        name: '测试业务库',
        type: 'MySQL',
        environment: 'test',
        endpoint: 'mysql.test.internal:3306',
        connected: true,
      },
      {
        id: 'server-test',
        name: '测试服务器 A',
        type: 'Server',
        environment: 'test',
        endpoint: 'server.test.internal',
        connected: true,
      },
      {
        id: 'redis-test',
        name: '测试缓存',
        type: 'Redis',
        environment: 'test',
        endpoint: 'redis.test.internal:6379',
        connected: false,
      },
      {
        id: 'mysql-production',
        name: '生产业务库',
        type: 'MySQL',
        environment: 'production',
        endpoint: 'mysql.prod.internal:3306',
        connected: false,
      },
      {
        id: 'gateway',
        name: '统一设备接入服务',
        type: 'service',
        environment: 'test',
        endpoint: 'gateway.test.internal',
        connected: true,
      },
    ],
    plugins: {
      cabinet: {
        enabled: true,
        name: '机柜迁移',
        databaseId: 'mysql-test',
        serviceId: 'gateway',
        group: name,
        prototypeDocId: 'prototype',
      },
      api: { enabled: true, name: '接口调试', baseUrl: 'https://api.test.example.com' },
      logs: { enabled: false, name: '日志分析', retention: '7', serverId: 'server-test' },
    },
  }
  const files = [
    {
      name: 'README.md',
      content: `# ${name}\n\n这是前端原型中的示例源码，不连接实际仓库。\n\n## 启动\npnpm install\npnpm start\n`,
    },
    {
      name: 'src/device-service.ts',
      content:
        '// 设备心跳超过阈值时显示离线状态。\nexport function isDeviceOnline(lastSeen, now) {\n  return now - lastSeen < 60000\n}\n',
    },
    {
      name: 'config.example.json',
      content: '{\n  "database": "${DATABASE_URL}",\n  "apiKey": "[已脱敏]"\n}\n',
    },
  ]
  return {
    id,
    name,
    configVersion: 12,
    config,
    draft: structuredClone(config),
    savedAt: null,
    documents: [
      {
        id: 'design',
        name: '系统设计说明.md',
        type: 'Markdown',
        version: 3,
        updatedAt: '2026-10-20 10:21',
        content: `# ${name} · 系统设计说明\n\n## 服务组成\nAPI 服务处理业务请求，Web 控制台提供管理入口，设备网关负责设备接入。\n\n## 环境\n测试和生产环境分别配置数据库、缓存和服务器。所有插件通过项目资源引用读取配置。\n\n## 设备状态\n设备通过心跳上报状态，超过 60 秒未收到心跳时显示离线。检查时应先核对日志时间和设备分组。\n\n此内容为交互原型示例资料。`,
      },
      {
        id: 'api-doc',
        name: '接口规范.md',
        type: 'Markdown',
        version: 5,
        updatedAt: '2026-10-19 16:32',
        content:
          '# 接口规范\n\nGET /devices\n返回当前项目的设备列表。\n\nGET /devices/:id/status\n读取指定设备最近一次心跳与路由分组。\n\n所有请求必须校验项目归属。示例页面不发送这些请求。',
      },
      {
        id: 'prototype',
        name: '设备管理原型说明.md',
        type: 'Markdown',
        version: 3,
        updatedAt: '2026-10-18 09:18',
        content:
          '# 设备管理原型\n\n设备列表包含编号、分组、状态和最后心跳。\n\n支持按编号搜索、查看设备信息，以及复制设备编号。\n\n插件启用后从资料区引用数据库与统一设备接入服务。',
      },
      {
        id: 'runbook',
        name: '设备接入说明.md',
        type: 'Markdown',
        version: 12,
        updatedAt: '2026-10-20 13:10',
        content:
          '# 设备接入说明\n\n## 1. 注册设备\n绑定设备编号与项目分组。\n\n## 2. 接入路由\n通过统一设备接入服务选择对应业务入口。\n\n## 3. 离线排查\n1. 检查最近心跳是否超过 60 秒。\n2. 检查设备分组与路由是否匹配。\n3. 对照测试环境日志与接入时间。\n\n原型中的日志和设备均为模拟数据。',
      },
    ],
    artifacts: [
      {
        id: 'source-v12',
        name: 'source-v12',
        type: 'source',
        version: 12,
        status: 'ready',
        sourceId: '38e20cf',
        createdAt: '2026-10-20 13:40',
        files,
        content: files[0].content,
        usage: ['部署'],
      },
      {
        id: 'sanitized-v12',
        name: 'sanitized-v12',
        type: 'sanitized',
        version: 12,
        status: 'ready',
        sourceId: 'source-v12',
        createdAt: '2026-10-20 13:42',
        files: structuredClone(files),
        content: '已脱敏并校验的示例源码目录。',
        usage: ['Agent', '插件'],
      },
      {
        id: 'zip-v12',
        name: 'sol-source-v12.zip',
        type: 'zip',
        version: 12,
        status: 'ready',
        sourceId: 'sanitized-v12',
        createdAt: '2026-10-20 13:43',
        files: structuredClone(files),
        content: '脱敏源码打包结果。',
        usage: ['下载交付'],
      },
      {
        id: 'report-v12',
        name: 'sanitize-report-v12.md',
        type: 'report',
        version: 12,
        status: 'ready',
        sourceId: 'sanitized-v12',
        createdAt: '2026-10-20 13:42',
        files: [],
        content:
          '# 脱敏处理报告\n\n- 源码提交：38e20cf\n- 规则版本：项目脱敏规则 v3\n- 示例文件：3 个\n- 凭据占位：已替换\n- Git 历史：未包含\n- 校验结果：通过\n\n本报告来自模拟数据，不代表对真实代码的检查结果。',
        usage: ['追溯'],
      },
    ],
    agents: [
      {
        id: 'builtin',
        name: '项目助手',
        provider: '内置 Agent',
        host: '工作台服务器',
        owner: '团队',
        online: true,
        shared: true,
      },
      {
        id: 'codex',
        name: '代码顾问',
        provider: 'Codex',
        host: '陶涛的主机',
        owner: '陶涛',
        online: true,
        shared: true,
      },
      {
        id: 'claude',
        name: '设计助手',
        provider: 'Claude Code',
        host: '设计工作站',
        owner: '林舟',
        online: true,
        shared: true,
      },
    ],
    services: [
      {
        id: 'api-service',
        name: 'API 服务',
        description: '后端业务与开放接口',
        branch: 'main',
        commit: '38e20cf',
        status: 'running',
        environment: 'test',
      },
      {
        id: 'web-service',
        name: 'Web 控制台',
        description: '项目管理与运营界面',
        branch: 'main',
        commit: '7bd120a',
        status: 'running',
        environment: 'test',
      },
      {
        id: 'device-service',
        name: '设备网关',
        description: '设备接入与状态上报',
        branch: 'release',
        commit: '93ac721',
        status: 'running',
        environment: 'test',
      },
      {
        id: 'api-production',
        name: 'API 服务',
        description: '生产业务接口',
        branch: 'release',
        commit: 'b617da2',
        status: 'running',
        environment: 'production',
      },
    ],
    devices: [
      {
        id: 'SOL-00128',
        name: '示例设备 128',
        group: name,
        status: 'online',
        heartbeat: '10 秒前',
      },
      {
        id: 'SOL-00129',
        name: '示例设备 129',
        group: name,
        status: 'offline',
        heartbeat: '12 分钟前',
      },
      { id: 'SOL-00130', name: '示例设备 130', group: name, status: 'online', heartbeat: '8 秒前' },
      {
        id: 'SOL-00131',
        name: '示例设备 131',
        group: name,
        status: 'offline',
        heartbeat: '27 分钟前',
      },
    ],
    members: [
      {
        id: 'taotao',
        name: '陶涛',
        initials: 'T',
        role: '项目管理员',
        email: 'taotao@example.com',
      },
      { id: 'lin', name: '林舟', initials: 'L', role: '操作成员', email: 'lin@example.com' },
      { id: 'chen', name: '陈曦', initials: 'C', role: '查看成员', email: 'chen@example.com' },
    ],
    conversations: [],
    releases: [],
    activities: [
      { id: 'seed-1', title: 'API 服务发布成功', time: '今天 14:20', type: 'deploy' },
      { id: 'seed-2', title: '脱敏源码包 v12 已生成', time: '今天 13:42', type: 'artifact' },
    ],
  }
}

function seed() {
  return {
    version: 1,
    projectId: 'sol',
    environment: 'test',
    projects: { sol: makeProject('sol', 'SOL 标准版'), demo: makeProject('demo', '星河开放平台') },
  }
}

function readState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (
      saved?.version === 1 &&
      saved.projects?.sol?.config &&
      saved.projects?.demo?.config &&
      saved.projects[saved.projectId]
    ) {
      // 同步旧默认名称，保留自定义名称及尚未应用的配置草稿。
      for (const project of Object.values(saved.projects)) {
        for (const config of [project.config, project.draft]) {
          if (config?.plugins?.cabinet?.name === '设备路由') {
            config.plugins.cabinet.name = '机柜迁移'
          }
        }
      }
      return saved
    }
  } catch {}
  return seed()
}

function readRoute() {
  const [page = 'overview', tab = '', id = ''] = location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return ''
      }
    })
  return { page: page || 'overview', tab, id }
}

export function PrototypeProvider({ children }) {
  const [state, setState] = useState(readState)
  const [route, setRoute] = useState(readRoute)
  const [storageError, setStorageError] = useState(false)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }, [state])
  useEffect(() => {
    const handle = () => setRoute(readRoute())
    window.addEventListener('hashchange', handle)
    return () => window.removeEventListener('hashchange', handle)
  }, [])
  const projectId = state.projectId
  const project = state.projects[projectId]
  const navigate = useCallback((page, tab = '', id = '') => {
    location.hash =
      '/' +
      [page, tab, id]
        .filter((value, index) => index === 0 || value || (index === 1 && id))
        .map(encodeURIComponent)
        .join('/')
  }, [])
  const updateProject = useCallback(
    (updater) => {
      setState((current) => ({
        ...current,
        projects: {
          ...current.projects,
          [projectId]:
            typeof updater === 'function' ? updater(current.projects[projectId]) : updater,
        },
      }))
    },
    [projectId],
  )
  const editDraft = useCallback(
    (updater) => {
      updateProject((current) => ({
        ...current,
        draft: typeof updater === 'function' ? updater(current.draft) : updater,
      }))
    },
    [updateProject],
  )
  const saveDraft = useCallback(() => {
    updateProject((current) => ({ ...current, savedAt: new Date().toISOString() }))
    toast.success('草稿已保存', { description: '应用后供后续操作使用，当前生效配置保持原版本。' })
  }, [updateProject])
  const applyDraft = useCallback(() => {
    const draft = project.draft
    if (!draft.name?.trim()) {
      toast.error('请填写项目名称')
      return false
    }
    if (!draft.repository?.trim() || !draft.branch?.trim()) {
      toast.error('请填写仓库地址和分支')
      return false
    }
    if (Object.values(draft.plugins).some((plugin) => plugin.enabled && !plugin.name?.trim())) {
      toast.error('请填写已启用插件的名称')
      return false
    }
    const cabinet = draft.plugins.cabinet
    if (
      cabinet.enabled &&
      (!cabinet.name?.trim() ||
        !cabinet.group?.trim() ||
        !draft.resources.some(
          (r) => r.id === cabinet.databaseId && /mysql|database/i.test(r.type),
        ) ||
        !draft.resources.some((r) => r.id === cabinet.serviceId && /server|service/i.test(r.type)))
    ) {
      toast.error('请补全机柜迁移配置，并选择有效的数据库与接入服务')
      return false
    }
    if (draft.plugins.api.enabled && !/^https?:\/\/\S+$/.test(draft.plugins.api.baseUrl || '')) {
      toast.error('请填写有效的接口调试地址')
      return false
    }
    if (
      draft.plugins.logs.enabled &&
      (!draft.plugins.logs.serverId ||
        !draft.resources.some(
          (r) => r.id === draft.plugins.logs.serverId && /^server$/i.test(r.type),
        ))
    ) {
      toast.error('请为日志分析选择服务器')
      return false
    }
    if (
      draft.plugins.logs.enabled &&
      (!Number.isInteger(Number(draft.plugins.logs.retention)) ||
        Number(draft.plugins.logs.retention) < 1 ||
        Number(draft.plugins.logs.retention) > 90)
    ) {
      toast.error('日志保留天数需要为 1–90 的整数')
      return false
    }
    if (JSON.stringify(project.config) === JSON.stringify(draft)) {
      toast.info('配置已是最新版本')
      return true
    }
    updateProject((current) => ({
      ...current,
      name: current.draft.name.trim(),
      config: structuredClone(current.draft),
      configVersion: current.configVersion + 1,
      connectionStates: Object.fromEntries(
        Object.entries(current.connectionStates || {}).filter(([id]) => {
          const previous = current.config.resources.find((resource) => resource.id === id)
          const next = current.draft.resources.find((resource) => resource.id === id)
          return (
            previous && next && previous.endpoint === next.endpoint && previous.type === next.type
          )
        }),
      ),
      savedAt: new Date().toISOString(),
      activities: [
        {
          id: crypto.randomUUID(),
          title: `项目配置 v${current.configVersion + 1} 已应用`,
          time: '刚刚',
          type: 'config',
        },
        ...current.activities,
      ].slice(0, 30),
    }))
    toast.success(`配置 v${project.configVersion + 1} 已生效`, {
      description: '后续模拟操作将使用此版本。',
    })
    return true
  }, [project, updateProject])
  const value = useMemo(
    () => ({
      project,
      projectId,
      projects: Object.values(state.projects),
      route,
      environment: state.environment,
      environmentLabel: state.environment === 'production' ? '生产' : '测试',
      storageError,
      navigate,
      updateProject,
      editDraft,
      saveDraft,
      applyDraft,
      hasDraftChanges: JSON.stringify(project.draft) !== JSON.stringify(project.config),
      setEnvironment: (environment) => setState((current) => ({ ...current, environment })),
      selectProject: (id) => {
        if (!state.projects[id]) return
        setState((current) => ({ ...current, projectId: id, environment: 'test' }))
        navigate('overview')
      },
      reset: () => {
        setState(seed())
        navigate('overview')
        toast.success('示例数据已重置')
      },
    }),
    [
      project,
      projectId,
      state,
      route,
      storageError,
      navigate,
      updateProject,
      editDraft,
      saveDraft,
      applyDraft,
    ],
  )
  return <PrototypeContext.Provider value={value}>{children}</PrototypeContext.Provider>
}

export function usePrototype() {
  return useContext(PrototypeContext)
}
