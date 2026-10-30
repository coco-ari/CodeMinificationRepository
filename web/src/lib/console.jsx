import { createContext, useContext } from 'react'
export const ConsoleContext = createContext(null)
export const useConsole = () => useContext(ConsoleContext)
export const pageNames = {
  home: ['项目', '从一个项目开始，组织每一次交付。'],
  overview: ['项目概览', '源码、环境和服务发布，尽在当前项目。'],
  projects: ['代码仓库', '独立管理仓库配置与下载入口。'],
  servers: ['项目服务器', '绑定已接入服务器，或安装 Agent 接入新服务器。'],
  applications: ['环境与服务', '为每个环境中的服务配置仓库和发布分支。'],
  services: ['服务与部署', '配置服务、选择部署位置并发布。'],
  environments: ['环境管理', '独立管理项目环境。'],
  service: ['服务详情', ''],
  setup: ['配置服务', ''],
  deployments: ['部署发布', '独立发布每个服务，掌握版本与运行状态。'],
  release: ['发布工作台', ''],
  configuration: ['服务配置', ''],
  tasks: ['发布记录', '跟踪发布进度、查看日志和回退结果。'],
  'system-servers': ['服务器管理', '管理全部服务器与 Agent 接入。'],
  credentials: ['共享 Gitee 凭证', '复用仓库访问凭证，密码加密保存。'],
  activity: ['操作记录', '查看管理操作和源码同步记录。'],
}
export function parseRoute() {
  const [path, query = ''] = (location.hash.slice(1) || '/projects').split('?')
  const params = new URLSearchParams(query)
  const match =
    /^\/projects\/([a-f0-9-]{36})(?:\/(overview|projects|servers|applications|deployments|services|environments|service|setup|tasks|release|configuration))?$/.exec(
      path,
    )
  return {
    workspaceId: match?.[1],
    view: match
      ? { applications: 'services', deployments: 'services', configuration: 'service' }[match[2]] ||
        match[2] ||
        'overview'
      : /^\/system\/(system-servers|credentials|activity)$/.exec(path)?.[1] || 'home',
    environmentId: params.get('environment'),
    taskId: params.get('task'),
    targetId: params.get('target'),
    action: params.get('action'),
    releaseId: params.get('release'),
    editor: params.get('editor'),
    serviceId: params.get('service'),
    step: params.get('step'),
    tab: params.get('tab') || (match?.[2] === 'configuration' ? 'config' : null),
  }
}
export function routeUrl(view, workspaceId, environmentId, taskId, extra = {}) {
  view =
    { applications: 'services', deployments: 'services', configuration: 'service' }[view] || view
  if (view === 'home') return '#/projects'
  if (['system-servers', 'credentials', 'activity'].includes(view)) return `#/system/${view}`
  const query = new URLSearchParams()
  if (environmentId) query.set('environment', environmentId)
  if (taskId) query.set('task', taskId)
  if (extra.targetId) query.set('target', extra.targetId)
  if (extra.action) query.set('action', extra.action)
  if (extra.releaseId) query.set('release', extra.releaseId)
  if (extra.editor) query.set('editor', extra.editor)
  if (extra.serviceId) query.set('service', extra.serviceId)
  if (extra.step) query.set('step', extra.step)
  if (extra.tab) query.set('tab', extra.tab)
  return `#/projects/${workspaceId}/${view}${query.size ? `?${query}` : ''}`
}
export const date = (value) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未上报'
export const short = (value) => (value ? String(value).slice(0, 12) : '—')
export const size = (bytes) =>
  Number.isFinite(Number(bytes)) && bytes != null
    ? `${(Number(bytes) / 1024 ** 3).toFixed(1)} GB`
    : '—'
export const actionNames = {
  deploy: '发布',
  restart: '重启',
  rollback: '回退',
  'build-check': '试构建',
}
export const statusNames = {
  preparing: '准备源码',
  queued: '排队中',
  syncing: '同步中',
  ready: '已就绪',
  idle: '等待下载',
  disabled: '已停用',
  running: '执行中',
  succeeded: '发布成功',
  success: '发布成功',
  failed: '执行失败',
  rolled_back: '发布失败 · 已回退',
  cancelled: '已取消',
  interrupted: '已中断',
}
export const stageNames = {
  source_fetch: '拉取代码',
  source_resolve: '固定提交',
  source_archive: '打包 ZIP',
  prepare: '准备源码',
  preparing: '准备源码',
  queued: '等待执行',
  download: '下载源码',
  downloading: '下载源码',
  build: '编译打包',
  building: '编译打包',
  image: '构建镜像',
  deploy: '更新容器',
  deploying: '更新容器',
  health: '健康检查',
  verifying: '健康检查',
  rollback: '恢复版本',
  restart: '重启服务',
  succeeded: '完成',
  completed: '完成',
  done: '完成',
  failed: '失败',
  interrupted: '已中断',
  rolled_back: '已回退',
}
export function stageLabel(stage, kind) {
  if (kind === 'static') {
    const names = { building: '构建前端', deploying: '切换站点', verifying: '验证站点' }
    if (names[stage]) return names[stage]
  }
  return stageNames[stage] || stage || '等待执行'
}
export const finished = (task) =>
  ['succeeded', 'success', 'failed', 'rolled_back', 'cancelled', 'interrupted'].includes(
    task.status,
  )
export const resultName = (task) =>
  ['succeeded', 'success'].includes(task.status)
    ? `${actionNames[task.action] || '执行'}成功`
    : statusNames[task.status] || task.status
export const revisionOf = (task) =>
  task.revision ||
  task.result?.release?.revision ||
  task.release?.revision ||
  task.previousRelease?.revision
export const duration = (task) => {
  const start = task.startedAt || task.createdAt
  if (!start) return '—'
  const seconds = Math.max(
    0,
    Math.floor(
      ((task.finishedAt ? Date.parse(task.finishedAt) : Date.now()) - Date.parse(start)) / 1000,
    ),
  )
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
export const downloadPage = (id) => `${location.origin}/download/${id}`
export const downloadUrl = (id) => `${location.origin}/api/projects/${id}/source/latest`
export async function copy(value) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(value)
  const field = document.createElement('textarea')
  field.value = value
  const host = [...document.querySelectorAll('[role="dialog"]')].at(-1) || document.body
  host.append(field)
  field.select()
  const ok = document.execCommand('copy')
  field.remove()
  if (!ok) throw new Error('自动复制失败，请选中文字手动复制')
}
