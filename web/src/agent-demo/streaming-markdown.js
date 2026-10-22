// Incremental lifecycle and inline URL validation adapted from Hermes WebUI
// (MIT), commit 3aa21f63387939dcff37baa141ad59a0e1e1147f, static/messages.js.
// See /third-party/agent-demo-streaming-NOTICES.txt. No word/typing delays.
import * as smd from 'streaming-markdown'

export function safeMarkdownUrl(value, base = location.origin) {
  try {
    const url = new URL(String(value), base)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch {}
  return null
}

export function createStreamingMarkdown(root) {
  const renderer = smd.default_renderer(root)
  const baseAddToken = renderer.add_token
  const baseSetAttr = renderer.set_attr
  const blocks = []
  renderer.add_token = (data, token) => {
    baseAddToken(data, token)
    const node = data.nodes[data.index]
    if (token === smd.CODE_FENCE || token === smd.CODE_BLOCK) {
      const pre = node.parentElement
      const wrapper = document.createElement('div')
      wrapper.className = 'workbench-demo-code-block'
      const toolbar = document.createElement('div')
      toolbar.className = 'workbench-demo-code-heading'
      pre.replaceWith(wrapper)
      wrapper.append(toolbar, pre)
      // React portals own only this empty toolbar, never parser-owned children.
      blocks.push({ id: blocks.length, node, toolbar })
    } else if (token === smd.TABLE) {
      const wrapper = document.createElement('div')
      wrapper.className = 'workbench-demo-markdown-table'
      node.replaceWith(wrapper)
      wrapper.append(node)
    } else if (token === smd.LINK || token === smd.RAW_URL) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  }
  renderer.set_attr = (data, attribute, value) => {
    if (attribute === smd.HREF || attribute === smd.SRC) {
      const url = safeMarkdownUrl(value)
      if (!url) return
      baseSetAttr(data, attribute, url)
      return
    }
    // Attributes are the parser's fixed enum, never arbitrary model attributes.
    baseSetAttr(data, attribute, value)
  }
  const parser = smd.parser(renderer)
  return {
    writtenText: '',
    finalized: false,
    blocks,
    write(text) {
      if (this.finalized || !text.startsWith(this.writtenText)) return false
      const delta = text.slice(this.writtenText.length)
      if (delta) smd.parser_write(parser, delta)
      this.writtenText = text
      return true
    },
    finish() {
      if (this.finalized) return
      smd.parser_end(parser)
      this.finalized = true
    },
  }
}
