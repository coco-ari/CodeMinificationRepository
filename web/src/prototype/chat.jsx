import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clipboard,
  FileText,
  History,
  Link2,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { usePrototype } from './context'
import './chat.css'

const makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`
const busyStates = ['running', 'waiting']
const canAccessAgent = (agent) =>
  !!agent && (agent.id === 'builtin' || agent.shared || agent.owner === '陶涛')
const canRunAgent = (agent) => !!agent?.online && canAccessAgent(agent)
const stateLabels = {
  running: '正在生成',
  waiting: '等待你的回答',
  complete: '已完成',
  cancelled: '已停止',
  interrupted: '已中断，可继续',
}
const timeLabel = (value) =>
  new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const itemContent = (item) =>
  item?.content ||
  item?.files?.map((file) => `${file.name}\n${file.content || ''}`).join('\n\n') ||
  item?.description ||
  '此资料暂时没有可预览的正文。'

function deviceAccessIssue(project) {
  const plugin = project.config?.plugins?.cabinet
  if (!plugin?.enabled) return '设备路由插件未启用。请在资料与配置中启用插件并应用配置。'
  const resources = project.config?.resources || []
  const dependencies = [
    { id: plugin.databaseId, label: '数据库', matches: /mysql|database/i },
    { id: plugin.serviceId, label: '设备接入服务', matches: /server|service/i },
  ]
  for (const dependency of dependencies) {
    const resource = resources.find((item) => item.id === dependency.id)
    if (!resource || !dependency.matches.test(resource.type)) {
      return `设备路由的${dependency.label}引用无效。请在插件配置中选择有效资源并应用。`
    }
    if (!(project.connectionStates?.[resource.id] ?? resource.connected)) {
      return `${resource.name} 尚未连接。请在 MCP 与连接中连接该资源后发起新一轮查询。`
    }
  }
  return ''
}

function downloadReport(artifact) {
  const url = URL.createObjectURL(
    new Blob([itemContent(artifact)], { type: 'text/markdown;charset=utf-8' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = artifact.name.endsWith('.md') ? artifact.name : `${artifact.name}.md`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function makeResponse(question, project, scope, deviceId, references) {
  const quoted =
    references.map((item, index) => `[${index + 1}] ${item.name}`).join('；') ||
    '当前项目的配置摘要'
  if (/设备/.test(question)) {
    const blocked = deviceAccessIssue(project)
    if (blocked) {
      return `本次设备查询未执行。\n\n阻断原因\n${blocked}\n\n当前轮次固定使用配置 v${project.configVersion || 1} 及开始时的连接状态。完成配置或连接调整后，请发送一个新问题，让新一轮读取最新状态。\n\n已读取的资料仍可用于分析，但没有返回设备列表或巡检结论。这是基于本地模拟配置的依赖校验，未调用真实 API。`
    }
    const devices = (project.devices || []).filter(
      (item) => scope !== 'specific' || item.id === deviceId,
    )
    const offline = devices.filter((item) => item.status === 'offline')
    const result = devices.length
      ? `示例中共 ${devices.length} 台设备，${devices.length - offline.length} 台在线，${offline.length} 台离线。${offline.length ? `\n离线设备：${offline.map((item) => `${item.id}（最近心跳 ${item.heartbeat}）`).join('、')}。` : ''}`
      : `没有找到设备 ${deviceId} 的示例记录，请核对编号后重新查询。`
    return `已完成${scope === 'specific' ? `设备 ${deviceId}` : '全部设备'}的模拟巡检。\n\n结论\n${result}\n本次读取的是项目中的预设示例数据，没有连接真实设备或数据库。\n\n建议关注\n• 对照最近心跳与设备分组，检查离线设备的接入日志。\n• 设备路由引用资料区的环境和数据库配置，避免重复维护。\n• 上线前在 MCP 与连接中验证连通性，再执行正式巡检。\n\n本轮使用配置 v${project.configVersion || 1}，参考 ${quoted}。我已将过程和建议整理为可保存的报告。`
  }
  if (/部署|发布|上线/.test(question)) {
    return `可以按以下顺序检查 ${project.name} 的发布准备情况。\n\n1. 在资料与配置中确认当前环境、仓库分支和配置版本。\n2. 选择明确的源码快照，检查来源提交与处理状态。\n3. 核对服务构建命令、端口及健康检查路径。\n4. 在服务与部署中发起模拟发布，并查看阶段与日志。\n\nAI 资料使用脱敏产物；部署应引用原始源码快照。已经运行的任务继续使用创建时的配置版本。\n\n依据：${quoted}。\n\n以上为基于模拟资料的演示建议；未执行发布或连接服务器。`
  }
  if (/脱敏|源码|产物|压缩|代码/.test(question)) {
    return `当前项目的源码可以按独立步骤加工，每一步都保留可复用产物。\n\n源码快照 → 无 Git 历史的文件树 → 脱敏文件树 → ZIP 压缩包。\n\n• 原始快照保留提交来源，供部署和追溯使用。\n• 移除 Git 元数据后可以单独导出，不需要等待脱敏。\n• 脱敏产物记录规则与输入版本，供 Agent 或插件读取。\n• ZIP 是独立输出；打包失败不会破坏已有文件树。\n\n参考：${quoted}。你可以进入源码与产物查看文件、处理报告和来源关系。\n\n这是模拟回答，没有扫描或打包真实仓库。`
  }
  return `关于“${question}”，我已查看 ${project.name} 的可用资料与配置摘要。\n\n项目资料是共享的数据入口，部署、MCP、插件和 Agent 通过统一接口按权限读取。插件启用后会在资料区显示自己的配置，并可引用项目已有的仓库、环境与连接。\n\n建议下一步\n1. 先确认需求和设计文档的版本。\n2. 在资料区补全项目公共配置，再应用草稿。\n3. 选择需要的插件，检查引用配置是否完整。\n4. 使用已经脱敏的源码产物进行问答，并保留来源引用。\n\n本轮参考：${quoted}。\n\n这是用于体验交互的模拟回答，不代表模型分析或真实系统检查结果。`
}

export function ChatPage({ tab, selectedId }) {
  const { project, projectId, environmentLabel, navigate, updateProject } = usePrototype()
  const [input, setInput] = useState('')
  const [historySearch, setHistorySearch] = useState('')
  const [agentId, setAgentId] = useState(project.agents?.find(canRunAgent)?.id || '')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  const [scope, setScope] = useState('all')
  const [deviceId, setDeviceId] = useState('')
  const [attachedIds, setAttachedIds] = useState([])
  const [copiedId, setCopiedId] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const live = useRef({ project, projectId, updateProject })
  live.current = { project, projectId, updateProject }
  const jobs = useRef(new Map())
  const scroller = useRef(null)
  const composing = useRef(false)
  const conversation =
    tab === 'session' ? project.conversations?.find((item) => item.id === selectedId) : null
  const currentTurn = conversation?.activeTurn
  const busy = busyStates.includes(currentTurn?.state)
  const currentAgent = project.agents?.find(
    (item) => item.id === (conversation?.agentId || agentId),
  )
  const allSources = [
    ...(project.documents || []).map((item) => ({ ...item, kind: 'document' })),
    ...(project.artifacts || [])
      .filter((item) => item.status === 'ready')
      .map((item) => ({ ...item, kind: 'artifact' })),
  ]
  const contextIds = conversation?.contextIds || attachedIds
  const selectedSources = allSources.filter((item) => contextIds.includes(item.id))
  const turnMessage = conversation?.messages.find((item) => item.id === currentTurn?.assistantId)
  const sourcesForDisplay =
    turnMessage?.references ||
    (selectedSources.length
      ? selectedSources
      : allSources.filter((item) => item.kind === 'document').slice(0, 2))
  const chats = (project.conversations || []).filter((item) =>
    `${item.title} ${item.messages?.map((message) => message.content).join(' ')}`
      .toLowerCase()
      .includes(historySearch.toLowerCase()),
  )

  function changeConversation(id, transform, expectedProjectId = projectId) {
    live.current.updateProject((current) =>
      current.id !== expectedProjectId
        ? current
        : {
            ...current,
            conversations: (current.conversations || []).map((item) =>
              item.id === id ? transform(item) : item,
            ),
          },
    )
  }

  function clearJob(id) {
    const job = jobs.current.get(id)
    job?.timers.forEach(clearTimeout)
    jobs.current.delete(id)
  }

  function schedule(id, callback, delay, owner = projectId) {
    let job = jobs.current.get(id)
    if (!job) {
      job = { owner, timers: new Set() }
      jobs.current.set(id, job)
    }
    const timer = setTimeout(() => {
      job.timers.delete(timer)
      if (jobs.current.get(id) !== job || live.current.projectId !== owner) return
      callback()
    }, delay)
    job.timers.add(timer)
  }

  useEffect(() => {
    const owner = projectId
    // 刷新或离开页面会停止模拟定时器，保留正文并允许显式继续。
    updateProject((current) =>
      current.id !== owner
        ? current
        : {
            ...current,
            conversations: (current.conversations || []).map((item) =>
              item.activeTurn?.state === 'running'
                ? { ...item, activeTurn: { ...item.activeTurn, state: 'interrupted' } }
                : item,
            ),
          },
    )
    setAgentId(project.agents?.find(canRunAgent)?.id || '')
    setHistorySearch('')
    return () => {
      jobs.current.forEach((job) => job.timers.forEach(clearTimeout))
      jobs.current.clear()
    }
    // 项目切换时重新建立独立的模拟执行上下文。
  }, [projectId])

  useEffect(() => {
    setInput('')
    setScope('all')
    setDeviceId('')
    setPreview(null)
    setReferenceOpen(false)
    setAttachedIds(tab === 'new' && selectedId ? [selectedId] : [])
    setAtBottom(true)
  }, [projectId, selectedId, tab])

  useEffect(() => {
    if (atBottom && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [conversation?.messages, currentTurn?.state, atBottom])

  function addToolStep(id, turnId, step) {
    changeConversation(id, (item) =>
      item.activeTurn?.id !== turnId
        ? item
        : {
            ...item,
            messages: item.messages.map((message) =>
              message.id === item.activeTurn.assistantId
                ? { ...message, steps: [...(message.steps || []), step] }
                : message,
            ),
          },
    )
  }

  function buildReport(message, title, id, conversationId) {
    const date = new Date().toISOString()
    const content = `# ${title}\n\n项目：${live.current.project.name}\n生成时间：${date}\n配置版本：v${message.configVersion || live.current.project.configVersion || 1}\n\n> 模拟 Agent 生成的演示报告，未查询真实服务。\n\n${message.content}\n\n## 来源\n\n${(message.references || []).map((item) => `- ${item.name}（${item.version || '当前版本'}）`).join('\n') || '- 项目配置摘要'}\n`
    const name = `${title}.md`
    return {
      id,
      name,
      type: 'report',
      version: 'v1',
      status: 'ready',
      sourceId: message.id,
      sourceKind: 'conversation',
      conversationId,
      sourceMessageId: message.id,
      createdAt: date,
      content,
      files: [{ name, content }],
      usage: ['问答'],
    }
  }

  function saveReport(message, session = conversation, quiet = false) {
    if (!session) return
    const existing = live.current.project.artifacts?.find(
      (item) => item.sourceId === message.id && item.type === 'report',
    )
    if (existing) {
      if (!quiet) setPreview(existing)
      return existing.id
    }
    const artifactId = makeId('report')
    const report = buildReport(
      message,
      `${session.title.slice(0, 22)}-分析报告`,
      artifactId,
      session.id,
    )
    const owner = projectId
    live.current.updateProject((current) =>
      current.id !== owner
        ? current
        : {
            ...current,
            artifacts: [report, ...(current.artifacts || [])],
            conversations: current.conversations.map((item) =>
              item.id === session.id
                ? {
                    ...item,
                    messages: item.messages.map((entry) =>
                      entry.id === message.id ? { ...entry, artifactId } : entry,
                    ),
                  }
                : item,
            ),
          },
    )
    if (!quiet) {
      setPreview(report)
      toast.success('报告已保存到项目产物')
    }
    return artifactId
  }

  function runQueued(id) {
    const entry = live.current.project.conversations?.find((item) => item.id === id)
    if (!entry?.queue?.length || busyStates.includes(entry.activeTurn?.state)) return
    const next = entry.queue[0]
    beginTurn(entry, next.text, { queuedId: next.id })
  }

  function validateAgent(id) {
    const agent = live.current.project.agents?.find((item) => item.id === id)
    if (!canAccessAgent(agent)) {
      toast.error('此 Agent 尚未共享给当前项目，请选择自己或已共享的 Agent')
      return false
    }
    if (!agent.online) {
      toast.error('当前 Agent 离线，请连接主机或选择在线 Agent')
      return false
    }
    return true
  }

  function finishStream(id, turn, snapshot, references, chosenScope = '', chosenDevice = '') {
    const answer = makeResponse(turn.question, snapshot, chosenScope, chosenDevice, references)
    let length = 0
    function tick() {
      const entry = live.current.project.conversations?.find((item) => item.id === id)
      if (entry?.activeTurn?.id !== turn.id || entry.activeTurn.state !== 'running') return
      length = Math.min(answer.length, length + 12)
      const done = length >= answer.length
      changeConversation(id, (item) =>
        item.activeTurn?.id !== turn.id
          ? item
          : {
              ...item,
              updatedAt: new Date().toISOString(),
              activeTurn: { ...item.activeTurn, state: done ? 'complete' : 'running' },
              messages: item.messages.map((message) =>
                message.id === turn.assistantId
                  ? {
                      ...message,
                      content: answer.slice(0, length),
                      status: done ? 'complete' : 'streaming',
                    }
                  : message,
              ),
            },
      )
      if (!done) schedule(id, tick, 65)
      else {
        if (/报告|分析|设备|检查/.test(turn.question)) {
          schedule(
            id,
            () => {
              const updated = live.current.project.conversations?.find((item) => item.id === id)
              const message = updated?.messages.find((item) => item.id === turn.assistantId)
              if (message) saveReport(message, updated, true)
            },
            150,
          )
        }
        schedule(id, () => runQueued(id), 550)
      }
    }
    schedule(id, tick, 350)
  }

  function startSteps(entry, turn, references, snapshot) {
    schedule(
      entry.id,
      () => {
        addToolStep(entry.id, turn.id, {
          id: 'search',
          name: '检索项目资料',
          tool: 'assets.search',
          result: `找到 ${references.length} 份可引用的资料；限定当前项目。`,
        })
      },
      500,
    )
    schedule(
      entry.id,
      () => {
        addToolStep(entry.id, turn.id, {
          id: 'read',
          name: '读取资料与配置',
          tool: 'assets.read',
          result: `读取配置 v${snapshot.configVersion || 1}，内容来自本地模拟数据。`,
        })
        const deviceIssue = /设备/.test(turn.question) ? deviceAccessIssue(snapshot) : ''
        if (deviceIssue) {
          addToolStep(entry.id, turn.id, {
            id: 'devices',
            name: '设备查询已阻断',
            tool: 'cabinet.devices.list',
            status: 'failed',
            result: deviceIssue,
          })
          finishStream(entry.id, turn, snapshot, references, turn.scope, turn.deviceId)
        } else if (/设备/.test(turn.question) && !turn.scope) {
          changeConversation(entry.id, (item) =>
            item.activeTurn?.id !== turn.id
              ? item
              : {
                  ...item,
                  activeTurn: { ...item.activeTurn, state: 'waiting' },
                  messages: item.messages.map((message) =>
                    message.id === turn.assistantId
                      ? {
                          ...message,
                          status: 'waiting',
                          content:
                            '已找到项目设备与路由相关的资料。继续模拟巡检前，请确认本次设备范围。',
                        }
                      : message,
                  ),
                },
          )
        } else {
          if (turn.scope)
            addToolStep(entry.id, turn.id, {
              id: 'devices',
              name: '模拟查询设备',
              tool: 'cabinet.devices.list',
              result:
                turn.scope === 'specific'
                  ? `示例设备：${turn.deviceId}。未调用真实 API。`
                  : '示例范围：本项目全部设备。未调用真实 API。',
            })
          finishStream(entry.id, turn, snapshot, references, turn.scope, turn.deviceId)
        }
      },
      1100,
    )
  }

  function beginTurn(entry, question, options = {}) {
    if (!validateAgent(entry.agentId)) return
    const oldTurn = options.resume ? entry.activeTurn : null
    const snapshot = { ...live.current.project, ...(oldTurn?.contextSnapshot || {}) }
    const sources = [
      ...(snapshot.documents || []),
      ...(snapshot.artifacts || []).filter((item) => item.status === 'ready'),
    ]
    const referenceIds = entry.contextIds?.length
      ? entry.contextIds
      : (snapshot.documents || []).slice(0, 2).map((item) => item.id)
    const previousMessage = oldTurn
      ? entry.messages.find((item) => item.id === oldTurn.assistantId)
      : null
    const references =
      previousMessage?.references ||
      sources
        .filter((item) => referenceIds.includes(item.id))
        .map((item) => ({
          id: item.id,
          name: item.name,
          version: item.version,
          content: itemContent(item),
        }))
    clearJob(entry.id)
    const assistantId = oldTurn?.assistantId || makeId('message')
    const turn = {
      id: makeId('turn'),
      assistantId,
      question,
      state: 'running',
      scope: options.scope || oldTurn?.scope || '',
      deviceId: options.deviceId || oldTurn?.deviceId || '',
      configVersion: snapshot.configVersion,
      contextSnapshot: {
        name: snapshot.name,
        configVersion: snapshot.configVersion,
        devices: snapshot.devices,
        config: structuredClone(snapshot.config),
        connectionStates: structuredClone(snapshot.connectionStates || {}),
      },
    }
    const userMessage = {
      id: makeId('message'),
      role: 'user',
      content: question,
      createdAt: new Date().toISOString(),
      status: 'received',
    }
    const assistantMessage = {
      id: assistantId,
      role: 'assistant',
      agentId: entry.agentId,
      content: '',
      status: 'streaming',
      steps: [],
      references,
      configVersion: snapshot.configVersion,
      createdAt: new Date().toISOString(),
    }
    changeConversation(entry.id, (item) => ({
      ...item,
      activeTurn: turn,
      updatedAt: new Date().toISOString(),
      queue: options.queuedId
        ? (item.queue || []).filter((queued) => queued.id !== options.queuedId)
        : item.queue || [],
      messages: options.resume
        ? item.messages.map((message) => (message.id === assistantId ? assistantMessage : message))
        : [
            ...item.messages.map((message) =>
              message.queueId === options.queuedId && options.queuedId
                ? { ...message, status: 'received' }
                : message,
            ),
            ...(!options.queuedId ? [userMessage] : []),
            assistantMessage,
          ],
    }))
    startSteps(entry, turn, references, snapshot)
    setAtBottom(true)
  }

  function send(text = input) {
    const question = text.trim()
    if (!question) return
    if (!validateAgent(currentAgent?.id)) return
    setInput('')
    let entry = conversation
    if (!entry) {
      entry = {
        id: makeId('conversation'),
        title: question.slice(0, 28),
        agentId: currentAgent.id,
        contextIds: [...attachedIds],
        messages: [],
        queue: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      const owner = projectId
      updateProject((current) =>
        current.id !== owner
          ? current
          : { ...current, conversations: [entry, ...(current.conversations || [])] },
      )
      navigate('chat', 'session', entry.id)
    }
    if (busyStates.includes(entry.activeTurn?.state)) {
      const queueId = makeId('queued')
      changeConversation(entry.id, (item) => ({
        ...item,
        queue: [...(item.queue || []), { id: queueId, text: question }],
        messages: [
          ...item.messages,
          {
            id: makeId('message'),
            queueId,
            role: 'user',
            content: question,
            status: 'queued',
            createdAt: new Date().toISOString(),
          },
        ],
      }))
      toast.success('补充内容已接收，将在下一轮处理')
    } else {
      beginTurn(entry, question)
    }
    setAtBottom(true)
  }

  function stop() {
    if (!conversation) return
    clearJob(conversation.id)
    changeConversation(conversation.id, (item) => ({
      ...item,
      activeTurn: { ...item.activeTurn, state: 'cancelled' },
      messages: item.messages.map((message) =>
        message.id === item.activeTurn.assistantId ? { ...message, status: 'cancelled' } : message,
      ),
    }))
    toast.info('模拟任务已停止；已接收的补充消息仍保留')
  }

  function answerScope() {
    if (!conversation || !validateAgent(conversation.agentId)) return
    if (scope === 'specific' && !deviceId.trim()) {
      toast.error('请输入设备编号')
      return
    }
    const turn = { ...currentTurn, state: 'running', scope, deviceId: deviceId.trim() }
    changeConversation(conversation.id, (item) => ({
      ...item,
      activeTurn: turn,
      messages: item.messages.map((message) =>
        message.id === turn.assistantId
          ? {
              ...message,
              status: 'streaming',
              content: '',
              scopeAnswer: scope === 'all' ? '全部设备' : `指定设备 ${deviceId.trim()}`,
            }
          : message,
      ),
    }))
    const snapshot = {
      ...project,
      ...(turn.contextSnapshot || {}),
      configVersion: turn.configVersion,
    }
    const deviceIssue = deviceAccessIssue(snapshot)
    addToolStep(conversation.id, turn.id, {
      id: 'devices',
      name: deviceIssue ? '设备查询已阻断' : '模拟查询设备',
      tool: 'cabinet.devices.list',
      status: deviceIssue ? 'failed' : 'complete',
      result:
        deviceIssue ||
        (scope === 'all'
          ? '范围：项目全部设备；仅使用示例数据。'
          : `范围：设备 ${deviceId.trim()}；仅使用示例数据。`),
    })
    const message = conversation.messages.find((item) => item.id === turn.assistantId)
    finishStream(conversation.id, turn, snapshot, message?.references || [], scope, deviceId.trim())
  }

  function toggleReference(id) {
    const next = contextIds.includes(id)
      ? contextIds.filter((item) => item !== id)
      : [...contextIds, id]
    if (conversation) changeConversation(conversation.id, (item) => ({ ...item, contextIds: next }))
    else setAttachedIds(next)
  }

  async function copyMessage(message) {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedId(message.id)
      toast.success('回答已复制')
    } catch {
      toast.error('浏览器未允许复制，请选中正文复制')
    }
  }

  function openSource(reference) {
    if (reference.content) {
      setPreview(reference)
      return
    }
    const item = allSources.find((source) => source.id === reference.id)
    if (item) setPreview(item)
    else toast.error('这份资料已不在当前项目中')
  }

  const historyPanel = (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">对话</span>
        <Badge variant="secondary">{project.conversations?.length || 0}</Badge>
      </div>
      <Button
        className="w-full"
        onClick={() => {
          navigate('chat', 'new')
          setHistoryOpen(false)
        }}
      >
        <Plus />
        新建对话
      </Button>
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <Input
          className="pl-9"
          aria-label="搜索历史对话"
          placeholder="搜索历史对话"
          value={historySearch}
          onChange={(event) => setHistorySearch(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {chats.length ? (
          chats.map((item) => (
            <Button
              key={item.id}
              variant={item.id === conversation?.id ? 'secondary' : 'ghost'}
              className="h-auto w-full justify-start gap-2 px-3 py-3 text-left"
              onClick={() => {
                navigate('chat', 'session', item.id)
                setHistoryOpen(false)
              }}
            >
              <MessageSquare className="self-start text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{item.title}</span>
                <span className="mt-1 block text-[11px] font-normal text-muted-foreground">
                  {item.activeTurn ? stateLabels[item.activeTurn.state] : '新对话'} ·{' '}
                  {timeLabel(item.updatedAt)}
                </span>
              </span>
            </Button>
          ))
        ) : (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {historySearch ? '没有匹配的对话' : '从一个问题开始，历史将保存在当前项目。'}
          </p>
        )}
      </div>
      <div className="rounded-lg border bg-background/60 p-3 text-xs leading-relaxed text-muted-foreground">
        <span className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <Bot className="size-3.5" />
          模拟 Agent
        </span>
        数据保存在当前浏览器；没有连接模型、主机或真实 MCP。
      </div>
    </div>
  )

  const contextPanel = (
    <div className="space-y-5 p-4 text-sm">
      <div>
        <div className="mb-3 flex items-center gap-2 font-semibold">
          <Link2 className="size-4 text-emerald-600" />
          本轮上下文
        </div>
        <div className="space-y-2 text-xs text-muted-foreground">
          <div className="flex justify-between gap-2">
            <span>项目</span>
            <span className="truncate text-foreground">{project.name}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>环境</span>
            <span className="text-foreground">{environmentLabel}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>配置版本</span>
            <span className="text-foreground">
              v{currentTurn?.configVersion || project.configVersion || 1}
            </span>
          </div>
        </div>
      </div>
      <div className="border-t pt-4">
        <div className="mb-2 flex items-center justify-between text-xs font-medium">
          <span>{turnMessage ? '本轮引用 · 固定版本' : '下一轮引用'}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="选择下一轮引用资料"
            onClick={() => setReferenceOpen(true)}
          >
            <Plus />
          </Button>
        </div>
        {sourcesForDisplay.length ? (
          sourcesForDisplay.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              className="h-auto w-full justify-start px-1 py-2 text-left"
              onClick={() => setPreview(item)}
            >
              <FileText className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">{item.name}</span>
            </Button>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">尚未添加资料</p>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          此处展示本轮保存的资料版本。通过右上角加号选择下一轮引用，不会改变已有回答。
        </p>
      </div>
      <div className="border-t pt-4">
        <div className="mb-3 text-xs font-medium">Agent 运行环境</div>
        <div className="flex items-start gap-2 rounded-lg border bg-background/50 p-3">
          <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-1 text-xs">
            <div className="truncate font-medium">{currentAgent?.host || '未选择主机'}</div>
            <div className="text-muted-foreground">
              {currentAgent?.provider} · {currentAgent?.owner || '项目管理员'}
            </div>
            <Badge variant="secondary" className="text-[10px]">
              {!canAccessAgent(currentAgent)
                ? '未共享给项目'
                : currentAgent?.online
                  ? '模拟在线'
                  : '模拟离线'}
            </Badge>
          </div>
        </div>
      </div>
      <div className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">
        <span className="mb-1 block font-medium text-foreground">按项目隔离</span>Agent
        只读取本项目选定的资料。生成的报告可在源码与产物中继续查看。
      </div>
    </div>
  )

  return (
    <div className="prototype-chat-root">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Agent 对话</h1>
          <Badge variant="secondary" className="text-[10px]">
            交互原型
          </Badge>
        </div>
        <Button variant="outline" className="lg:hidden" onClick={() => setHistoryOpen(true)}>
          <History />
          历史对话
        </Button>
      </div>
      <Card className="prototype-chat-layout gap-0 overflow-hidden p-0">
        <aside className="prototype-chat-history">{historyPanel}</aside>
        <section className="prototype-chat-main">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3 md:px-6">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {conversation?.title || '新建对话'}
              </div>
              {currentTurn && (
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className={`size-1.5 rounded-full ${busy ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  />
                  {stateLabels[currentTurn.state]}
                </div>
              )}
            </div>
            <Select
              value={conversation?.agentId || agentId}
              disabled={busy}
              onValueChange={(value) => {
                if (conversation)
                  changeConversation(conversation.id, (item) => ({ ...item, agentId: value }))
                else setAgentId(value)
              }}
            >
              <SelectTrigger className="w-[174px] max-w-full text-xs" aria-label="选择 Agent">
                <Bot className="size-3.5" />
                <SelectValue placeholder="选择 Agent" />
              </SelectTrigger>
              <SelectContent>
                {project.agents?.map((item) => (
                  <SelectItem value={item.id} key={item.id} disabled={!canRunAgent(item)}>
                    {item.name} · {item.provider}
                    {!canAccessAgent(item) ? ' · 未共享' : !item.online ? ' · 离线' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Collapsible className="border-b xl:hidden">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-between rounded-none px-4 text-xs"
              >
                <span className="flex items-center gap-2">
                  <Link2 className="size-3.5" />
                  本轮上下文 · {sourcesForDisplay.length} 份资料
                </span>
                <ChevronDown />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>{contextPanel}</CollapsibleContent>
          </Collapsible>
          <div
            ref={scroller}
            className="prototype-chat-messages"
            onScroll={(event) => {
              const target = event.currentTarget
              setAtBottom(target.scrollHeight - target.scrollTop - target.clientHeight < 90)
            }}
          >
            {!conversation?.messages.length ? (
              <div className="mx-auto flex min-h-[340px] max-w-lg flex-col items-center justify-center px-3 py-10 text-center">
                <div className="mb-5 flex size-14 items-center justify-center rounded-2xl border bg-emerald-50 text-emerald-700">
                  <Sparkles className="size-6" />
                </div>
                <h2 className="text-xl font-semibold">一起读懂你的项目</h2>
                <div className="mt-7 grid w-full gap-2">
                  {[
                    '总结当前项目的架构与资料',
                    '检查设备状态并生成分析报告',
                    '解释源码脱敏和产物处理流程',
                  ].map((question) => (
                    <Button
                      key={question}
                      variant="outline"
                      className="h-auto min-h-10 justify-between whitespace-normal px-4 py-3 text-left text-xs"
                      onClick={() => send(question)}
                    >
                      {question}
                      <ArrowUp className="size-3.5 rotate-45" />
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-7">
                {conversation.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`min-w-0 ${message.role === 'user' ? 'ml-auto max-w-[88%]' : ''}`}
                  >
                    {message.role === 'user' ? (
                      <>
                        <div className="rounded-2xl rounded-tr-sm bg-emerald-50 px-4 py-3 text-sm leading-6 whitespace-pre-wrap break-words">
                          {message.content}
                        </div>
                        <div className="mt-1.5 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                          {message.status === 'queued' ? (
                            <>
                              <History className="size-3" />
                              已接收 · 下一轮排队
                            </>
                          ) : message.status === 'removed' ? (
                            '已移出队列'
                          ) : (
                            <>
                              <CheckCheck className="size-3" />
                              已接收
                            </>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="mb-3 flex items-center gap-2 text-xs font-medium">
                          <span className="flex size-7 items-center justify-center rounded-lg border bg-background">
                            <Bot className="size-4 text-emerald-700" />
                          </span>
                          {project.agents?.find(
                            (item) => item.id === (message.agentId || conversation.agentId),
                          )?.name || '项目 Agent'}
                          <Badge variant="outline" className="text-[9px]">
                            模拟
                          </Badge>
                        </div>
                        {!!message.steps?.length && (
                          <Collapsible className="mb-3 rounded-lg border bg-muted/25">
                            <CollapsibleTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full justify-between text-xs"
                              >
                                <span className="flex items-center gap-2">
                                  <Terminal className="size-3.5 text-emerald-600" />
                                  {message.steps.some((step) => step.status === 'failed')
                                    ? '存在阻断 · '
                                    : '已完成 '}
                                  {message.steps.length} 个工具步骤
                                </span>
                                <ChevronDown className="size-3" />
                              </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="space-y-3 px-3 pt-1 pb-3">
                                {message.steps.map((step) => (
                                  <div key={step.id} className="flex gap-2 text-xs">
                                    {step.status === 'failed' ? (
                                      <X className="mt-0.5 size-3 shrink-0 text-destructive" />
                                    ) : (
                                      <Check className="mt-0.5 size-3 shrink-0 text-emerald-600" />
                                    )}
                                    <div className="min-w-0">
                                      <div className="font-medium">
                                        {step.name}
                                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                                          {step.tool}
                                        </span>
                                      </div>
                                      <p className="mt-1 leading-5 text-muted-foreground">
                                        {step.result}
                                      </p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        )}
                        {message.scopeAnswer && (
                          <Badge variant="secondary" className="mb-3 text-[10px]">
                            已确认范围：{message.scopeAnswer}
                          </Badge>
                        )}
                        <div className="prototype-chat-answer text-sm leading-7 whitespace-pre-wrap break-words">
                          {message.content ||
                            (currentTurn?.assistantId === message.id &&
                            currentTurn.state === 'running' ? (
                              <span className="flex items-center gap-2 text-muted-foreground">
                                <LoaderCircle className="size-4 animate-spin" />
                                正在检索项目资料…
                              </span>
                            ) : (
                              '模拟任务已中断，可继续生成。'
                            ))}
                        </div>
                        {currentTurn?.assistantId === message.id &&
                          currentTurn.state === 'waiting' && (
                            <Card className="mt-4 gap-3 border-emerald-200 p-4">
                              <div className="flex items-center gap-2 text-sm font-medium">
                                <CircleHelp className="size-4 text-emerald-700" />
                                这次要检查哪些设备？
                              </div>
                              <p className="text-xs leading-5 text-muted-foreground">
                                确认范围后继续模拟查询。选择指定设备时，请填写编号。
                              </p>
                              <Select value={scope} onValueChange={setScope}>
                                <SelectTrigger aria-label="设备检查范围">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="all">本项目全部设备</SelectItem>
                                  <SelectItem value="specific">指定设备编号</SelectItem>
                                </SelectContent>
                              </Select>
                              {scope === 'specific' && (
                                <div className="space-y-2">
                                  <Label htmlFor="prototype-device-id">设备编号</Label>
                                  <Input
                                    id="prototype-device-id"
                                    placeholder="例如 SOL-00128"
                                    value={deviceId}
                                    onChange={(event) => setDeviceId(event.target.value)}
                                  />
                                </div>
                              )}
                              <Button className="self-start" size="sm" onClick={answerScope}>
                                确认并继续
                                <ArrowUp className="size-3 rotate-45" />
                              </Button>
                            </Card>
                          )}
                        {message.content && message.status === 'complete' && (
                          <>
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {message.references?.map((reference, index) => (
                                <Button
                                  key={reference.id}
                                  variant="outline"
                                  size="xs"
                                  className="h-auto max-w-full py-1 text-[10px]"
                                  onClick={() => openSource(reference)}
                                >
                                  <BookOpen className="size-3" />
                                  <span className="truncate">
                                    [{index + 1}] {reference.name}
                                  </span>
                                </Button>
                              ))}
                            </div>
                            {message.artifactId && (
                              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border bg-background/60 p-3">
                                <FileText className="size-5 text-emerald-700" />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs font-medium">
                                    {project.artifacts?.find(
                                      (item) => item.id === message.artifactId,
                                    )?.name || '分析报告'}
                                  </div>
                                  <div className="mt-1 text-[10px] text-muted-foreground">
                                    Markdown · 已保存到项目产物
                                  </div>
                                </div>
                                <Button
                                  variant="outline"
                                  size="xs"
                                  onClick={() => {
                                    const item = project.artifacts?.find(
                                      (item) => item.id === message.artifactId,
                                    )
                                    if (item) setPreview(item)
                                  }}
                                >
                                  查看报告
                                </Button>
                              </div>
                            )}
                            <div className="mt-2 flex gap-1">
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => copyMessage(message)}
                              >
                                {copiedId === message.id ? <Check /> : <Clipboard />}复制
                              </Button>
                              {!message.artifactId && (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => saveReport(message)}
                                >
                                  <FileText />
                                  保存为报告
                                </Button>
                              )}
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </article>
                ))}
                {['cancelled', 'interrupted'].includes(currentTurn?.state) && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
                    <p className="text-xs text-muted-foreground">
                      {currentTurn.state === 'cancelled'
                        ? '任务已停止，已有内容仍保留。'
                        : '上次模拟执行已中断，点击继续重新生成本轮。'}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        beginTurn(conversation, currentTurn.question, { resume: true })
                      }
                    >
                      继续本轮
                    </Button>
                  </div>
                )}
                {!!conversation.queue?.length && (
                  <div className="rounded-lg border border-dashed p-3">
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium">
                      <span>下一轮补充 · {conversation.queue.length}</span>
                      {!busy && (
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => runQueued(conversation.id)}
                        >
                          处理下一条
                        </Button>
                      )}
                    </div>
                    {conversation.queue.map((queued) => (
                      <div
                        key={queued.id}
                        className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
                      >
                        <span className="min-w-0 flex-1 truncate">{queued.text}</span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`移除排队消息：${queued.text}`}
                          onClick={() =>
                            changeConversation(conversation.id, (item) => ({
                              ...item,
                              queue: item.queue.filter((entry) => entry.id !== queued.id),
                              messages: item.messages.map((entry) =>
                                entry.queueId === queued.id
                                  ? { ...entry, status: 'removed' }
                                  : entry,
                              ),
                            }))
                          }
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="prototype-chat-composer border-t bg-background/80 px-4 pt-3 pb-3 md:px-6">
            {!atBottom && conversation?.messages.length > 0 && (
              <div className="mb-2 flex justify-center">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    setAtBottom(true)
                    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
                  }}
                >
                  <ArrowDown />
                  回到最新消息
                </Button>
              </div>
            )}
            <div className="rounded-xl border bg-background p-2">
              <Textarea
                aria-label="向 Agent 提问"
                className="min-h-[66px] resize-none border-0 bg-transparent px-2 py-1 shadow-none focus-visible:ring-0"
                placeholder={
                  busy ? '补充问题或要求，将在下一轮处理…' : '描述问题，或让 Agent 分析项目资料…'
                }
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onCompositionStart={() => {
                  composing.current = true
                }}
                onCompositionEnd={() => {
                  composing.current = false
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    !composing.current &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault()
                    send()
                  }
                }}
              />
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground"
                  onClick={() => setReferenceOpen(true)}
                >
                  <Paperclip />
                  资料{contextIds.length > 0 ? ` · ${contextIds.length}` : ''}
                </Button>
                <div className="flex items-center gap-2">
                  {busy && (
                    <Button variant="outline" size="sm" onClick={stop}>
                      <Square className="size-3" />
                      停止
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={!input.trim() || !canRunAgent(currentAgent)}
                    onClick={() => send()}
                  >
                    {busy ? '加入下一轮' : '发送'}
                    <ArrowUp className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
            <p className="mt-2 text-center text-[10px] text-muted-foreground">
              模拟 Agent · Enter 发送，Shift + Enter 换行 · 回答仅用于原型演示
            </p>
          </div>
        </section>
        <aside className="prototype-chat-context">{contextPanel}</aside>
      </Card>
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="flex w-80 flex-col gap-0 p-0">
          <SheetHeader className="p-4 pb-0">
            <SheetTitle>项目对话</SheetTitle>
            <SheetDescription>当前项目的历史与运行状态</SheetDescription>
          </SheetHeader>
          {historyPanel}
        </SheetContent>
      </Sheet>
      <Dialog open={referenceOpen} onOpenChange={setReferenceOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>引用项目资料</DialogTitle>
            <DialogDescription>
              选择下一轮使用的资料。未指定时读取前两份项目文档。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {allSources.length ? (
              allSources.map((item) => (
                <div className="flex items-center gap-2 rounded-lg border p-3" key={item.id}>
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{item.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {item.kind === 'document' ? '项目文档' : '项目产物'} · {item.version || 'v1'}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setPreview(item)}>
                    预览
                  </Button>
                  <Button
                    variant={contextIds.includes(item.id) ? 'secondary' : 'outline'}
                    size="sm"
                    aria-pressed={contextIds.includes(item.id)}
                    onClick={() => toggleReference(item.id)}
                  >
                    {contextIds.includes(item.id) ? (
                      <>
                        <Check />
                        已选
                      </>
                    ) : (
                      '引用'
                    )}
                  </Button>
                </div>
              ))
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                请先在资料与配置中添加项目资料。
              </p>
            )}
          </div>
          <Button className="justify-self-end" onClick={() => setReferenceOpen(false)}>
            完成
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null)
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="pr-5 leading-6">{preview?.name}</DialogTitle>
            <DialogDescription>
              当前项目资料 · {preview?.version || 'v1'}
              {preview?.type === 'report' ? ' · 模拟 Agent 生成' : ''}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[55dvh] overflow-y-auto rounded-lg border bg-muted/35 p-4 font-sans text-sm leading-7 whitespace-pre-wrap break-words">
            {itemContent(preview)}
          </pre>
          {preview?.type === 'report' && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => downloadReport(preview)}>
                <ArrowDown />
                下载报告
              </Button>
              <Button
                onClick={() => {
                  const id = preview.id
                  setPreview(null)
                  navigate('materials', 'artifacts', id)
                }}
              >
                在产物中查看
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
