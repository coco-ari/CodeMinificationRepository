/** 平台 skill 的唯一范围规则：上层启用优先，关闭上层后沿用下层。 */
export const GLOBAL_SKILL_TARGET = 'all-projects'
export function effectiveSkillAssignment(assignments, skillId, { projectId, assistantId }) {
  const enabled = assignments.filter((entry) => entry.skillId === skillId && entry.enabled)
  return (
    enabled.find(
      (entry) => entry.targetType === 'global' && entry.targetId === GLOBAL_SKILL_TARGET,
    ) ??
    enabled.find((entry) => entry.targetType === 'project' && entry.targetId === projectId) ??
    enabled.find(
      (entry) =>
        entry.targetType === 'assistant' &&
        entry.projectId === projectId &&
        entry.targetId === assistantId,
    )
  )
}
