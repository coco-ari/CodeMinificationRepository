import { useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '~/components/ui/dialog'
import type { DeploymentSourceIdentity } from '../deployments'

export function DeploymentSourceDetails({
  source,
  label = '查看来源',
}: {
  source: Partial<DeploymentSourceIdentity>
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  return (
    <>
      <Button ref={trigger} size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup finalFocus={() => trigger.current}>
          <DialogHeader>
            <DialogTitle>部署源码来源</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <dl className="space-y-3 text-sm">
              {(source.repositories ?? []).map((repository) => (
                <div key={repository.path}>
                  <dt className="break-all text-muted-foreground">
                    {repository.path || '仓库根目录'}
                  </dt>
                  <dd className="break-all font-mono text-xs">{repository.commit}</dd>
                </div>
              ))}
              <div>
                <dt className="text-muted-foreground">源码包</dt>
                <dd className="break-all font-mono text-xs">
                  {source.packageId ?? '历史记录未提供'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">内容摘要</dt>
                <dd className="break-all font-mono text-xs">
                  {source.contentHash ?? '历史记录未提供'}
                </dd>
              </div>
            </dl>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  )
}
