import { AUTOOPS_AREAS, normalizeAutoOpsChatHref, type AutoOpsArea } from '../../autoops/projectNavigation.logic.ts'

export interface SettingsReturnProject {
  readonly id: string
  readonly membership?: {
    readonly workspaceAccess: 'internal' | 'external'
    readonly role: 'manager' | 'member'
  }
}

export interface AutoOpsMainLocation {
  readonly href: string
  readonly projectId: string
  readonly area: AutoOpsArea
}

function areaFromHref(href: string): AutoOpsArea | null {
  if (!href.startsWith('/') || href.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/u.test(href)) return null
  try {
    const url = new URL(href, 'https://autoops.invalid')
    const area = AUTOOPS_AREAS.find((entry) => entry.path !== '/' && entry.path === url.pathname)
    if (area) return area.id
    return normalizeAutoOpsChatHref(href) ? 'chat' : null
  } catch { return null }
}

/** The caller supplies the project established by the current native route or page. */
export function captureAutoOpsMainLocation(
  href: string,
  projectId: string,
  projects: ReadonlyArray<SettingsReturnProject>,
): AutoOpsMainLocation | null {
  const area = areaFromHref(href)
  if (!area || !projects.some((project) => project.id === projectId)) return null
  const query = new URL(href, 'https://autoops.invalid').searchParams.getAll('projectId')
  if (query.length > 1 || (query.length === 1 && query[0] !== projectId)) return null
  return { href, projectId, area }
}

/** Resolve against today's project and authority, never append a project to an old thread URL. */
export function resolveAutoOpsSettingsReturnHref(input: {
  readonly location: AutoOpsMainLocation | null
  readonly projectId: string
  readonly projects: ReadonlyArray<SettingsReturnProject>
  readonly projectHref: (area: AutoOpsArea, projectId: string, search?: unknown) => string
  readonly chatProjectId: (href: string) => string | null
}): string {
  const project = input.projects.find((entry) => entry.id === input.projectId)
  if (!project) return '/'
  const previous = input.location && captureAutoOpsMainLocation(
    // The old project can have lost access while settings were open. Its area
    // can still be retained, but its resource is reused only for today's project.
    input.location.href, input.location.projectId, [{ id: input.location.projectId }],
  )
  const validPrevious = previous && previous.area === input.location?.area ? previous : null
  const area = validPrevious?.area ?? 'chat'
  const allowedArea = area === 'deployments' &&
    !(project.membership?.workspaceAccess === 'internal' && project.membership.role === 'manager')
    ? 'workspaces' : area
  if (validPrevious?.projectId === project.id && allowedArea === validPrevious.area &&
    (allowedArea !== 'chat' || input.chatProjectId(validPrevious.href) === project.id)) {
    return validPrevious.href
  }
  return input.projectHref(allowedArea, project.id,
    allowedArea === 'skills' ? validPrevious?.href : undefined)
}
