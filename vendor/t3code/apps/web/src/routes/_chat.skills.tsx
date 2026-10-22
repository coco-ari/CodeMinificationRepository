import { createFileRoute } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import { AutoOpsSkillLibraryPage } from '../autoops/SkillLibraryPage'

export const Route = createFileRoute('/_chat/skills')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { projectId?: ProjectId; skillView?: 'library' | 'agent' | 'project'; agentId?: string } => ({
    // Preserve explicit invalid project selection; never fall back to another project.
    ...(Object.hasOwn(search, 'projectId')
      ? { projectId: ProjectId.make(typeof search.projectId === 'string' ? search.projectId : '') }
      : {}),
    ...(search.skillView === 'library' ||
    search.skillView === 'agent' ||
    search.skillView === 'project'
      ? { skillView: search.skillView }
      : {}),
    ...(Object.hasOwn(search, 'agentId')
      ? { agentId: typeof search.agentId === 'string' ? search.agentId : '' }
      : {}),
  }),
  component: AutoOpsSkillLibraryPage,
})
