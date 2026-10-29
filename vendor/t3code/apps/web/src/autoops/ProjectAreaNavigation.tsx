import { useEffect, useLayoutEffect, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import {
  ChevronDownIcon,
  LayoutGridIcon,
  ServerIcon,
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
import {
  AUTOOPS_AREAS,
  AUTOOPS_GLOBAL_AREAS,
  autoOpsGlobalArea,
  autoOpsGlobalAreaAvailable,
  autoOpsAreaAvailable,
} from './projectNavigation.logic'
import { useThreadRouteTarget } from '~/hooks/useThreadRouteTarget'
import { useThreadSelectionStore } from '~/threadSelectionStore'
import { Button } from '~/components/ui/button'
import { WorkspacePageHeader } from '~/components/WorkspacePageHeader'
import { SidebarTrigger } from '~/components/ui/sidebar'
import { ProjectModuleNavigation } from './ProjectModuleNavigation'
import { toastManager } from '~/components/ui/toast'
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
  server: ServerIcon,
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

/** 项目与模块集中排列，切换继续使用原生搜索和焦点流程。 */
export function ProjectAreaTopbar() {
  const host = useAutoOpsHost()
  const projectId = useAutoOpsProjectId()
  const location = useLocation()
  const pathname = location.pathname
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const filter = useComboboxFilter()
  useEffect(() => {
    setOpen(false)
    setQuery('')
  }, [projectId, pathname])
  if (!host) return null
  const selected = host.projects.find((project) => project.id === projectId) ?? null
  const currentArea = autoOpsAreaFromPath(pathname)
  const globalArea = autoOpsGlobalArea(pathname, location.search)
  const settings = globalArea === 'settings'
  const filtered = host.projects.filter((project) => filter.contains(project.name, query))
  const availableAreas = areas.filter(
    (area) => area.scope === 'project' && autoOpsAreaAvailable(area.id, host, projectId),
  )
  const globalAreas = AUTOOPS_GLOBAL_AREAS.filter((area) =>
    autoOpsGlobalAreaAvailable(area.id, host),
  ).map((area) => ({ ...area, icon: areaIcons[area.icon] }))
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
      {globalArea || areas.find((area) => area.id === currentArea)?.sidebar ? (
        <SidebarTrigger aria-label="切换主侧栏" />
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        aria-label="全局工作台"
        title="全局工作台"
        onClick={() => navigateTo('/projects')}
      >
        <LayoutGridIcon />
        <span className="hidden xl:inline">工作台</span>
      </Button>
      <div className="w-52 max-w-[38%] min-w-0 shrink-0">
        <Combobox
          items={host.projects}
          filteredItems={filtered}
          autoHighlight
          aria-label="搜索项目"
          itemToStringLabel={(project) => project.name}
          isItemEqualToValue={(left, right) => left.id === right.id}
          value={globalArea ? null : selected}
          open={open}
          onOpenChange={(value) => {
            setOpen(value)
            if (!value) setQuery('')
          }}
          onValueChange={(project) => {
            if (!project || (!globalArea && project.id === projectId)) return
            if (globalArea) {
              go('projects', project.id)
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
                title={globalArea ? '进入项目' : (selected?.name ?? '选择项目')}
                className="w-full min-w-0 justify-start"
              />
            }
          >
            <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">
              {globalArea ? '进入项目' : (selected?.name ?? '选择项目')}
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
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setOpen(false)
                  navigateTo('/projects')
                }}
              >
                全部项目
              </Button>
            </div>
          </ComboboxPopup>
        </Combobox>
      </div>
      <div className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
      {globalArea ? (
        <ProjectModuleNavigation
          label="全局功能"
          contextKey="global"
          items={globalAreas}
          current={globalArea === 'settings' ? null : globalArea}
          currentLabel={globalAreas.find((area) => area.id === globalArea)?.label ?? '设置'}
          onNavigate={(id) => {
            const area = globalAreas.find((area) => area.id === id)
            if (area) navigateTo(area.href)
          }}
        />
      ) : (
        <ProjectModuleNavigation
          contextKey={projectId}
          items={availableAreas.toSorted((a, b) => Number(b.common) - Number(a.common) || (a.id === 'projects' ? 1 : b.id === 'projects' ? -1 : 0))}
          current={currentArea}
          currentLabel={currentLabel}
          onNavigate={go}
        />
      )}
    </WorkspacePageHeader>
  )
}
