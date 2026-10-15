import * as React from 'react'
import { ScrollArea as Primitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { getNonce } from 'get-nonce'
function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof Primitive.ScrollAreaScrollbar>) {
  return (
    <Primitive.ScrollAreaScrollbar
      orientation={orientation}
      className={cn(
        'flex touch-none select-none p-px',
        orientation === 'vertical'
          ? 'h-full w-2.5 border-l border-l-transparent'
          : 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <Primitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
    </Primitive.ScrollAreaScrollbar>
  )
}
function ScrollArea({
  className,
  children,
  viewportRef,
  onViewportScroll,
  ...props
}: React.ComponentProps<typeof Primitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>
}) {
  return (
    <Primitive.Root data-slot="scroll-area" className={cn('relative', className)} {...props}>
      <Primitive.Viewport
        nonce={getNonce()}
        ref={viewportRef}
        onScroll={onViewportScroll}
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring [&>div]:!block"
      >
        {children}
      </Primitive.Viewport>
      <ScrollBar />
      <ScrollBar orientation="horizontal" />
      <Primitive.Corner />
    </Primitive.Root>
  )
}
export { ScrollArea, ScrollBar }
