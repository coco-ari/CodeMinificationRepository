import * as React from 'react'
import { Accordion as Primitive } from 'radix-ui'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
const Accordion = Primitive.Root
function AccordionItem({ className, ...props }: React.ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item className={cn('border-b last:border-b-0', className)} {...props} />
}
function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Header className="flex">
      <Primitive.Trigger
        className={cn(
          'flex flex-1 items-center justify-between gap-4 py-3 text-left text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring [&[data-state=open]>svg]:rotate-180',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform" />
      </Primitive.Trigger>
    </Primitive.Header>
  )
}
function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Content className="overflow-hidden text-sm" {...props}>
      <div className={cn('space-y-4 pb-4', className)}>{children}</div>
    </Primitive.Content>
  )
}
export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
