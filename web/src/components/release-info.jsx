import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion'
import { Commit } from './workspace-home'
import { date, short } from '@/lib/console'

export function archiveLabel(release) {
  if (release.archiveStatus === 'available') return '中心源码可重建'
  const state =
    release.archiveStatus === 'invalid'
      ? '源码校验失败'
      : release.archiveStatus === 'cleared'
        ? '源码已清理'
        : '中心源码缺失'
  return state + (release.available ? ' · 仅可核验本机缓存' : ' · 不可回退')
}

export function ReleaseInfo({ release, selectable = false, badge }) {
  return (
    <span className="block min-w-0 flex-1 text-left">
      <span className="flex flex-wrap items-center gap-2">
        {selectable ? (
          <span className="min-w-0 break-words font-medium">
            {release.commitSubject || '无提交说明'}
          </span>
        ) : (
          <Commit value={release.revision} subject={release.commitSubject} summary />
        )}
        {badge}
      </span>
      <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground">
        {selectable && <code>{short(release.revision)}</code>}
        <span className="break-all">{release.sourceSnapshot?.branch || '历史分支未记录'}</span>
        <span>发布于 {date(release.createdAt)}</span>
      </span>
      <span className="mt-1 block text-xs font-normal text-muted-foreground">
        {archiveLabel(release)}
      </span>
    </span>
  )
}

export function ReleaseBuildDetails({ release }) {
  const build = release.buildSnapshot || {}
  return (
    <Accordion type="single" collapsible className="mt-2">
      <AccordionItem value="build" className="border-0">
        <AccordionTrigger className="justify-start gap-2 py-2 text-xs">
          版本与构建明细
        </AccordionTrigger>
        <AccordionContent>
          <dl className="space-y-2 text-xs">
            {[
              ['版本 ID', release.id],
              ['来源版本', release.restoredFromReleaseId],
              ['完整提交', release.revision],
              ['构建镜像', build.buildImage],
              ['运行镜像', build.runtimeImage],
              ['Maven', build.mavenVersion],
              [
                '包管理器',
                build.packageManagerVersion
                  ? `${build.packageManager} ${build.packageManagerVersion}`
                  : null,
              ],
            ]
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-all font-mono">{value}</dd>
                </div>
              ))}
          </dl>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
