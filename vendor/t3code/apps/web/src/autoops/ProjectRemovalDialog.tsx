import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Button } from '~/components/ui/button'
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, DialogFooter } from '~/components/ui/dialog'
import { SettingsSection, SettingsRow } from '~/components/settings/settingsLayout'
import { Spinner } from '~/components/ui/spinner'
import { EllipsisIcon } from 'lucide-react'
import { Menu, MenuTrigger, MenuPopup, MenuItem } from '~/components/ui/menu'
import { toastManager } from '~/components/ui/toast'
import { autoOpsRequest, AutoOpsRequestError, isAutoOpsAccessError } from './apiClient'
import { prepareProjectMutation, readPendingProjectWrite, refreshProjectHost, submitProjectWrite } from './projectDirectory'

export type ProjectRemovalTarget = {
  projectId: string
  name: string
  revision: number
  environmentId?: string
}
type Preview = { canDelete: boolean; revision: number; blockers: Array<{ kind: string; count: number; message: string }>; truncated: boolean }
const pathFor = (target: ProjectRemovalTarget) => `/api/v1/projects/${encodeURIComponent(target.projectId)}${target.environmentId ? `/environments/${encodeURIComponent(target.environmentId)}` : ''}`

export function ProjectRemovalAction({target, disabled, onSelect}: {
  target: ProjectRemovalTarget
  disabled: boolean
  onSelect(target: ProjectRemovalTarget, trigger: HTMLButtonElement): void
}) {
  const trigger = useRef<HTMLButtonElement | null>(null)
  return <Menu>
    <MenuTrigger ref={trigger} render={<Button variant="ghost" size="icon-sm"
      aria-label={`管理${target.environmentId ? '环境' : '项目'} ${target.name}`} disabled={disabled} />}>
      <EllipsisIcon />
    </MenuTrigger>
    <MenuPopup align="end"><MenuItem variant="destructive" onClick={() => {
      if (trigger.current) onSelect(target, trigger.current)
    }}>{target.environmentId ? '删除环境' : '删除项目'}</MenuItem></MenuPopup>
  </Menu>
}

export function ProjectRemovalDialog({ target, finalFocus, onClose, onRemoved, onLockChange, onAccessDenied }: {
  target: ProjectRemovalTarget
  finalFocus: ComponentProps<typeof DialogPopup>['finalFocus']
  onClose(): void
  onRemoved(): void
  onLockChange(value: boolean): void
  onAccessDenied(cause: unknown): void
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(readPendingProjectWrite)
  const [attempt, setAttempt] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const alive = useRef(true)
  const submitting = useRef(false)
  const path = pathFor(target)
  const callbacks = useRef({onClose, onRemoved, onLockChange, onAccessDenied})
  callbacks.current = {onClose, onRemoved, onLockChange, onAccessDenied}
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; callbacks.current.onLockChange(false) }
  }, [])
  useEffect(() => { callbacks.current.onLockChange(busy || !!pending) }, [busy, pending])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void autoOpsRequest<Preview>(`${path}/deletion-preview`, {label: '删除预检', signal: controller.signal})
      .then((result) => { if (!controller.signal.aborted) setPreview(result) })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setPreview(null)
        if (isAutoOpsAccessError(cause)) {
          callbacks.current.onAccessDenied(cause)
          callbacks.current.onClose()
        } else setError(cause instanceof Error ? cause.message : '删除预检未完成')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [path, attempt])
  const changed = preview !== null && preview.revision !== target.revision
  const canRemove = !loading && preview?.canDelete && !changed && !pending
  async function remove() {
    if (submitting.current || (!pending && !canRemove)) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const original = pending ?? prepareProjectMutation(path, target.revision, {}, 'DELETE')
      if (original.path !== path || original.method !== 'DELETE') throw new Error('请先核对另一项配置保存结果')
      setPending(original)
      let result: Record<string, unknown>
      try { result = await submitProjectWrite(original) }
      catch (cause) {
        if (!(cause instanceof AutoOpsRequestError) || !cause.uncertain) throw cause
        result = await submitProjectWrite(original)
      }
      if (!alive.current) return
      setPending(null)
      if (result.deleted === true) toastManager.add({type: 'success', title: '已删除'})
      else if (result.saved === true && result.available === false)
        toastManager.add({type: 'info', title: '操作已保存，当前对象不可访问'})
      else throw new Error('删除结果缺少确认，请刷新后核对原对象')
      setConfirmed(true)
      await refreshProjectHost()
      if (!alive.current) return
      callbacks.current.onRemoved()
    } catch (cause) {
      if (!alive.current) return
      setPending(readPendingProjectWrite())
      if (isAutoOpsAccessError(cause)) {
        callbacks.current.onAccessDenied(cause)
        callbacks.current.onClose()
      } else setError(cause instanceof Error ? cause.message : '删除未完成，请核对原请求')
    } finally {
      submitting.current = false
      if (alive.current) setBusy(false)
    }
  }
  const close = () => confirmed ? onRemoved() : onClose()
  return <Dialog open onOpenChange={(value) => { if (!value && !busy && !pending) close() }}>
    <DialogPopup finalFocus={finalFocus} showCloseButton={!busy && !pending}>
      <DialogHeader><DialogTitle>{target.environmentId ? '删除环境' : '删除项目'}</DialogTitle></DialogHeader>
      <DialogPanel>
        <p className="break-words text-sm">删除“{target.name}”？</p>
        {loading ? <p role="status" className="flex items-center gap-2 text-sm"><Spinner size="sm" />检查引用…</p> : null}
        {preview?.blockers.length ? <SettingsSection title="请先处理下列引用">
          {preview.blockers.map((blocker) => <SettingsRow key={blocker.kind} title={blocker.message} control={<span>{blocker.count}</span>} />)}
          {preview.truncated ? <SettingsRow title="还有其他引用，请处理后刷新核对" /> : null}
        </SettingsSection> : null}
        {changed ? <p role="alert" className="text-sm">配置已更新，请取消并刷新后重新确认。</p> : null}
        {error ? <p role="alert" className="break-words text-sm">{error}</p> : null}
        {pending ? <p role="status" className="text-sm">删除结果尚待确认，请核对原请求。</p> : null}
        {!loading && !pending && !confirmed ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>刷新引用</Button> : null}
        {confirmed ? <Button variant="outline" disabled={busy} onClick={() => {
          setBusy(true)
          void refreshProjectHost().then(() => { if (alive.current) callbacks.current.onRemoved() })
            .catch((cause: unknown) => { if (alive.current) setError(cause instanceof Error ? cause.message : '目录刷新未完成') })
            .finally(() => { if (alive.current) setBusy(false) })
        }}>重试刷新目录</Button> : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" disabled={busy || !!pending} onClick={close}>{confirmed ? '关闭' : '取消'}</Button>
        <Button variant="destructive" disabled={busy || confirmed || (!pending && !canRemove)} onClick={() => void remove()}>
          {busy ? <Spinner size="sm" /> : null}{pending ? '核对原请求' : '确认删除'}
        </Button>
      </DialogFooter>
    </DialogPopup>
  </Dialog>
}
