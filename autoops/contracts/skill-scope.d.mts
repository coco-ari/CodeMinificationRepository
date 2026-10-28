export const GLOBAL_SKILL_TARGET: 'all-projects'
export interface SkillScopeAssignment {
  skillId: string
  targetType: 'global' | 'project' | 'assistant'
  targetId: string
  projectId?: string
  enabled: boolean
}
export function effectiveSkillAssignment<T extends SkillScopeAssignment>(
  assignments: readonly T[],
  skillId: string,
  scope: { projectId: string; assistantId?: string },
): T | undefined
