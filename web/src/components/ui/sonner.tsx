import { Toaster as Sonner, type ToasterProps } from 'sonner'
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: 'glass-toast !text-popover-foreground',
          description: '!text-muted-foreground',
        },
      }}
      {...props}
    />
  )
}
