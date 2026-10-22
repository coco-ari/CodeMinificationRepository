import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { seedMaterials } from './material-seed'
import { seedAgents } from './agent-seed'
import { seedCabinet } from './cabinet-seed'
import { resetConversationDrafts } from './use-conversation-draft'
export const STORAGE_KEY = 'autoops:interactive-prototype:v2'
const Context = createContext(null)
export const uid = (prefix = 'item') => `${prefix}-${crypto.randomUUID().slice(0, 8)}`
export const stamp = () => new Date().toISOString()
export function applyEffects(draft, effects = []) {
  for (const effect of effects) {
    let target = draft
    for (const key of effect.path) target = target?.[key]
    if (!target) continue
    if (effect.op === 'append') target.unshift(structuredClone(effect.value))
    if (effect.op === 'patch') {
      const item = Array.isArray(target) ? target.find((x) => x.id === effect.id) : target
      if (
        item &&
        (!effect.ifMatch ||
          Object.entries(effect.ifMatch).every(([key, value]) => item[key] === value))
      )
        Object.assign(item, structuredClone(effect.value))
    }
    if (effect.op === 'remove' && Array.isArray(target)) {
      const i = target.findIndex((x) => x.id === effect.id)
      if (i >= 0) target.splice(i, 1)
    }
  }
}
function makeProject(id, name, memberIds, environments) {
  const resources = environments.flatMap((e, i) => [
    {
      id: `${e.id}-server`,
      name: i ? '生产主机' : '应用主机',
      type: 'Server',
      environmentId: e.id,
      host: `192.0.2.${i + 20}`,
      port: '22',
      username: 'deploy',
      password: 'DEMO_ONLY',
      status: 'connected',
      cpu: 23 + i * 8,
      memory: 48,
      disk: 36,
    },
    {
      id: `${e.id}-mysql`,
      name: '业务数据库',
      type: 'MySQL',
      environmentId: e.id,
      host: `db-${id}-${i}.example.test`,
      port: '3306',
      username: 'reader',
      password: 'DEMO_ONLY',
      status: 'untested',
    },
  ])
  resources.push({
    id: `${id}-redis`,
    name: '公共缓存',
    type: 'Redis',
    environmentId: null,
    host: `cache-${id}.example.test`,
    port: '6379',
    username: 'default',
    password: 'DEMO_ONLY',
    status: 'untested',
  })
  return {
    id,
    name,
    description: id === 'sol' ? '设备管理、接入服务与运维门户' : '团队研发协作与知识服务',
    memberIds,
    environments,
    resources,
    ...seedMaterials(id),
    services:
      id === 'sol'
        ? [
            {
              id: 'sol-api',
              name: '设备接入 API',
              type: 'java',
              environmentId: 'sol-prod',
              hostIds: ['sol-prod-server'],
              status: 'running',
              version: 'v1.8.2',
              artifactId: 'source-sol',
              healthPath: '/actuator/health',
              command: 'mvn package -DskipTests',
              port: '8080',
              versions: [
                {
                  id: 'release-sol-182',
                  name: 'v1.8.2',
                  artifactId: 'source-sol',
                  status: 'retained',
                  createdAt: '2026-10-20T01:20:00Z',
                },
                {
                  id: 'release-sol-181',
                  name: 'v1.8.1',
                  artifactId: 'source-sol',
                  status: 'retained',
                  createdAt: '2026-10-19T08:00:00Z',
                },
              ],
              logs: ['[09:20:01] 服务启动完成', '[09:20:03] GET /actuator/health → 200'],
            },
            {
              id: 'sol-web',
              name: '运维门户',
              type: 'static',
              environmentId: 'sol-prod',
              hostIds: ['sol-prod-server'],
              status: 'running',
              version: 'v2.4.0',
              artifactId: 'sanitized-sol',
              healthPath: '/',
              command: 'pnpm build',
              port: '80',
              versions: [
                {
                  id: 'release-sol-web',
                  name: 'v2.4.0',
                  artifactId: 'sanitized-sol',
                  status: 'retained',
                  createdAt: '2026-10-20T02:00:00Z',
                },
              ],
              logs: ['[10:00:00] 静态文件就绪', '[10:00:01] GET / → 200'],
            },
          ]
        : [],
  }
}
export function initialState() {
  const now = stamp()
  return {
    schema: 2,
    userId: null,
    connected: true,
    users: [
      { id: 'admin', name: '林知远', username: 'admin', password: 'Demo123!', role: 'admin' },
      { id: 'lin', name: '林夏', username: 'lin', password: 'Demo123!', role: 'member' },
      { id: 'chen', name: '陈默', username: 'chen', password: 'Demo123!', role: 'member' },
    ],
    projects: {
      sol: makeProject(
        'sol',
        'SOL 设备平台',
        ['admin', 'lin'],
        [
          { id: 'sol-test', name: '测试', authBase: 'https://sol-test.example.invalid' },
          { id: 'sol-prod', name: '生产', authBase: 'https://sol.example.test' },
        ],
      ),
      atlas: makeProject(
        'atlas',
        'Atlas 研发平台',
        ['admin', 'chen'],
        [{ id: 'atlas-stage', name: '预发布', authBase: 'https://atlas-stage.example.test:8443' }],
      ),
    },
    ...seedAgents(),
    cabinet: seedCabinet(),
    tasks: [
      {
        id: 'task-seed',
        projectId: 'sol',
        type: 'deploy',
        title: '设备接入 API · v1.8.2 发布',
        status: 'success',
        progress: 100,
        createdAt: '2026-10-20T01:20:00Z',
        actorId: 'admin',
        artifactIds: ['source-sol'],
        logs: ['构建完成', '部署到 192.0.2.21', '健康检查 200；发布成功'],
      },
      {
        id: 'task-fetch',
        projectId: 'sol',
        type: 'source',
        title: '获取 main 源码快照',
        status: 'success',
        progress: 100,
        createdAt: '2026-10-20T01:00:00Z',
        actorId: 'lin',
        artifactIds: [],
        logs: ['获取固定提交', '源码快照已保存'],
      },
    ],
    notifications: [
      {
        id: 'notice-seed',
        projectId: 'sol',
        title: '设备接入 API v1.8.2 发布成功',
        createdAt: now,
        readBy: [],
      },
    ],
    audit: [
      {
        id: 'audit-seed',
        projectId: 'sol',
        actorId: 'admin',
        action: '发布服务',
        object: '设备接入 API',
        result: '成功',
        createdAt: '2026-10-20T01:20:00Z',
      },
    ],
  }
}
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (saved?.schema === 2) {
      // 首轮仅开放内置 Agent；保留旧演示记录，但不恢复外部 Agent 的执行。
      const deferredAgentIds = new Set(
        saved.agents.filter((agent) => agent.kind !== 'platform').map((agent) => agent.id),
      )
      let deferredExecutionStopped = false
      for (const conversation of saved.conversations) {
        if (!deferredAgentIds.has(conversation.agentId)) continue
        if (conversation.active || conversation.queue?.length) deferredExecutionStopped = true
        conversation.active = null
        conversation.queue = []
      }
      for (const task of saved.tasks) {
        if (!deferredAgentIds.has(task.agentId) || task.status !== 'running') continue
        deferredExecutionStopped = true
        task.status = 'stopped'
        task.finishedAt = stamp()
        task.logs.push('第一轮暂不接入外部 Agent，此演示任务已停止。')
      }
      if (deferredExecutionStopped) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
        } catch {}
      }
      return { ...saved, connected: true }
    }
  } catch {}
  return initialState()
}
export function WorkbenchProvider({ children }) {
  const [state, setState] = useState(load)
  const ref = useRef(state)
  const [route, setRoute] = useState(location.hash.slice(1) || '/')
  const storageError = useRef(false)
  function update(recipe) {
    const next = structuredClone(ref.current)
    recipe(next)
    ref.current = next
    setState(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      storageError.current = false
    } catch {
      if (!storageError.current) {
        toast.error('浏览器存储空间不足，新改动仅保留到页面关闭；请下载大文件后清理')
        storageError.current = true
      }
    }
  }
  useEffect(() => {
    const cb = () => setRoute(location.hash.slice(1) || '/')
    window.addEventListener('hashchange', cb)
    return () => window.removeEventListener('hashchange', cb)
  }, [])
  useEffect(() => {
    const timer = setInterval(() => {
      if (!ref.current.tasks.some((t) => t.status === 'running' && !t.runtimeManaged)) return
      update((d) => {
        for (const t of d.tasks.filter((t) => t.status === 'running' && !t.runtimeManaged)) {
          t.elapsed = Date.now() - new Date(t.createdAt).getTime()
          t.progress = Math.min(97, Math.round((t.elapsed / t.duration) * 100))
          if (t.elapsed < t.duration) continue
          t.status = t.outcome || 'success'
          t.progress = 100
          t.finishedAt = stamp()
          applyEffects(d, t.status === 'success' ? t.effects : t.failureEffects)
          t.logs.push(
            t.status === 'success'
              ? '任务完成'
              : t.status === 'rolledback'
                ? '健康检查失败；已恢复上一运行版本'
                : t.status === 'unknown'
                  ? '结果待核查，请先核查再操作'
                  : '任务失败，可检查日志后重试',
          )
          d.notifications.unshift({
            id: uid('notice'),
            projectId: t.projectId,
            agentId: t.agentId,
            title: `${t.title} · ${t.status === 'success' ? '完成' : t.status === 'rolledback' ? '已自动回退' : '未成功'}`,
            createdAt: stamp(),
            readBy: [],
          })
          d.audit.unshift({
            id: uid('audit'),
            projectId: t.projectId,
            agentId: t.agentId,
            actorId: t.actorId,
            action: t.type,
            object: t.title,
            result: t.status,
            createdAt: stamp(),
          })
        }
      })
    }, 400)
    return () => clearInterval(timer)
  }, [])
  const user = state.users.find((x) => x.id === state.userId)
  const routeProject = route.match(/^\/p\/([^/]+)/)?.[1]
  const candidate = state.projects[routeProject]
  const project =
    user && candidate && (user.role === 'admin' || candidate.memberIds.includes(user.id))
      ? candidate
      : null
  const projectId = project?.id
  function canUseAgent(a, pid) {
    if (!a || a.kind !== 'platform' || !user) return false
    if (a.sharing === 'private') return a.ownerId === user.id
    const p = state.projects[pid]
    return (
      a.projectId === pid && Boolean(p) && (user.role === 'admin' || p.memberIds.includes(user.id))
    )
  }
  function canViewAgent(id, pid) {
    return (
      !id ||
      canUseAgent(
        state.agents.find((a) => a.id === id),
        pid,
      )
    )
  }
  function audit({ projectId = null, agentId = null, action, object, result = '成功' }) {
    update((d) =>
      d.audit.unshift({
        id: uid('audit'),
        projectId,
        agentId,
        action,
        object,
        result,
        actorId: user?.id,
        createdAt: stamp(),
      }),
    )
  }
  function notify({ projectId = null, title, agentId = null }) {
    update((d) =>
      d.notifications.unshift({
        id: uid('notice'),
        projectId,
        title,
        agentId,
        createdAt: stamp(),
        readBy: [],
      }),
    )
  }
  function startTask(options) {
    const id = uid('task')
    update((d) =>
      d.tasks.unshift({
        id,
        projectId: projectId || null,
        actorId: user?.id,
        createdAt: stamp(),
        status: 'running',
        progress: 0,
        elapsed: 0,
        duration: 4500,
        outcome: 'success',
        effects: [],
        failureEffects: [],
        artifactIds: [],
        logs: [],
        ...structuredClone(options),
        configSnapshot:
          options.configSnapshot ||
          structuredClone(d.projects[options.projectId || projectId]?.resources || []),
      }),
    )
    return id
  }
  function stopTask(id) {
    update((d) => {
      const t = d.tasks.find((x) => x.id === id)
      if (t?.status === 'running') {
        t.status = 'stopped'
        for (const a of d.projects[t.projectId]?.artifacts || []) {
          if (t.artifactIds?.includes(a.id) && a.status === 'processing') a.status = 'stopped'
        }
        t.logs.push('用户停止任务，未应用后续变更')
        t.finishedAt = stamp()
        if (!t.runtimeManaged) applyEffects(d, t.stopEffects)
        d.audit.unshift({
          id: uid('audit'),
          projectId: t.projectId,
          agentId: t.agentId,
          action: '停止任务',
          object: t.title,
          result: '已停止',
          actorId: user?.id,
          createdAt: stamp(),
        })
      }
    })
  }
  const value = {
    state,
    user,
    project,
    projectId,
    route,
    update,
    updateProject: (recipe, id = projectId) =>
      update((d) => {
        if (d.projects[id]) recipe(d.projects[id], d)
      }),
    navigate: (path) => {
      location.hash = path
      setRoute(path)
    },
    audit,
    notify,
    startTask,
    stopTask,
    canUseAgent,
    canViewAgent,
    reset: () => {
      if (!resetConversationDrafts()) {
        toast.error('浏览器草稿未能清理，演示数据尚未重置，请重试')
        return
      }
      const next = initialState()
      ref.current = next
      setState(next)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      location.hash = '/'
      setRoute('/')
    },
  }
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export const useWorkbench = () => useContext(Context)
export function removeEnvironment(d, pid, eid) {
  const p = d.projects[pid]
  p.environments = p.environments.filter((e) => e.id !== eid)
  p.resources = p.resources.filter((r) => r.environmentId !== eid)
  for (const device of d.cabinet.devices) {
    if (device.targetId === `env:${pid}:${eid}`) {
      device.targetId = null
      device.revision = (device.revision || 0) + 1
    }
  }
}
export function removeProject(d, pid) {
  for (const device of d.cabinet.devices) {
    if (device.targetId?.startsWith(`env:${pid}:`)) {
      device.targetId = null
      device.revision = (device.revision || 0) + 1
    }
  }
  delete d.projects[pid]
  for (const collection of ['tasks', 'notifications', 'audit', 'conversations'])
    d[collection] = d[collection].filter((x) => x.projectId !== pid)
  for (const a of d.agents) {
    if (a.projectId === pid) {
      a.projectId = null
      a.sharing = 'private'
    }
  }
}
