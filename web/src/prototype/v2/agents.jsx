import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  ArrowDown,
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Copy,
  Download,
  Eye,
  FileText,
  History,
  Link2,
  LockKeyhole,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  Button,
  Input,
  Textarea,
  Label,
  Checkbox,
  Badge,
  Card,
  PageHeader,
  Panel,
  Field,
  Picker,
  Modal,
  Confirm,
  Empty,
  toast,
} from './ui'
import { useWorkbench, uid } from './store'
import { createReportPDF, downloadChatFile } from './agent-files'
import { useConversationDraft, discardConversationDrafts } from './use-conversation-draft'
import './agents.css'

const now = () => new Date().toISOString()
const isAlive = (artifact) => artifact && !artifact.deleted && artifact.status === 'ready'
const agentCanManage = (agent, user) => agent.kind === 'platform' && user.role === 'admin'
const projectName = (state, id) => state.projects[id]?.name || '项目已删除'
const visibilityName = (agent, state) =>
  agent.sharing === 'private' ? '仅本人' : `${projectName(state, agent.projectId)}成员`
const chatTime = (value) =>
  new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const lastActivity = (conversation) => conversation.messages?.at(-1)?.at || conversation.createdAt
const toolNames = {
  'project.materials.search': '检索项目资料',
  'artifact.files.read': '读取指定制品',
  'artifact.source.read': '读取源码',
  'mcp.resources.connect': '连接环境资源',
  'mcp.resource.status.read': '查询资源状态',
  'platform.capability.check': '核对执行范围',
}

function MessageMarkdown({ content = '' }) {
  const inline = (text) =>
    text
      .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
      .map((part, index) =>
        part.startsWith('**') ? (
          <strong key={index}>{part.slice(2, -2)}</strong>
        ) : part.startsWith('`') ? (
          <code key={index}>{part.slice(1, -1)}</code>
        ) : (
          part
        ),
      )
  return (
    <div className="wb-chat-markdown">
      {content.split(/(```[\s\S]*?```)/g).flatMap((part, index) => {
        if (part.startsWith('```'))
          return (
            <pre key={`code-${index}`} className="wb-code">
              {part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}
            </pre>
          )
        return part
          .split(/\n\s*\n/)
          .filter(Boolean)
          .map((block, item) => {
            const key = `${index}-${item}`
            if (/^#{1,4}\s/.test(block))
              return <h3 key={key}>{inline(block.replace(/^#{1,4}\s/, ''))}</h3>
            const lines = block.split('\n')
            if (lines.every((line) => /^\s*\d+[.)、]\s*/.test(line)))
              return (
                <ol key={key}>
                  {lines.map((line, i) => (
                    <li key={i}>{inline(line.replace(/^\s*\d+[.)、]\s*/, ''))}</li>
                  ))}
                </ol>
              )
            if (lines.every((line) => /^\s*[-*•]\s+/.test(line)))
              return (
                <ul key={key}>
                  {lines.map((line, i) => (
                    <li key={i}>{inline(line.replace(/^\s*[-*•]\s+/, ''))}</li>
                  ))}
                </ul>
              )
            if (/^>\s?/.test(block))
              return <blockquote key={key}>{inline(block.replace(/^>\s?/gm, ''))}</blockquote>
            return <p key={key}>{inline(block)}</p>
          })
      })}
    </div>
  )
}

function agentScope(project, conversation) {
  const selected = new Set(conversation.scopeIds || [])
  const documents = (project.documents || []).filter(
    (item) => !item.deleted && item.kind !== 'folder',
  )
  if (!selected.size) return documents
  const selectedFolders = (project.documents || []).filter(
    (item) => selected.has(item.id) && item.kind === 'folder',
  )
  const inFolder = (doc) => {
    let parent = doc.parentId
    const visited = new Set()
    while (parent && !visited.has(parent)) {
      if (selected.has(parent)) return true
      visited.add(parent)
      parent = project.documents.find((item) => item.id === parent)?.parentId
    }
    return selectedFolders.some(
      (folder) => doc.path && doc.path.startsWith(`${folder.path || folder.name}/`),
    )
  }
  return documents.filter((item) => selected.has(item.id) || inFolder(item))
}

function artifactFile(file, conversation, agent) {
  return {
    ...file,
    id: uid('agent-file'),
    type: file.name.endsWith('.md') || file.name.endsWith('.pdf') ? 'report' : 'file',
    status: 'ready',
    createdAt: now(),
    files: file.dataUrl ? [] : [{ name: file.name, content: file.content || '' }],
    conversationId: conversation.id,
    agentId: agent.id,
    sourceId: conversation.sourceArtifactId || null,
    documentIds: conversation.scopeIds || [],
  }
}

function makeResponse(project, agent, conversation, active) {
  const docs = agent.kind === 'platform' ? agentScope(project, conversation) : []
  const source =
    agent.kind === 'platform'
      ? project.artifacts.find((item) => item.id === conversation.sourceArtifactId && isAlive(item))
      : null
  const scopedArtifacts =
    agent.kind === 'platform'
      ? project.artifacts.filter(
          (item) =>
            isAlive(item) &&
            conversation.scopeIds?.includes(item.id) &&
            ['report', 'file'].includes(item.type),
        )
      : []
  const environment = project.environments.find((item) => item.id === conversation.environmentId)
  const resources = project.resources.filter(
    (item) => !item.environmentId || item.environmentId === conversation.environmentId,
  )
  const needsResource = agent.kind === 'platform' && Boolean(environment)
  const isMutation =
    /删除|写入|更新数据库|UPDATE\s|INSERT\s|DELETE\s|重启|停止服务|执行部署|帮我部署|迁移机柜|解绑|重置平台|修改服务器/i.test(
      active.input,
    )
  const steps = []
  const citations = []
  if (agent.kind === 'platform') {
    steps.push({
      name: 'project.materials.search',
      args: {
        projectId: project.id,
        scope: conversation.scopeIds?.length ? conversation.scopeIds : '自动检索',
        query: active.input,
        readOnly: true,
      },
      result: `命中 ${docs.length} 份资料（模拟检索）`,
      status: 'success',
    })
    docs.slice(0, 3).forEach((doc) =>
      citations.push({
        id: doc.id,
        kind: 'document',
        label: doc.name,
        excerpt: String(doc.content || '上传文档，仅引用已保存的文件。').slice(0, 300),
      }),
    )
    if (scopedArtifacts.length) {
      steps.push({
        name: 'artifact.files.read',
        args: { artifactIds: scopedArtifacts.map((item) => item.id), readOnly: true },
        result: `读取 ${scopedArtifacts.length} 项指定制品（模拟）`,
        status: 'success',
      })
      scopedArtifacts.forEach((artifact) =>
        citations.push({
          id: artifact.id,
          kind: 'artifact',
          label: artifact.name,
          excerpt: String(
            artifact.content || artifact.files?.[0]?.content || '引用已保存的文件。',
          ).slice(0, 300),
        }),
      )
    }
    if (source) {
      steps.push({
        name: 'artifact.source.read',
        args: {
          artifactId: source.id,
          sourcePolicy: conversation.sourceMode,
          commit: source.commit || null,
        },
        result: `读取 ${source.files?.length || 0} 个文件，源文件保持不变`,
        status: 'success',
      })
      citations.push({
        id: source.id,
        kind: 'artifact',
        label: source.name,
        excerpt: `来源提交：${source.commit || '未提供'}。${source.files?.map((file) => file.name).join('、') || ''}`,
      })
    }
    if (needsResource && !isMutation) {
      steps.push({
        name: 'mcp.resources.connect',
        args: {
          environmentId: environment.id,
          resources: resources.map((resource) => resource.id),
          automatic: true,
        },
        result:
          active.scenario === 'failed'
            ? '连接失败，未执行查询。可手动重试。'
            : `自动连接 ${resources.length} 个环境/公共资源（模拟）`,
        status: active.scenario === 'failed' ? 'failed' : 'success',
      })
      if (active.scenario !== 'failed')
        steps.push({
          name: 'mcp.resource.status.read',
          args: {
            environmentId: environment.id,
            capability: '预置只读状态查询',
            configurationSnapshot: active.resourceSnapshot?.map(({ name, host }) => ({
              name,
              host,
            })),
          },
          result: 'Server / MySQL / Redis 状态查询完成（模拟），没有写入外部资源。',
          status: 'success',
        })
    }
  }
  if (isMutation && agent.kind === 'platform')
    return {
      content:
        '此平台 Agent 仅执行问答、只读查询和分析，不能执行部署、服务操作、数据库写入或机柜变更。\n\n你可以在对应功能页面手动操作；我可以先生成检查清单或分析现有状态。',
      steps: [
        ...steps,
        {
          name: 'platform.capability.check',
          args: { requestedOperation: active.input },
          result: '超出平台 Agent 只读能力范围，未执行变更。',
          status: 'blocked',
        },
      ],
      citations,
      files: [],
      status: 'success',
    }
  if (active.scenario === 'failed')
    return {
      content: '本轮处理失败（演示场景）。未获得完整结果，请检查连接状态后手动重试。',
      steps,
      citations,
      files: [],
      status: 'failed',
    }
  if (active.scenario === 'clarify')
    return {
      content: '你希望这次分析优先关注哪一部分？请选择后继续，我会保留当前会话的 Agent 和环境。',
      steps,
      citations,
      files: [],
      status: 'success',
      clarification: ['部署前状态检查', '源码与文档一致性', '生成当前资料概览'],
    }
  let content
  if (agent.kind === 'platform') {
    content = `已根据${docs.length + scopedArtifacts.length ? ` ${docs.length + scopedArtifacts.length} 份项目资料` : '当前可用的项目上下文'}${source ? `和「${source.name}」` : ''}完成分析（模拟）。\n\n`
    content += environment
      ? `当前会话固定在「${environment.name}」环境。资源查询使用本轮开始时的配置快照；查询过程没有修改外部系统。\n\n`
      : '当前会话仅使用项目资料，不连接任何环境资源。\n\n'
    content +=
      '建议先核对业务目标、选定版本与验收条件，再执行需要人工确认的操作。引用来源可在下方展开核对。'
    if (!docs.length && !scopedArtifacts.length && !source)
      content +=
        '\n\n目前没有可用的匹配资料，因此无法给出具体项目结论；请上传资料或新建会话调整范围。'
    if (active.attachments.length)
      content += `\n\n本轮显式附件：${active.attachments.map((file) => file.name).join('、')}。`
  }
  const files = []
  if (/报告|导出|report|CSV|PDF|文件/i.test(active.input) || active.scenario === 'report') {
    if (agent.kind === 'platform') {
      const report = `# ${project.name}分析报告\n\n${content}\n\n## 资料来源\n\n${citations.map((ref) => `- ${ref.label}`).join('\n') || '- 本轮没有匹配资料'}\n\n生成时间：${now()}\n\n> 交互原型模拟报告，不代表真实运行结果。\n`
      files.push({ name: '项目分析报告.md', content: report, mime: 'text/markdown;charset=utf-8' })
      files.push({
        name: '项目分析报告.pdf',
        dataUrl: createReportPDF(`${project.name}分析报告`, [
          content,
          `资料来源：${citations.map((ref) => ref.label).join('、') || '没有匹配资料'}`,
          '',
          '交互原型模拟报告',
          `生成时间：${now()}`,
        ]),
        mime: 'application/pdf',
      })
      files.push({
        name: '资料索引.csv',
        content: `\ufeff"类型","名称","环境"\r\n${citations.map((ref) => [ref.kind, ref.label, environment?.name || '无环境'].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n')}\r\n`,
        mime: 'text/csv;charset=utf-8',
      })
    }
  }
  return {
    content,
    steps,
    citations,
    files: files.map((file) => artifactFile(file, conversation, agent)),
    status: 'success',
  }
}

function beginTurn(draft, conversation, input) {
  const agent = draft.agents.find((item) => item.id === conversation.agentId)
  const project = draft.projects[conversation.projectId]
  if (agent?.kind !== 'platform' || !project) return
  const source = project.artifacts.find(
    (artifact) => artifact.id === conversation.sourceArtifactId && isAlive(artifact),
  )
  const taskId = uid('task-agent')
  const createdAt = now()
  conversation.pendingClarification = null
  conversation.lastStopped = null
  conversation.lastFailed = null
  conversation.messages.push({
    id: uid('msg'),
    role: 'user',
    content: input.content,
    attachments: input.attachments || [],
    at: createdAt,
    actorId: input.actorId,
  })
  conversation.active = {
    id: uid('turn'),
    input: input.content,
    attachments: input.attachments || [],
    actorId: input.actorId,
    elapsed: 0,
    duration: input.scenario === 'slow' ? 24000 : 8500,
    lastTick: Date.now(),
    scenario: input.scenario || 'normal',
    taskId,
    startedAt: createdAt,
    environmentName:
      project.environments.find((item) => item.id === conversation.environmentId)?.name || null,
    instructionsSnapshot: agent.instructions,
    resourceSnapshot:
      agent.kind === 'platform' && conversation.environmentId
        ? project.resources
            .filter(
              (resource) =>
                !resource.environmentId || resource.environmentId === conversation.environmentId,
            )
            .map(({ id, name, type, host, port, environmentId }) => ({
              id,
              name,
              type,
              host,
              port,
              environmentId,
            }))
        : [],
  }
  conversation.active.response = makeResponse(project, agent, conversation, conversation.active)
  draft.tasks.unshift({
    id: taskId,
    projectId: conversation.projectId,
    agentId: agent.id,
    type: 'agent',
    title: `${agent.name} · ${input.content.slice(0, 35)}`,
    status: 'running',
    actorId: input.actorId,
    createdAt,
    progress: 0,
    elapsed: 0,
    duration: conversation.active.duration,
    logs: ['会话环境与 Agent 已固定。', '已记录本轮启动时的配置快照。'],
    artifactIds:
      agent.kind === 'platform'
        ? [
            ...new Set([
              ...(source ? [source.id] : []),
              ...project.artifacts
                .filter(
                  (artifact) => isAlive(artifact) && conversation.scopeIds?.includes(artifact.id),
                )
                .map((artifact) => artifact.id),
            ]),
          ]
        : [],
    configSnapshot: structuredClone(conversation.active.resourceSnapshot),
    runtimeManaged: true,
    effects: [],
    failureEffects: [],
  })
}

function streamedContent(active) {
  if (!active) return ''
  const start = active.streamFrom ?? active.duration / 2
  const fraction = Math.max(0, Math.min(1, (active.elapsed - start) / (active.duration - start)))
  const prefix = active.streamPrefix || ''
  const rest = active.response.content.slice(prefix.length)
  return prefix + rest.slice(0, Math.ceil(rest.length * fraction))
}

function turnSnapshot(conversation, active) {
  return {
    startedAt: active.startedAt,
    environmentId: conversation.environmentId,
    environmentName: active.environmentName,
    sourceArtifactId: conversation.sourceArtifactId,
    sourceMode: conversation.sourceMode,
    scopeIds: [...(conversation.scopeIds || [])],
    resources: structuredClone(active.resourceSnapshot),
  }
}

function preservedInput(active) {
  return {
    content: [
      active.input,
      ...(active.guidance || []).map((item) => `本轮补充：${item.content}`),
    ].join('\n\n'),
    attachments: structuredClone(active.attachments || []),
    actorId: active.actorId,
  }
}

function steerTurn(draft, conversation, message, expectedTurnId) {
  const active = conversation.active
  const task = draft.tasks.find((item) => item.id === active?.taskId)
  if (!active || active.id !== expectedTurnId || task?.status !== 'running') return false
  const prefix = streamedContent(active)
  active.guidance ||= []
  active.guidance.push({ ...message, delivery: 'simulated', acceptedAt: now() })
  conversation.messages.push({
    id: message.id,
    role: 'user',
    kind: 'steer',
    turnId: active.id,
    content: message.content,
    attachments: [],
    actorId: message.actorId,
    at: now(),
  })
  // 演示保留同一个轮次和已显示内容，不以停止重启代替引导。
  active.streamPrefix = prefix
  active.streamFrom = active.elapsed
  active.duration = Math.max(active.duration, active.elapsed + 6500)
  active.response.content = `${prefix}${prefix ? '\n\n' : ''}已加入本轮的引导（模拟）：${message.content}\n\n后续回复将围绕这条补充继续。本轮 Agent、环境和资料范围保持不变；真实执行器是否接收及遵循，将在接入后验证。`
  active.response.files = []
  active.response.clarification = null
  task.duration = active.duration
  task.logs.push(`收到本轮引导（模拟）：${message.content}`)
  return true
}

export function useAgentRuntime() {
  const { state, update } = useWorkbench()
  const activeRef = useRef(state)
  const updateRef = useRef(update)
  activeRef.current = state
  updateRef.current = update
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        !activeRef.current.conversations.some(
          (conversation) =>
            (conversation.active || conversation.queue?.length) &&
            activeRef.current.agents.some(
              (agent) => agent.id === conversation.agentId && agent.kind === 'platform',
            ),
        )
      )
        return
      updateRef.current((draft) => {
        for (const conversation of draft.conversations) {
          const agent = draft.agents.find((item) => item.id === conversation.agentId)
          const project = draft.projects[conversation.projectId]
          if (agent?.kind !== 'platform' || !project) continue
          if (
            !conversation.active &&
            conversation.queue?.length &&
            !conversation.queuePaused &&
            !conversation.pendingClarification &&
            draft.connected &&
            agent.status === 'online'
          ) {
            const queued = conversation.queue.shift()
            const allowed =
              agent.sharing === 'private'
                ? queued.actorId === agent.ownerId
                : agent.projectId === conversation.projectId &&
                  (project.memberIds.includes(queued.actorId) ||
                    draft.users.find((item) => item.id === queued.actorId)?.role === 'admin')
            const sourceReady =
              agent.kind !== 'platform' ||
              conversation.sourceMode === 'none' ||
              project.artifacts.some(
                (item) => item.id === conversation.sourceArtifactId && isAlive(item),
              )
            const environmentReady =
              !conversation.environmentId ||
              project.environments.some((item) => item.id === conversation.environmentId)
            if (allowed && sourceReady && environmentReady) beginTurn(draft, conversation, queued)
            else
              conversation.messages.push({
                id: uid('msg'),
                role: 'system',
                content: !allowed
                  ? '共享范围已变化，一条失去访问权限的待发消息已取消。'
                  : '固定环境或源码制品已不可用，待发消息已取消。请新建会话重新选择；不会自动切换上下文。',
                at: now(),
              })
          }
          const active = conversation.active
          if (!active) continue
          const task = draft.tasks.find((item) => item.id === active.taskId)
          if (!task || task.status === 'stopped') {
            const progress = active.elapsed / active.duration
            conversation.messages.push({
              id: uid('msg'),
              role: 'assistant',
              status: 'interrupted',
              content: streamedContent(active) || '本轮已停止，尚未生成回复正文。',
              steps:
                progress > 0.25
                  ? active.response.steps.slice(
                      0,
                      Math.max(1, Math.ceil(active.response.steps.length * progress)),
                    )
                  : [],
              citations: [],
              files: [],
              taskId: active.taskId,
              contextSnapshot: turnSnapshot(conversation, active),
              at: now(),
            })
            conversation.messages.push({
              id: uid('msg'),
              role: 'system',
              content: '本轮已停止，已生成内容已保留。待发队列已暂停，可继续此轮或恢复队列。',
              at: now(),
            })
            conversation.lastStopped = preservedInput(active)
            conversation.active = null
            conversation.queuePaused = true
            continue
          }
          const tick = Date.now()
          const elapsed = Math.max(0, Math.min(tick - active.lastTick, 1500))
          active.lastTick = tick
          if (!draft.connected || agent.status !== 'online') {
            task.logs = [
              ...task.logs.filter((log) => !String(log).startsWith('等待恢复：')),
              `等待恢复：${!draft.connected ? '中心连接中断' : 'Agent 离线'}。`,
            ]
            continue
          }
          active.elapsed += elapsed
          task.elapsed = active.elapsed
          task.progress = Math.min(99, Math.floor((active.elapsed / active.duration) * 100))
          if (active.elapsed < active.duration) continue
          const response = active.response
          const shared = agent.sharing === 'project'
          const files = response.files.map((file) => ({ ...file, savedToProject: shared }))
          if (
            agent.kind === 'platform' &&
            conversation.environmentId &&
            response.steps.some((step) => step.name === 'mcp.resources.connect')
          ) {
            for (const snapshot of active.resourceSnapshot) {
              const resource = project.resources.find(
                (item) =>
                  item.id === snapshot.id &&
                  item.host === snapshot.host &&
                  item.port === snapshot.port,
              )
              if (resource) resource.status = response.status === 'failed' ? 'failed' : 'connected'
            }
          }
          if (shared) project.artifacts.unshift(...files.map((file) => ({ ...file })))
          conversation.messages.push({
            id: uid('msg'),
            role: 'assistant',
            content: response.content,
            steps: response.steps,
            citations: response.citations,
            files,
            clarification: response.clarification,
            taskId: active.taskId,
            contextSnapshot: {
              startedAt: active.startedAt,
              environmentId: conversation.environmentId,
              environmentName: active.environmentName,
              sourceArtifactId: conversation.sourceArtifactId,
              sourceMode: conversation.sourceMode,
              scopeIds: [...(conversation.scopeIds || [])],
              resources: structuredClone(active.resourceSnapshot),
            },
            at: now(),
          })
          conversation.pendingClarification = response.clarification || null
          conversation.lastFailed = response.status === 'failed' ? preservedInput(active) : null
          if (response.status === 'failed') conversation.queuePaused = true
          task.status = response.status
          task.progress = 100
          task.completedAt = now()
          task.logs.push(
            ...response.steps.map((step) => `${step.name}: ${step.result}`),
            shared && files.length ? '报告已保存至项目制品。' : '本轮处理结束。',
          )
          draft.notifications.unshift({
            id: uid('notice'),
            projectId: project.id,
            agentId: agent.id,
            title: `${agent.name}：${response.status === 'failed' ? '处理失败' : '回复已完成'}`,
            createdAt: now(),
            readBy: [],
          })
          draft.audit.unshift({
            id: uid('audit'),
            projectId: project.id,
            agentId: agent.id,
            actorId: active.actorId,
            action: 'Agent 分析任务',
            object: conversation.title,
            result: response.status === 'failed' ? '失败' : '完成',
            createdAt: now(),
          })
          conversation.active = null
        }
      })
    }, 550)
    return () => clearInterval(timer)
  }, [])
}

export function AgentsPage() {
  const { state, user, project, projectId, update, audit, canUseAgent, navigate } = useWorkbench()
  const [editing, setEditing] = useState(null)
  const [pending, setPending] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [query, setQuery] = useState('')
  const agents = state.agents.filter(
    (agent) =>
      agent.kind === 'platform' &&
      (agentCanManage(agent, user) || canUseAgent(agent, projectId)) &&
      `${agent.name} ${agent.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  const startEdit = (agent) => {
    if (user.role !== 'admin' || (agent && agent.kind !== 'platform')) return
    setEditing(
      agent
        ? { ...agent }
        : {
            id: null,
            name: '',
            description: '',
            kind: 'platform',
            ownerId: user.id,
            sharing: 'private',
            projectId: null,
            status: 'online',
            instructions: '',
            runtime: '内置只读运行时',
            model: '演示推理模型',
            supportsImages: true,
            supportsDocuments: true,
          },
    )
  }
  const saveAgent = (values) => {
    if (user.role !== 'admin' || values.kind !== 'platform') return
    const old = values.id && state.agents.find((agent) => agent.id === values.id)
    const id = values.id || uid('agent')
    update((draft) => {
      if (old)
        Object.assign(
          draft.agents.find((agent) => agent.id === id),
          values,
        )
      else draft.agents.push({ ...values, id })
    })
    audit({
      projectId,
      agentId: id,
      action: old ? '更新 Agent 配置' : '创建 Agent',
      object: values.name,
    })
    setEditing(null)
    setPending(null)
    toast.success('Agent 配置已保存')
  }
  const prepareSave = () => {
    if (user.role !== 'admin' || editing?.kind !== 'platform') return
    if (!editing.name.trim()) return toast.error('请输入 Agent 名称')
    if (editing.kind === 'platform' && !editing.instructions.trim())
      return toast.error('请填写角色指令')
    if (editing.sharing === 'project' && !editing.projectId) return toast.error('请选择共享项目')
    const historyProjects = [
      ...new Set(
        state.conversations
          .filter((conversation) => conversation.agentId === editing.id)
          .map((conversation) => conversation.projectId),
      ),
    ]
    if (editing.sharing === 'project' && historyProjects.some((id) => id !== editing.projectId))
      return toast.error(
        '已有会话属于其他项目，不能跨项目共享历史。请创建新的 Agent，并共享到目标项目。',
      )
    const values = {
      ...editing,
      name: editing.name.trim(),
      projectId: editing.sharing === 'project' ? editing.projectId : null,
    }
    const old = editing.id && state.agents.find((agent) => agent.id === editing.id)
    if (old && (old.sharing !== values.sharing || old.projectId !== values.projectId))
      return setPending({ values, old })
    saveAgent(values)
  }
  const count = pending
    ? state.conversations.filter((conversation) => conversation.agentId === pending.old.id).length
    : 0
  const projectOptions = Object.values(state.projects)
    .filter((item) => item.memberIds.includes(user.id) || user.role === 'admin')
    .map((item) => ({ value: item.id, label: item.name }))
  return (
    <div className="wb-page">
      <PageHeader title="Agent">
        <Button variant="outline" onClick={() => navigate(`/p/${projectId}/chat`)}>
          <ArrowLeft size={15} />
          返回对话
        </Button>
        {user.role === 'admin' && (
          <Button onClick={() => startEdit(null)}>
            <Plus size={16} />
            创建 Agent
          </Button>
        )}
      </PageHeader>
      <Input
        aria-label="搜索 Agent"
        placeholder="搜索名称或描述"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <Panel title="可用 Agent">
        {!agents.length && <Empty>还没有可用的 Agent。</Empty>}
        {agents.map((agent) => (
          <div className="wb-agent-config-row" key={agent.id}>
            <div>
              <div className="wb-row">
                <Bot size={18} />
                <strong>{agent.name}</strong>
                <Badge variant={agent.status === 'online' ? 'secondary' : 'outline'}>
                  {agent.status === 'online' ? '在线' : '离线'}
                </Badge>
                <Badge variant="outline">平台 Agent</Badge>
              </div>
              <p>{agent.description || '未填写描述'}</p>
              <p>{visibilityName(agent, state)} · 只读分析与报告</p>
            </div>
            <div className="wb-row">
              {canUseAgent(agent, projectId) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    sessionStorage.setItem('wb:v2:preferred-agent', agent.id)
                    navigate(`/p/${projectId}/chat`)
                  }}
                >
                  <MessageSquare size={15} />
                  会话
                  <ArrowUpRight size={14} />
                </Button>
              )}
              {agentCanManage(agent, user) && (
                <>
                  <Button variant="outline" onClick={() => startEdit(agent)}>
                    配置
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      update((draft) => {
                        const item = draft.agents.find((item) => item.id === agent.id)
                        item.status = item.status === 'online' ? 'offline' : 'online'
                      })
                      toast.success(
                        agent.status === 'online'
                          ? '已模拟离线；进行中的会话会等待恢复'
                          : '已模拟重新连接',
                      )
                    }}
                  >
                    {agent.status === 'online' ? '模拟离线' : '模拟连接'}
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`删除 ${agent.name}`}
                    onClick={() => setRemoving(agent)}
                  >
                    <Trash2 size={16} />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </Panel>
      <Modal
        title={editing?.id ? '配置 Agent' : '创建 Agent'}
        open={!!editing}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={prepareSave}>保存</Button>
          </>
        }
      >
        {editing && (
          <div className="wb-stack">
            <Field label="名称">
              <Input
                aria-label="Agent 名称"
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </Field>
            <Field label="描述">
              <Textarea
                aria-label="Agent 描述"
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </Field>
            <Field label="角色指令">
              <Textarea
                aria-label="角色指令"
                rows={4}
                value={editing.instructions}
                onChange={(event) => setEditing({ ...editing, instructions: event.target.value })}
              />
            </Field>
            <div className="wb-form-grid">
              <Field label="运行时">
                <Picker
                  label="运行时"
                  value={editing.runtime}
                  onChange={(runtime) => setEditing({ ...editing, runtime })}
                  options={[{ value: '内置只读运行时', label: '内置只读运行时（模拟）' }]}
                />
              </Field>
              <Field label="模型名称">
                <Input
                  aria-label="模型名称"
                  value={editing.model || ''}
                  onChange={(event) => setEditing({ ...editing, model: event.target.value })}
                />
              </Field>
            </div>
            <p className="wb-muted">
              平台能力固定为问答、预置 MCP 只读查询、分析与报告。角色指令不能授予外部写入权限。
            </p>
            <Field label="共享范围">
              <Picker
                label="共享范围"
                value={editing.sharing}
                onChange={(sharing) =>
                  setEditing({
                    ...editing,
                    sharing,
                    projectId: sharing === 'project' ? projectId : null,
                  })
                }
                options={[
                  { value: 'private', label: '私有 · 仅我的账号' },
                  { value: 'project', label: '指定项目的成员' },
                ]}
              />
            </Field>
            {editing.sharing === 'project' && (
              <>
                <Field label="共享项目">
                  <Picker
                    label="共享项目"
                    value={editing.projectId || projectId}
                    options={projectOptions}
                    onChange={(id) => setEditing({ ...editing, projectId: id })}
                  />
                </Field>
                <p className="wb-muted">
                  已有会话保持原项目归属。若此 Agent 已在其他项目产生会话，请创建新的 Agent
                  共享到目标项目，避免带出其他项目资料。
                </p>
              </>
            )}
          </div>
        )}
      </Modal>
      <Confirm
        title="更改 Agent 与历史会话的可见范围"
        open={!!pending}
        onClose={() => setPending(null)}
        onConfirm={() => saveAgent(pending.values)}
        confirmLabel="确认更改共享范围"
      >
        {pending && (
          <div className="wb-stack">
            <p>
              将从「{visibilityName(pending.old, state)}」变为「
              {visibilityName(pending.values, state)}」。
            </p>
            <p>
              此 Agent 的 {count}{' '}
              个已有会话及对应任务、通知会立即按新范围显示。私有改共享会让指定项目成员看到旧会话的消息和附件；改为私有会收回其他成员的会话访问权限。
            </p>
            <p>
              已经显式或自动保存到项目的制品仍属于项目，不会随会话收回。尚未保存的历史文件跟随会话可见性。
            </p>
          </div>
        )}
      </Confirm>
      <Confirm
        title="删除 Agent"
        open={!!removing}
        danger
        onClose={() => setRemoving(null)}
        confirmLabel="删除 Agent"
        onConfirm={() => {
          if (
            state.conversations.some(
              (conversation) => conversation.agentId === removing.id && conversation.active,
            )
          )
            return toast.error('请先停止此 Agent 的进行中会话')
          if (state.conversations.some((conversation) => conversation.agentId === removing.id))
            return toast.error('请先在会话页面手动清理历史会话，再删除 Agent')
          update((draft) => {
            draft.agents = draft.agents.filter((agent) => agent.id !== removing.id)
          })
          audit({ projectId, agentId: removing.id, action: '删除 Agent', object: removing.name })
          setRemoving(null)
        }}
      >
        <p>将移除此平台 Agent 的配置；存在会话时需要先清理会话。</p>
      </Confirm>
    </div>
  )
}

export function ChatPage() {
  const {
    state,
    user,
    project,
    projectId,
    update,
    audit,
    canUseAgent,
    canViewAgent,
    navigate,
    stopTask,
    route,
  } = useWorkbench()
  const available = state.agents.filter(
    (agent) => agent.kind === 'platform' && canUseAgent(agent, projectId),
  )
  const conversations = state.conversations.filter(
    (conversation) =>
      conversation.projectId === projectId &&
      state.agents.some(
        (agent) => agent.id === conversation.agentId && agent.kind === 'platform',
      ) &&
      canViewAgent(conversation.agentId, projectId),
  )
  const [newChat, setNewChat] = useState(null)
  const [scenario, setScenario] = useState('normal')
  const [preview, setPreview] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [saveFile, setSaveFile] = useState(null)
  const [query, setQuery] = useState('')
  const [editingQueued, setEditingQueued] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [demoOpen, setDemoOpen] = useState(false)
  const [clarification, setClarification] = useState('')
  const [inspectedMessageId, setInspectedMessageId] = useState(null)
  const [atBottom, setAtBottom] = useState(true)
  const fileInput = useRef(null)
  const scroller = useRef(null)
  const followLatest = useRef(true)
  const readingPositions = useRef(new Map())
  const composing = useRef(false)
  const preparedLink = useRef('')
  const routeParams = new URLSearchParams(route.split('?')[1] || '')
  const selectedId = routeParams.get('conversation')
  const selected = selectedId
    ? conversations.find((conversation) => conversation.id === selectedId)
    : conversations[0]
  const agent = state.agents.find((agent) => agent.id === selected?.agentId)
  const { input, setInput, attachments, setAttachments, loadingFiles, attachFiles, clearDraft } =
    useConversationDraft({
      userId: user.id,
      projectId,
      conversationId: selected?.id,
      agent,
      onError: (message) => toast.error(message),
    })
  const newAgent = state.agents.find((agent) => agent.id === newChat?.agentId)
  const sourceArtifacts = project.artifacts.filter(
    (artifact) =>
      isAlive(artifact) &&
      (newChat?.sourceMode === 'raw'
        ? ['source', 'stripped'].includes(artifact.type)
        : artifact.type === 'sanitized'),
  )
  const docs = project.documents.filter((doc) => !doc.deleted)
  const selectableScope = [
    ...docs,
    ...project.artifacts
      .filter((artifact) => isAlive(artifact) && ['report', 'file'].includes(artifact.type))
      .map((artifact) => ({ ...artifact, scopeArtifact: true })),
  ]
  const isShared = agent?.sharing === 'project'
  const selectConversation = (id) => {
    navigate(`/p/${projectId}/chat?conversation=${encodeURIComponent(id)}`)
    setHistoryOpen(false)
  }
  const openNew = (preferred, overrides = {}) => {
    const nextAgent =
      available.find((agent) => agent.id === preferred) ||
      available.find((agent) => agent.status === 'online') ||
      available[0]
    setNewChat({
      agentId: nextAgent?.id || '',
      environmentId: 'none',
      title: '',
      sourceMode: 'sanitized',
      sourceArtifactId:
        project.artifacts.find((artifact) => artifact.type === 'sanitized' && isAlive(artifact))
          ?.id || '',
      scopeIds: [],
      scopeMode: 'auto',
      ...overrides,
    })
    setHistoryOpen(false)
  }
  useEffect(() => {
    const params = new URLSearchParams(route.split('?')[1] || '')
    const artifactId = params.get('artifact')
    const documentId = params.get('document')
    const requestedAgentId = params.get('agent')
    const linkKey = `${projectId}:${artifactId || ''}:${documentId || ''}:${requestedAgentId || ''}`
    if ((artifactId || documentId) && preparedLink.current !== linkKey) {
      preparedLink.current = linkKey
      const platform = available.find(
        (item) => item.kind === 'platform' && item.status === 'online',
      )
      const item = artifactId
        ? project.artifacts.find((item) => item.id === artifactId && isAlive(item))
        : project.documents.find((item) => item.id === documentId && !item.deleted)
      if (!item) {
        toast.error('引用资料已删除或尚未就绪，请重新选择')
        openNew(platform?.id, { contextNotice: '此链接的资料不可用，请选择有效的会话上下文。' })
      } else if (artifactId && ['source', 'stripped', 'sanitized'].includes(item.type)) {
        const raw = item.type !== 'sanitized'
        openNew(platform?.id, {
          agentId: platform?.id || '',
          sourceMode: raw ? 'raw' : 'sanitized',
          sourceArtifactId: item.id,
          contextNotice: `将使用${raw ? '原始源码' : '脱敏源码'}：${item.name}`,
          requiresRawConfirmation: raw,
          rawConfirmed: false,
          requirePlatform: true,
        })
      } else if (documentId || ['report', 'file'].includes(item.type)) {
        openNew(platform?.id, {
          agentId: platform?.id || '',
          scopeMode: 'selected',
          scopeIds: [item.id],
          sourceMode: 'none',
          contextNotice: `将引用${item.kind === 'folder' ? '文件夹' : artifactId ? '制品' : '文档'}：${item.name}`,
          requirePlatform: true,
        })
      } else {
        openNew(platform?.id, {
          contextNotice: '请先选择压缩包的来源源码或解压后的文件；不会自动将压缩包作为源码发送。',
        })
      }
      return
    }
    if (requestedAgentId && preparedLink.current !== linkKey) {
      preparedLink.current = linkKey
      if (available.some((item) => item.id === requestedAgentId)) openNew(requestedAgentId)
      else toast.error('此 Agent 不存在或未共享给当前项目')
      return
    }
    if (!artifactId && !documentId && !requestedAgentId) preparedLink.current = ''
    const preferred = sessionStorage.getItem('wb:v2:preferred-agent')
    if (preferred) {
      sessionStorage.removeItem('wb:v2:preferred-agent')
      if (available.some((item) => item.id === preferred)) openNew(preferred)
      else toast.error('此 Agent 不存在或未共享给当前项目')
    }
  }, [projectId, route])
  useLayoutEffect(() => {
    setInspectedMessageId(null)
    setClarification('')
    setEditingQueued(null)
    const position = readingPositions.current.get(selected?.id)
    followLatest.current = position?.follow ?? true
    setAtBottom(followLatest.current)
    if (scroller.current)
      scroller.current.scrollTop = followLatest.current
        ? scroller.current.scrollHeight
        : position.top
  }, [selected?.id])
  useLayoutEffect(() => {
    if (followLatest.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight
  }, [
    selected?.messages.length,
    selected?.active?.elapsed,
    selected?.queue?.length,
    input,
    attachments,
  ])
  useEffect(() => {
    const content = scroller.current?.querySelector('.wb-chat-message-column')
    if (!content) return
    const observer = new ResizeObserver(() => {
      if (followLatest.current && scroller.current)
        scroller.current.scrollTop = scroller.current.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [selected?.id])
  const createConversation = () => {
    if (newAgent?.kind !== 'platform' || !canUseAgent(newAgent, projectId))
      return toast.error('请选择有使用权限的 Agent')
    if (newAgent.status !== 'online')
      return toast.error('Agent 离线，请选择在线 Agent。不会自动路由或排队等待。')
    if (newChat.sourceMode === 'raw' && newChat.requiresRawConfirmation && !newChat.rawConfirmed)
      return toast.error('请明确确认使用链接指定的原始源码')
    if (
      newAgent.kind === 'platform' &&
      newChat.sourceMode !== 'none' &&
      !sourceArtifacts.some((item) => item.id === newChat.sourceArtifactId)
    )
      return toast.error(
        newChat.sourceMode === 'sanitized'
          ? '请先准备脱敏制品，或明确选择仅文档 / 原始源码'
          : '请选择一份可用的原始源码制品',
      )
    if (
      newAgent.kind === 'platform' &&
      newChat.scopeMode === 'selected' &&
      !newChat.scopeIds.length
    )
      return toast.error('请至少选择一份文档或一个文件夹')
    const id = uid('conversation')
    update((draft) => {
      draft.conversations.unshift({
        id,
        projectId,
        agentId: newAgent.id,
        creatorId: user.id,
        environmentId:
          newAgent.kind === 'platform' && newChat.environmentId !== 'none'
            ? newChat.environmentId
            : null,
        title: newChat.title.trim() || `${newAgent.name} · 新会话`,
        createdAt: now(),
        sourceMode: newAgent.kind === 'platform' ? newChat.sourceMode : 'none',
        sourceArtifactId:
          newAgent.kind === 'platform' && newChat.sourceMode !== 'none'
            ? newChat.sourceArtifactId
            : null,
        scopeIds:
          newAgent.kind === 'platform' && newChat.scopeMode === 'selected' ? newChat.scopeIds : [],
        messages: [],
        queue: [],
      })
    })
    selectConversation(id)
    setNewChat(null)
    toast.success('已创建会话，Agent 和环境已固定')
  }
  const send = (
    content = input,
    selectedScenario = scenario,
    mode = 'queue',
    originalInput = null,
  ) => {
    if (!selected || agent?.kind !== 'platform') return
    const files = originalInput?.attachments || attachments
    if (!originalInput && loadingFiles) return toast.error('附件仍在读取，请完成后再发送')
    if (!content.trim() && !files.length) return toast.error('请输入问题或添加附件')
    if (mode === 'steer' && files.length)
      return toast.error('这轮先验证文字引导；带附件的消息请排队到下一轮')
    if (!canUseAgent(agent, projectId))
      return toast.error('此 Agent 的共享范围已变化，请重新选择会话')
    if (agent.status !== 'online')
      return toast.error(
        'Agent 已离线。本条消息未提交，也不会排队等待；请选择在线 Agent 新建会话。',
      )
    if (!state.connected) return toast.error('中心连接已中断，请恢复连接后重试；本条消息未提交')
    if (
      selected.environmentId &&
      !project.environments.some((environment) => environment.id === selected.environmentId)
    )
      return toast.error('此会话的固定环境已删除，请新建会话选择环境；不会自动切换环境')
    if (
      agent.kind === 'platform' &&
      selected.sourceMode !== 'none' &&
      !project.artifacts.some(
        (artifact) => artifact.id === selected.sourceArtifactId && isAlive(artifact),
      )
    )
      return toast.error(
        '此会话引用的源码制品已删除。请新建会话选择其他制品；不会自动回退到原始源码。',
      )
    if (
      files.some((file) =>
        file.mime.startsWith('image/') ? !agent.supportsImages : !agent.supportsDocuments,
      )
    )
      return toast.error('此 Agent 不支持当前附件类型，请移除不支持的附件')
    let outcome = ''
    update((draft) => {
      const conversation = draft.conversations.find((item) => item.id === selected.id)
      if (!conversation) return
      const message = {
        id: uid('queued'),
        content: content.trim() || '请分析附件',
        attachments: structuredClone(files),
        actorId: user.id,
        scenario: selectedScenario,
        createdAt: now(),
      }
      if (mode === 'steer') {
        if (steerTurn(draft, conversation, message, selected.active?.id)) outcome = 'steer'
        return
      }
      if (
        conversation.active ||
        (conversation.queue?.length &&
          !conversation.queuePaused &&
          !conversation.pendingClarification &&
          mode !== 'clarify')
      ) {
        conversation.queue.push(message)
        outcome = 'queue'
      } else {
        beginTurn(draft, conversation, message)
        outcome = 'start'
      }
      if (
        conversation.messages.filter((message) => message.role === 'user').length <= 1 &&
        conversation.title.endsWith('新会话')
      )
        conversation.title = message.content.slice(0, 32)
    })
    if (!outcome) return toast.error('当前轮已结束或正在停止，输入已保留；可作为下一轮发送')
    if (!originalInput) clearDraft()
    setScenario('normal')
    setClarification('')
    if (outcome === 'queue') toast.success('已加入队列，当前轮继续执行')
    if (outcome === 'steer') toast.success('已加入当前轮（交互演示）')
  }
  const replay = (value) => {
    const original = typeof value === 'string' ? { content: value, attachments: [] } : value
    send(original.content, 'normal', 'resume', original)
  }
  const updateQueue = (action, queued) => {
    if (!selected || !canUseAgent(agent, projectId)) return
    if (action === 'steer' && (!state.connected || agent.status !== 'online'))
      return toast.error('连接不可用，排队消息已保留')
    if (action === 'steer' && queued.attachments?.length)
      return toast.error('带附件的排队消息暂不支持引导')
    let changed = false
    update((draft) => {
      const conversation = draft.conversations.find((item) => item.id === selected.id)
      const current = conversation?.queue.find((item) => item.id === queued.id)
      if (!current) return
      if (action === 'steer') {
        if (!steerTurn(draft, conversation, { ...current, actorId: user.id }, selected.active?.id))
          return
      } else if (action === 'edit') {
        current.content = queued.content.trim()
        changed = true
        return
      }
      conversation.queue = conversation.queue.filter((item) => item.id !== queued.id)
      changed = true
    })
    if (!changed) toast.error('消息或当前轮状态已变化，队列内容已保留，请重新查看')
    return changed
  }
  const stop = () => {
    if (selected?.active) stopTask(selected.active.taskId)
  }
  const renderFile = (file, allowSave = false) => {
    const saved = file.savedToProject
    const artifact = project.artifacts.find((item) => item.id === file.id)
    const deleted = saved && (!artifact || artifact.deleted)
    return (
      <div className="wb-chat-attachment" key={file.id || file.name}>
        {file.mime?.startsWith('image/') ? (
          <img src={file.dataUrl} alt={file.name} />
        ) : (
          <span className="wb-chat-file-icon">
            <FileText size={19} />
          </span>
        )}
        <span className="wb-chat-file-label">
          <strong>{file.name}</strong>
          <small>
            {deleted
              ? '项目制品已删除'
              : saved
                ? '已保存到项目'
                : file.size
                  ? `${Math.max(1, Math.ceil(file.size / 1024))} KB`
                  : `${file.name.split('.').at(-1)?.toUpperCase()} · 已生成`}
          </small>
        </span>
        {!deleted && (
          <>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`预览 ${file.name}`}
              onClick={() => setPreview(file)}
            >
              <Eye size={15} />
              <span className="sr-only">预览</span>
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`下载 ${file.name}`}
              onClick={() => downloadChatFile(file)}
            >
              <Download size={16} />
            </Button>
          </>
        )}
        {allowSave && !saved && (
          <Button variant="outline" size="sm" onClick={() => setSaveFile(file)}>
            存入项目
          </Button>
        )}
      </div>
    )
  }
  const renderCitations = (citations) =>
    citations?.length > 0 && (
      <div className="wb-chat-citations">
        {citations.map((citation, index) => {
          const current =
            citation.kind === 'artifact'
              ? project.artifacts.find((item) => item.id === citation.id)
              : project.documents.find((item) => item.id === citation.id)
          const deleted = citation.id && (!current || current.deleted)
          return (
            <Button
              key={`${citation.id || index}`}
              variant="outline"
              size="sm"
              onClick={() =>
                setPreview({
                  name: citation.label,
                  content: deleted
                    ? `此引用的${citation.kind === 'artifact' ? '制品' : '文档'}已删除。以下为会话中的历史引用摘录：\n\n${citation.excerpt}`
                    : citation.excerpt,
                  mime: 'text/plain',
                })
              }
            >
              <FileText size={13} /> {citation.label}
              {deleted ? '（已删除）' : ''}
              <ArrowUpRight size={11} />
            </Button>
          )
        })}
      </div>
    )
  const renderSteps = (steps, progress = 1) => {
    if (!steps?.length) return null
    const shown = steps.slice(0, Math.max(1, Math.ceil(steps.length * progress)))
    const failed = shown.some((step) => step.status === 'failed' || step.status === 'blocked')
    return (
      <Accordion type="single" collapsible className="wb-chat-process">
        <AccordionItem value="process">
          <AccordionTrigger className="wb-chat-process-trigger">
            <span className="wb-chat-process-summary">
              {failed ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}
              <span>{failed ? '存在未完成步骤' : progress < 1 ? '正在处理' : '处理完成'}</span>
              <span className="wb-chat-process-count">{shown.length} 个步骤</span>
            </span>
            <span className="wb-chat-process-expand">展开过程</span>
          </AccordionTrigger>
          <AccordionContent className="wb-chat-process-content">
            {shown.map((step, index) => (
              <div className="wb-chat-tool-step" key={`${step.name}-${index}`}>
                <div className="wb-chat-tool-title">
                  {step.status === 'failed' || step.status === 'blocked' ? (
                    <CircleAlert size={14} />
                  ) : (
                    <Check size={14} />
                  )}
                  <strong>{toolNames[step.name] || '执行工具'}</strong>
                  <span>
                    {step.status === 'failed'
                      ? '失败'
                      : step.status === 'blocked'
                        ? '未执行'
                        : '完成'}
                  </span>
                </div>
                <p>{step.result}</p>
                <Accordion type="single" collapsible>
                  <AccordionItem value="details">
                    <AccordionTrigger className="wb-chat-tool-details-trigger">
                      参数与结果详情
                    </AccordionTrigger>
                    <AccordionContent>
                      <code className="wb-chat-tool-name">{step.name}</code>
                      <pre className="wb-code">{JSON.stringify(step.args, null, 2)}</pre>
                      <p>{step.result}</p>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            ))}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    )
  }
  const activeProgress = selected?.active
    ? Math.min(1, selected.active.elapsed / selected.active.duration)
    : 0
  const inspectedMessage =
    selected?.messages.find((message) => message.id === inspectedMessageId) ||
    selected?.messages.filter((message) => message.role === 'assistant').at(-1)
  const followingActive = !inspectedMessageId && selected?.active
  const contextResponse = followingActive ? selected.active.response : inspectedMessage
  const contextSnapshot = followingActive
    ? {
        startedAt: selected.active.startedAt,
        environmentId: selected.environmentId,
        environmentName: selected.active.environmentName,
        sourceArtifactId: selected.sourceArtifactId,
        sourceMode: selected.sourceMode,
        resources: selected.active.resourceSnapshot,
      }
    : inspectedMessage?.contextSnapshot
  const contextCitations = contextResponse?.citations || []
  const source = project.artifacts.find(
    (item) => item.id === (contextSnapshot?.sourceArtifactId || selected?.sourceArtifactId),
  )
  const sourceStep = contextResponse?.steps?.find((step) => step.name === 'artifact.source.read')
  const messageIndex =
    selected?.messages.findIndex((message) => message.id === inspectedMessage?.id) ?? -1
  const contextAttachments = followingActive
    ? selected.active.attachments
    : selected?.messages
        .slice(0, messageIndex + 1)
        .filter((message) => message.role === 'user')
        .at(-1)?.attachments || []
  const contextFiles = followingActive ? [] : inspectedMessage?.files || []
  const sessionEnvironmentName =
    project.environments.find((item) => item.id === selected?.environmentId)?.name ||
    (selected?.environmentId ? '环境已删除' : '无环境')
  const environmentName = contextSnapshot?.environmentName || sessionEnvironmentName
  const scopeDocuments = selected && agent?.kind === 'platform' ? agentScope(project, selected) : []
  const scopeArtifacts =
    selected && agent?.kind === 'platform'
      ? project.artifacts.filter(
          (artifact) =>
            isAlive(artifact) &&
            ['report', 'file'].includes(artifact.type) &&
            selected.scopeIds?.includes(artifact.id),
        )
      : []
  const historyGroups = [
    {
      label: '今天',
      items: conversations.filter(
        (item) => new Date(lastActivity(item)).toDateString() === new Date().toDateString(),
      ),
    },
    {
      label: '更早',
      items: conversations.filter(
        (item) => new Date(lastActivity(item)).toDateString() !== new Date().toDateString(),
      ),
    },
  ].map((group) => ({
    ...group,
    items: group.items
      .filter((item) => item.title.includes(query))
      .sort((a, b) => new Date(lastActivity(b)) - new Date(lastActivity(a))),
  }))
  const copyMessage = async (message) => {
    try {
      await navigator.clipboard.writeText(message.content)
      toast.success('已复制回复')
    } catch {
      toast.error('复制失败，请选择内容后复制')
    }
  }
  const previewCitation = (citation) => {
    const current =
      citation.kind === 'artifact'
        ? project.artifacts.find((item) => item.id === citation.id)
        : project.documents.find((item) => item.id === citation.id)
    const missing = citation.id && (!current || current.deleted)
    setPreview({
      name: citation.label,
      mime: 'text/plain',
      content: `${missing ? '资料已删除，以下为本轮保存的引用摘录。\n\n' : ''}${citation.excerpt || current?.content || ''}`,
    })
  }
  const historyPanel = (
    <div className="wb-chat-history-inner">
      <Button className="wb-chat-new" variant="outline" onClick={() => openNew()}>
        <Plus size={16} />
        新建会话
      </Button>
      <div className="wb-chat-search">
        <Search size={15} />
        <Input
          aria-label="搜索会话标题"
          placeholder="搜索会话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="wb-agent-list">
        {historyGroups.map(
          (group) =>
            group.items.length > 0 && (
              <section className="wb-chat-history-group" key={group.label}>
                <h2>{group.label}</h2>
                {group.items.map((conversation) => {
                  const ownerAgent = state.agents.find((item) => item.id === conversation.agentId)
                  return (
                    <Button
                      key={conversation.id}
                      variant="ghost"
                      className={`wb-conversation-button ${conversation.id === selected?.id ? 'is-selected' : ''}`}
                      onClick={() => selectConversation(conversation.id)}
                    >
                      <MessageSquare size={15} />
                      <span className="wb-chat-history-text">
                        <strong>{conversation.title}</strong>
                        <small>
                          {conversation.active
                            ? '处理中'
                            : ownerAgent?.sharing === 'private'
                              ? '私有'
                              : '项目共享'}{' '}
                          · {ownerAgent?.name}
                        </small>
                      </span>
                      <time>{chatTime(lastActivity(conversation))}</time>
                    </Button>
                  )
                })}
              </section>
            ),
        )}
        {!historyGroups.some((group) => group.items.length) && (
          <Empty>{query ? '没有匹配的会话' : '还没有可见的会话'}</Empty>
        )}
      </div>
      <Button
        className="wb-chat-manage"
        variant="ghost"
        onClick={() => navigate(`/p/${projectId}/agents`)}
      >
        <Settings2 size={15} />
        管理 Agent
        <ArrowUpRight size={13} />
      </Button>
    </div>
  )
  const contextPanel = (
    <div className="wb-chat-context-inner">
      <div className="wb-chat-context-heading">
        <h2>{followingActive ? '本轮上下文' : inspectedMessage ? '本轮上下文' : '会话上下文'}</h2>
        {inspectedMessageId && (
          <Button variant="ghost" size="sm" onClick={() => setInspectedMessageId(null)}>
            跟随最新
          </Button>
        )}
      </div>
      {selected && agent ? (
        <>
          <dl className="wb-chat-facts">
            <div>
              <dt>Agent</dt>
              <dd>{agent.name}</dd>
            </div>
            <div>
              <dt>可见范围</dt>
              <dd>{isShared ? '项目成员' : '仅本人'}</dd>
            </div>
            <div>
              <dt>环境</dt>
              <dd>{environmentName}</dd>
            </div>
            <div>
              <dt>源码</dt>
              <dd>
                {selected.sourceMode === 'none'
                  ? '仅项目文档'
                  : source?.deleted
                    ? '制品已删除'
                    : source?.name || '制品不可用'}
              </dd>
            </div>
            {(sourceStep?.args.commit || source?.commit) && (
              <div>
                <dt>提交</dt>
                <dd className="wb-chat-commit">
                  {(sourceStep?.args.commit || source.commit).slice(0, 8)}
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="复制上下文提交号"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(sourceStep?.args.commit || source.commit)
                        .then(() => toast.success('已复制提交号'))
                        .catch(() => toast.error('复制失败'))
                    }
                  >
                    <Copy size={12} />
                  </Button>
                </dd>
              </div>
            )}
            <div>
              <dt>源码策略</dt>
              <dd>
                {selected.sourceMode === 'raw'
                  ? '显式使用原始源码'
                  : selected.sourceMode === 'none'
                    ? '不读取源码'
                    : '脱敏源码'}
              </dd>
            </div>
            {contextSnapshot?.startedAt ? (
              <div>
                <dt>本轮开始</dt>
                <dd>{chatTime(contextSnapshot.startedAt)}</dd>
              </div>
            ) : (
              <div>
                <dt>配置依据</dt>
                <dd>会话当前配置</dd>
              </div>
            )}
          </dl>
          {agent.kind === 'platform' && (
            <section className="wb-chat-context-section">
              <h3>{contextCitations.length ? '资料引用' : '资料范围'}</h3>
              {contextCitations.length ? (
                contextCitations.map((citation, index) => (
                  <Button
                    variant="ghost"
                    className="wb-chat-context-file"
                    key={citation.id || index}
                    onClick={() => previewCitation(citation)}
                  >
                    <FileText size={15} />
                    <span>{citation.label}</span>
                    <ArrowUpRight size={12} />
                  </Button>
                ))
              ) : scopeDocuments.length || scopeArtifacts.length ? (
                <>
                  <p className="wb-chat-context-note">
                    {selected.scopeIds?.length ? '已指定范围' : '自动检索'} ·{' '}
                    {scopeDocuments.length + scopeArtifacts.length} 份资料
                  </p>
                  {scopeDocuments.map((document) => (
                    <Button
                      key={document.id}
                      variant="ghost"
                      className="wb-chat-context-file"
                      onClick={() =>
                        setPreview({ ...document, mime: document.mime || 'text/plain' })
                      }
                    >
                      <FileText size={15} />
                      <span>{document.name}</span>
                    </Button>
                  ))}
                  {scopeArtifacts.map((artifact) => (
                    <Button
                      key={artifact.id}
                      variant="ghost"
                      className="wb-chat-context-file"
                      onClick={() => setPreview(artifact)}
                    >
                      <FileText size={15} />
                      <span>{artifact.name}</span>
                    </Button>
                  ))}
                </>
              ) : (
                <p className="wb-chat-context-note">暂无匹配资料</p>
              )}
            </section>
          )}
          {agent.kind === 'platform' && contextSnapshot?.resources?.length > 0 && (
            <section className="wb-chat-context-section">
              <h3>本轮资源快照</h3>
              {contextSnapshot.resources.map((resource) => (
                <div className="wb-chat-resource" key={resource.id}>
                  <span>{resource.name}</span>
                  <small>
                    {resource.type} · {resource.host}:{resource.port}
                  </small>
                </div>
              ))}
            </section>
          )}
          {contextAttachments.length > 0 && (
            <section className="wb-chat-context-section">
              <h3>显式附件</h3>
              {contextAttachments.map((file) => (
                <Button
                  variant="ghost"
                  className="wb-chat-context-file"
                  key={file.id}
                  onClick={() => setPreview(file)}
                >
                  <Paperclip size={14} />
                  <span>{file.name}</span>
                </Button>
              ))}
            </section>
          )}
          <section className="wb-chat-context-section">
            <h3>本轮产物</h3>
            {contextFiles.length ? (
              contextFiles.map((file) => {
                const saved = file.savedToProject
                const artifact = project.artifacts.find((item) => item.id === file.id)
                const deleted = saved && (!artifact || artifact.deleted)
                return (
                  <Button
                    variant="ghost"
                    disabled={deleted}
                    className="wb-chat-context-file"
                    key={file.id}
                    onClick={() => setPreview(file)}
                  >
                    <FileText size={15} />
                    <span>
                      {file.name}
                      <small>{deleted ? '已删除' : saved ? '已保存到项目' : '会话文件'}</small>
                    </span>
                  </Button>
                )
              })
            ) : (
              <p className="wb-chat-context-note">
                {followingActive ? '处理完成后显示生成文件' : '本轮未生成文件'}
              </p>
            )}
          </section>
          <Button
            className="wb-chat-context-manage"
            variant="link"
            onClick={() => navigate(`/p/${projectId}/agents`)}
          >
            管理 Agent
            <ArrowUpRight size={13} />
          </Button>
        </>
      ) : (
        <p className="wb-chat-context-note">创建会话后显示使用的资料和环境。</p>
      )}
    </div>
  )
  return (
    <div className="wb-chat-page">
      <h1 className="sr-only">Agent 对话</h1>
      <Card className="wb-agent-workspace">
        <aside className="wb-chat-history" aria-label="历史会话">
          {historyPanel}
        </aside>
        <section className="wb-agent-chat">
          <header className="wb-chat-header">
            <div className="wb-chat-title-row">
              <Button
                className="wb-chat-history-trigger"
                variant="ghost"
                size="icon-sm"
                aria-label="打开历史会话"
                onClick={() => setHistoryOpen(true)}
              >
                <History size={18} />
              </Button>
              <h2>{selected?.title || (selectedId ? '会话不可用' : '新建会话')}</h2>
              <span className="wb-chat-demo-label">交互演示</span>
            </div>
            <div className="wb-chat-header-actions">
              {agent && (
                <div className="wb-chat-agent-identity">
                  <Button
                    variant="outline"
                    className="wb-chat-agent-selector"
                    aria-label="更换 Agent / 环境"
                    onClick={() => openNew(agent.id)}
                  >
                    <Bot size={16} />
                    <span>{agent.name}</span>
                    <i
                      className={`wb-chat-online ${agent.status !== 'online' ? 'is-offline' : ''}`}
                    />
                    <span className="wb-chat-online-label">
                      {agent.status === 'online' ? '在线' : '离线'}
                    </span>
                    <ChevronDown size={13} />
                  </Button>
                  <div className="wb-chat-agent-meta">
                    <span>平台 Agent</span>
                    <span>·</span>
                    <span>{isShared ? '项目共享' : '私有'}</span>
                    <span>·</span>
                    <span>{sessionEnvironmentName}</span>
                  </div>
                </div>
              )}
              <Button
                className="wb-chat-context-trigger"
                variant="ghost"
                size="icon-sm"
                aria-label="打开本轮上下文"
                onClick={() => setContextOpen(true)}
              >
                <PanelRight size={18} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="会话更多操作">
                    <MoreHorizontal size={18} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => openNew(agent?.id)}>
                    <Plus />
                    新建会话
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDemoOpen(true)}>
                    <SlidersHorizontal />
                    演示场景
                  </DropdownMenuItem>
                  {selected && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleting(selected)}
                      >
                        <Trash2 />
                        删除会话
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          {selected && agent ? (
            <>
              {(!state.connected || agent.status !== 'online') && (
                <div className="wb-chat-connection" role="status">
                  <CircleAlert size={15} />
                  <span>
                    {!state.connected
                      ? '中心连接中断，已保留本轮进度。'
                      : 'Agent 离线，新消息暂时无法提交。'}
                  </span>
                  {!state.connected ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        update((draft) => {
                          draft.connected = true
                        })
                      }
                    >
                      恢复中心连接
                    </Button>
                  ) : (
                    agentCanManage(agent, user) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          update((draft) => {
                            draft.agents.find((item) => item.id === agent.id).status = 'online'
                          })
                        }
                      >
                        模拟 Agent 重新连接
                      </Button>
                    )
                  )}
                </div>
              )}
              <div
                ref={scroller}
                className="wb-chat-messages"
                aria-label="会话消息"
                onScroll={(event) => {
                  const element = event.currentTarget
                  const follow =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 80
                  followLatest.current = follow
                  readingPositions.current.set(selected.id, { top: element.scrollTop, follow })
                  setAtBottom(follow)
                }}
              >
                <div className="wb-chat-message-column">
                  {!selected.messages.length && !selected.active && (
                    <div className="wb-chat-welcome">
                      <span className="wb-chat-welcome-icon">
                        <Bot size={26} />
                      </span>
                      <h3>开始这段会话</h3>
                      <div className="wb-chat-suggestions">
                        {['总结当前项目资料', '检查发布前的准备情况', '整理一份项目分析报告'].map(
                          (suggestion) => (
                            <Button
                              variant="outline"
                              key={suggestion}
                              onClick={() => setInput(suggestion)}
                            >
                              {suggestion}
                              <ArrowUpRight size={13} />
                            </Button>
                          ),
                        )}
                      </div>
                    </div>
                  )}
                  {selected.messages.map((message) => (
                    <article
                      className={`wb-chat-message wb-chat-message-${message.role}`}
                      key={message.id}
                    >
                      {message.role === 'user' ? (
                        <>
                          <div className="wb-chat-user-row">
                            <div className="wb-chat-user-bubble">
                              <p>{message.content}</p>
                              {message.attachments?.length > 0 && (
                                <div className="wb-chat-message-files">
                                  {message.attachments.map((file) => renderFile(file))}
                                </div>
                              )}
                            </div>
                            <span className="wb-chat-avatar">
                              {(
                                state.users.find((item) => item.id === message.actorId)?.name ||
                                '用户'
                              ).slice(-1)}
                            </span>
                          </div>
                          <div className="wb-chat-user-time">
                            {message.kind === 'steer' && <span>已加入本轮 · 模拟引导　</span>}
                            {chatTime(message.at)}
                          </div>
                        </>
                      ) : message.role === 'system' ? (
                        <div className="wb-chat-system-message">
                          <CircleAlert size={14} />
                          <span>{message.content}</span>
                        </div>
                      ) : (
                        <>
                          <div className="wb-chat-answer-heading">
                            <span className="wb-chat-avatar wb-chat-avatar-agent">
                              <Bot size={16} />
                            </span>
                            <span>{agent.name}</span>
                            {message.status === 'interrupted' && <span>已停止 · 内容已保留</span>}
                            <span className="wb-chat-answer-time">{chatTime(message.at)}</span>
                          </div>
                          <div className="wb-chat-answer-content">
                            {renderSteps(message.steps)}
                            <MessageMarkdown content={message.content} />
                            {renderCitations(message.citations)}
                            {message.files?.length > 0 && (
                              <div className="wb-chat-message-files">
                                {message.files.map((file) =>
                                  renderFile(file, !file.savedToProject),
                                )}
                              </div>
                            )}
                            <div className="wb-chat-message-actions">
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label="复制回复"
                                onClick={() => copyMessage(message)}
                              >
                                <Copy size={13} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setInspectedMessageId(message.id)
                                  if (window.innerWidth < 1280) setContextOpen(true)
                                }}
                              >
                                <Link2 size={13} />
                                本轮上下文
                              </Button>
                            </div>
                          </div>
                        </>
                      )}
                    </article>
                  ))}
                  {selected.pendingClarification && !selected.active && (
                    <div className="wb-chat-clarification">
                      <div className="wb-chat-clarification-title">
                        <CircleAlert size={16} />
                        <strong>需要你补充</strong>
                      </div>
                      <div className="wb-chat-clarification-body">
                        <p>这次分析优先关注哪一部分？</p>
                        <div className="wb-chat-clarification-options">
                          {selected.pendingClarification.map((option) => (
                            <Button
                              key={option}
                              variant="ghost"
                              aria-pressed={clarification === option}
                              className={clarification === option ? 'is-selected' : ''}
                              onClick={() => setClarification(option)}
                            >
                              <span className="wb-chat-choice-dot">
                                {clarification === option && <span />}
                              </span>
                              {option}
                            </Button>
                          ))}
                        </div>
                        <Button
                          disabled={!clarification}
                          onClick={() =>
                            send(clarification, 'normal', 'clarify', { attachments: [] })
                          }
                        >
                          提交并继续
                        </Button>
                      </div>
                    </div>
                  )}
                  {selected.active && (
                    <article
                      className="wb-chat-message wb-chat-message-assistant"
                      aria-live="polite"
                    >
                      <div className="wb-chat-answer-heading">
                        <span className="wb-chat-avatar wb-chat-avatar-agent">
                          <Bot size={16} />
                        </span>
                        <span>{agent.name}</span>
                        <span className="wb-chat-running">
                          <i />
                          {!state.connected || agent.status !== 'online'
                            ? '等待恢复'
                            : activeProgress < 0.3
                              ? '正在检索资料'
                              : activeProgress < 0.55
                                ? '正在查询'
                                : '正在生成回复'}
                        </span>
                      </div>
                      <div className="wb-chat-answer-content">
                        {activeProgress > 0.25 &&
                          renderSteps(selected.active.response.steps, activeProgress)}
                        {streamedContent(selected.active) ? (
                          <MessageMarkdown content={streamedContent(selected.active) + ' ▍'} />
                        ) : (
                          <div className="wb-chat-thinking">
                            <span />
                            <span />
                            <span />
                          </div>
                        )}
                      </div>
                    </article>
                  )}
                </div>
              </div>
              <div className="wb-chat-composer">
                {!atBottom && selected.messages.length > 0 && (
                  <div className="wb-chat-latest">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        followLatest.current = true
                        setAtBottom(true)
                        if (scroller.current)
                          scroller.current.scrollTop = scroller.current.scrollHeight
                      }}
                    >
                      <ArrowDown size={14} />
                      回到最新消息
                    </Button>
                  </div>
                )}
                {selected.queue?.length > 0 && (
                  <Accordion
                    type="single"
                    defaultValue="queue"
                    collapsible
                    className="wb-chat-queue"
                  >
                    <AccordionItem value="queue">
                      <AccordionTrigger>
                        下一轮队列 · {selected.queue.length}
                        {selected.queuePaused
                          ? ' · 已暂停'
                          : selected.pendingClarification
                            ? ' · 等待澄清'
                            : ''}
                      </AccordionTrigger>
                      <AccordionContent>
                        {selected.queue.map((queued, index) => (
                          <div className="wb-chat-queued-item" key={queued.id}>
                            <span className="wb-chat-queued-text">
                              <span>
                                {index + 1}. {queued.content}
                              </span>
                              <small>
                                {state.users.find((item) => item.id === queued.actorId)?.name ||
                                  '用户'}
                                {queued.attachments?.length
                                  ? ` · ${queued.attachments.map((file) => file.name).join('、')}`
                                  : ''}
                              </small>
                            </span>
                            <div className="wb-chat-queue-actions">
                              {selected.active && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`引导排队消息 ${queued.id}`}
                                  disabled={Boolean(queued.attachments?.length)}
                                  onClick={() => updateQueue('steer', queued)}
                                >
                                  引导
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`编辑排队消息 ${queued.id}`}
                                onClick={() => setEditingQueued({ ...queued })}
                              >
                                <Pencil size={13} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`移除排队消息 ${queued.id}`}
                                onClick={() => updateQueue('remove', queued)}
                              >
                                <X size={13} />
                              </Button>
                            </div>
                          </div>
                        ))}
                        {selected.queuePaused && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              !state.connected ||
                              agent.status !== 'online' ||
                              Boolean(selected.pendingClarification)
                            }
                            onClick={() =>
                              update((draft) => {
                                const conversation = draft.conversations.find(
                                  (item) => item.id === selected.id,
                                )
                                if (conversation) conversation.queuePaused = false
                              })
                            }
                          >
                            恢复队列
                          </Button>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                )}
                {selected.lastFailed && !selected.active && (
                  <div className="wb-chat-retry">
                    <CircleAlert size={14} />
                    <span>上一轮未完成</span>
                    <Button variant="outline" size="sm" onClick={() => replay(selected.lastFailed)}>
                      重试上一轮
                    </Button>
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="wb-chat-pending-files">
                    {attachments.map((file) => (
                      <div className="wb-chat-pending-file" key={file.id}>
                        {file.mime.startsWith('image/') ? (
                          <img src={file.dataUrl} alt={file.name} />
                        ) : (
                          <FileText size={15} />
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setPreview(file)}>
                          {file.name}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`移除 ${file.name}`}
                          onClick={() =>
                            setAttachments((files) => files.filter((item) => item.id !== file.id))
                          }
                        >
                          <X size={13} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="wb-chat-input-box">
                  <Textarea
                    aria-label="输入问题"
                    rows={2}
                    value={input}
                    placeholder={
                      selected.active ? '补充要求，选择引导本轮或排队…' : '输入问题，或继续提问…'
                    }
                    onChange={(event) => setInput(event.target.value)}
                    onCompositionStart={() => {
                      composing.current = true
                    }}
                    onCompositionEnd={() => {
                      composing.current = false
                    }}
                    onPaste={(event) => {
                      const pasted = [...event.clipboardData.files]
                      if (pasted.length) {
                        event.preventDefault()
                        attachFiles(pasted)
                      }
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
                  <div className="wb-chat-input-toolbar">
                    <div className="wb-chat-input-tools">
                      <input
                        ref={fileInput}
                        hidden
                        aria-label="选择会话附件"
                        type="file"
                        multiple
                        accept="image/*,.md,.markdown,.txt,.csv,.json,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                        onChange={(event) => {
                          const element = event.currentTarget
                          void attachFiles(element.files).finally(() => {
                            element.value = ''
                          })
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="添加附件"
                        disabled={
                          loadingFiles || (!agent.supportsImages && !agent.supportsDocuments)
                        }
                        onClick={() => fileInput.current?.click()}
                      >
                        <Paperclip size={17} />
                      </Button>
                      {agent.kind === 'platform' && (
                        <Button variant="ghost" size="sm" onClick={() => setContextOpen(true)}>
                          <FileText size={15} />
                          引用资料
                        </Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="更多输入操作">
                            <Plus size={16} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem
                            onSelect={() =>
                              setInput('请生成项目分析报告，提供 Markdown、PDF 和 CSV 文件。')
                            }
                          >
                            <FileText />
                            生成报告
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="wb-chat-send-tools">
                      <span className={`wb-chat-capability ${selected.active ? 'is-running' : ''}`}>
                        <ShieldCheck size={12} />
                        只读分析
                      </span>
                      {selected.active ? (
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label="停止生成"
                          title="停止生成"
                          onClick={stop}
                        >
                          <Square size={14} />
                        </Button>
                      ) : (
                        selected.lastStopped && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => replay(selected.lastStopped)}
                          >
                            继续此轮
                          </Button>
                        )
                      )}
                      {selected.active ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="引导当前执行"
                            title={
                              attachments.length
                                ? '本轮先验证文字引导，附件请排队'
                                : '补充到当前执行'
                            }
                            disabled={loadingFiles || !input.trim() || attachments.length > 0}
                            onClick={() => send(input, scenario, 'steer')}
                          >
                            引导本轮
                          </Button>
                          <Button
                            size="sm"
                            aria-label="排队到下一轮"
                            disabled={loadingFiles || (!input.trim() && !attachments.length)}
                            onClick={() => send()}
                          >
                            <Send size={14} />
                            排队
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="icon-sm"
                          aria-label="发送"
                          disabled={loadingFiles || (!input.trim() && !attachments.length)}
                          onClick={() => send()}
                        >
                          <Send size={16} />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="wb-chat-composer-meta">
                  <span>
                    {loadingFiles ? '正在读取附件…' : isShared ? '项目成员可接续会话' : '仅你可见'}
                  </span>
                  <span>{selected.active ? 'Enter 排队' : 'Enter 发送'} · Shift + Enter 换行</span>
                </div>
              </div>
            </>
          ) : (
            <div className="wb-chat-empty-state">
              <Bot size={30} />
              <h3>{selectedId ? '会话不存在或无权访问' : '开始一段新会话'}</h3>
              <Button onClick={() => openNew()}>
                <Plus size={16} />
                新建会话
              </Button>
            </div>
          )}
        </section>
        <aside className="wb-chat-context" aria-label="本轮上下文">
          {contextPanel}
        </aside>
      </Card>
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="wb-chat-mobile-sheet">
          <SheetHeader>
            <SheetTitle>会话</SheetTitle>
            <SheetDescription className="sr-only">当前项目的会话列表</SheetDescription>
          </SheetHeader>
          {historyPanel}
        </SheetContent>
      </Sheet>
      <Sheet open={contextOpen} onOpenChange={setContextOpen}>
        <SheetContent side="right" className="wb-chat-mobile-sheet">
          <SheetHeader>
            <SheetTitle>本轮上下文</SheetTitle>
            <SheetDescription className="sr-only">本轮使用的资料、环境与生成文件</SheetDescription>
          </SheetHeader>
          {contextPanel}
        </SheetContent>
      </Sheet>
      <Modal
        title="编辑排队消息"
        open={Boolean(editingQueued)}
        onClose={() => setEditingQueued(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditingQueued(null)}>
              取消
            </Button>
            <Button
              disabled={!editingQueued?.content.trim()}
              onClick={() => {
                if (updateQueue('edit', editingQueued)) setEditingQueued(null)
              }}
            >
              保存修改
            </Button>
          </>
        }
      >
        <Textarea
          aria-label="排队消息内容"
          rows={4}
          value={editingQueued?.content || ''}
          onChange={(event) =>
            setEditingQueued((current) => ({ ...current, content: event.target.value }))
          }
        />
        {editingQueued?.attachments?.length > 0 && (
          <p>附件：{editingQueued.attachments.map((file) => file.name).join('、')}</p>
        )}
      </Modal>
      <Modal
        title="演示场景"
        open={demoOpen}
        onClose={() => setDemoOpen(false)}
        footer={<Button onClick={() => setDemoOpen(false)}>完成</Button>}
      >
        <div className="wb-stack">
          <Field label="下一轮场景">
            <Picker
              label="本轮演示场景"
              value={scenario}
              onChange={setScenario}
              options={[
                { value: 'normal', label: '正常回复' },
                { value: 'clarify', label: '需要澄清' },
                { value: 'failed', label: '连接 / 执行失败' },
                { value: 'slow', label: '延迟回复' },
              ]}
            />
          </Field>
          <div className="wb-row">
            <span>{state.connected ? '中心已连接' : '中心连接中断'}</span>
            <Button
              variant="outline"
              onClick={() =>
                update((draft) => {
                  draft.connected = !draft.connected
                })
              }
            >
              {state.connected ? '模拟中心断线' : '恢复中心连接'}
            </Button>
          </div>
          {agent && agentCanManage(agent, user) && (
            <div className="wb-row">
              <span>
                {agent.name} · {agent.status === 'online' ? '在线' : '离线'}
              </span>
              <Button
                variant="outline"
                onClick={() =>
                  update((draft) => {
                    const item = draft.agents.find((item) => item.id === agent.id)
                    item.status = item.status === 'online' ? 'offline' : 'online'
                  })
                }
              >
                {agent.status === 'online' ? '模拟 Agent 离线' : '模拟 Agent 重新连接'}
              </Button>
            </div>
          )}
          <p className="wb-muted">这些场景用于体验原型，不连接真实模型或环境资源。</p>
        </div>
      </Modal>
      <Modal
        title="新建会话"
        open={!!newChat}
        onClose={() => setNewChat(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewChat(null)}>
              取消
            </Button>
            <Button onClick={createConversation} disabled={!available.length}>
              创建会话
            </Button>
          </>
        }
      >
        {newChat && (
          <div className="wb-stack">
            {!available.length ? (
              <Empty>
                还没有可用的 Agent。
                <Button variant="outline" onClick={() => navigate(`/p/${projectId}/agents`)}>
                  前往 Agent 管理
                </Button>
              </Empty>
            ) : (
              <>
                {newChat.contextNotice && (
                  <div className="wb-chat-prepared-context">
                    <Link2 size={16} />
                    <span>{newChat.contextNotice}</span>
                  </div>
                )}
                <Field label="Agent">
                  <Picker
                    label="会话 Agent"
                    value={newChat.agentId}
                    options={available
                      .filter((agent) => !newChat.requirePlatform || agent.kind === 'platform')
                      .map((agent) => ({
                        value: agent.id,
                        label: `${agent.name} · ${agent.status === 'online' ? '在线' : '离线'}`,
                      }))}
                    onChange={(agentId) => setNewChat({ ...newChat, agentId })}
                  />
                </Field>
                {newChat.requirePlatform &&
                  !available.some((agent) => agent.kind === 'platform') && (
                    <p className="wb-danger">
                      项目资料需要平台 Agent。请先在管理页面创建或共享平台 Agent。
                    </p>
                  )}
                <Field label="会话名称（可选）">
                  <Input
                    aria-label="会话名称"
                    value={newChat.title}
                    onChange={(event) => setNewChat({ ...newChat, title: event.target.value })}
                  />
                </Field>
                <p className="wb-muted">
                  新会话可见范围：{newAgent ? visibilityName(newAgent, state) : '未选择'}。Agent
                  固定后不能在同一会话中更换。
                </p>
                {newAgent && (
                  <>
                    <Field label="固定环境">
                      <Picker
                        label="会话环境"
                        value={newChat.environmentId}
                        onChange={(environmentId) => setNewChat({ ...newChat, environmentId })}
                        options={[
                          { value: 'none', label: '无环境 · 仅项目资料' },
                          ...project.environments.map((environment) => ({
                            value: environment.id,
                            label: environment.name,
                          })),
                        ]}
                      />
                    </Field>
                    <Field label="项目资料范围">
                      <Picker
                        label="项目资料范围"
                        value={newChat.scopeMode}
                        options={[
                          { value: 'auto', label: '自动检索项目资料' },
                          { value: 'selected', label: '限定文件 / 文件夹' },
                        ]}
                        onChange={(scopeMode) => setNewChat({ ...newChat, scopeMode })}
                      />
                    </Field>
                    {newChat.scopeMode === 'selected' && (
                      <div className="wb-agent-scope">
                        {selectableScope.length ? (
                          selectableScope.map((doc) => (
                            <div className="wb-row" key={doc.id}>
                              <Label htmlFor={`scope-${doc.id}`}>
                                {doc.kind === 'folder'
                                  ? '文件夹 · '
                                  : doc.scopeArtifact
                                    ? '制品 · '
                                    : ''}
                                {doc.path || doc.name}
                              </Label>
                              <Checkbox
                                id={`scope-${doc.id}`}
                                checked={newChat.scopeIds.includes(doc.id)}
                                onCheckedChange={(checked) =>
                                  setNewChat({
                                    ...newChat,
                                    scopeIds: checked
                                      ? [...newChat.scopeIds, doc.id]
                                      : newChat.scopeIds.filter((id) => id !== doc.id),
                                  })
                                }
                              />
                            </div>
                          ))
                        ) : (
                          <Empty>项目尚无文档或可选文件制品。</Empty>
                        )}
                      </div>
                    )}
                    <Field label="源码策略">
                      <Picker
                        label="源码策略"
                        value={newChat.sourceMode}
                        onChange={(sourceMode) =>
                          setNewChat({
                            ...newChat,
                            sourceMode,
                            sourceArtifactId:
                              project.artifacts.find(
                                (artifact) =>
                                  isAlive(artifact) &&
                                  (sourceMode === 'raw'
                                    ? ['source', 'stripped'].includes(artifact.type)
                                    : artifact.type === 'sanitized'),
                              )?.id || '',
                          })
                        }
                        options={[
                          { value: 'sanitized', label: '脱敏源码（默认）' },
                          { value: 'none', label: '仅项目文档，不使用源码' },
                          { value: 'raw', label: '显式允许原始源码' },
                        ]}
                      />
                    </Field>
                    {newChat.sourceMode !== 'none' && (
                      <Field label="源码制品">
                        {sourceArtifacts.length ? (
                          <Picker
                            label="源码制品"
                            value={newChat.sourceArtifactId}
                            options={sourceArtifacts.map((artifact) => ({
                              value: artifact.id,
                              label: artifact.name,
                            }))}
                            onChange={(sourceArtifactId) =>
                              setNewChat({ ...newChat, sourceArtifactId })
                            }
                          />
                        ) : (
                          <div className="wb-chat-error">
                            没有可用的{newChat.sourceMode === 'raw' ? '原始' : '脱敏'}
                            源码制品。请先准备，或明确选择其他源码策略。不会自动改用原始源码。
                            <div className="mt-2">
                              <Button
                                variant="outline"
                                onClick={() => navigate(`/p/${projectId}/artifacts`)}
                              >
                                前往制品准备
                              </Button>
                            </div>
                          </div>
                        )}
                      </Field>
                    )}
                    {newChat.sourceMode === 'raw' && (
                      <div className="wb-chat-raw-notice">
                        <p>
                          你已主动选择原始源码。创建会话后，平台 Agent 可以读取其中未经脱敏的内容。
                        </p>
                        {newChat.requiresRawConfirmation && (
                          <div className="wb-row">
                            <Checkbox
                              id="confirm-linked-raw"
                              checked={Boolean(newChat.rawConfirmed)}
                              onCheckedChange={(rawConfirmed) =>
                                setNewChat({ ...newChat, rawConfirmed })
                              }
                            />
                            <Label htmlFor="confirm-linked-raw">确认使用这份原始源码</Label>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
      <Confirm
        title="删除会话"
        open={!!deleting}
        danger
        onClose={() => setDeleting(null)}
        confirmLabel="删除会话"
        onConfirm={() => {
          const current = state.conversations.find((item) => item.id === deleting.id)
          if (current?.active) return toast.error('会话正在处理中，请先停止')
          if (!discardConversationDrafts({ projectId, conversationId: deleting.id }))
            return toast.error('浏览器草稿未能清理，会话尚未删除，请重试')
          update((draft) => {
            draft.conversations = draft.conversations.filter(
              (conversation) => conversation.id !== deleting.id,
            )
          })
          if (selected?.id === deleting.id) {
            const next = conversations.find((conversation) => conversation.id !== deleting.id)
            navigate(
              `/p/${projectId}/chat${next ? `?conversation=${encodeURIComponent(next.id)}` : ''}`,
            )
          }
          setDeleting(null)
          toast.success('会话已删除')
        }}
      >
        <p>将删除「{deleting?.title}」的消息和未保存文件。已保存到项目的制品与任务记录保留。</p>
      </Confirm>
      <Confirm
        title="将文件分享到项目"
        open={!!saveFile}
        onClose={() => setSaveFile(null)}
        confirmLabel="保存并分享"
        onConfirm={() => {
          update((draft) => {
            const conversation = draft.conversations.find((item) => item.id === selected.id)
            const file = conversation.messages
              .flatMap((message) => message.files || [])
              .find((file) => file.id === saveFile.id)
            if (!file || file.savedToProject) return
            file.savedToProject = true
            draft.projects[projectId].artifacts.unshift({ ...file })
          })
          audit({
            projectId,
            agentId: agent.id,
            action: '分享 Agent 生成文件到项目',
            object: saveFile.name,
          })
          setSaveFile(null)
          toast.success('已保存，项目成员现在可以访问此文件')
        }}
      >
        <p>
          「{saveFile?.name}」将保存到 {project.name}{' '}
          制品，所有项目成员都可访问。会话本身的可见范围不变。
        </p>
      </Confirm>
      <Modal
        title={preview?.name || '预览'}
        open={!!preview}
        onClose={() => setPreview(null)}
        footer={
          <Button variant="ghost" onClick={() => setPreview(null)}>
            关闭
          </Button>
        }
      >
        {preview &&
          (preview.mime?.startsWith('image/') ? (
            <img className="wb-agent-preview-img" src={preview.dataUrl} alt={preview.name} />
          ) : preview.mime === 'application/pdf' && preview.dataUrl ? (
            <div className="wb-stack">
              <iframe title={preview.name} src={preview.dataUrl} className="wb-agent-pdf" />
              <Button variant="outline" onClick={() => downloadChatFile(preview)}>
                下载 PDF
              </Button>
            </div>
          ) : preview.content !== undefined ? (
            <pre className="wb-code whitespace-pre-wrap">{preview.content}</pre>
          ) : (
            <Empty>
              此文件支持下载后查看。
              <div className="mt-3">
                <Button onClick={() => downloadChatFile(preview)}>
                  <Download size={16} />
                  下载文件
                </Button>
              </div>
            </Empty>
          ))}
      </Modal>
    </div>
  )
}
