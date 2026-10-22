import { useEffect, useLayoutEffect, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon, FolderGit2Icon, MessageSquareIcon, RocketIcon } from 'lucide-react'
import { readAutoOpsHost } from './hostConfig'
import {
  autoOpsAreaFromPath, autoOpsProjectHref, rememberAutoOpsChatLocation,
  selectAutoOpsProject, useAutoOpsProjectId,
} from './projectNavigation'
import { useThreadRouteTarget } from '~/hooks/useThreadRouteTarget'
import { useThreadSelectionStore } from '~/threadSelectionStore'
import { SidebarChromeFooter, SidebarChromeHeader } from '~/components/sidebar/SidebarChrome'
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import {
  Combobox, ComboboxEmpty, ComboboxItem, ComboboxList,
  ComboboxPopup, ComboboxSearchInput, ComboboxTrigger, useComboboxFilter,
} from '~/components/ui/combobox'
import { isElectron } from '~/env'

const areas = [
  { id: 'chat', label: '问答', icon: MessageSquareIcon },
  { id: 'workspaces', label: '工作区', icon: FolderGit2Icon },
  { id: 'deployments', label: '部署发布', icon: RocketIcon },
] as const

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

/** T3's project Combobox and SettingsSidebarNav compose one business navigation. */
export function ProjectAreaNavigation() {
  const host = readAutoOpsHost()
  const projectId = useAutoOpsProjectId()
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const filter = useComboboxFilter()
  if (!host) return null
  const selected = host.projects.find((project) => project.id === projectId) ?? null
  const currentArea = autoOpsAreaFromPath(pathname)
  const canDeploy = selected?.membership?.workspaceAccess === 'internal' && selected.membership.role === 'manager'
  const filtered = host.projects.filter((project) => filter.contains(project.name, query))
  const go = (area: typeof areas[number]['id'], nextProjectId = projectId) => {
    if (!nextProjectId) return
    selectAutoOpsProject(nextProjectId)
    if (isMobile) setOpenMobile(false)
    void navigate({ href: autoOpsProjectHref(area, nextProjectId) })
  }
  return (
    <SidebarGroup className="shrink-0 gap-2 border-b border-sidebar-border/60 pb-3" data-testid="project-area-navigation">
      <Combobox
        items={host.projects} filteredItems={filtered} autoHighlight aria-label="搜索项目"
        itemToStringLabel={(project) => project.name}
        isItemEqualToValue={(left, right) => left.id === right.id}
        value={selected} open={open}
        onOpenChange={(value) => { setOpen(value); if (!value) setQuery('') }}
        onValueChange={(project) => {
          if (!project || project.id === projectId) return
          const allowedDeployment = project.membership?.workspaceAccess === 'internal' && project.membership.role === 'manager'
          go(currentArea === 'deployments' && !allowedDeployment ? 'workspaces' : currentArea, project.id)
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
      <SidebarMenu aria-label="项目功能">
        {areas.filter((area) => area.id !== 'deployments' || canDeploy).map((area) => <SidebarMenuItem key={area.id}>
          <SidebarMenuButton aria-label={area.label} aria-current={currentArea === area.id ? 'page' : undefined} isActive={currentArea === area.id} disabled={!projectId} onClick={() => go(area.id)}>
            <area.icon /><span>{area.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>)}
      </SidebarMenu>
    </SidebarGroup>
  )
}

export function ProjectAreaSidebar() {
  return <>
    <SidebarChromeHeader isElectron={isElectron} />
    <ProjectAreaNavigation />
    <div className="min-h-0 flex-1" />
    <SidebarChromeFooter />
  </>
}
