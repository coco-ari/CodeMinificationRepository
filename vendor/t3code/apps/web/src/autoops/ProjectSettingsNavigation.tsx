import { useEffect, useState, type ReactNode } from 'react'
import { ModuleSidebarItem } from './ModuleWorkspace'
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

export function ProjectSettingsNavigation({
  canManage,
  returnAction,
  sidebar = false,
  returnOnly = false,
}: {
  canManage: boolean
  returnAction?: ReactNode
  sidebar?: boolean
  returnOnly?: boolean
}) {
  const [active, setActive] = useState<ProjectSettingsArea>('general')
  useEffect(() => {
    if (!sidebar) return
    const update = () => {
      const container = document.querySelector('[data-project-settings-scroll]')
      if (!container) return
      const top = container.getBoundingClientRect().top + 48
      const visible = areas.filter((area) => document.getElementById(targetId(area.id)))
      const current = visible.findLast(
        (area) => document.getElementById(targetId(area.id))!.getBoundingClientRect().top <= top,
      )
      setActive(current?.id ?? 'general')
    }
    document.addEventListener('scroll', update, true)
    return () => document.removeEventListener('scroll', update, true)
  }, [sidebar])
  if (sidebar)
    return (
      <nav aria-label="项目配置分组">
        {areas
          .filter((area) => !area.manage || canManage)
          .map((area) => (
            <ModuleSidebarItem
              key={area.id}
              label={area.label}
              selected={active === area.id}
              onClick={() => focusProjectSettingsArea(area.id)}
            />
          ))}
      </nav>
    )
  return (
    <nav aria-label="项目配置分组" className="shrink-0 border-b border-border/60">
      <div className="mx-auto flex max-w-4xl flex-wrap gap-1 px-5 py-2 sm:px-6">
        {returnAction}
        {(returnOnly ? [] : areas)
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
