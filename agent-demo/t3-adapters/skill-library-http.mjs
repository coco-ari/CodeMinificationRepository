// The library stores packages; this transport is the authoritative user/scope gate.
import { effectiveSkillAssignment } from '../../autoops/contracts/skill-scope.mjs'
import { createSkillLibrary, SkillLibraryError } from './skill-library.mjs'
const fail = (status, code, message) => { throw new SkillLibraryError(status, code, message) }
function visibleCatalog(access, principal, library, projectId) {
  const current = access.refresh(principal), bootstrap = access.bootstrap(current), catalog = library.catalog()
  if (projectId && !bootstrap.projects.some(project => project.id === projectId)) fail(404, 'SKILL_SCOPE_FORBIDDEN', '项目不存在或无权访问')
  const selectedProjects = bootstrap.projects.filter(project => !projectId || project.id === projectId)
  const canManage = current.role === 'admin'
  const projects = selectedProjects.map(project => ({ id: project.id, name: project.name, canManage: canManage || project.capabilities?.['project.manage'] === true }))
  const projectIds = new Set(projects.map(project => project.id))
  // 使用真实项目助手目录；旧业务身份不再出现在 skill 的分配对象中。
  const assistants = selectedProjects.flatMap(project => (project.assistants?.items ?? [])
    .filter(item => item.preset.enabled)
    .map(({ preset }) => ({ id: preset.id, name: preset.name, projectId: project.id, executionKind: preset.configuration.executionBinding.kind })))
  const assignments = catalog.assignments.filter(entry => entry.targetType === 'global' || (entry.targetType === 'project' ? projectIds.has(entry.targetId) : projectIds.has(entry.projectId)))
  const base = { ...catalog, assignments, canManage, projects, assistants }
  // 项目管理员可选择目录里的包，但不能修改包或其他项目的范围。
  if (canManage || projects.some(project => project.canManage)) return base
  const allowedVersions = new Map(), allowedAssignmentIds = new Set()
  for (const project of projects) {
    for (const assistantId of [undefined, ...assistants.filter(item => item.projectId === project.id).map(item => item.id)]) {
      for (const skill of catalog.skills) {
        if (!skill.enabled) continue
        const assignment = effectiveSkillAssignment(assignments, skill.id, { projectId: project.id, assistantId })
        if (!assignment) continue
        if (!allowedVersions.has(skill.id)) allowedVersions.set(skill.id, new Set())
        allowedVersions.get(skill.id).add(assignment.versionId); allowedAssignmentIds.add(assignment.id)
      }
    }
  }
  const skills = catalog.skills.filter(skill => allowedVersions.has(skill.id)).map(skill => {
    const versions = skill.versions.filter(version => allowedVersions.get(skill.id).has(version.id))
    return { ...skill, latestVersionId: versions.some(version => version.id === skill.latestVersionId) ? skill.latestVersionId : versions.at(-1)?.id, versions }
  })
  return { ...base, skills, assignments: assignments.filter(assignment => allowedAssignmentIds.has(assignment.id)) }
}
function authorizeAssignment(access, principal, assignment, catalog) {
  if (assignment.targetType === 'global') {
    if (!catalog.canManage) fail(403, 'SKILL_MANAGEMENT_FORBIDDEN', '只有平台管理员可以设置所有项目的 skill')
    return
  }
  const projectId = assignment.targetType === 'project' ? assignment.targetId : assignment.projectId
  if (!catalog.projects.some(project => project.id === projectId && project.canManage)) fail(403, 'SKILL_SCOPE_FORBIDDEN', '无权配置此项目的 skill')
  access.requireProjectActionForActor(principal.id, projectId, 'project.manage')
  if (assignment.targetType === 'assistant' && !catalog.assistants.some(item => item.id === assignment.targetId && item.projectId === projectId)) fail(403, 'SKILL_SCOPE_FORBIDDEN', '助手不属于当前项目或已停用')
  if (!['project', 'assistant'].includes(assignment.targetType)) fail(400, 'SKILL_ASSIGNMENT_INVALID', '请选择所有项目、当前项目或指定助手')
}
export async function handleSkillLibraryRequest({ access, principal, url, method, input, dataDirectory }) {
  const match = /^\/autoops\/skill-library(?:\/(.*))?$/.exec(url.pathname)
  if (!match) fail(404, 'SKILL_ROUTE_NOT_FOUND', '此 skill 操作不存在')
  const library = createSkillLibrary(dataDirectory), catalog = visibleCatalog(access, principal, library, url.searchParams.get('projectId'))
  const parts = (match[1] || '').split('/').filter(Boolean).map(decodeURIComponent)
  if (method === 'GET') {
    if (!parts.length) return { status: 200, body: catalog }
    if (parts.length === 4 && parts[1] === 'versions' && parts[3] === 'content') {
      const skill = catalog.skills.find(entry => entry.id === parts[0]), version = skill?.versions.find(entry => entry.id === parts[2])
      if (!version) fail(404, 'SKILL_NOT_FOUND', 'skill 或版本不存在，或无权访问')
      const raw = url.searchParams.get('raw') === '1'
      const result = library.readFile(skill.id, version.id, url.searchParams.get('path') || 'SKILL.md', raw)
      return raw ? { status: 200, file: result } : { status: 200, body: result }
    }
  }
  if (method === 'POST' && !parts.length) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    if (body.action === 'assign') authorizeAssignment(access, principal, body, catalog)
    else if (body.action === 'unassign') {
      const assignment = library.catalog().assignments.find(entry => entry.id === body.assignmentId)
      if (!assignment) fail(404, 'SKILL_NOT_FOUND', '启用范围不存在或已移除')
      // 已删除或停用助手的旧范围也允许所属项目管理员撤销。
      authorizeAssignment(access, principal, assignment.targetType === 'assistant' ? { targetType: 'project', targetId: assignment.projectId } : assignment, catalog)
    } else if (!catalog.canManage) fail(403, 'SKILL_MANAGEMENT_FORBIDDEN', '只有平台管理员可以修改 skill 包')
    const methods = { 'import-markdown': 'importMarkdown', 'import-archive': 'importArchive', 'import-git': 'importGit', 'set-enabled': 'setEnabled', assign: 'assign', unassign: 'unassign', delete: 'remove', verify: 'verify' }
    const operation = methods[body.action]
    if (!operation) fail(400, 'SKILL_ACTION_INVALID', 'skill 操作无效')
    await library[operation](body)
    return { status: 200, body: visibleCatalog(access, principal, library, url.searchParams.get('projectId')) }
  }
  fail(404, 'SKILL_ROUTE_NOT_FOUND', '此 skill 操作不存在')
}
