import * as React from 'react'
import { Command as Primitive } from 'cmdk'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
function Command({ className, ...props }: React.ComponentProps<typeof Primitive>) {
  return (
    <Primitive
      data-slot="command"
      className={cn(
        'flex w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
        className,
      )}
      {...props}
    />
  )
}
function CommandInput({ className, ...props }: React.ComponentProps<typeof Primitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b px-3">
      <Search className="size-4 shrink-0 opacity-50" />
      <Primitive.Input
        className={cn(
          'h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground',
          className,
        )}
        {...props}
      />
    </div>
  )
}
function CommandList({ className, ...props }: React.ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className={cn('max-h-64 overflow-x-hidden overflow-y-auto', className)}
      {...props}
    />
  )
}
function CommandEmpty(props: React.ComponentProps<typeof Primitive.Empty>) {
  return <Primitive.Empty className="py-6 text-center text-sm text-muted-foreground" {...props} />
}
function CommandGroup({ className, ...props }: React.ComponentProps<typeof Primitive.Group>) {
  return <Primitive.Group className={cn('p-1', className)} {...props} />
}
function CommandItem({ className, ...props }: React.ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem }
