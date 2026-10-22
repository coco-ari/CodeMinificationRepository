import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Download, FileText, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { copyText, fileUrl } from './api'
import { createStreamingMarkdown } from './streaming-markdown'
import { useStreamingTextThrottle } from './use-streaming-text'
import { commitStreamedText } from './vendor/openchamber/reasoning/streamTextCommit'

function CodeToolbar({ block }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  return (
    <>
      <span>{block.node.getAttribute('class')?.replace(/^language-/, '') || '文本'}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="复制代码"
        onClick={async () => {
          try {
            await copyText(block.node.textContent || '')
            setCopied(true)
            setError('')
          } catch {
            setError('复制不可用，请选择代码后复制')
          }
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? '已复制' : '复制'}
      </Button>
      {error && <span className="workbench-demo-inline-error">{error}</span>}
    </>
  )
}

export const Markdown = memo(function Markdown({
  content = '',
  streaming = false,
  identity,
  committed = false,
}) {
  const throttledText = useStreamingTextThrottle({
    text: String(content),
    isStreaming: streaming,
    identityKey: identity,
  })
  // OpenChamber commits complete blocks while streaming, then flushes the tail.
  // Keep the established Hermes incremental parser for the committed prefix.
  const text = streaming && !committed ? commitStreamedText(throttledText) : throttledText
  const root = useRef(null)
  const current = useRef(null)
  const generation = useRef(0)
  const [codeBlocks, setCodeBlocks] = useState([])
  useLayoutEffect(() => {
    let state = current.current
    if (
      !state ||
      state.identity !== identity ||
      !text.startsWith(state.parser.writtenText) ||
      (state.parser.finalized && state.parser.writtenText !== text)
    ) {
      root.current.replaceChildren()
      state = {
        identity,
        generation: ++generation.current,
        parser: createStreamingMarkdown(root.current),
        blockCount: -1,
      }
      current.current = state
    }
    if (!state.parser.finalized) state.parser.write(text)
    if (!streaming) state.parser.finish()
    if (state.blockCount !== state.parser.blocks.length) {
      state.blockCount = state.parser.blocks.length
      setCodeBlocks(
        state.parser.blocks.map((block) => ({ ...block, generation: state.generation })),
      )
    }
  }, [text, streaming, identity])
  useLayoutEffect(
    () => () => {
      current.current = null
    },
    [],
  )
  return (
    <>
      {/* The parser owns this node's children; React owns only separate toolbar portals. */}
      <div className="workbench-demo-markdown" ref={root} data-streaming={streaming || undefined} />
      {codeBlocks.map((block) =>
        createPortal(
          <CodeToolbar block={block} />,
          block.toolbar,
          `${block.generation}-${block.id}`,
        ),
      )}
    </>
  )
})

export function FilePreview({ file, onClose, onReference }) {
  const [state, setState] = useState({ loading: false, content: '', error: '' })
  const [documentDownload, setDocumentDownload] = useState(null)
  const url = file?.projectDocument ? '' : fileUrl(file, true)
  const downloadUrl = file?.projectDocument
    ? documentDownload?.id === file.id &&
      documentDownload?.viewerId === file.viewerId &&
      documentDownload?.content === file.content
      ? documentDownload.url
      : ''
    : fileUrl(file)
  useEffect(() => {
    if (!file?.projectDocument || typeof file.content !== 'string') {
      setDocumentDownload(null)
      return
    }
    const url = URL.createObjectURL(
      new Blob([file.content], { type: file.mime || 'text/plain;charset=utf-8' }),
    )
    setDocumentDownload({
      id: file.id,
      viewerId: file.viewerId,
      content: file.content,
      url,
    })
    return () => URL.revokeObjectURL(url)
  }, [file?.projectDocument, file?.id, file?.content, file?.mime, file?.viewerId])
  const image = Boolean(file?.mime?.startsWith('image/'))
  const pdf = file?.mime === 'application/pdf' || /\.pdf$/i.test(file?.name || '')
  const readable =
    file &&
    (typeof file.content === 'string' ||
      /^text\//.test(file.mime) ||
      /json|javascript|xml/.test(file.mime) ||
      /\.(md|markdown|txt|csv|json|log|js|ts|jsx|tsx|py|yaml|yml|xml|html|css)$/i.test(file.name))
  useEffect(() => {
    if (!file) return
    const controller = new AbortController()
    let active = true
    if (typeof file.content === 'string') {
      setState({ loading: false, content: file.content, error: '' })
      return () => {
        active = false
      }
    }
    if (!readable || !url) {
      setState({ loading: false, content: '', error: !url ? '文件地址不可用' : '' })
      return () => {
        active = false
      }
    }
    setState({ loading: true, content: '', error: '' })
    fetch(url, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('文件无法读取，可能已删除或访问权限已变化。')
        const content = await response.text()
        if (active) setState({ loading: false, content, error: '' })
      })
      .catch((error) => {
        if (active && error.name !== 'AbortError')
          setState({ loading: false, content: '', error: error.message })
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [file?.id, file?.content, url, readable])
  return (
    <Dialog
      open={Boolean(file)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="workbench-demo-preview-dialog">
        <DialogHeader>
          <DialogTitle className="workbench-demo-preview-title">
            <FileText size={18} />
            {file?.name}
          </DialogTitle>
          <DialogDescription className="sr-only">查看文件内容，或下载原始文件。</DialogDescription>
        </DialogHeader>
        {['unavailable', 'partial'].includes(file?.extraction?.status) && (
          <p role="status" className="text-sm text-muted-foreground">
            {file.extraction.message}
          </p>
        )}
        <div className="workbench-demo-preview-body">
          {state.loading ? (
            <div className="workbench-demo-empty">
              <LoaderCircle className="workbench-demo-spin" />
              正在读取文件
            </div>
          ) : state.error ? (
            <div role="alert" className="workbench-demo-inline-error">
              {state.error}
            </div>
          ) : image && url ? (
            <img className="workbench-demo-preview-image" src={url} alt={file.name} />
          ) : pdf && url ? (
            <iframe className="workbench-demo-preview-pdf" src={url} title={file.name} />
          ) : readable ? (
            <Markdown content={state.content} />
          ) : (
            <div className="workbench-demo-empty">
              <FileText />
              <p>此格式暂不支持在线预览，可下载原文件查看。</p>
            </div>
          )}
        </div>
        {(downloadUrl || onReference) && (
          <div className="workbench-demo-dialog-actions">
            {onReference && (
              <Button variant="outline" onClick={onReference}>
                <FileText size={15} />
                引用到输入
              </Button>
            )}
            {downloadUrl && (
              <Button variant="outline" asChild>
                <a href={downloadUrl} download={file?.name}>
                  <Download size={15} />
                  下载原文件
                </a>
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
