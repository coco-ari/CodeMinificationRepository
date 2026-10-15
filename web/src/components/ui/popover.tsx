import * as React from 'react'
import { Popover as Primitive } from 'radix-ui'
import { cn } from '@/lib/utils'
const Popover = Primitive.Root
const PopoverTrigger = Primitive.Trigger
function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}
export { Popover, PopoverTrigger, PopoverContent }
