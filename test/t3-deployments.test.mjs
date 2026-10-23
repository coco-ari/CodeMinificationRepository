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
import {createDeploymentStore} from '../agent-demo/t3-adapters/deployments.mjs'
import {handleDeploymentRequest} from '../agent-demo/t3-adapters/deployment-http.mjs'

const projects = [{id:'p-one', name:'同名项目', environments:[{id:'env-one', name:'测试'},{id:'env-two', name:'测试'}]}, {id:'p-other', name:'同名项目', environments:[{id:'env-one', name:'测试'}]}]
const principal = {id:'manager', displayName:'真实管理者', allowed:['env-one']}
const forbidden = () => { throw Object.assign(new Error('无权访问'), {status:403}) }
const access = {
  requireDeploymentActor(userId, projectId, environmentId) { if (userId !== principal.id) forbidden(); this.requireWorkspaceManager(principal, projectId); this.requireEnvironment(principal, projectId, environmentId) },
  requireProject(p, id) { const project = projects.find((item) => item.id === id); if (!project || p.id === 'other-user') forbidden(); return project },
  requireWorkspaceManager(p) { if (p.id !== 'manager' || p.external) forbidden(); return {workspaceAccess:'internal', role:'manager', environmentIds:p.allowed} },
  requireEnvironment(p, id, env) { if (!this.requireProject(p,id).environments.some((item) => item.id === env) || !p.allowed.includes(env)) forbidden() },
}
async function finish(workspaces, projectId, task) {
  for (let index = 0; index < 200; index++) { const current = workspaces.overview(projectId).tasks.find((item) => item.id === task.id); if (!['queued','running'].includes(current.status)) { assert.equal(current.status,'completed',current.error); return current }; await new Promise((done) => setTimeout(done,10)) }
  assert.fail('工作区生成任务超时')
}
async function fixture(t, {listener = false, accessLayer = access, requestPrincipal = principal} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(),'t3-deployment-')), workspaceStore = createWorkspaceStore({dataDir,authorizeTask:()=>{}})
  for (const project of projects) await workspaceStore.ensureProject(project)
  let store = createDeploymentStore({dataDir,workspaceStore,access:accessLayer,...(listener ? {agentPort:0} : {})})
  await store.initialize()
  const request = (suffix = '', method = 'GET', input, p = requestPrincipal, projectId = 'p-one') => handleDeploymentRequest({access:accessLayer, store, principal:p, url:new URL(`http://demo/autoops/projects/${projectId}/deployments${suffix}`), method,input})
  t.after(async () => { await store.close(); await workspaceStore.close(); await rm(dataDir,{recursive:true,force:true}) })
  return {dataDir,workspaceStore,get store(){return store}, request, async reopen(){await store.close();store = createDeploymentStore({dataDir,workspaceStore,access:accessLayer,...(listener ? {agentPort:0} : {})});await store.initialize();return store}}
}
async function records(f) {
  const serverInput = {name:'隔离服务器',environmentId:'env-one',requestId:randomUUID()}
  const server = (await f.request('/servers','POST',serverInput)).body
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

test('真实成员排队后撤权、重启后撤权均不能领取，权限服务故障保留排队并在恢复后可执行', async (t) => {
  const sessionDb = new DatabaseSync(':memory:'), bindingDb = new DatabaseSync(':memory:')
  t.after(() => { sessionDb.close(); bindingDb.close() })
  sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY, uid TEXT, csrf TEXT, expires INTEGER)')
  initializeAutoOpsAccessSchema(bindingDb)
  sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('real-manager-session').digest('hex'), 'manager', 'csrf', Date.now() + 60_000)
  const catalog = { users: [{ id: 'manager', name: '真实管理者', role: 'member', status: 'active' }], agents: [], projects: projects.map((project) => ({ ...project, documents: [], resources: [], memberIds: ['manager'], memberships: [{ userId: 'manager', workspaceAccess: 'internal', role: 'manager', status: 'active', environmentIds: ['env-one'] }] })) }
  let outage = false
  const realAccess = createAutoOpsAccess({ sessionDb, bindingDb, catalog, deploymentEnabled: () => { if (outage) throw new Error('授权配置不可用'); return true } })
  const realPrincipal = realAccess.authenticateCookie('demo_session=real-manager-session')
  const f = await fixture(t, { listener: true, accessLayer: realAccess, requestPrincipal: realPrincipal }), r = await records(f)
  const registered = await agent(f, '/register', { registrationToken: r.server.registrationToken, capabilities: ['static-site-v1'] })
  const submit = async () => (await f.request('/tasks', 'POST', { targetId: r.target.id, action: 'deploy', service: 'frontend', packageId: r.pack.id, configKey: r.target.configKey, requestId: randomUUID() })).body.task
  const claim = (signal) => fetch(`http://127.0.0.1:${f.store.agentAddress.port}/api/agent/v1/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registered.token}` }, body: '{}', signal })
  const membership = catalog.projects[0].memberships[0]
  for (const revoke of [() => { membership.environmentIds = [] }, () => { membership.role = 'member' }, () => { membership.status = 'disabled' }]) {
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
    Object.assign(membership, { environmentIds: ['env-one'], role: 'manager', status: 'active' })
  }
  const task = await submit()
  outage = true
  assert.equal((await claim()).status, 503)
  assert.equal(readState(f.dataDir).deployments.tasks.find((entry) => entry.id === task.id).status, 'queued')
  assert.equal(f.workspaceStore.overview('p-other').internalVersions.length, 1)
  outage = false
  assert.equal((await (await claim()).json()).task.id, task.id)
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
  await assert.rejects(f.request('/targets','POST',{...r.targetInput,requestId:randomUUID(),environmentId:'env-two'},{...principal,allowed:['env-one','env-two']}),{status:404})
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
  const repeated=(await f.request('/servers','POST',r.serverInput)).body
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
  const input = {requestId,sources:[{sourceId:'app'},{sourceId:'shared'}],contexts:[{service:'frontend',root:'.',workingDirectory:'app'}]}
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
  const server=await f.store.createServer('p-one',{name:'关闭验证',environmentId:'env-one',requestId:randomUUID()})
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
