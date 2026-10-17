import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { useConsole, date } from '@/lib/console'
import { Notice } from './shared'

const states = {
  pending: '待下发',
  waiting: '等待任务结束',
  applying: '正在清理',
  applied: '已应用',
  failed: '清理未完成',
  unsupported: '需要更新 Agent',
}
const gib = (bytes) =>
  Number.isFinite(bytes) ? (bytes / 1024 ** 3).toFixed(2) + ' GiB' : '尚未采集'

export function StoragePolicy({ server, editable = true }) {
  const { request, refresh, notify, find } = useConsole()
  const [open, setOpen] = useState(false)
  const [retained, setRetained] = useState(2)
  const [cache, setCache] = useState(2)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const policy = server.storagePolicy || { retainedVersions: 2, buildCacheGiB: 2 }
  const report = server.storageStatus
  const edit = () => {
    setRetained(policy.retainedVersions)
    setCache(policy.buildCacheGiB)
    setError('')
    setOpen(true)
  }
  async function save(event) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await request(
        '/api/deploy/servers/' + server.id + '/storage-policy',
        { retainedVersions: Number(retained), buildCacheGiB: Number(cache) },
        'PUT',
      )
      await refresh()
      setOpen(false)
      notify('策略已保存，Agent 将在空闲时执行')
    } catch (failure) {
      setError(failure.message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
        <span className="text-muted-foreground">
          保留 {policy.retainedVersions} 个版本 · 构建缓存 {policy.buildCacheGiB} GiB
        </span>
        {editable && !server.revoked ? (
          <Button variant="ghost" size="sm" onClick={edit}>
            存储策略
          </Button>
        ) : null}
        <Badge variant={server.storageState === 'failed' ? 'destructive' : 'secondary'}>
          {states[server.storageState] || '待下发'}
          {!server.online && !server.revoked ? ' · 离线' : ''}
        </Badge>
      </div>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!saving) setOpen(next)
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>存储策略</SheetTitle>
            <SheetDescription>{server.name} · 对这台服务器的所有部署位置生效</SheetDescription>
          </SheetHeader>
          <form onSubmit={save} className="space-y-6 px-4 pb-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="storage-retained">本机保留成功版本数</FieldLabel>
                <Input
                  id="storage-retained"
                  type="number"
                  min="2"
                  max="20"
                  required
                  value={retained}
                  onChange={(e) => setRetained(e.target.value)}
                />
                <FieldDescription>
                  按每个部署位置成功发布链条的最后 N
                  个节点保留。成功回退计入，重启和失败不计入；更早版本从中心源码包重建。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="storage-cache">平台 Docker 构建缓存（GiB）</FieldLabel>
                <Input
                  id="storage-cache"
                  type="number"
                  min="1"
                  max="20"
                  required
                  value={cache}
                  onChange={(e) => setCache(e.target.value)}
                />
                <FieldDescription>
                  专用构建器空闲清理后的目标容量。构建期间可能暂时超过，不包含业务镜像、Maven/npm
                  依赖缓存和日志。
                </FieldDescription>
              </Field>
            </FieldGroup>
            {error && <Notice error>{error}</Notice>}
            <Button type="submit" disabled={saving}>
              {saving ? '保存中…' : '保存并下发'}
            </Button>
            <div className="space-y-3 border-t pt-4 text-sm">
              <p className="font-medium">执行情况 · {states[server.storageState] || '待下发'}</p>
              <p className="text-muted-foreground">最近检查：{date(report?.checkedAt)}</p>
              <p>
                构建缓存：{gib(report?.cache?.bytes)} · 最近回收：
                {gib(report?.cache?.reclaimedBytes)}
              </p>
              {(report?.targets || []).map((target) => (
                <div key={target.targetId} className="flex justify-between gap-3">
                  <span className="min-w-0 break-all">
                    {find('services', find('targets', target.targetId)?.serviceId)?.name ||
                      target.targetId}
                  </span>
                  <span className="shrink-0">保留 {target.retainedNodes} 个节点</span>
                </div>
              ))}
              {(report?.errors || []).map((message, index) => (
                <Notice error key={index}>
                  {message}
                </Notice>
              ))}
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  )
}
