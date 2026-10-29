import type { ComponentProps, ReactNode } from 'react'
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from '~/components/ui/dialog'

/** 首次配置与就地编辑共用表单，完整页面不创建浮层或第二套焦点边界。 */
export function ConfigurationDialog({
  embedded,
  ...props
}: Omit<ComponentProps<typeof Dialog>, 'children'> & {
  children?: ReactNode
  embedded?: boolean | undefined
}) {
  return embedded ? (
    <section className="min-w-0" aria-label="服务配置表单">
      {props.children}
    </section>
  ) : (
    <Dialog {...props} />
  )
}
export function ConfigurationPopup({
  embedded,
  ...props
}: ComponentProps<typeof DialogPopup> & { embedded?: boolean | undefined }) {
  return embedded ? <div className="min-w-0">{props.children}</div> : <DialogPopup {...props} />
}
export function ConfigurationHeader({
  embedded,
  ...props
}: ComponentProps<typeof DialogHeader> & { embedded?: boolean | undefined }) {
  return embedded ? <div className="px-4 py-3">{props.children}</div> : <DialogHeader {...props} />
}
export function ConfigurationTitle({
  embedded,
  ...props
}: ComponentProps<typeof DialogTitle> & { embedded?: boolean | undefined }) {
  return embedded ? (
    <h2 className="text-sm font-medium">{props.children}</h2>
  ) : (
    <DialogTitle {...props} />
  )
}
export function ConfigurationPanel({
  embedded,
  ...props
}: ComponentProps<typeof DialogPanel> & { embedded?: boolean | undefined }) {
  return embedded ? (
    <div className="space-y-4 px-4 pb-4">{props.children}</div>
  ) : (
    <DialogPanel {...props} />
  )
}
export function ConfigurationFooter({
  embedded,
  ...props
}: ComponentProps<typeof DialogFooter> & { embedded?: boolean | undefined }) {
  return embedded ? (
    <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 px-4 py-3">
      {props.children}
    </div>
  ) : (
    <DialogFooter {...props} />
  )
}
