// AutoOps boundary adapters for the unchanged OpenChamber reasoning block.
import { forwardRef } from 'react'
import { Brain, ChevronDown, ChevronRight } from 'lucide-react'
import { Markdown } from '../../../Content'

export const Icon = ({ name, ...props }) => {
  const Component =
    { 'brain-ai-3': Brain, 'arrow-down-s': ChevronDown, 'arrow-right-s': ChevronRight }[name] ||
    Brain
  return <Component {...props} />
}
export const useI18n = () => ({
  t: (key) =>
    ({
      'chat.reasoningTrace.collapseAria': '收起思考过程',
      'chat.reasoningTrace.expandAria': '展开思考过程',
      'chat.reasoningTrace.thinking': '思考过程',
    })[key] || key,
})
export const MarkdownRenderer = ({ content, messageId, isStreaming }) => (
  <Markdown content={content} identity={messageId} streaming={isStreaming} committed />
)
// The host uses a native scroll container; the upstream block still owns all
// wheel/touch/scroll intent and ResizeObserver follow behavior.
export const ScrollableOverlay = forwardRef(function ScrollableOverlay(
  { as, outerClassName, className, useScrollShadow, scrollShadowSize, userIntentOnly, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={`workbench-demo-reasoning-body ${outerClassName || ''} ${className || ''}`}
      {...props}
    />
  )
})
