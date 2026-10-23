import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { FolderGit2Icon, SearchIcon, type LucideIcon } from 'lucide-react'
import { WorkspacePageHeader } from '~/components/WorkspacePageHeader'
import { SidebarInput, SidebarMenuButton, useSidebar } from '~/components/ui/sidebar'
import { readAutoOpsHost } from './hostConfig'
import { useAutoOpsProjectId } from './projectNavigation'

const ModuleSidebarContext = createContext<{
  container: HTMLDivElement | null
  setContainer: (element: HTMLDivElement | null) => void
} | null>(null)

/** 模块只投影业务内容，侧栏容器、尺寸、折叠和底部操作始终由问答公共框架持有。 */
export function ModuleSidebarProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return <ModuleSidebarContext value={{ container, setContainer }}>{children}</ModuleSidebarContext>
}

export function ModuleSidebarOutlet() {
  const context = useContext(ModuleSidebarContext)
  return (
    <div
      ref={context?.setContainer}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-module-sidebar-outlet=""
    />
  )
}

export function ModuleSidebar({
  children,
  header,
  actions,
  search,
  label,
}: {
  children: ReactNode
  label: string
  header?: ReactNode
  actions?: ReactNode
  search?: { value: string; onChange: (value: string) => void; label: string }
}) {
  const context = useContext(ModuleSidebarContext)
  if (!context?.container) return null
  return createPortal(
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={label} data-module-sidebar="">
      <div className="flex h-13 shrink-0 items-center gap-1 px-[var(--sidebar-content-inset)]">
        {search ? (
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover">
            <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
            <SidebarInput
              nativeInput
              type="search"
              value={search.value}
              aria-label={search.label}
              placeholder={search.label}
              onChange={(event) => search.onChange(event.currentTarget.value)}
              className="min-w-0 flex-1"
            />
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate px-2 text-sm font-medium text-sidebar-muted-foreground">
            {label}
          </span>
        )}
        {actions}
      </div>
      {header ? (
        <div className="shrink-0 space-y-1 px-[var(--sidebar-content-inset)] pb-2">{header}</div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>,
    context.container,
  )
}

export function ModuleSidebarItem({
  label,
  description,
  icon: Icon,
  selected,
  onClick,
  disabled,
  closeOnSelect = true,
}: {
  label: string
  description?: string
  icon?: LucideIcon
  selected?: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  closeOnSelect?: boolean
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  return (
    <SidebarMenuButton
      isActive={selected === true}
      disabled={disabled}
      aria-pressed={selected}
      title={label}
      className="h-auto min-h-9 py-2 pointer-coarse:min-h-11"
      onClick={(event) => {
        onClick(event)
        if (isMobile && closeOnSelect) setOpenMobile(false)
      }}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {description ? (
          <span className="mt-0.5 block truncate text-xs font-normal text-sidebar-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </SidebarMenuButton>
  )
}

export function ModuleSidebarEmpty({ children }: { children: ReactNode }) {
  return (
    <p
      className="px-4 py-6 text-center text-xs leading-relaxed text-sidebar-muted-foreground"
      role="status"
    >
      {children}
    </p>
  )
}

/** 与问答共用原生头部：模块仅提供标题、当前资源及操作，不再另建页面标题栏。 */
export function ModuleHeader({
  title,
  detail,
  actions,
  ...props
}: ComponentProps<'header'> & {
  title: string
  detail?: string | undefined
  actions?: ReactNode
}) {
  const projectId = useAutoOpsProjectId()
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  return (
    <WorkspacePageHeader data-module-header="" {...props}>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="hidden min-w-0 truncate font-medium text-muted-foreground sm:block">
          {project?.name ?? 'AutoOps'}
        </span>
        <span className="hidden text-muted-foreground/60 sm:block">/</span>
        <h1
          className="min-w-0 truncate font-medium"
          title={detail ? `${title} · ${detail}` : title}
        >
          {detail ?? title}
        </h1>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </WorkspacePageHeader>
  )
}
