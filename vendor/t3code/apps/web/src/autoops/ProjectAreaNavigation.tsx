import { useEffect, useLayoutEffect, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import {
  ChevronDownIcon,
  BotIcon,
  FolderGit2Icon,
  MessageSquareIcon,
  RocketIcon,
  SparklesIcon,
  UsersIcon,
} from 'lucide-react'
import { readAutoOpsHost, useAutoOpsHost } from './hostConfig'
import {
  autoOpsAreaFromPath,
  autoOpsProjectHref,
  rememberAutoOpsChatLocation,
  selectAutoOpsProject,
  useAutoOpsProjectId,
  type AutoOpsArea,
} from './projectNavigation'
import { AUTOOPS_AREAS, autoOpsAreaAvailable } from './projectNavigation.logic'
import { useThreadRouteTarget } from '~/hooks/useThreadRouteTarget'
import { useThreadSelectionStore } from '~/threadSelectionStore'
import { Button } from '~/components/ui/button'
import { WorkspacePageHeader } from '~/components/WorkspacePageHeader'
import { SidebarTrigger } from '~/components/ui/sidebar'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { toastManager } from '~/components/ui/toast'
import { useMediaQuery } from '~/hooks/useMediaQuery'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from '~/components/ui/combobox'

const areaIcons = {
  message: MessageSquareIcon,
  folder: FolderGit2Icon,
  rocket: RocketIcon,
  sparkles: SparklesIcon,
  bot: BotIcon,
  folderSettings: FolderGit2Icon,
  users: UsersIcon,
}
const areas = AUTOOPS_AREAS.map((area) => ({ ...area, icon: areaIcons[area.icon] }))

/** 原生路由归属优先于浏览偏好及页面筛选参数。 */
export function AutoOpsProjectRouteSync() {
  const location = useLocation()
  const selectedId = useAutoOpsProjectId()
  const route = useThreadRouteTarget()
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection)
  useLayoutEffect(() => {
    const host = readAutoOpsHost()
    if (!host) return
    const projectId = selectedId
    if (!projectId || !host.projects.some((project) => project.id === projectId)) return
    selectAutoOpsProject(projectId)
    if (route) rememberAutoOpsChatLocation(projectId, location.href)
  }, [location.href, selectedId, route?.kind])
  useEffect(() => {
    clearSelection()
  }, [selectedId, clearSelection])
  return null
}

type FunctionItem = (typeof areas)[number]

/** 项目与模块集中排列，切换继续使用原生搜索和焦点流程。 */
export function ProjectAreaTopbar() {
  const host = useAutoOpsHost()
  const projectId = useAutoOpsProjectId()
  const location = useLocation()
  const pathname = location.pathname
  const navigate = useNavigate()
  const wide = useMediaQuery('lg')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [functionOpen, setFunctionOpen] = useState(false)
  const [functionQuery, setFunctionQuery] = useState('')
  const filter = useComboboxFilter()
  useEffect(() => {
    setOpen(false)
    setQuery('')
    setFunctionOpen(false)
    setFunctionQuery('')
  }, [projectId, pathname, wide])
  if (!host) return null
  const selected = host.projects.find((project) => project.id === projectId) ?? null
  const currentArea = autoOpsAreaFromPath(pathname)
  const settings = pathname === '/settings' || pathname.startsWith('/settings/')
  const filtered = host.projects.filter((project) => filter.contains(project.name, query))
  const availableAreas = areas.filter((area) => autoOpsAreaAvailable(area.id, host, projectId))
  const commonAreas = availableAreas.filter((area) => area.common)
  const items = availableAreas.filter((area) => !wide || !area.common)
  const filteredFunctions = items.filter((item) => filter.contains(item.label, functionQuery))
  const currentFunction = settings ? null : (items.find((item) => item.id === currentArea) ?? null)
  const currentLabel = settings
    ? '设置'
    : (areas.find((area) => area.id === currentArea)?.label ?? '选择模块')
  const reportFailure = (error: unknown) =>
    toastManager.add({
      type: 'error',
      title: '操作未完成',
      description: error instanceof Error ? error.message : '请重试。',
    })
  const navigateTo = (href: string) => {
    void navigate({ href }).catch(reportFailure)
  }
  const go = (area: AutoOpsArea, nextProjectId = projectId) => {
    if (!nextProjectId) {
      const definition = areas.find((entry) => entry.id === area)
      if (definition?.scope === 'global') navigateTo(definition.path)
      return
    }
    selectAutoOpsProject(nextProjectId)
    navigateTo(
      autoOpsProjectHref(
        area,
        nextProjectId,
        (area === 'skills' && currentArea === 'skills') ||
          (area === 'assistants' && currentArea === 'assistants')
          ? location.search
          : undefined,
      ),
    )
  }
  return (
    <WorkspacePageHeader
      reserveSidebarControl={false}
      className="relative z-30 w-full min-w-0 gap-2 border-b border-border/60 pl-3! pr-3!"
      data-testid="project-area-navigation"
      aria-label="项目与功能导航"
    >
      {settings || areas.find((area) => area.id === currentArea)?.sidebar ? (
        <SidebarTrigger aria-label="切换主侧栏" />
      ) : null}
      <span className="hidden shrink-0 text-sm font-semibold sm:block">AutoOps</span>
      <div className="min-w-0 flex-1 sm:max-w-52 sm:flex-none">
        <Combobox
          items={host.projects}
          filteredItems={filtered}
          autoHighlight
          aria-label="搜索项目"
          itemToStringLabel={(project) => project.name}
          isItemEqualToValue={(left, right) => left.id === right.id}
          value={selected}
          open={open}
          onOpenChange={(value) => {
            setOpen(value)
            if (!value) setQuery('')
          }}
          onValueChange={(project) => {
            if (!project || project.id === projectId) return
            if (settings) {
              selectAutoOpsProject(project.id)
              if (Object.hasOwn(location.search, 'projectId')) {
                const url = new URL(location.href, 'https://autoops.invalid')
                url.searchParams.delete('projectId')
                navigateTo(url.pathname + url.search)
              }
              return
            }
            const nextArea = autoOpsAreaAvailable(currentArea, host, project.id)
              ? currentArea
              : AUTOOPS_AREAS.find((area) => autoOpsAreaAvailable(area.id, host, project.id))?.id
            if (nextArea) go(nextArea, project.id)
          }}
        >
          <ComboboxTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label="切换项目"
                className="w-full min-w-0 justify-start"
              />
            }
          >
            <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">
              {selected?.name ?? '选择项目'}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </ComboboxTrigger>
          <ComboboxPopup align="start" className="max-w-[min(22rem,var(--available-width))]">
            <ComboboxSearchInput
              aria-label="搜索项目"
              placeholder="搜索项目…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ComboboxEmpty>没有匹配的项目。</ComboboxEmpty>
            <ComboboxList>
              {(project: (typeof host.projects)[number]) => (
                <ComboboxItem key={project.id} value={project}>
                  <FolderGit2Icon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                </ComboboxItem>
              )}
            </ComboboxList>
            <div className="border-t p-1">
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { setOpen(false); navigateTo('/projects') }}>项目管理</Button>
            </div>
          </ComboboxPopup>
        </Combobox>
      </div>
      <div className="hidden h-5 w-px shrink-0 bg-border lg:block" aria-hidden="true" />
      {wide ? (
        <nav aria-label="常用模块" className="min-w-0 shrink-0">
          <ToggleGroup
            variant="segmented"
            aria-label="项目功能"
            value={
              settings || !commonAreas.some((area) => area.id === currentArea) ? [] : [currentArea]
            }
            onValueChange={(value) => {
              const area = commonAreas.find((entry) => entry.id === value[0])
              if (area) go(area.id)
            }}
          >
            {commonAreas.map((area) => (
              <Toggle
                key={area.id}
                value={area.id}
                aria-label={area.label}
                aria-current={!settings && currentArea === area.id ? 'page' : undefined}
                disabled={!projectId && area.scope === 'project'}
              >
                <area.icon />
                <span>{area.label}</span>
              </Toggle>
            ))}
          </ToggleGroup>
        </nav>
      ) : null}
      {items.length > 0 ? (
        <Combobox<FunctionItem>
          items={items}
          filteredItems={filteredFunctions}
          aria-label="搜索功能"
          autoHighlight
          itemToStringLabel={(item) => item.label}
          isItemEqualToValue={(left, right) => left.id === right.id}
          value={currentFunction}
          open={functionOpen}
          onOpenChange={(value) => {
            setFunctionOpen(value)
            if (!value) setFunctionQuery('')
          }}
          onValueChange={(item) => {
            if (item) go(item.id)
          }}
        >
          <ComboboxTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                aria-label={wide ? '更多功能' : '切换模块'}
                className="max-w-40 min-w-0 shrink-0"
              />
            }
          >
            {wide && currentFunction ? <currentFunction.icon /> : null}
            <span className="truncate">
              {wide ? (currentFunction?.label ?? '更多') : currentLabel}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0" />
          </ComboboxTrigger>
          <ComboboxPopup align="end" className="w-64 max-w-(--available-width)">
            <ComboboxSearchInput
              aria-label="搜索功能"
              placeholder="搜索功能…"
              value={functionQuery}
              onChange={(event) => setFunctionQuery(event.target.value)}
            />
            <ComboboxEmpty>没有匹配的功能。</ComboboxEmpty>
            <ComboboxList>
              {(item: FunctionItem) => (
                <ComboboxItem
                  key={item.id}
                  value={item}
                  disabled={!projectId && item.scope !== 'global'}
                >
                  <item.icon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      ) : null}
    </WorkspacePageHeader>
  )
}
