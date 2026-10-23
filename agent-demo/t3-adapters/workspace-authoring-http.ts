import type { AutoOpsAccess, AutoOpsPrincipal } from './access.mjs'
import { configuredWorkspaceStore, WorkspaceError, type WorkspaceStore } from './workspaces.mjs'
import { configuredWorkspaceManagement, type WorkspaceManagement } from './workspace-management.ts'
import type { WorkspaceAuthoringMutation, WorkspaceDeploymentSourceInput, WorkspaceExtractionRetryInput, WorkspaceDeleteInput, WorkspaceMoveInput, WorkspaceRepositorySource, WorkspaceSourceInput, WorkspaceTextSaveInput, WorkspaceUploadInput } from '../../autoops/contracts/workspace-authoring.ts'
import type { CredentialCreate, CredentialReplace, CredentialRevoke } from './credentials.ts'

export interface WorkspaceAuthoringHttpResult {
  status: number
  body?: unknown
  file?: { bytes: Uint8Array; name: string; mime: string }
}
function fail(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'WORKSPACE_REQUEST_INVALID', '工作区请求格式无效')
  return value as Record<string, unknown>
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 160) fail(400, 'WORKSPACE_REQUEST_INVALID', '工作区请求缺少有效标识')
  return value
}
export async function handleWorkspaceAuthoringRequest({ access, principal, url, method, input, bytes, service: provided, store: supplied }: {
  access: AutoOpsAccess; principal: AutoOpsPrincipal; url: URL; method: string; input?: unknown; bytes?: Uint8Array; service?: WorkspaceManagement; store?: WorkspaceStore
}): Promise<WorkspaceAuthoringHttpResult> {
  const match = /^\/api\/v1\/projects\/([^/]+)\/workspace\/(.+)$/.exec(url.pathname)
  if (!match) fail(404, 'WORKSPACE_ROUTE_NOT_FOUND', '此资料操作不存在')
  let projectId: string, action: string
  try { projectId = decodeURIComponent(match[1]!); action = decodeURIComponent(match[2]!) } catch { return fail(400, 'WORKSPACE_REQUEST_INVALID', '工作区路径无效') }
  const project = access.requireProject(principal, projectId)
  access.requireWorkspace(principal, projectId, 'internal')
  if (method !== 'GET') access.requireWorkspaceManager(principal, projectId)
  const store = supplied ?? configuredWorkspaceStore()
  if (!store) fail(503, 'WORKSPACE_UNAVAILABLE', '工作区暂时不可用')
  await store.ensureProject(project)
  const service = provided ?? configuredWorkspaceManagement(access)
  const actor = principal.id
  const ok = (body: unknown): WorkspaceAuthoringHttpResult => ({ status: 200, body })
  if (method === 'GET') {
    const path = url.searchParams.get('path') ?? ''
    const revision = url.searchParams.get('revision') ?? undefined
    if (action === 'authoring') return ok(service.overview(projectId, actor))
    if (action === 'credentials') return ok({ credentials: service.credentials.list(actor, projectId) })
    if (action.startsWith('credentials/requests/')) return ok({ result: service.credentials.receipt(actor, projectId, identifier(action.slice('credentials/requests/'.length))) })
    if (action === 'current/tree') return ok(service.tree(projectId, path, actor))
    if (action === 'current/search') return ok(service.search(projectId, url.searchParams.get('query') ?? '', actor, Number(url.searchParams.get('limit') ?? 200)))
    if (action === 'current/metadata') return ok(await service.currentContent(projectId, path, actor, revision))
    if (action === 'current/file') return { status: 200, file: service.currentFile(projectId, path, actor, revision) }
    if (action.startsWith('requests/')) return ok(service.receipt(projectId, identifier(action.slice('requests/'.length)), actor))
  }
  if (method === 'POST') {
    const body = object(input)
    if (action === 'uploads') {
      if (!bytes) fail(400, 'WORKSPACE_UPLOAD_MISSING', '上传内容为空')
      return ok(await service.authoring.upload(projectId, body as unknown as WorkspaceUploadInput, bytes, actor))
    }
    if (action === 'cleanup') {
      if (!Array.isArray(body.versionIds) || body.versionIds.some(value => typeof value !== 'string')) fail(400, 'WORKSPACE_CLEANUP_INVALID', '清理目标无效')
      return ok(body.dryRun === true ? service.planCleanupVersions(projectId, body.versionIds as string[], actor) : service.cleanupVersions(projectId, body.versionIds as string[], actor))
    }
    if (action === 'deployment-packages') return { status: 202, body: { task: service.startDeploymentPackages(projectId, body as unknown as WorkspaceDeploymentSourceInput, actor) } }
    if (action === 'sync') return { status: 202, body: { task: await service.sync(projectId, body as unknown as WorkspaceAuthoringMutation, actor) } }
    if (action === 'external') return { status: 202, body: { task: await service.generateCurrentExternal(projectId, body as unknown as { requestId: string; rules?: Array<{ find: string; replace: string }>; expectedRevision?: number }, actor) } }
    if (action === 'versions') return { status: 202, body: { task: await service.generate(projectId, body as unknown as WorkspaceAuthoringMutation, actor) } }
    const command = object(body.input)
    if (action === 'sources') {
      if (body.action === 'save') {
        service.validateSource({ ...command, id: typeof command.id === 'string' ? command.id : 'new-source' } as unknown as WorkspaceRepositorySource)
        if (command.credentialId) service.credentials.referenceVersion(actor, projectId, identifier(command.credentialId))
        return ok(service.authoring.saveSource(projectId, command as unknown as WorkspaceSourceInput & WorkspaceAuthoringMutation, actor))
      }
      if (body.action === 'remove') {
        const sourceId = identifier(command.id)
        const result = service.authoring.removeSource(projectId, sourceId, command as unknown as WorkspaceAuthoringMutation, actor)
        store.releaseVersion(projectId, `current:${sourceId}`)
        return ok(result)
      }
    }
    if (action === 'credentials') {
      if (body.action === 'create') return ok(service.credentials.create(actor, projectId, command as unknown as CredentialCreate))
      if (body.action === 'replace') return ok(service.credentials.replace(actor, projectId, identifier(command.id), command as unknown as CredentialReplace))
      if (body.action === 'revoke') return ok(service.credentials.revoke(actor, projectId, identifier(command.id), command as unknown as CredentialRevoke))
    }
    if (action === 'documents') {
      if (body.action === 'directory') return ok(service.authoring.createDirectory(projectId, command as unknown as WorkspaceAuthoringMutation & { path: string }, actor))
      if (body.action === 'save') return ok(service.authoring.saveText(projectId, command as unknown as WorkspaceTextSaveInput, actor))
      if (body.action === 'move') return ok(service.authoring.move(projectId, command as unknown as WorkspaceMoveInput, actor))
      if (body.action === 'delete') return ok(service.authoring.remove(projectId, command as unknown as WorkspaceDeleteInput, actor))
      if (body.action === 'extract') return ok(await service.authoring.retryExtraction(projectId, command as unknown as WorkspaceExtractionRetryInput, actor))
    }
  }
  return fail(404, 'WORKSPACE_ROUTE_NOT_FOUND', '此资料操作不存在')
}
