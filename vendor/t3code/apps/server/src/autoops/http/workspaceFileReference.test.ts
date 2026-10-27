// @effect-diagnostics nodeBuiltinImport:off -- HTTP 回归组合真实授权、资料所有者和隔离 SQLite。
import { expect, it, vi } from 'vite-plus/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as NodeHttpPlatform from '@effect/platform-node/NodeHttpPlatform'
import { HttpRouter } from 'effect/http'
import * as EnvironmentAuth from '../../auth/EnvironmentAuth.ts'
import * as ThreadManagement from '../../orchestration-v2/ThreadManagementService.ts'
import * as ServerConfig from '../../config.ts'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../../agent-demo/t3-adapters/access.mjs'
import { createWorkspaceStore } from '../../../../../../../agent-demo/t3-adapters/workspaces.mjs'
import { createWorkspaceAuthoring } from '../../../../../../../agent-demo/t3-adapters/workspace-authoring/index.ts'
import { createProjectCredentialService } from '../../../../../../../agent-demo/t3-adapters/credentials.ts'
import { createWorkspaceManagement } from '../../../../../../../agent-demo/t3-adapters/workspace-management.ts'
import { createBusinessResourceCatalog, type BusinessResourceCatalog } from '../../../../../../../agent-demo/t3-adapters/resources.mjs'
import { decodeContract } from '../../../../../../../autoops/contracts/index.ts'
import { WorkspaceFileReference } from '../../../../../../../autoops/contracts/workspace-file-reference.ts'

const configured = vi.hoisted(() => ({ catalog: undefined as BusinessResourceCatalog | undefined }))
vi.mock(import('../resourceCatalog.ts'), () => ({ configuredHostResourceCatalog: () => configured.catalog }))
import { resourcesRoutes } from './resources.ts'

it('普通文件定位真实HTTP验证本人picker、释放后当前正文、私有边界、严格参数和晚撤权', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'workspace-reference-http-'))
  const sessions = new DatabaseSync(':memory:'), bindings = new DatabaseSync(':memory:')
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  const memberships = ['manager', 'reader', 'other'].map(userId => ({
    userId, workspaceAccess: 'internal' as const, role: userId === 'reader' ? 'reader' as const : 'project_admin' as const,
    environmentIds: ['env'], status: 'active' as 'active' | 'disabled',
  }))
  for (const {userId} of memberships) sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(`session-${userId}`, userId, 'csrf', 60000)
  const project = { id: 'project', name: '隔离项目', memberships, memberIds: memberships.map(member => member.userId), environments: [{id: 'env', name: '测试'}], documents: [], resources: [] }
  const access = createAutoOpsAccess({ sessionDb: sessions, bindingDb: bindings, catalog: {
    users: memberships.map(({userId}) => ({id: userId, name: userId, role: 'member'})),
    projects: [project], agents: [{id: 'assistant', name: '测试助手', description: '隔离测试', capabilities: [], projectIds: ['project']}],
  }, now: () => 1000 })
  const store = createWorkspaceStore({dataDir})
  await store.ensureProject(project)
  const authoring = createWorkspaceAuthoring({dataDir, authorize: (actor, scope, action) => {
    if (action === 'read') return access.requireWorkspaceReader(actor, scope)
    if (action === 'external-read') return access.requireWorkspaceInputReader(actor, scope, 'external')
    return access.requireWorkspaceActor(actor, scope)
  }})
  const credentials = createProjectCredentialService({ databasePath: join(dataDir, 'credentials.sqlite'), keyPath: join(dataDir, 'master.key'), initializeKeyIfNew: true,
    authorize: (actor, scope, action) => { access.requireCredentialActor(actor, scope, action) } })
  const unavailableGit = () => { throw new Error('读取当前资料不能访问Git') }
  const service = createWorkspaceManagement({ access, store, authoring, credentials, git: {
    validateRepositorySource: unavailableGit, resolveRepositoryRef: unavailableGit, fetchRepositoryAt: unavailableGit, repositoryRefs: unavailableGit, repositoryHistory: unavailableGit,
  } })
  const bytes = Buffer.from('原资料')
  await authoring.upload('project', {requestId: 'upload', expectedRevision: 0, path: 'docs/file.md', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), conflict: 'replace'}, bytes, 'manager')
  const picker = await service.captureAvailableInput('project', {workspaceType: 'internal'}, 'reader')
  const foreign = await service.captureAvailableInput('project', {workspaceType: 'internal'}, 'other')
  let actor = 'reader', principalCalls = 0, revokeAtSecondPrincipal = false, switchAtSecondPrincipal = false
  const principal = () => access.refresh({id: actor, displayName: actor, role: 'member', csrf: 'csrf', expiresAt: 60000, sessionHash: `session-${actor}`})
  access.bindThread(principal(), {threadId: 'thread', projectId: 'project', environmentId: 'env', agentId: 'assistant', visibility: 'private', workspaceType: 'internal'})
  configured.catalog = createBusinessResourceCatalog({access, workspaceStore: store, workspaceInputs: service})
  const app = HttpRouter.toWebHandler(resourcesRoutes({ access, principal: Effect.sync(() => {
    principalCalls++
    if (revokeAtSecondPrincipal && principalCalls === 2) memberships.find(member => member.userId === 'reader')!.status = 'disabled'
    if (switchAtSecondPrincipal && principalCalls === 2) actor = 'other'
    return principal()
  }) }).pipe(HttpRouter.provideRequest(Layer.mergeAll(NodeHttpPlatform.layer,
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({}), Layer.mock(ThreadManagement.ThreadManagementService)({}), ServerConfig.layerTest(dataDir, join(dataDir, 'server-config')),
  ).pipe(Layer.provideMerge(NodeServices.layer)))), {disableLogger: true})
  const params = {threadId: 'thread', inputId: picker.id, path: 'docs/file.md', workspaceType: 'internal'}
  const request = (overrides: Record<string, string> = {}, suffix = '', scope = 'project') => new Request(`http://localhost/api/v1/projects/${scope}/workspace/file-reference?${new URLSearchParams({...params, ...overrides})}${suffix}`)
  try {
    const original = await app.handler(request(), Context.empty())
    expect(original.status, await original.clone().text()).toBe(200)
    expect(await original.json()).toMatchObject({mode: 'original', changed: false, originalInputId: picker.id})
    service.releaseInput('project', picker.id, 'reader')
    const current = await app.handler(request(), Context.empty())
    expect(current.status, await current.clone().text()).toBe(200)
    expect(current.headers.get('cache-control')).toBe('private, no-store')
    const reference = decodeContract(WorkspaceFileReference, await current.json())
    expect(reference).toMatchObject({mode: 'current', changed: false, currentPath: 'docs/file.md', threadId: 'thread', viewerThreadId: 'thread'})
    const actualBytes = await app.handler(new Request(`http://localhost/autoops/resources?path=${encodeURIComponent(reference.resourcePath)}`), Context.empty())
    expect(actualBytes.status, await actualBytes.clone().text()).toBe(200)
    expect(await actualBytes.text()).toBe('原资料')
    const metadata = await app.handler(new Request(`http://localhost/autoops/resources?metadata=1&path=${encodeURIComponent(reference.resourcePath)}`), Context.empty())
    expect(metadata.status).toBe(200)
    expect(await metadata.json()).toMatchObject({id: reference.resourcePath, name: 'file.md', size: bytes.length})
    expect((await app.handler(request({inputId: foreign.id}), Context.empty())).status).toBe(404)
    expect((await app.handler(request({workspaceType: 'external'}), Context.empty())).status).toBe(404)
    expect((await app.handler(request({}, '', 'other-project'), Context.empty())).status).toBe(404)
    for (const suffix of ['&inputId=duplicate', '&unexpected=true'])
      expect((await app.handler(request({}, suffix), Context.empty())).status).toBe(400)
    actor = 'other'
    expect((await app.handler(request(), Context.empty())).status).toBe(404)
    actor = 'reader'; principalCalls = 0; revokeAtSecondPrincipal = true
    const revoked = await app.handler(request(), Context.empty())
    expect(revoked.status).toBe(404)
    expect(await revoked.json()).toMatchObject({code: 'THREAD_NOT_FOUND'})
    memberships.find(member => member.userId === 'reader')!.status = 'active'
    revokeAtSecondPrincipal = false
    principalCalls = 0; switchAtSecondPrincipal = true
    const changedActor = await app.handler(request(), Context.empty())
    expect(changedActor.status).toBe(403)
    expect(await changedActor.json()).toMatchObject({code: 'WORKSPACE_REFERENCE_ACTOR_CHANGED'})
    actor = 'reader'; switchAtSecondPrincipal = false
    await authoring.close()
    const unavailable = await app.handler(request(), Context.empty())
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({code: 'WORKSPACE_AUTHORING_STOPPING'})
  } finally {
    await app.dispose(); configured.catalog = undefined
    await service.close(); await store.close(); await authoring.close(); credentials.close()
    sessions.close(); bindings.close(); rmSync(dataDir, {recursive: true, force: true})
  }
})
