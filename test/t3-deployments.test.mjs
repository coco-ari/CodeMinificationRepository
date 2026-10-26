import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm, readdir, mkdir, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {createServer as createHttpServer, request as httpRequest, Server as HttpServer} from 'node:http'
import {DeploymentService} from '../src/deployment.mjs'
import {Store} from '../src/store.mjs'
import {createAutoOpsAccess, initializeAutoOpsAccessSchema} from '../agent-demo/t3-adapters/access.mjs'
import {createWorkspaceStore} from '../agent-demo/t3-adapters/workspaces.mjs'
import {createWorkspaceManagement} from '../agent-demo/t3-adapters/workspace-management.ts'
import {createDeploymentStore} from '../agent-demo/t3-adapters/deployments.mjs'
import {handleDeploymentRequest} from '../agent-demo/t3-adapters/deployment-http.mjs'

const projects = [{id:'p-one', name:'同名项目', environments:[{id:'env-one', name:'测试'},{id:'env-two', name:'测试'}]}, {id:'p-other', name:'同名项目', environments:[{id:'env-one', name:'测试'}]}]
const principal = {id:'manager', displayName:'真实管理者', allowed:['env-one']}
const forbidden = () => { throw Object.assign(new Error('无权访问'), {status:403}) }
const access = {
  requireDeploymentActionForActor(userId, projectId, action, environmentId) { if (userId !== principal.id) forbidden(); return this.requireDeploymentAction(principal, projectId, action, environmentId) },
  requireDeploymentAction(p, projectId, action, environmentId) { const member = this.requireWorkspaceManager(p, projectId); if (environmentId) this.requireEnvironment(p, projectId, environmentId); if (action === 'server.admin') forbidden(); return member },
  requireDeploymentNodeManagerForActor(userId) { if (userId !== 'platform') forbidden() },
  requireDeploymentNodeManager(p) { this.requireDeploymentNodeManagerForActor(p.id) },
  requireDeploymentActor(userId, projectId, environmentId) { if (userId !== principal.id) forbidden(); this.requireWorkspaceManager(principal, projectId); this.requireEnvironment(principal, projectId, environmentId) },
  requireProject(p, id) { const project = projects.find((item) => item.id === id); if (!project || p.id === 'other-user') forbidden(); return project },
  requireWorkspaceManager(p) { if (p.id !== 'manager' || p.external) forbidden(); return {workspaceAccess:'internal', role:'project_admin', environmentIds:p.allowed} },
  requireEnvironment(p, id, env) { if (!this.requireProject(p,id).environments.some((item) => item.id === env) || !p.allowed.includes(env)) forbidden() },
}
async function finish(workspaces, projectId, task) {
  for (let index = 0; index < 200; index++) { const current = workspaces.overview(projectId).tasks.find((item) => item.id === task.id); if (!['queued','running'].includes(current.status)) { assert.equal(current.status,'completed',current.error); return current }; await new Promise((done) => setTimeout(done,10)) }
  assert.fail('工作区生成任务超时')
}
async function fixture(t, {listener = false, accessLayer = access, requestPrincipal = principal, workspaceManagement, installAssetsRoot} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(),'t3-deployment-')), workspaceStore = createWorkspaceStore({dataDir,authorizeTask:()=>{}})
  for (const project of projects) await workspaceStore.ensureProject(project, { initialContent: 'example' })
  let store = createDeploymentStore({dataDir,workspaceStore,workspaceManagement,access:accessLayer,...(listener ? {agentPort:0} : {}),...(installAssetsRoot ? {installAssetsRoot} : {})})
  await store.initialize()
  const request = (suffix = '', method = 'GET', input, p = requestPrincipal, projectId = 'p-one') => handleDeploymentRequest({access:accessLayer, store, principal:p, url:new URL(`http://demo/autoops/projects/${projectId}/deployments${suffix}`), method,input})
  t.after(async () => { await store.close(); await workspaceStore.close(); await rm(dataDir,{recursive:true,force:true}) })
  return {dataDir,workspaceStore,get store(){return store}, request, async reopen(){await store.close();store = createDeploymentStore({dataDir,workspaceStore,workspaceManagement,access:accessLayer,...(listener ? {agentPort:0} : {}),...(installAssetsRoot ? {installAssetsRoot} : {})});await store.initialize();return store}}
}
async function provisionNode(f, input, platform) {
  platform ||= { id: 'platform', displayName: '平台节点管理者' }
  await f.store.ensureProject(projects[0])
  const created = await f.store.createGlobalServer({ name: input.name, requestId: input.requestId }, platform)
  const expectedRevision = f.store.globalNodeCatalog(platform).projectAccess.find(entry => entry.projectId === 'p-one').revision
  await f.store.setServerAccess('p-one', { serverId: created.server.id, allowed: true, expectedRevision, requestId: randomUUID() }, platform)
  await f.request(`/servers/${created.server.id}/bind`, 'POST', { environmentId: input.environmentId, requestId: randomUUID() })
  return created
}
async function records(f, platform) {
  const serverInput = {name:'隔离服务器',environmentId:'env-one',requestId:randomUUID()}
  const server = await provisionNode(f, serverInput, platform)
  const targetInput = {name:'前端站点',environmentId:'env-one',serverId:server.server.id,requestId:randomUUID(),config:{module:'.',artifactPath:'dist',health:{url:'http://127.0.0.1:12345/'}}}
  const target = (await f.request('/targets','POST',targetInput)).body.target
  const source = f.workspaceStore.overview('p-one').internalVersions[0]
  await finish(f.workspaceStore,'p-one',f.workspaceStore.startPackages('p-one',{sourceVersionId:source.id,services:['frontend'],requestId:randomUUID()}))
  const pack = f.workspaceStore.overview('p-one').releases[0]
  return {serverInput,server,targetInput,target,source,pack}
}
function readState(dataDir) { const db=new DatabaseSync(join(dataDir,'deployment-center/state.sqlite'),{readOnly:true});try{return JSON.parse(db.prepare('SELECT value FROM application_state WHERE id=1').get().value)}finally{db.close()} }
async function agent(f, route, input, token) {
  const address=f.store.agentAddress
  const response=await fetch(`http://127.0.0.1:${address.port}/api/agent/v1${route}`,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})})
  const body=await response.json();assert.ok(response.ok,JSON.stringify(body));return body
}

test('部署监听器使用宿主指定的发行资源提供安装脚本和执行器包', async t => {
  const installAssetsRoot = await mkdtemp(join(tmpdir(), 't3-install-release-'))
  t.after(() => rm(installAssetsRoot, {recursive:true, force:true}))
  await mkdir(join(installAssetsRoot, 'agent')); await mkdir(join(installAssetsRoot, 'dist'))
  const assets = [
    ['/agent/install.sh', 'agent/install.sh', Buffer.from('#!/bin/sh\nprintf isolated-release\n')],
    ['/agent/bundle.tar.gz', 'dist/agent-bundle.tar.gz', Buffer.from([31,139,8,0,8,5])],
  ]
  for (const [, file, bytes] of assets) await writeFile(join(installAssetsRoot, file), bytes)
  const f = await fixture(t, {listener:true, installAssetsRoot})
  for (const [route, , bytes] of assets) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`http://127.0.0.1:${f.store.agentAddress.port}${route}`, {method})
      assert.equal(response.status, 200)
      assert.equal(Number(response.headers.get('content-length')), bytes.length)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : bytes)
    }
  }
})

test('已接纳但尚未落盘的部署目录初始化阻止删除，完成后空映射不被误判业务引用',async t=>{
  const f=await fixture(t)
  const pending=f.store.ensureProject(projects[0])
  assert.equal(f.store.deletionReferences('p-one')[0]?.kind,'deployment-initializing')
  await pending
  assert.deepEqual(f.store.deletionReferences('p-one'),[])
})

test('真实成员排队后撤权、重启后撤权均不能领取，权限服务故障保留排队并在恢复后可执行', async (t) => {
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  t.after(() => { sessionDb.close(); bindingDb.close() })
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('real-manager-session').digest('hex'), 'manager', 'csrf', Date.now() + 60_000)
  sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('real-platform-session').digest('hex'), 'platform', 'csrf', Date.now() + 60_000)
  const catalog = { users: [{ id: 'manager', name: '真实管理者', role: 'member', status: 'active' }, { id: 'platform', name: '平台节点管理者', role: 'admin', status: 'active' }], agents: [], projects: projects.map((project) => ({ ...project, documents: [], resources: [], memberIds: ['manager'], memberships: [{ userId: 'manager', workspaceAccess: 'internal', role: 'project_admin', status: 'active', environmentIds: ['env-one'] }] })) }
  let outage = false
  const realAccess = createAutoOpsAccess({ sessionDb, bindingDb, catalog, deploymentEnabled: () => { if (outage) throw new Error('授权配置不可用'); return true } })
  const realPrincipal = realAccess.authenticateCookie('demo_session=real-manager-session')
  const platformPrincipal = realAccess.authenticateCookie('demo_session=real-platform-session')
  const f = await fixture(t, { listener: true, accessLayer: realAccess, requestPrincipal: realPrincipal }), r = await records(f, platformPrincipal)
  const registered = await agent(f, '/register', { registrationToken: r.server.registrationToken, capabilities: ['static-site-v1'] })
  const submit = async () => (await f.request('/tasks', 'POST', { targetId: r.target.id, action: 'deploy', service: 'frontend', packageId: r.pack.id, configKey: r.target.configKey, requestId: randomUUID() })).body.task
  const claim = (signal) => fetch(`http://127.0.0.1:${f.store.agentAddress.port}/api/agent/v1/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registered.token}` }, body: '{}', signal })
  const membership = catalog.projects[0].memberships[0]
  membership.role = 'release_operator'
  for (const revoke of [() => { membership.environmentIds = [] }, () => { membership.role = 'reader' }, () => { membership.status = 'disabled' }]) {
    const task = await submit()
    if (membership.status === 'active') await f.reopen()
    revoke()
    const controller = new AbortController(), pending = claim(controller.signal).catch((error) => { if (error.name !== 'AbortError') throw error })
    try {
      for (let attempt = 0; attempt < 100 && readState(f.dataDir).deployments.tasks.find((entry) => entry.id === task.id).status === 'queued'; attempt++) await new Promise((done) => setTimeout(done, 10))
      const persisted = readState(f.dataDir).deployments.tasks.find((entry) => entry.id === task.id)
      assert.equal(persisted.status, 'interrupted'); assert.equal(persisted.startedAt, undefined)
      assert.match(persisted.error, /权限已失效/)
      assert.equal((await f.request('', 'GET', undefined, realPrincipal, 'p-other')).body.targets.length, 0)
    } finally { controller.abort(); await pending }
    Object.assign(membership, { environmentIds: ['env-one'], role: 'release_operator', status: 'active' })
  }
  const task = await submit()
  outage = true
  assert.equal((await claim()).status, 503)
  assert.equal(readState(f.dataDir).deployments.tasks.find((entry) => entry.id === task.id).status, 'queued')
  assert.equal(f.workspaceStore.overview('p-other').internalVersions.length, 1)
  outage = false
  assert.equal((await (await claim()).json()).task.id, task.id)
})

test('项目准入撤回拒绝新发布与实际 Agent 领取，原提交收据保持且重新准入后可新建任务', async t => {
  const f = await fixture(t, {listener:true}), r = await records(f)
  const platform = {id:'platform'}
  const registered = await agent(f, '/register', {registrationToken:r.server.registrationToken,capabilities:['static-site-v1']})
  const input = {targetId:r.target.id,action:'deploy',service:'frontend',packageId:r.pack.id,configKey:r.target.configKey,requestId:randomUUID()}
  const accepted = (await f.request('/tasks','POST',input)).body.task
  await f.store.setServerAccess('p-one',{serverId:r.server.server.id,allowed:false,expectedRevision:2,requestId:randomUUID()},platform)
  assert.equal((await f.request('/tasks','POST',input)).body.task.id,accepted.id)
  await assert.rejects(f.request('/tasks','POST',{...input,requestId:randomUUID()}),{status:403,code:'DEPLOYMENT_SERVER_ACCESS_REVOKED'})
  const claimed = Promise.withResolvers(), originalClaim = DeploymentService.prototype.claim
  t.mock.method(DeploymentService.prototype,'claim',async function(...args) {
    const result = await originalClaim.apply(this,args)
    claimed.resolve(result)
    return result
  })
  const controller = new AbortController()
  const pending = fetch(`http://127.0.0.1:${f.store.agentAddress.port}/api/agent/v1/claim`,{
    method:'POST',headers:{'content-type':'application/json',Authorization:`Bearer ${registered.token}`},body:'{}',signal:controller.signal,
  }).catch(error => {if(error.name !== 'AbortError') throw error})
  try {
    assert.equal(await claimed.promise,null)
    const rejected = (await f.request(`/tasks/${accepted.id}`)).body.task
    assert.equal(rejected.status,'interrupted')
    assert.equal(rejected.startedAt,undefined)
  } finally {controller.abort();await pending}
  await f.store.setServerAccess('p-one',{serverId:r.server.server.id,allowed:true,expectedRevision:3,requestId:randomUUID()},platform)
  const next = (await f.request('/tasks','POST',{...input,requestId:randomUUID()})).body.task
  assert.notEqual(next.id,accepted.id)
  assert.equal(next.status,'queued')
})

test('项目与同名环境使用持久ID映射，重启不新增默认环境；GET/POST和历史均校验管理及环境权限',async t=>{
  const f=await fixture(t), r=await records(f)
  const overview=(await f.request()).body
  assert.deepEqual(overview.environments.map(item=>item.id),['env-one'])
  assert.equal(overview.targets.length,1);assert.equal(overview.servers.length,1)
  assert.doesNotMatch(JSON.stringify(overview),/tokenHash|registrationHash|master\.key|source\.zip|\/private\/|\/Users\//)
  const state=readState(f.dataDir), maps=state.autoopsDeploymentBindings.projects
  assert.equal(state.deployments.environments.length,2)
  assert.equal(new Set(maps[0].environments.map(item=>item.legacyEnvironmentId)).size,2)
  const applicationId=maps[0].applicationId
  // History limits must be applied after project scoping, and must never hide
  // an old task that is still running while newer tasks have already ended.
  const db=new DatabaseSync(join(f.dataDir,'deployment-center/state.sqlite'))
  try {
    const snapshot=JSON.parse(db.prepare('SELECT value FROM application_state WHERE id=1').get().value)
    snapshot.deployments.tasks.push({id:randomUUID(),targetId:r.target.id,serverId:r.server.server.id,applicationId,status:'running',stage:'building',createdAt:new Date().toISOString(),lastSeq:0})
    for(let index=0;index<205;index++) snapshot.deployments.tasks.push({id:randomUUID(),targetId:r.target.id,serverId:r.server.server.id,applicationId,status:'succeeded',stage:'succeeded',createdAt:new Date().toISOString(),lastSeq:0})
    for(let index=0;index<205;index++) snapshot.deployments.tasks.push({id:randomUUID(),targetId:randomUUID(),applicationId:'unrelated-project',status:'succeeded',stage:'succeeded',createdAt:new Date().toISOString(),lastSeq:0})
    db.prepare('UPDATE application_state SET value=? WHERE id=1').run(JSON.stringify(snapshot))
  } finally {db.close()}
  const history=(await f.request()).body.tasks
  assert.equal(history.length,201)
  assert.equal(history.filter(item=>item.status==='running').length,1)
  await f.reopen();await f.request()
  assert.equal(readState(f.dataDir).deployments.environments.length,2)
  assert.equal(readState(f.dataDir).autoopsDeploymentBindings.projects[0].applicationId,applicationId)
  const repeated=(await f.request('/targets','POST',r.targetInput)).body.target
  assert.equal(repeated.id,r.target.id)
  await assert.rejects(f.request('/targets','POST',{...r.targetInput,name:'不同参数'}),{status:409})
  await assert.rejects(f.request('?environmentId=env-two'),{status:403})
  for (const p of [{...principal,external:true},{...principal,id:'member'},{...principal,id:'other-user'}]) {
    await assert.rejects(f.request('','GET',undefined,p),{status:403})
    await assert.rejects(f.request('/targets','POST',r.targetInput,p),{status:403})
    await assert.rejects(f.request(`/targets/${r.target.id}/releases`,'GET',undefined,p),{status:403})
  }
  const other=(await f.request('','GET',undefined,principal,'p-other')).body
  assert.equal(other.targets.length,0);assert.equal(other.servers.length,0)
  await assert.rejects(f.request(`/targets/${r.target.id}/releases`,'GET',undefined,principal,'p-other'),{status:404})
  principal.allowed.push('env-two')
  try { await assert.rejects(f.request('/targets','POST',{...r.targetInput,requestId:randomUUID(),environmentId:'env-two'}),{status:404}) }
  finally { principal.allowed.splice(principal.allowed.indexOf('env-two'), 1) }
})

test('真实角色经 HTTP 与引擎同源裁决环境覆盖，伪造环境和隐式创建共享服务都拒绝', async t => {
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  t.after(() => { sessionDb.close(); bindingDb.close() })
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('role-http-session').digest('hex'), 'manager', 'csrf', Date.now() + 60_000)
  sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('platform-role-http-session').digest('hex'), 'platform', 'csrf', Date.now() + 60_000)
  const membership = { userId: 'manager', role: 'project_admin', workspaceAccess: 'internal', environmentIds: ['env-one', 'env-two'], environmentRoles: {}, status: 'active' }
  const catalog = { users: [{ id: 'manager', name: '真实角色成员', role: 'member' }, { id: 'platform', name: '平台节点管理者', role: 'admin' }], projects: [{ ...projects[0], memberships: [membership], memberIds: ['manager'], documents: [], resources: [] }], agents: [] }
  const realAccess = createAutoOpsAccess({ sessionDb, bindingDb, catalog, deploymentEnabled: () => true })
  const realPrincipal = realAccess.authenticateCookie('demo_session=role-http-session')
  const platformPrincipal = realAccess.authenticateCookie('demo_session=platform-role-http-session')
  const f = await fixture(t, { listener: true, accessLayer: realAccess, requestPrincipal: realPrincipal }), r = await records(f, platformPrincipal)
  await agent(f, '/register', { registrationToken: r.server.registrationToken, capabilities: ['static-site-v1'] })
  const server = (await provisionNode(f, { name: '生产隔离节点', environmentId: 'env-two', requestId: randomUUID() }, platformPrincipal)).server
  const production = (await f.request('/targets', 'POST', { ...r.targetInput, name: '生产隔离目标', serverId: server.id, environmentId: 'env-two', requestId: randomUUID() })).body.target
  Object.assign(membership, { role: 'developer', environmentRoles: { 'env-one': 'release_operator', 'env-two': 'reader' } })
  const input = { targetId: r.target.id, action: 'deploy', service: 'frontend', packageId: r.pack.id, configKey: r.target.configKey, requestId: randomUUID() }
  const task = (await f.request('/tasks', 'POST', input)).body.task
  assert.equal(task.environmentId, 'env-one')
  assert.equal((await f.request(`/tasks/${task.id}`)).body.task.id, task.id)
  const forged = { ...input, targetId: production.id, configKey: production.configKey, requestId: randomUUID(), environmentId: 'env-one' }
  await assert.rejects(f.request('/tasks', 'POST', forged), { code: 'DEPLOYMENT_ACTION_FORBIDDEN' })
  await assert.rejects(f.store.createTask('p-one', forged, realPrincipal), { code: 'DEPLOYMENT_ACTION_FORBIDDEN' })
  const before = f.store.overview(catalog.projects[0], ['env-one', 'env-two'])
  await assert.rejects(f.request('/services', 'POST', { name: '越权共享服务', kind: 'java', requestId: randomUUID() }), { code: 'DEPLOYMENT_ACTION_FORBIDDEN' })
  await assert.rejects(f.request('/targets', 'POST', { ...r.targetInput, name: '隐式共享服务', requestId: randomUUID() }), { code: 'DEPLOYMENT_ACTION_FORBIDDEN' })
  const after = f.store.overview(catalog.projects[0], ['env-one', 'env-two'])
  assert.deepEqual(after.services, before.services)
  assert.deepEqual(after.targets, before.targets)
  assert.equal(after.tasks.length, 1)
  assert.equal((await f.request('/tasks', 'POST', input)).body.task.id, task.id)
})

test('真实内部ZIP移交原引擎归档、原Agent协议、日志补读、发布和回退；幂等不执行Git并忽略伪造actor',async t=>{
  const f=await fixture(t,{listener:true}), r=await records(f)
  assert.equal(f.store.agentAddress.address,'127.0.0.1')
  const registered=await agent(f,'/register',{registrationToken:r.server.registrationToken,version:'adapter-test',capabilities:['static-site-v1','source-archive-recovery-v1','delivery-telemetry-v1']})
  const input={targetId:r.target.id,action:'deploy',service:'frontend',packageId:r.pack.id,configKey:r.target.configKey,requestId:randomUUID(),actor:{id:'forged'}}
  const task=(await f.request('/tasks','POST',input)).body.task
  assert.equal(task.status,'queued');assert.equal(task.sourceIdentity.sourceVersionId,r.source.id)
  assert.deepEqual(task.actor,{id:'manager',displayName:'真实管理者'})
  assert.equal((await f.request('/tasks','POST',input)).body.task.id,task.id)
  assert.deepEqual(await readdir(join(f.dataDir,'deployment-center/workspace-inputs')),[])
  const claimed=(await agent(f,'/claim',{},registered.token)).task
  assert.equal(claimed.id,task.id)
  const archive=await fetch(`http://127.0.0.1:${f.store.agentAddress.port}/api/agent/v1/tasks/${task.id}/source`,{headers:{Authorization:`Bearer ${registered.token}`}})
  assert.equal(archive.status,200);assert.equal(archive.headers.get('x-archive-sha256'),r.pack.services[0].sha256)
  assert.ok((await archive.arrayBuffer()).byteLength>100)
  await agent(f,`/tasks/${task.id}/events`,{seq:1,stage:'building',message:'真实协议构建日志'},registered.token)
  await agent(f,`/tasks/${task.id}/events`,{seq:2,stage:'verifying',status:'succeeded',result:{release:{id:task.id,artifact:`static/${task.targetId}/${task.id}`,kind:'static',revision:task.revision}}},registered.token)
  const details=(await f.request(`/tasks/${task.id}?after=1`)).body
  assert.deepEqual(details.logs.map(item=>item.seq),[2]);assert.equal(details.nextSeq,3)
  assert.equal(details.task.status,'succeeded')
  const releases=(await f.request(`/targets/${task.targetId}/releases`)).body.releases
  assert.equal(releases.length,1);assert.equal(releases[0].available,true);assert.equal(releases[0].current,true)
  const rollback=(await f.request('/tasks','POST',{targetId:task.targetId,action:'rollback',service:'frontend',releaseId:task.id,configKey:r.target.configKey,requestId:randomUUID()})).body.task
  assert.equal(rollback.status,'queued');assert.equal(rollback.actor.id,principal.id)
  await agent(f,'/claim',{},registered.token)
  await agent(f,`/tasks/${rollback.id}/events`,{seq:1,stage:'verifying',status:'failed',message:'发布与恢复失败',result:{error:'站点健康检查超时',rollback:{status:'failed',error:'旧版本健康检查失败',tokenHash:'不允许导出'},tokenHash:'不允许导出'}},registered.token)
  const failed=(await f.request(`/tasks/${rollback.id}`)).body.task
  assert.deepEqual(failed.result,{error:'站点健康检查超时',rollback:{status:'failed',error:'旧版本健康检查失败'}})
  await assert.rejects(f.request(`/tasks/${task.id}`,'GET',undefined,{...principal,allowed:[]}),{status:403})
  await assert.rejects(f.request(`/tasks/${task.id}`,'GET',undefined,principal,'p-other'),{status:404})
  const exposed=JSON.stringify({details,releases,rollback})
  assert.doesNotMatch(exposed,/tokenHash|registrationHash|requestFingerprint|sourceSnapshot|sourceArchiveId|\/private\/|\/Users\//)
  const state=readState(f.dataDir);assert.equal(state.projects.length,0);assert.equal(state.deployments.sourceArchives.length,1)
})

test('固定包上下文、项目来源和配置变化拒绝发布，服务器一次性口令不重发',async t=>{
  const f=await fixture(t,{listener:true}), r=await records(f)
  const repeated=await f.store.createGlobalServer({name:r.serverInput.name,requestId:r.serverInput.requestId},{id:'platform'})
  assert.equal(repeated.server.id,r.server.server.id);assert.equal(repeated.registrationToken,null)
  await agent(f,'/register',{registrationToken:r.server.registrationToken,capabilities:['static-site-v1']})
  const base={targetId:r.target.id,action:'deploy',service:'frontend',packageId:r.pack.id,configKey:r.target.configKey,requestId:randomUUID()}
  await assert.rejects(f.request('/tasks','POST',{...base,configKey:'0'.repeat(64)}),{status:409})
  await assert.rejects(f.request('/tasks','POST',{...base,service:'backend'}),{status:400})
  await assert.rejects(f.request('/tasks','POST',{...base,packageId:randomUUID()}),{status:404})
  const mismatched=(await f.request('/targets','POST',{...r.targetInput,requestId:randomUUID(),config:{...r.targetInput.config,module:'frontend'}})).body.target
  await assert.rejects(f.request('/tasks','POST',{...base,targetId:mismatched.id,configKey:mismatched.configKey}),{status:409})
  const packageFile=f.workspaceStore.packageFile
  f.workspaceStore.packageFile=(...args)=>({...packageFile(...args),bytes:Buffer.from('已被篡改的包')})
  await assert.rejects(f.request('/tasks','POST',base),{status:409})
  f.workspaceStore.packageFile=packageFile
  const getVersion=f.workspaceStore.getVersion
  f.workspaceStore.getVersion=(...args)=>({...getVersion(...args),type:'external'})
  await assert.rejects(f.request('/tasks','POST',base),{status:409})
  f.workspaceStore.getVersion=(...args)=>({...getVersion(...args),status:'pending_review'})
  await assert.rejects(f.request('/tasks','POST',base),{status:409})
  for (const cachePurpose of ['source', 'external-input']) {
    f.workspaceStore.getVersion=(...args)=>({...getVersion(...args),cachePurpose})
    await assert.rejects(f.request('/tasks','POST',base),{status:409,code:'DEPLOYMENT_SOURCE_INVALID'})
  }
  f.workspaceStore.getVersion=getVersion
  assert.equal(readState(f.dataDir).deployments.tasks.length,0)
})

test('独立 Git 源码包无需日常工作区版本，清单固定多仓提交并沿用部署收据', async t => {
  const f = await fixture(t,{listener:true}), r = await records(f)
  await agent(f,'/register',{registrationToken:r.server.registrationToken,capabilities:['static-site-v1']})
  const repositories = [{path:'app',commit:'a'.repeat(40)},{path:'shared',commit:'b'.repeat(40)}]
  const requestId = randomUUID()
  const prepare = async ({materializeCache}) => {
    const version = await materializeCache({cacheKey:'deployment-test',source:{repositories,documents:[]}},async ({root}) => {
      await mkdir(join(root,'app'),{recursive:true}); await mkdir(join(root,'shared'),{recursive:true})
      await writeFile(join(root,'app','package.json'),JSON.stringify({name:'isolated-app'}))
      await writeFile(join(root,'shared','README.md'),'共享源码')
    })
    return {sourceVersionId:version.id,contexts:[{service:'frontend',root:'.',workingDirectory:'app'}]}
  }
  const input = {requestId,sources:[{sourceId:'app', refKind: 'default', ref: '', mountPath: 'app' },{sourceId:'shared', refKind: 'default', ref: '', mountPath: 'app' }],contexts:[{service:'frontend',root:'.',workingDirectory:'app'}]}
  const completed = await finish(f.workspaceStore,'p-one',f.workspaceStore.startSourcePackages('p-one',input,prepare,principal.id))
  assert.equal(f.workspaceStore.startSourcePackages('p-one',input,prepare,principal.id).id,completed.id)
  const pack = f.workspaceStore.overview('p-one').releases.find(value=>value.id===completed.releaseId)
  assert.equal(f.workspaceStore.overview('p-one').internalVersions.some(value=>value.id===pack.sourceVersionId),false)
  assert.deepEqual(pack.manifest.source.repositories,repositories)
  assert.deepEqual(pack.manifest.source.documents,[])
  const target=(await f.request('/targets','POST',{...r.targetInput,requestId:randomUUID(),config:{...r.targetInput.config,module:'app'}})).body.target
  const submitted={targetId:target.id,action:'deploy',service:'frontend',packageId:pack.id,configKey:target.configKey,requestId:randomUUID()}
  const task=(await f.request('/tasks','POST',submitted)).body.task
  assert.deepEqual(task.sourceIdentity.repositories,repositories)
  assert.equal((await f.request('/tasks','POST',submitted)).body.task.id,task.id)
})

test('未启用部署也要授权，合法GET显示真实关闭状态，其余操作503',async()=>{
  const request=(method='GET',p=principal)=>handleDeploymentRequest({access,store:undefined,principal:p,url:new URL('http://demo/autoops/projects/p-one/deployments'),method})
  assert.equal((await request()).body.enabled,false)
  await assert.rejects(request('POST'),{status:503})
  await assert.rejects(request('GET',{...principal,external:true}),{status:403})
})

test('关闭等待已接受的Agent写入，即使客户端断开也先落盘后释放存储', async t => {
  const f=await fixture(t,{listener:true})
  await f.store.ensureProject(projects[0])
  const server=await provisionNode(f,{name:'关闭验证',environmentId:'env-one',requestId:randomUUID()})
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),listenerClosed=Promise.withResolvers()
  const originalRegister=DeploymentService.prototype.register,originalClose=Store.prototype.close,originalListenerClose=HttpServer.prototype.close
  let storageClosed=false
  // 只在隔离测试中设置真实写入前的屏障，生产协作仍使用公开方法。
  t.mock.method(DeploymentService.prototype,'register',async function(input) {
    entered.resolve();await release.promise;return originalRegister.call(this,input)
  })
  t.mock.method(Store.prototype,'close',function() {
    if(this.directory===join(f.dataDir,'deployment-center'))storageClosed=true
    return originalClose.call(this)
  })
  const address=f.store.agentAddress
  t.mock.method(HttpServer.prototype,'close',function(callback) {
    const selected=this.address()?.port===address.port
    return originalListenerClose.call(this,(...args)=>{if(selected)listenerClosed.resolve();callback?.(...args)})
  })
  const request=httpRequest({hostname:'127.0.0.1',port:address.port,path:'/api/agent/v1/register',method:'POST',headers:{'content-type':'application/json'}})
  request.on('error',()=>{})
  request.end(JSON.stringify({registrationToken:server.registrationToken,capabilities:['static-site-v1']}))
  let closing
  try {
    await entered.promise
    request.destroy()
    let completed=false
    closing=f.store.close().then(()=>{completed=true})
    // 已确认监听与全部socket关闭，剩余阻塞只能来自已接受的异步写入。
    await listenerClosed.promise
    await new Promise(done=>setImmediate(done))
    assert.equal(completed,false)
    assert.equal(storageClosed,false)
    await assert.rejects(f.store.createServer('p-one',{}),{code:'DEPLOYMENT_STOPPING'})
  } finally { release.resolve();if(closing)await closing }
  assert.equal(storageClosed,true)
  const saved=readState(f.dataDir).deployments.servers.find(item=>item.id===server.server.id)
  assert.ok(saved.registeredAt)
  assert.ok(saved.tokenHash)
  await f.reopen()
  assert.ok(f.store.overview(projects[0],['env-one']).servers.find(item=>item.id===server.server.id).registeredAt)
})

test('Agent端口占用导致初始化失败时清理自己的资源，不关闭已有监听者', async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'t3-deployment-init-fail-'))
  const occupied=createHttpServer((_request,response)=>response.end('fixture-owner'))
  await new Promise(done=>occupied.listen(0,'127.0.0.1',done))
  const workspaceStore=createWorkspaceStore({dataDir,authorizeTask:()=>{}})
  const store=createDeploymentStore({dataDir,workspaceStore,access,agentPort:occupied.address().port})
  t.after(async()=>{await store.close();await workspaceStore.close();await new Promise(done=>occupied.close(done));await rm(dataDir,{recursive:true,force:true})})
  await assert.rejects(store.initialize(),{code:'EADDRINUSE'})
  await assert.rejects(store.initialize(),{code:'DEPLOYMENT_CLOSED'})
  await Promise.all([store.close(),store.close()])
  assert.equal(await(await fetch(`http://127.0.0.1:${occupied.address().port}`)).text(),'fixture-owner')
})


test('Java 服务复用多个部署位置，编辑使用配置快照且发布固定 backend 包', async t => {
  const f = await fixture(t), r = await records(f)
  const serviceInput = {name:'订单服务',kind:'java',module:'.',requestId:randomUUID(),actor:{id:'forged'}}
  const service = (await f.request('/services','POST',serviceInput)).body.service
  assert.equal(service.kind,'java')
  assert.equal((await f.request('/services','POST',serviceInput)).body.service.id,service.id)
  const input = {serviceId:service.id,environmentId:'env-one',serverId:r.server.server.id,requestId:randomUUID(),config:{kind:'java',module:'.'}}
  const target = (await f.request('/targets','POST',input)).body.target
  assert.equal(target.serviceId,service.id); assert.equal(target.service,'backend')
  assert.equal(target.config.kind,'java')
  const editedInput = {config:{...target.config,profile:'test'},configKey:target.configKey,requestId:randomUUID()}
  const edited = (await f.request(`/targets/${target.id}`,'PATCH',editedInput)).body.target
  assert.equal(edited.config.profile,'test'); assert.equal(edited.currentRelease,undefined)
  assert.equal((await f.request(`/targets/${target.id}`,'PATCH',editedInput)).body.target.configKey,edited.configKey)
  await assert.rejects(f.request(`/targets/${target.id}`,'PATCH',{...editedInput,requestId:randomUUID()}),{status:409})
  await assert.rejects(f.request(`/targets/${target.id}`,'PATCH',{...editedInput,configKey:edited.configKey,environmentId:'env-two',requestId:randomUUID()}),{status:400})
  await assert.rejects(f.request('/services','POST',{...serviceInput,id:service.id,configKey:'stale',requestId:randomUUID()}),{status:409})
  const source = f.workspaceStore.overview('p-one').internalVersions[0]
  const completed = await finish(f.workspaceStore,'p-one',f.workspaceStore.startPackages('p-one',{sourceVersionId:source.id,services:['backend'],requestId:randomUUID()}))
  const submission = {targetId:target.id,action:'deploy',service:'backend',packageId:completed.releaseId,configKey:edited.configKey,requestId:randomUUID()}
  const task = (await f.request('/tasks','POST',submission)).body.task
  assert.equal(task.status,'queued'); assert.equal(task.sourceIdentity.service,'backend')
  assert.equal((await f.request('/tasks','POST',submission)).body.task.id,task.id)
  await assert.rejects(f.request('/tasks','POST',{...submission,service:'frontend',requestId:randomUUID()}),{status:400})
  await f.reopen()
  const overview = (await f.request()).body
  assert.equal(overview.services.find(item=>item.id===service.id).kind,'java')
  assert.equal(overview.targets.find(item=>item.id===target.id).config.profile,'test')
})

test('发布默认来源按项目环境校验，一次确认后后台固定源码且原请求不重复创建', async t => {
  let workspaceStore
  const sources = [{id:'source-one',mountPath:'app'}]
  const management = {
    authoring: { repositories(){ return { items: sources } } },
    startDeploymentPackages(projectId,input,actorId) {
      return workspaceStore.startSourcePackages(projectId,input,async ({materializeCache})=> {
        const version = await materializeCache({cacheKey:'automatic-source',source:{repositories:[{path:'app',commit:'a'.repeat(40)}],documents:[]}}, async ({root})=> {
          await mkdir(join(root,'app'),{recursive:true}); await writeFile(join(root,'app','pom.xml'),'<project/>')
          await mkdir(join(root,'app','next-module'),{recursive:true}); await writeFile(join(root,'app','next-module','pom.xml'),'<project/>')
        })
        return {sourceVersionId:version.id,contexts:input.contexts}
      },actorId)
    },
    receipt(projectId,requestId,actorId){ return {task:workspaceStore.taskForRequest(projectId,'packages',requestId,actorId)} },
  }
  const f = await fixture(t,{workspaceManagement:management,listener:true}), r = await records(f)
  const registered = await agent(f,'/register',{registrationToken:r.server.registrationToken,capabilities:['source-archive-recovery-v1']})
  workspaceStore = f.workspaceStore
  const service = (await f.request('/services','POST',{name:'自动发布',kind:'java',module:'.',requestId:randomUUID()})).body.service
  const target = (await f.request('/targets','POST',{serviceId:service.id,environmentId:'env-one',serverId:r.server.server.id,config:{kind:'java'},requestId:randomUUID()})).body.target
  const selection = {sources:[{sourceId:'source-one',refKind:'branch',ref:'release', mountPath: 'app' }],contexts:[{service:'backend',root:'app',workingDirectory:'.'}],requestId:randomUUID()}
  const saved = (await f.request(`/services/${service.id}/sources/env-one`,'PUT',selection)).body.source
  assert.equal(saved.sources[0].ref,'release')
  await assert.rejects(f.request(`/services/${service.id}/sources/env-two`,'PUT',selection),{status:403})
  await assert.rejects(f.request(`/services/${service.id}/sources/env-one`,'PUT',{...selection,requestId:randomUUID(),sources:[{sourceId:'other-project', refKind: 'default', ref: '', mountPath: 'app' }]}),{status:404})
  const submission={targetId:target.id,action:'deploy',service:'backend',configKey:target.configKey,requestId:randomUUID()}
  const task=(await f.request('/tasks','POST',submission)).body.task
  assert.equal(task.status,'preparing')
  assert.equal((await f.request('/tasks','POST',submission)).body.task.id,task.id)
  const explicitSubmission = {...submission,requestId:randomUUID(),sourceSelection:{sources:selection.sources,contexts:selection.contexts}}
  const explicitTask = (await f.request('/tasks','POST',explicitSubmission)).body.task
  for (const change of [{ mountPath: 'changed-mount' }, { sourcePath: 'changed-subdirectory' }])
    await assert.rejects(f.request('/tasks','POST',{...explicitSubmission,sourceSelection:{...explicitSubmission.sourceSelection,sources:[{...selection.sources[0],...change}]}}),{status:409})
  await f.request(`/services/${service.id}/sources/env-one`,'PUT',{...selection,requestId:randomUUID(),configKey:saved.configKey,sources:[{sourceId:'source-one',refKind:'branch',ref:'next', mountPath: 'app' }]})
  assert.equal((await f.request('/tasks','POST',submission)).body.task.id,task.id)
  sources.splice(0)
  assert.equal((await f.request('/tasks','POST',submission)).body.task.id,task.id)
  assert.equal((await f.request('/tasks','POST',explicitSubmission)).body.task.id,explicitTask.id)
  await assert.rejects(f.request('/tasks','POST',{...submission,configKey:'b'.repeat(64)}),{status:409})
  await assert.rejects(f.request('/tasks','POST',{...explicitSubmission,sourceSelection:{...explicitSubmission.sourceSelection,sources:[{sourceId:'source-one',refKind:'branch',ref:'changed', mountPath: 'app' }]}}),{status:409})
  await f.store.close()
  await f.reopen()
  const result=(await f.request(`/tasks/${task.id}`)).body.task
  assert.equal(result.status,'queued',result.error)
  assert.equal(result.sourceIdentity.repositories[0].commit,'a'.repeat(40))
  assert.equal((await f.request()).body.tasks.filter(item=>item.requestId===submission.requestId).length,1)
  assert.equal((await f.request('/tasks','POST',submission)).body.task.id,task.id)
  await agent(f,'/claim',{},registered.token)
  await agent(f,`/tasks/${task.id}/events`,{seq:1,stage:'verifying',status:'succeeded',result:{release:{id:task.id,image:`cmr/${target.id}:${task.id}`,revision:result.sourceIdentity.repositories[0].commit}}},registered.token)
  const history = (await f.request(`/targets/${target.id}/releases`)).body.releases
  assert.deepEqual(history[0].sourceSelection, {sources:selection.sources,contexts:selection.contexts})
  await agent(f,'/claim',{},registered.token)
  await agent(f,`/tasks/${explicitTask.id}/events`,{seq:1,stage:'failed',status:'failed',message:'隔离测试结束'},registered.token)
  await f.request('/services','POST',{id:service.id,name:service.name,kind:'java',module:'next-module',configKey:service.configKey,requestId:randomUUID()})
  assert.equal((await f.request('/tasks','POST',submission)).body.task.id,task.id)
  assert.equal((await f.request('/tasks','POST',explicitSubmission)).body.task.id,explicitTask.id)
  const fresh = (await f.request()).body.targets.find(entry=>entry.id===target.id)
  assert.equal(fresh.config.module,'next-module','服务目录变化后，概览必须返回下次任务实际使用的配置')
  assert.notEqual(fresh.configKey,target.configKey)
  assert.equal(fresh.currentRelease.config.module,'','历史运行版本继续保留原构建目录')
  assert.equal((await f.request(`/targets/${target.id}/releases`)).body.releases[0].config.module,'')
  sources.push({id:'source-one',mountPath:'app'})
  const nextSelection = {sources:selection.sources,contexts:[{service:'backend',root:'app',workingDirectory:fresh.config.module}]}
  const nextSubmission = {...submission,requestId:randomUUID(),configKey:fresh.configKey,sourceSelection:nextSelection}
  await assert.rejects(f.request('/tasks','POST',{...nextSubmission,configKey:target.configKey}),{status:409})
  const nextTask = (await f.request('/tasks','POST',nextSubmission)).body.task
  await f.store.close(); await f.reopen()
  const prepared = (await f.request(`/tasks/${nextTask.id}`)).body.task
  assert.equal(prepared.status,'queued',prepared.error)
  assert.equal(prepared.config.module,fresh.config.module)
  await agent(f,'/claim',{},registered.token)
  await agent(f,`/tasks/${nextTask.id}/events`,{seq:1,stage:'failed',status:'failed',message:'隔离测试结束'},registered.token)
  await assert.rejects(f.request('/tasks','POST',{...submission,requestId:randomUUID(),configKey:fresh.configKey,packageId:result.sourceIdentity.packageId}),{status:409,code:'DEPLOYMENT_CONTEXT_MISMATCH'})
  const fixed = (await f.request('/tasks','POST',{...submission,requestId:randomUUID(),configKey:fresh.configKey,packageId:prepared.sourceIdentity.packageId})).body.task
  assert.equal(fixed.status,'queued')
  assert.equal(fixed.config.module,fresh.config.module)
  assert.equal((await f.request(`/targets/${target.id}/releases`)).body.releases[0].config.module,'')
})

test('宿主停止接单时已成功固定的源码按原持久收据继续归档，重启后保留原排队任务', async t => {
  let workspaceStore, management, continuePackaging, enteredPackaging
  const packaging = new Promise(resolve => { enteredPackaging = resolve })
  const gate = new Promise(resolve => { continuePackaging = resolve })
  const sources = [{id:'source-one',mountPath:'app'}]
  const port = {
    authoring: { repositories(){ return { items: sources } } },
    startDeploymentPackages(projectId,input,actorId) {
      return workspaceStore.startSourcePackages(projectId,input,async ({materializeCache})=> {
        enteredPackaging(); await gate
        const version = await materializeCache({cacheKey:'draining-source',source:{repositories:[{path:'app',commit:'c'.repeat(40)}],documents:[]}}, async ({root})=> {
          await mkdir(join(root,'app'),{recursive:true}); await writeFile(join(root,'app','pom.xml'),'<project/>')
        })
        return {sourceVersionId:version.id,contexts:input.contexts}
      },actorId)
    },
    receipt(...args){ return management.receipt(...args) },
  }
  const f = await fixture(t,{workspaceManagement:port}), r = await records(f)
  workspaceStore = f.workspaceStore
  management = createWorkspaceManagement({access:{requireWorkspaceReader(){},requireWorkspaceActor(){}},store:workspaceStore,authoring:{currentAdoptionProjects(){return []}},credentials:{},git:{}})
  const service = (await f.request('/services','POST',{name:'排空发布',kind:'java',module:'.',requestId:randomUUID()})).body.service
  const target = (await f.request('/targets','POST',{serviceId:service.id,environmentId:'env-one',serverId:r.server.server.id,config:{kind:'java'},requestId:randomUUID()})).body.target
  const submission = {targetId:target.id,action:'deploy',service:'backend',configKey:target.configKey,requestId:randomUUID(),sourceSelection:{sources:[{sourceId:'source-one',refKind:'branch',ref:'release', mountPath: 'app' }],contexts:[{service:'backend',root:'app',workingDirectory:'.'}]}}
  const task = (await f.request('/tasks','POST',submission)).body.task
  await packaging
  management.stopAccepting(); workspaceStore.stopAccepting(); f.store.stopAccepting()
  continuePackaging()
  await f.store.close()
  const sourceReceipt = workspaceStore.taskForRequest('p-one','packages',submission.requestId,principal.id)
  assert.equal(sourceReceipt.status,'completed',sourceReceipt.error)
  await f.reopen()
  const resumed = (await f.request(`/tasks/${task.id}`)).body.task
  assert.equal(resumed.status,'queued',resumed.error)
  assert.equal(resumed.sourceIdentity.packageId,sourceReceipt.releaseId)
  assert.equal((await f.request('/tasks','POST',submission)).body.task.id,task.id)
})

test('目标运行观测只返回安全字段，服务端时间判定过期且缺失不假装健康', async t => {
  const f = await fixture(t,{listener:true}), r = await records(f)
  const before = (await f.request()).body.targets[0]
  assert.equal(before.observation,null); assert.equal(before.observationStale,true)
  const registered = await agent(f,'/register',{registrationToken:r.server.registrationToken,capabilities:['static-site-v1']})
  await agent(f,'/heartbeat',{containers:[{targetId:r.target.id,kind:'static',exists:true,status:'published',health:'healthy',managed:true,restartCount:0,startedAt:'2026-10-25T00:00:00Z',containerName:'/private/hidden-container',image:'private-image',unexpected:{token:'isolated-hidden-token'}}]},registered.token)
  const target = (await f.request()).body.targets[0]
  assert.deepEqual(target.observation,{targetId:r.target.id,kind:'static',exists:true,status:'published',health:'healthy',managed:true,restartCount:0,startedAt:'2026-10-25T00:00:00Z'})
  assert.equal(target.observationStale,false); assert.ok(Number.isFinite(Date.parse(target.lastObservedAt)))
  assert.doesNotMatch(JSON.stringify(target),/hidden-container|private-image|isolated-hidden-token/)
  const dateNow = Date.now
  t.mock.method(Date,'now',()=>dateNow()+61_000)
  try { assert.equal((await f.request()).body.targets[0].observationStale,true) }
  finally { Date.now.mock.restore() }
})

test('默认来源已保存后仓库移除和目录变化不阻断原请求核对，仍拒绝撤权和新请求', async t => {
  const sources = [{ id: 'source-one' }]
  let reads = 0
  const f = await fixture(t, { workspaceManagement: { authoring: { repositories() { reads++; return { items: sources } } } } })
  const service = (await f.request('/services', 'POST', { name: '来源收据', kind: 'java', module: '.', requestId: randomUUID() })).body.service
  const input = { sources: [{ sourceId: 'source-one', refKind: 'branch', ref: 'main', mountPath: 'app' }], contexts: [{ service: 'backend', root: '.', workingDirectory: '.' }], requestId: randomUUID() }
  const route = `/services/${service.id}/sources/env-one`
  const saved = (await f.request(route, 'PUT', input)).body.source
  sources.splice(0)
  await f.request('/services', 'POST', { id: service.id, name: service.name, kind: 'java', module: 'backend', configKey: service.configKey, requestId: randomUUID() })
  await f.reopen()
  assert.deepEqual((await f.request(route, 'PUT', input)).body.source, saved)
  assert.equal(reads, 1, '核对已接受请求不重新读取已移除仓库')
  await assert.rejects(f.request(route, 'PUT', { ...input, sources: [{ sourceId: 'source-other', refKind: 'default', ref: '', mountPath: 'app' }] }), { status: 409, code: 'DEPLOYMENT_REQUEST_CONFLICT' })
  await assert.rejects(f.request(route, 'PUT', { ...input, requestId: randomUUID() }), { status: 404, code: 'DEPLOYMENT_SOURCE_NOT_FOUND' })
  await assert.rejects(f.request(route, 'PUT', input, { ...principal, allowed: [] }), { status: 403 })
})
