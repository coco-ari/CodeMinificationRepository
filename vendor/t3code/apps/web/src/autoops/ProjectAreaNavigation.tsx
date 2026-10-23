import { useEffect, useLayoutEffect, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { ArchiveIcon, ChevronDownIcon, FolderGit2Icon, Grid2X2Icon, LogOutIcon, LaptopIcon, MessageSquareIcon, PaletteIcon, RocketIcon, SettingsIcon, SparklesIcon, type LucideIcon } from 'lucide-react'
import { readAutoOpsHost } from './hostConfig'
import {
  autoOpsAreaFromPath, autoOpsProjectHref, rememberAutoOpsChatLocation,
  selectAutoOpsProject, useAutoOpsProjectId, type AutoOpsArea,
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
  Combobox, ComboboxEmpty, ComboboxItem, ComboboxList,
  ComboboxPopup, ComboboxSearchInput, ComboboxTrigger, useComboboxFilter,
} from '~/components/ui/combobox'

const areaIcons = { message: MessageSquareIcon, folder: FolderGit2Icon, rocket: RocketIcon, sparkles: SparklesIcon, laptop: LaptopIcon }
const areas = AUTOOPS_AREAS.map((area) => ({ ...area, icon: areaIcons[area.icon] }))

/** Native route identity wins over browser preferences and page filter queries. */
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
  useEffect(() => { clearSelection() }, [selectedId, clearSelection])
  return null
}

type FunctionItem = { value: string; label: string; icon: LucideIcon } & (
  | { kind: 'area'; area: AutoOpsArea }
  | { kind: 'settings'; href: string }
  | { kind: 'logout' }
)

/** T3 workspace chrome and searchable pickers keep global navigation in one row. */
export function ProjectAreaTopbar() {
  const host = readAutoOpsHost()
  const projectId = useAutoOpsProjectId()
  const location = useLocation()
  const pathname = location.pathname
  const navigate = useNavigate()
  const wide = useMediaQuery('lg')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [functionOpen, setFunctionOpen] = useState(false)
  const [functionQuery, setFunctionQuery] = useState('')
  const [logoutBusy, setLogoutBusy] = useState(false)
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
  const items: FunctionItem[] = [
    ...availableAreas.map((area) => ({ value: area.id, label: area.label, icon: area.icon, kind: 'area' as const, area: area.id })),
    { value: 'settings-general', label: '常规设置', icon: SettingsIcon, kind: 'settings', href: '/settings/general' },
    { value: 'settings-appearance', label: '外观设置', icon: PaletteIcon, kind: 'settings', href: '/settings/appearance' },
    { value: 'settings-archived', label: '归档对话', icon: ArchiveIcon, kind: 'settings', href: '/settings/archived' },
    { value: 'logout', label: '退出登录', icon: LogOutIcon, kind: 'logout' },
  ]
  const filteredFunctions = items.filter((item) => filter.contains(item.label, functionQuery))
  const currentFunction = items.find((item) => settings
    ? item.kind === 'settings' && item.href === pathname
    : item.kind === 'area' && item.area === currentArea) ?? null
  const currentLabel = settings ? '设置' : areas.find((area) => area.id === currentArea)?.label ?? '选择模块'
  const reportFailure = (error: unknown) => toastManager.add({ type: 'error', title: '操作未完成', description: error instanceof Error ? error.message : '请重试。' })
  const navigateTo = (href: string) => { void navigate({ href }).catch(reportFailure) }
  const go = (area: AutoOpsArea, nextProjectId = projectId) => {
    if (!nextProjectId) {
      const definition = areas.find((entry) => entry.id === area)
      if (definition?.scope === 'global') navigateTo(definition.path)
      return
    }
    selectAutoOpsProject(nextProjectId)
    navigateTo(autoOpsProjectHref(area, nextProjectId,
      area === 'skills' && currentArea === 'skills' ? location.search : undefined))
  }
  const chooseFunction = (item: FunctionItem) => {
    if (item.kind === 'area') go(item.area)
    else if (item.kind === 'settings') navigateTo(item.href)
    else {
      setLogoutBusy(true)
      void fetch('/api/agent-demo/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Demo-CSRF': host.csrfToken }, body: '{}' })
        .then((response) => {
          if (!response.ok) throw new Error('退出登录失败，请重试。')
          window.location.replace('/agent-demo.html')
        }).catch(reportFailure).finally(() => setLogoutBusy(false))
    }
  }
  return (
    <WorkspacePageHeader reserveSidebarControl={false} className="relative z-30 w-full min-w-0 gap-2 border-b border-border/60 pl-3! pr-3!" data-testid="project-area-navigation" aria-label="项目与功能导航">
      {settings || areas.find((area) => area.id === currentArea)?.sidebar ? <SidebarTrigger aria-label="切换主侧栏" /> : null}
      <span className="hidden shrink-0 text-sm font-semibold sm:block">AutoOps</span>
      <div className="min-w-0 flex-1 sm:max-w-56">
      <Combobox
        items={host.projects} filteredItems={filtered} autoHighlight aria-label="搜索项目"
        itemToStringLabel={(project) => project.name}
        isItemEqualToValue={(left, right) => left.id === right.id}
        value={selected} open={open}
        onOpenChange={(value) => { setOpen(value); if (!value) setQuery('') }}
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
        <ComboboxTrigger render={<Button variant="ghost" size="sm" aria-label="切换项目" className="w-full min-w-0 justify-start" />}>
          <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">{selected?.name ?? '选择项目'}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </ComboboxTrigger>
        <ComboboxPopup align="start" className="max-w-[min(22rem,var(--available-width))]">
          <ComboboxSearchInput aria-label="搜索项目" placeholder="搜索项目…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <ComboboxEmpty>没有匹配的项目。</ComboboxEmpty>
          <ComboboxList>{(project: typeof host.projects[number]) => <ComboboxItem key={project.id} value={project}>
            <FolderGit2Icon className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{project.name}</span>
          </ComboboxItem>}</ComboboxList>
        </ComboboxPopup>
      </Combobox>
      </div>
      {wide ? <nav aria-label="常用模块" className="min-w-0 shrink-0">
        <ToggleGroup variant="segmented" aria-label="项目功能" value={settings || !commonAreas.some((area) => area.id === currentArea) ? [] : [currentArea]} onValueChange={(value) => { const area = commonAreas.find((entry) => entry.id === value[0]); if (area) go(area.id) }}>
          {commonAreas.map((area) => <Toggle key={area.id} value={area.id} aria-label={area.label} aria-current={!settings && currentArea === area.id ? 'page' : undefined} disabled={!projectId}><area.icon /><span>{area.label}</span></Toggle>)}
        </ToggleGroup>
      </nav> : null}
      <div className="hidden flex-1 sm:block" />
      <Combobox<FunctionItem> items={items} filteredItems={filteredFunctions} aria-label="搜索功能" autoHighlight
        itemToStringLabel={(item) => item.label} isItemEqualToValue={(left, right) => left.value === right.value}
        value={currentFunction} open={functionOpen}
        onOpenChange={(value) => { setFunctionOpen(value); if (!value) setFunctionQuery('') }}
        onValueChange={(item) => { if (item) chooseFunction(item) }}>
        <ComboboxTrigger render={<Button size="sm" variant="ghost" aria-label={wide ? '更多功能' : '切换模块'} disabled={logoutBusy} className="max-w-40 min-w-0 shrink-0" />}>
          {wide ? <Grid2X2Icon /> : null}<span className="truncate">{wide ? '更多功能' : currentLabel}</span><ChevronDownIcon className="size-3.5 shrink-0" />
        </ComboboxTrigger>
        <ComboboxPopup align="end" className="w-64 max-w-(--available-width)">
          <ComboboxSearchInput aria-label="搜索功能" placeholder="搜索功能…" value={functionQuery} onChange={(event) => setFunctionQuery(event.target.value)} />
          <ComboboxEmpty>没有匹配的功能。</ComboboxEmpty>
          <ComboboxList>{(item: FunctionItem) => <ComboboxItem key={item.value} value={item} disabled={item.kind === 'area' && !projectId && areas.find((area) => area.id === item.area)?.scope !== 'global'}>
            <item.icon className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{item.label}</span>
          </ComboboxItem>}</ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </WorkspacePageHeader>
  )
}
