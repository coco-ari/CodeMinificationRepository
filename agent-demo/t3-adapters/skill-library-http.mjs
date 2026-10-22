// The library stores packages; this transport is the authoritative user/scope gate.
import { createSkillLibrary, SkillLibraryError } from './skill-library.mjs'
const fail = (status, code, message) => { throw new SkillLibraryError(status, code, message) }
function visibleCatalog(access, principal, library) {
  const current = access.refresh(principal), bootstrap = access.bootstrap(current), catalog = library.catalog()
  const projects = bootstrap.projects.map(project => ({ id: project.id, name: project.name }))
  const projectIds = new Set(projects.map(project => project.id))
  const agents = bootstrap.agents.filter(agent => agent.projectIds.some(id => projectIds.has(id))).map(agent => ({ id: agent.id, name: agent.name, projectIds: agent.projectIds.filter(id => projectIds.has(id)) }))
  const canManage = current.role === 'admin'
  if (canManage) return { ...catalog, canManage, projects, agents }
  const allowedVersions = new Map(), allowedAssignmentIds = new Set()
  for (const project of bootstrap.projects) {
    const membership = access.requireMembership(current, project.id)
    const types = membership.workspaceAccess === 'internal' ? ['internal', 'external'] : ['external']
    for (const agent of agents.filter(agent => agent.projectIds.includes(project.id))) {
      for (const skill of catalog.skills) {
        if (!skill.enabled) continue
        const assignment = catalog.assignments.find(entry => entry.skillId === skill.id && entry.targetType === 'project' && entry.targetId === project.id)
          ?? catalog.assignments.find(entry => entry.skillId === skill.id && entry.targetType === 'agent' && entry.targetId === agent.id)
        if (!assignment?.enabled || !types.some(type => assignment.workspaceTypes.includes(type))) continue
        if (!allowedVersions.has(skill.id)) allowedVersions.set(skill.id, new Set())
        allowedVersions.get(skill.id).add(assignment.versionId); allowedAssignmentIds.add(assignment.id)
      }
    }
  }
  const skills = catalog.skills.filter(skill => allowedVersions.has(skill.id)).map(skill => {
    const versions = skill.versions.filter(version => allowedVersions.get(skill.id).has(version.id))
    return { ...skill, latestVersionId: versions.some(version => version.id === skill.latestVersionId) ? skill.latestVersionId : versions.at(-1)?.id, versions }
  })
  // Members receive only the source metadata of versions that are actually assigned.
  return { ...catalog, skills, assignments: catalog.assignments.filter(assignment => allowedAssignmentIds.has(assignment.id)), canManage, projects, agents }
}
export async function handleSkillLibraryRequest({ access, principal, url, method, input, dataDirectory }) {
  const match = /^\/autoops\/skill-library(?:\/(.*))?$/.exec(url.pathname)
  if (!match) fail(404, 'SKILL_ROUTE_NOT_FOUND', '此技能操作不存在')
  const library = createSkillLibrary(dataDirectory), catalog = visibleCatalog(access, principal, library)
  const parts = (match[1] || '').split('/').filter(Boolean).map(decodeURIComponent)
  if (method === 'GET') {
    if (!parts.length) return { status: 200, body: catalog }
    if (parts.length === 4 && parts[1] === 'versions' && parts[3] === 'content') {
      const skill = catalog.skills.find(entry => entry.id === parts[0]), version = skill?.versions.find(entry => entry.id === parts[2])
      if (!version) fail(404, 'SKILL_NOT_FOUND', '技能或版本不存在，或无权访问')
      const raw = url.searchParams.get('raw') === '1'
      const result = library.readFile(skill.id, version.id, url.searchParams.get('path') || 'SKILL.md', raw)
      return raw ? { status: 200, file: result } : { status: 200, body: result }
    }
  }
  if (method === 'POST' && !parts.length) {
    if (!catalog.canManage) fail(403, 'SKILL_MANAGEMENT_FORBIDDEN', '只有管理员可以管理技能仓库与范围分配')
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    if (body.action === 'assign') {
      if (body.targetType === 'project') {
        access.requireProject(principal, body.targetId)
        access.requireWorkspaceManager(principal, body.targetId)
      } else if (body.targetType === 'agent') {
        if (!catalog.agents.some(agent => agent.id === body.targetId)) fail(403, 'SKILL_SCOPE_FORBIDDEN', '该助手不存在或无权配置')
      } else fail(400, 'SKILL_ASSIGNMENT_INVALID', '请选择助手或项目范围')
    }
    const methods = { 'import-markdown': 'importMarkdown', 'import-archive': 'importArchive', 'import-git': 'importGit', 'set-enabled': 'setEnabled', assign: 'assign', unassign: 'unassign', delete: 'remove', verify: 'verify' }
    const operation = methods[body.action]
    if (!operation) fail(400, 'SKILL_ACTION_INVALID', '技能操作无效')
    await library[operation](body)
    return { status: 200, body: visibleCatalog(access, principal, library) }
  }
  fail(404, 'SKILL_ROUTE_NOT_FOUND', '此技能操作不存在')
}
