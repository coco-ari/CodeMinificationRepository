// OpenChamber tool row migration, commit 6491f51dbcf05d1e3f7f823049f5f097c96c234b.
// Copyright (c) 2025 Bohdan Triapitsyn (MIT).
// License: /third-party/agent-demo-streaming-NOTICES.txt
// Sources: message/parts/{ProgressiveGroup,ToolPart,toolPresentation}.tsx,
// message/toolRenderers.tsx and lib/{opencode/tools,toolHelpers}.ts.
// The row hierarchy, input formatting, output modes and scrolling below follow
// those sources. Business tool names and authorized document/file previews are
// the adapter boundary; OpenCode stores, editor APIs and Git-only tools are not
// carried over. JSON summary/tree views are copied separately without redesign.
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  FileText,
  Folder,
  Globe,
  List,
  Network,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyText } from './api'
import { BlockLine } from './vendor/openchamber/tool-parts/BlockLine'
import { MinDurationShineText } from './vendor/openchamber/tool-parts/MinDurationShineText'
import { JsonSummaryView } from './vendor/openchamber/tool-parts/JsonSummaryView'
import { JsonTreeViewer } from './vendor/openchamber/tool-parts/JsonTreeViewer'

const TOOL_TYPES = {
  read_project_document: ['read', '读取文件'],
  'project.documents.read': ['read', '读取文件'],
  读取项目资料: ['read', '读取文件'],
  read_attachment: ['read', '读取文件'],
  list_project_materials: ['search', '列出项目资料'],
  'project.materials.search': ['search', '搜索资料'],
  'project.documents.search': ['search', '搜索资料'],
  query_environment: ['environment', '查询环境'],
  查询环境快照: ['environment', '查询环境'],
  'environment.status': ['environment', '查询环境'],
  'mcp.resource.status.read': ['environment', '查询环境'],
  // These are custom host-delivered artifacts, not OpenCode's filesystem write.
  // Keep their business name on the generic ToolPart path.
  create_report: ['report', '生成报告'],
  'report.create': ['report', '生成报告'],
  ask_user: ['question', '提问'],
}
const TYPE_ICONS = {
  read: FileText,
  write: Pencil,
  search: Search,
  environment: Network,
  shell: Terminal,
  bash: Terminal,
  webfetch: Globe,
  skill: Folder,
}
const terminalStates = new Set(['completed', 'error', 'aborted', 'failed', 'timeout', 'cancelled'])
const normalizeToolName = (name) => {
  const trimmed = typeof name === 'string' ? name.trim().toLowerCase() : ''
  if (!trimmed) return ''
  const withoutIndex = trimmed.replace(/:\d+$/, '')
  if (!withoutIndex.includes('.')) return withoutIndex
  return withoutIndex.split('.').filter(Boolean).at(-1) ?? withoutIndex
}
const formatUnknownName = (name) =>
  String(name || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^./, (char) => char.toUpperCase())
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

// As in OpenChamber, only tools with an in-app navigation destination are static.
// A sourceUrl is never used as a fetch or preview destination: the authenticated
// document snapshot or a same-origin file-id route supplies the preview instead.
export function toolPresentation(rawStep, turn) {
  const step = record(rawStep)
  const input = record(step.input)
  const output = record(step.output)
  const [kind, name] = TOOL_TYPES[step.name] || [
    normalizeToolName(step.name),
    formatUnknownName(step.name || 'tool'),
  ]
  const documents = Array.isArray(turn?.context?.documents) ? turn.context.documents : []
  const document = documents.find((item) => item && (item.id === input.id || item.id === output.id))
  let file = null
  if (kind === 'read' && document) file = { ...document, projectDocument: true }
  else if (kind === 'read' && text(output.id) && text(output.name)) {
    file = { id: output.id, name: output.name, mime: output.mime || 'text/plain' }
    if (typeof output.content === 'string') file.content = output.content
  }
  const path =
    text(input.path) ||
    text(input.filePath) ||
    text(input.file_path) ||
    text(file?.name) ||
    text(output.name) ||
    (kind === 'write' || kind === 'report' ? text(input.name) : '')
  const description =
    kind === 'read' || kind === 'write' || kind === 'report'
      ? path
      : kind === 'environment'
        ? text(turn?.context?.environment?.name) ||
          text(output.environmentName) ||
          text(input.environmentId)
        : text(input.description) || text(input.pattern) || text(input.query) || path
  return {
    kind,
    name,
    description,
    file,
    // Native OpenCode read rows always navigate. These calls are custom MCP-like
    // business tools: a failed read has no successful navigation result, so use
    // OpenChamber's common expandable error renderer instead of hiding the error.
    static:
      kind === 'read' && Boolean(file) && !step.error && !['failed', 'error'].includes(step.status),
    Icon: TYPE_ICONS[kind] || Wrench,
  }
}

// OpenChamber lib/toolHelpers.ts::formatToolInput; only the supported tool
// categories are retained. Custom/MCP parameters use the original generic path.
function formatToolInput(input, kind) {
  if (!input) return ''
  const getString = (key) =>
    typeof input[key] === 'string'
      ? input[key]
      : typeof input[key] === 'number'
        ? String(input[key])
        : null
  if (kind === 'shell' || kind === 'bash') {
    const command = getString('command')
    if (command) return command
  }
  if (typeof input.content === 'string') return input.content
  if (typeof input === 'object')
    return Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => {
        const label = key
          .replace(/([A-Z])/g, ' $1')
          .replace(/_/g, ' ')
          .toLowerCase()
          .replace(/^./, (char) => char.toUpperCase())
        const formatted =
          typeof value === 'object'
            ? JSON.stringify(value, null, 2)
            : typeof value === 'boolean'
              ? value
                ? 'Yes'
                : 'No'
              : value
        return `${label}: ${formatted}`
      })
      .join('\n')
  return String(input)
}

// OpenChamber message/toolRenderers.tsx::capToolOutputText/tryParseJsonOutput.
export function capToolOutputText(output, maxChars = 512 * 1024) {
  if (typeof output !== 'string' || output.length <= maxChars) return output
  return (
    output.slice(0, maxChars) +
    `\n\n… [output truncated: ${output.length - maxChars} more characters not shown to prevent the renderer from running out of memory]`
  )
}
export function tryParseJsonOutput(output) {
  if (!output || typeof output !== 'string') return { data: null, isJson: false }
  const trimmed = output.trim()
  if (
    (!trimmed.startsWith('{') && !trimmed.startsWith('[')) ||
    (!trimmed.endsWith('}') && !trimmed.endsWith(']')) ||
    trimmed.length < 2
  )
    return { data: null, isJson: false }
  try {
    const data = JSON.parse(trimmed)
    return data !== null && typeof data === 'object'
      ? { data, isJson: true }
      : { data: null, isJson: false }
  } catch {
    return { data: null, isJson: false }
  }
}

// OpenChamber's four-pass text-block envelope unwrapping; validation is the same
// type/text shape without importing its schema library into this adapter.
export function unwrapTextBlocks(data) {
  const parse = (value) => {
    const blocks = Array.isArray(value) ? value : [value]
    return blocks.length &&
      blocks.every((block) => block?.type === 'text' && typeof block.text === 'string')
      ? blocks
      : null
  }
  let blocks = parse(data)
  if (!blocks) return null
  let result = ''
  for (let pass = 0; pass < 4; pass++) {
    result = blocks.map((block) => block.text).join('\n')
    const trimmed = result.trim()
    if (!(
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ))
      break
    try {
      const inner = parse(JSON.parse(result))
      if (!inner) break
      blocks = inner
    } catch {
      break
    }
  }
  return result
}

// ToolPart.tsx::ToolScrollableSection: an upward wheel releases follow, only
// reaching the bottom resumes it. Layout growth does not count as user intent.
function ToolScrollableSection({ children, followKey }) {
  const scrollRef = useRef(null)
  const following = useRef(true)
  const lastTop = useRef(0)
  useLayoutEffect(() => {
    if (followKey === undefined) {
      following.current = true
      return
    }
    const element = scrollRef.current
    if (!element || !following.current) return
    element.scrollTop = element.scrollHeight
    lastTop.current = element.scrollTop
  }, [followKey])
  return (
    <div
      ref={scrollRef}
      className="workbench-demo-tool-scroll"
      data-scrollable
      onWheelCapture={(event) => {
        if (followKey !== undefined && event.deltaY < 0) following.current = false
      }}
      onScroll={(event) => {
        if (followKey === undefined) return
        const element = event.currentTarget
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight
        if (distance <= 2) following.current = true
        else if (element.scrollTop < lastTop.current - 1) following.current = false
        lastTop.current = element.scrollTop
      }}
    >
      <div>{children}</div>
    </div>
  )
}

function ToolOutput({ output, running }) {
  const rendered = useMemo(
    () =>
      capToolOutputText(
        typeof output === 'string' ? output : JSON.stringify(output, null, 2) || '',
      ),
    [output],
  )
  const json = useMemo(() => tryParseJsonOutput(rendered), [rendered])
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem('autoops:agent-demo:tool-json-view') || 'summary'
    } catch {
      return 'summary'
    }
  })
  const [copyState, setCopyState] = useState('')
  useEffect(() => setCopyState(''), [rendered])
  const plain = json.isJson && view === 'summary' ? unwrapTextBlocks(json.data) : null
  return (
    <div className="workbench-demo-tool-output">
      <div className="workbench-demo-tool-output-actions">
        {json.isJson &&
          [
            ['summary', '结构化结果', List],
            ['formatted', 'JSON 树', Network],
            ['raw', 'JSON 原文', Code],
          ].map(([value, label, Icon]) => (
            <Button
              key={value}
              size="icon"
              variant="ghost"
              aria-label={label}
              title={label}
              aria-pressed={view === value}
              onClick={() => {
                setView(value)
                try {
                  localStorage.setItem('autoops:agent-demo:tool-json-view', value)
                } catch {}
              }}
            >
              <Icon size={14} />
            </Button>
          ))}
        <Button
          size="icon"
          variant="ghost"
          aria-label={copyState || '复制工具结果'}
          title={copyState || '复制工具结果'}
          onClick={async () => {
            try {
              await copyText(rendered)
              setCopyState('已复制')
            } catch {
              setCopyState('请选中文字复制')
            }
          }}
        >
          {copyState === '已复制' ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      </div>
      <ToolScrollableSection followKey={running ? rendered : undefined}>
        {json.isJson && view === 'summary' && plain === null ? (
          <JsonSummaryView data={json.data} />
        ) : json.isJson && view === 'formatted' ? (
          <JsonTreeViewer data={json.data} initiallyExpandedDepth={1} maxHeight="400px" />
        ) : (
          <pre className="workbench-demo-tool-text">{plain ?? rendered}</pre>
        )}
      </ToolScrollableSection>
    </div>
  )
}

const StaticToolRow = memo(function StaticToolRow({ step, presentation, onRead, onPreview }) {
  const { Icon, name, description, file } = presentation
  const running = !terminalStates.has(step.status)
  return (
    <div
      className="workbench-demo-tool-row is-static"
      data-step-id={step.id}
      data-status={step.status}
      data-tool-kind="read"
    >
      <Icon size={14} aria-hidden />
      <MinDurationShineText
        active={running}
        minDurationMs={1000}
        className="workbench-demo-tool-name"
      >
        {name}
      </MinDurationShineText>
      <Button
        variant="ghost"
        className="workbench-demo-tool-file min-w-0 flex-1 shrink"
        title={description}
        aria-label={`查看文件 ${description}`}
        onClick={() => {
          onRead?.()
          onPreview?.(file)
        }}
      >
        {description}
      </Button>
    </div>
  )
})

const ToolPartBody = memo(function ToolPartBody({
  step,
  turn,
  onRead,
  onPreview,
  expanded,
  onExpandedChange,
}) {
  const presentation = useMemo(() => toolPresentation(step, turn), [step, turn])
  const [localExpanded, setLocalExpanded] = useState(false)
  const isExpanded = expanded ?? localExpanded
  const contentId = useId()
  const running = !terminalStates.has(step.status)
  const failed = Boolean(step.error) || step.status === 'failed' || step.status === 'error'
  const input = useMemo(
    () => formatToolInput(step.input, presentation.kind),
    [step.input, presentation.kind],
  )
  const toggle = () => {
    if (!isExpanded) onRead?.()
    setLocalExpanded(!isExpanded)
    onExpandedChange?.(!isExpanded)
  }
  if (presentation.static)
    return (
      <StaticToolRow
        step={step}
        presentation={presentation}
        onRead={onRead}
        onPreview={onPreview}
      />
    )
  const { Icon, name, description } = presentation
  return (
    <div
      className={`workbench-demo-tool-part ${failed ? 'is-error' : ''}`}
      data-step-id={step.id}
      data-status={step.status}
      data-tool-kind={presentation.kind}
    >
      <Button
        variant="ghost"
        className="workbench-demo-tool-row"
        onClick={toggle}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        aria-label={`${isExpanded ? '收起' : '展开'} ${name}`}
      >
        <span className="workbench-demo-tool-icon">
          <Icon size={14} aria-hidden />
          <span className="workbench-demo-tool-chevron">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </span>
        <MinDurationShineText
          active={running && !failed}
          minDurationMs={300}
          className="workbench-demo-tool-name"
        >
          {name}
        </MinDurationShineText>
        {description && (
          <span className="workbench-demo-tool-description" title={description}>
            {description}
          </span>
        )}
      </Button>
      {isExpanded && (
        <div id={contentId} className="workbench-demo-tool-body">
          <BlockLine onToggle={toggle} topOffset={1} />
          {input && (
            <div className="workbench-demo-tool-input">
              <ToolScrollableSection>
                <blockquote>{input}</blockquote>
              </ToolScrollableSection>
            </div>
          )}
          {step.output !== undefined && <ToolOutput output={step.output} running={running} />}
          {step.error && (
            <p className="workbench-demo-inline-error">
              {typeof step.error === 'string' ? step.error : step.error.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
})

// A partial/legacy snapshot can reference a step before its body is available.
// Keep hooks on the mounted body so a later valid snapshot can fill the row.
export const ToolPart = memo(function ToolPart(props) {
  if (!props.step || typeof props.step !== 'object' || Array.isArray(props.step)) return null
  return <ToolPartBody {...props} />
})
