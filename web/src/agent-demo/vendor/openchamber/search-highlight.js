// Adapted from OpenChamber chat/search/chatSearchHighlight.ts at 6491f51d (MIT).
// Copyright (c) 2025 Bohdan Triapitsyn. License: /third-party/agent-demo-streaming-NOTICES.txt
// Changed selectors and highlight names; allow one Chinese character. Our
// incremental Markdown renderer splits text nodes per chunk, so map ranges
// across adjacent nodes (including inline emphasis), without modifying them.
// The Markdown parser's DOM is never rewritten by search.
export const toHighlightTerms = (query) =>
  query
    .trim()
    .split(/\s+/)
    .filter((term) => Array.from(term).length >= 1)
    .map((term) => term.toLowerCase())

export const findTermRanges = (root, terms) => {
  const ranges = []
  if (!terms.length) return ranges
  const document = root.ownerDocument
  for (const container of root.querySelectorAll('.workbench-demo-markdown')) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    let joined = ''
    let previousBlock
    const spans = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('button')) continue
      const text = node.nodeValue ?? ''
      if (!text) continue
      const block = node.parentElement?.closest('p,pre,li,h1,h2,h3,h4,h5,h6,th,td')
      if (spans.length && block !== previousBlock) joined += '\n'
      spans.push({ node, start: joined.length, end: joined.length + text.length })
      joined += text
      previousBlock = block
    }
    const lower = joined.toLowerCase()
    if (lower.length !== joined.length) continue
    for (const term of terms) {
      for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
        const first = spans.find((span) => span.start <= at && at < span.end)
        const last = spans.find(
          (span) => span.start < at + term.length && at + term.length <= span.end,
        )
        if (!first || !last) continue
        const range = document.createRange()
        range.setStart(first.node, at - first.start)
        range.setEnd(last.node, at + term.length - last.start)
        ranges.push(range)
      }
    }
  }
  return ranges
}

export const paintSearchHighlights = (all, current) => {
  if (!('Highlight' in window) || !('highlights' in CSS)) return
  if (all.length) CSS.highlights.set('workbench-demo-search', new Highlight(...all))
  else CSS.highlights.delete('workbench-demo-search')
  if (current.length) {
    const highlight = new Highlight(...current)
    highlight.priority = 1
    CSS.highlights.set('workbench-demo-search-current', highlight)
  } else CSS.highlights.delete('workbench-demo-search-current')
}
