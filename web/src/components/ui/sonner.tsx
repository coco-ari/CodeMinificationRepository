import { Toaster as Sonner, type ToasterProps } from 'sonner'
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: '!bg-popover !text-popover-foreground !border-border !rounded-lg !shadow-lg',
          description: '!text-muted-foreground',
        },
      }}
      {...props}
    />
  )
}
