// Adapted from OpenChamber lib/exportSession.ts at 6491f51d (MIT).
// Copyright (c) 2025 Bohdan Triapitsyn. License: /third-party/agent-demo-streaming-NOTICES.txt
// Keeps title/date/message separators, safe Unicode filenames and Blob download;
// translates AutoOps ordered parts. No runtime configuration or raw tool logs.
import { conversationRows } from './timeline.js'

export function formatConversationMarkdown(conversation, { includeReasoning = true } = {}) {
  const body = conversationRows(conversation)
    .map((message) => {
      const parts = message.parts
        ?.map((part) => {
          if (part.type === 'text') return part.text
          if (part.type === 'reasoning' && includeReasoning)
            return `> 思考过程\n>\n${part.text
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n')}`
          if (part.type === 'question') return `**需要补充：** ${part.question.prompt}`
          if (part.type === 'tool') {
            const step = conversation.turns
              .find((turn) => turn.id === message.turnId)
              ?.steps?.find((item) => item.id === part.stepId)
            return step ? `*工具：${step.name}（${step.status}）*` : ''
          }
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
      const attachments = message.attachments?.map((file) => `附件：${file.name}`).join('\n') || ''
      const content = [parts ?? message.content, attachments].filter(Boolean).join('\n\n')
      if (!content) return ''
      const name = message.role === 'assistant' ? '项目助手' : message.actorName || '我'
      return `**${name}**\n\n*${message.createdAt || ''}*\n\n${content}`
    })
    .filter(Boolean)
    .join('\n\n---\n\n')
  return `# ${conversation.title || '会话'}\n\n*导出于 ${new Date().toISOString().split('T')[0]}*\n\n---\n\n${body}\n`
}

export function buildExportFilename(title) {
  const safe = (title?.trim() || 'session')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${safe || 'session'}-${new Date().toISOString().split('T')[0]}.md`
}

export function downloadConversation(conversation, options) {
  const blob = new Blob([formatConversationMarkdown(conversation, options)], {
    type: 'text/markdown;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = buildExportFilename(conversation.title)
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
