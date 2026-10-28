import type { ReactNode } from 'react'
import { Button } from '~/components/ui/button'

const areas = [
  { id: 'general', label: '基本信息', manage: false },
  { id: 'environments', label: '环境', manage: false },
  { id: 'git', label: '仓库与凭证', manage: true },
  { id: 'access', label: '助手与成员', manage: true },
] as const

type ProjectSettingsArea = (typeof areas)[number]['id']
const targetId = (area: ProjectSettingsArea) => `project-settings-${area}`

export function focusProjectSettingsArea(area: ProjectSettingsArea) {
  const target = document.getElementById(targetId(area))
  // 只定位已挂载分组，避免切页卸载未确认的保存或凭证表单。
  target?.scrollIntoView({ block: 'start' })
  target?.focus({ preventScroll: true })
}

export function ProjectSettingsNavigation({ canManage, returnAction }: { canManage: boolean; returnAction?: ReactNode }) {
  return (
    <nav aria-label="项目配置分组" className="shrink-0 border-b border-border/60">
      <div className="mx-auto flex max-w-4xl flex-wrap gap-1 px-5 py-2 sm:px-6">
        {returnAction}
        {areas
          .filter((area) => !area.manage || canManage)
          .map((area) => (
            <Button
              key={area.id}
              variant="ghost-muted"
              size="sm"
              aria-controls={targetId(area.id)}
              onClick={() => focusProjectSettingsArea(area.id)}
            >
              {area.label}
            </Button>
          ))}
      </div>
    </nav>
  )
}

export function ProjectSettingsTarget({
  area,
  children,
}: {
  area: ProjectSettingsArea
  children: ReactNode
}) {
  return (
    <div
      id={targetId(area)}
      tabIndex={-1}
      role="region"
      aria-label={areas.find((item) => item.id === area)!.label}
      className="min-w-0 scroll-mt-6 space-y-6"
    >
      {children}
    </div>
  )
}
