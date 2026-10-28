// @effect-diagnostics nodeBuiltinImport:off -- 真实 HTTP 只创建隔离登录与 SQLite 夹具，不开启设备执行或写业务目标。
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpRouter } from 'effect/http'
import { AuthSessionId } from '@t3tools/contracts'
import * as EnvironmentAuth from '../auth/EnvironmentAuth.ts'
import type { AutoOpsAccess } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { createAssistantDirectory, questionConfigurationPolicy } from '../../../../../../agent-demo/t3-adapters/assistants/index.ts'
import { sharedProfileVerifier } from '../../../../../../agent-demo/t3-adapters/shared-profile-approvals.ts'
import type { CustomerAssistantRuntime } from '../../../../../../autoops/contracts/customer-assistant-runtime.ts'

const mock=vi.hoisted(()=>({access:undefined as AutoOpsAccess|undefined}))
vi.mock('../../../../../../agent-demo/t3-adapters/access.mjs',async original=>({...await original<typeof import('../../../../../../agent-demo/t3-adapters/access.mjs')>(),configuredAutoOpsAccess:()=>mock.access}))
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../../../../../../agent-demo/t3-adapters/access.mjs'
import { layer } from './customerHttp.ts'
import { RemoteDeviceHub } from './RemoteDeviceService.ts'
import { createCustomerTransportJournal } from '../../../../../../agent-demo/t3-adapters/customer-transport.mjs'
import type { CustomerAgentServerFrame } from '../../../../packages/contracts/src/autoopsRemote.ts'

const cleanups:Array<()=>void|Promise<void>>=[]
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();mock.access=undefined;delete process.env.AUTOOPS_CUSTOMER_AGENTS})

function fixture() {
  process.env.AUTOOPS_CUSTOMER_AGENTS='1'
  const dataDir=mkdtempSync(join(tmpdir(),'autoops-runtime-http-')),sessions=new DatabaseSync(':memory:'),bindings=new DatabaseSync(':memory:')
  cleanups.push(()=>{sessions.close();bindings.close();rmSync(dataDir,{recursive:true,force:true})})
  sessions.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
  initializeAutoOpsAccessSchema(bindings)
  const users=['provider','manager','recipient'].map(id=>({id,name:id,role:'member',status:'active' as const}))
  const projects=['source','target'].map(id=>({id,name:id,memberIds:users.map(u=>u.id),memberships:users.map(u=>({userId:u.id,role:u.id==='manager'||(id==='source'&&u.id==='provider')?'project_admin' as const:'reader' as const,workspaceAccess:'internal' as const,environmentIds:[],status:'active' as const,canAdjustChat:false})),environments:[],documents:[],resources:[]}))
  const agents=[{id:'a-project',name:'业务助手',description:'',capabilities:[],projectIds:['source','target']}]
  for(const user of users)sessions.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(user.id).digest('hex'),user.id,'csrf',60_000)
  let directory:ReturnType<typeof createAssistantDirectory>
  const access=createAutoOpsAccess({sessionDb:sessions,bindingDb:bindings,catalog:{users,projects,agents},now:()=>1000,questions:()=>directory})
  mock.access=access
  for(const user of users)access.recordNativeSession(access.authenticateCookie(`demo_session=${user.id}`),user.id)
  const registry=access.customerRegistry,paired=registry.consumePairing(registry.createPairing('provider').pairingCode,{label:'只读隔离设备'}),principal=registry.authenticateToken(paired.deviceToken)
  const target={kind:'customer' as const,deviceId:paired.device.id,registeredWorkspaceId:'source-directory',workspaceBindingRevision:1,runtimeId:'codex' as const}
  registry.registerWorkspace(principal,{registeredWorkspaceId:target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex',projectId:'source',label:'已共享资料'})
  registry.markConnected(principal)
  const profile={id:'readonly',revision:1,digest:'a'.repeat(64),imageDigest:`sha256:${'b'.repeat(64)}`,policy:'linux-docker-readonly-v1' as const,models:[{id:'isolated-model',supportedReasoningEfforts:['low'],defaultReasoningEffort:'low'}],skills:[]}
  const capability={registeredWorkspaceId:target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex' as const,protocolVersion:1 as const,revision:'actual-fixture-catalog',assistantConfiguration:true,models:[{id:'provider-private-model',supportedReasoningEfforts:['high']}],skills:[],sharedProfile:profile}
  registry.updateCapabilities(principal,capability)
  const {models,skills,...descriptor}=profile,approval=join(dataDir,'profile-approvals.json')
  writeFileSync(approval,JSON.stringify([{providerId:'provider',sourceProjectId:'source',target,profile:descriptor,validationId:'fixture-policy-only-not-os-acceptance',verifiedAt:'2026-10-26T00:00:00Z'}]),{mode:0o600})
  const verifySharedProfile=sharedProfileVerifier(()=>approval)
  directory=createAssistantDirectory({dataDir,membership:(actor,project)=>access.requireProjectActionForActor(actor,project,'chat.use'),manage:(actor,project)=>access.requireProjectActionForActor(actor,project,'project.manage'),validateTarget(){},verifySharedProfile,providers:{registry:()=>registry,displayName:actor=>actor},validate:questionConfigurationPolicy({projects:()=>projects,agents:()=>agents,customers:()=>registry,verifySharedProfile,models:()=>{throw new Error('不能读取平台模型')},skills:()=>[]})})
  cleanups.push(()=>directory.close())
  const preset=directory.saveProvided('provider',null,{requestId:'provided-profile',expectedRevision:0,value:{name:'隔离助手',description:'',instructions:'',enabled:true,configuration:{agentId:'a-project',executionBinding:target,customerProfile:descriptor,environmentId:null,workspaceType:null,visibility:'private',model:{instanceId:`customer-${target.deviceId}-codex`,model:'isolated-model',reasoningEffort:'low'},skillIds:[]}}})
  directory.shareProvided('provider',preset.id,'target',{requestId:'shared-target',expectedRevision:0,enabled:true})
  directory.assign('manager','target',{requestId:'assigned-recipient',expectedRevision:0,target:{kind:'member',id:'recipient'},assistantIds:[preset.id],defaultAssistantId:preset.id})
  const input={projectId:'target',question:{assistantId:preset.id,presetRevision:preset.revision,configuration:preset.configuration}}
  const app=HttpRouter.toWebHandler(layer.pipe(Layer.provideMerge(Layer.succeed(EnvironmentAuth.EnvironmentAuth,{authenticateHttpRequest:(request:{headers:Record<string,string>})=>Effect.succeed({sessionId:AuthSessionId.make(request.headers['x-test-session']??'missing'),subject:'fixture',method:'bearer-access-token',scopes:[]})} as unknown as EnvironmentAuth.EnvironmentAuth['Service']))),{disableLogger:true})
  cleanups.push(app.dispose)
  const request=(body:unknown=input,user='recipient',csrf=true)=>app.handler(new Request('http://localhost/autoops/customer/assistant-runtime',{method:'POST',headers:{'x-test-session':user,'content-type':'application/json',...(csrf?{'x-demo-csrf':'csrf'}:{})},body:typeof body==='string'?body:JSON.stringify(body)}))
  return {access,directory,registry,principal,preset,target,profile,capability,input,request,sessions,projects,app,deviceToken:paired.deviceToken}
}

it('真实HTTP仅为实际获分配者投影目录，不把设备令牌、管理身份或篡改参数当使用权',async()=>{
  const f=fixture()
  expect((await f.request(f.input,'missing')).status).toBe(401)
  expect((await f.request(f.input,'recipient',false)).status).toBe(403)
  expect((await f.request(f.input,'manager')).status).toBe(403)
  const response=await f.request(),body=await response.json() as CustomerAssistantRuntime
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(body).toMatchObject({available:true,profile:'linux-docker-readonly-v1',capabilities:{models:[{id:'isolated-model'}]}})
  expect(JSON.stringify(body)).not.toContain('provider-private-model')
  expect(Object.keys(body.device).sort()).toEqual(['id','label','online','status'])
  expect((await f.request({...f.input,target:f.target})).status).toBe(400)
  const changed={...f.input,question:{...f.input.question,configuration:{...f.input.question.configuration,model:{...f.input.question.configuration.model,model:'tampered'}}}}
  expect((await f.request(changed)).status).toBe(403)
  expect((await f.request(JSON.stringify(f.input)+' '.repeat(128*1024))).status).toBe(400)
})

it('目录失效时仍可读当前合法候选恢复，最终发送继续拒绝下线模型',async()=>{
  const f=fixture()
  f.registry.updateCapabilities(f.principal,{...f.capability,revision:'new-catalog',sharedProfile:{...f.profile,models:[{id:'current-model',supportedReasoningEfforts:['low']}]}})
  const response=await f.request(),body=await response.json()
  expect(response.status).toBe(200)
  expect(body).toMatchObject({available:false,reason:{code:'CUSTOMER_MODEL_UNAVAILABLE'},capabilities:{models:[{id:'current-model'}]}})
  expect(()=>f.directory.validateSelection('recipient','target',f.input.question)).toThrow()
})

it('目录读取后共享撤回或原生登录注销，返回前重查拒绝迟到资料',async()=>{
  const f=fixture(),original=f.access.customerAssistantRuntime
  let reads=0
  f.access.customerAssistantRuntime=(actor,input)=>{
    const value=original(actor,input)
    if(++reads===1)f.directory.shareProvided('provider',f.preset.id,'target',{requestId:'withdraw-before-return',expectedRevision:1,enabled:false})
    return value
  }
  const withdrawn=await f.request()
  expect(withdrawn.status).toBe(403)
  expect(JSON.stringify(await withdrawn.json())).not.toContain('isolated-model')
  f.directory.shareProvided('provider',f.preset.id,'target',{requestId:'share-again',expectedRevision:2,enabled:true})
  f.directory.assign('manager','target',{requestId:'confirm-again',expectedRevision:1,target:{kind:'member',id:'recipient'},assistantIds:[f.preset.id],defaultAssistantId:f.preset.id})
  f.access.customerAssistantRuntime=(actor,input)=>{const value=original(actor,input);f.sessions.prepare('DELETE FROM sessions WHERE uid=?').run('recipient');return value}
  expect((await f.request()).status).toBe(401)
})

it('设备HTTP准入仅接受中心已签发原scope，公开哈希、参数改写和撤回均拒绝',async()=>{
  const f=fixture(),actor=f.access.authenticateCookie('demo_session=recipient')
  f.access.reserveThread(actor,{threadId:'actual-shared',projectId:'target',environmentId:null,agentId:'a-project',visibility:'private',executionBinding:f.target,question:f.input.question})
  const scope=f.access.issueCustomerSessionScope('actual-shared','http-device-session')!
  const request=(body:unknown,token=f.deviceToken)=>f.app.handler(new Request('http://localhost/autoops/customer/connector/shared-admission',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}))
  expect((await request(scope,'invalid')).status).toBe(401)
  const admitted=await request(scope)
  expect(admitted.status).toBe(200)
  expect(await admitted.json()).toEqual({grantId:scope.grantId,available:true})
  expect((await request({...scope,grantId:'public-hash-cannot-issue'})).status).toBe(403)
  expect((await request({...scope,actorId:'provider'})).status).toBe(403)
  expect((await request({...scope,target:{...scope.target,registeredWorkspaceId:'other-source'}})).status).toBe(403)
  expect((await request({...scope,hostProfilePath:'/provider/private/profile'})).status).toBe(400)
  f.directory.shareProvided('provider',f.preset.id,'target',{requestId:'withdraw-device',expectedRevision:1,enabled:false})
  expect((await request(scope)).status).toBe(403)
})

function transportFixture(f:ReturnType<typeof fixture>) {
  const db=new DatabaseSync(':memory:'),journal=createCustomerTransportJournal(db),hub=new RemoteDeviceHub(f.access,journal)
  cleanups.push(()=>{hub.close();db.close()})
  f.registry.markConnected(f.principal)
  const actor=f.access.authenticateCookie('demo_session=recipient'),binding=f.access.reserveThread(actor,{threadId:'actual-transport-thread',projectId:'target',environmentId:null,agentId:'a-project',visibility:'private',executionBinding:f.target,question:f.input.question})
  hub.bind(binding,'transport-session')
  hub.update('transport-session',{runtimeEpoch:'native-original-epoch',state:'idle'})
  const session=hub.session('transport-session')!,scope=session.executionScope!
  const command={type:'command' as const,commandId:'original-command',sessionId:session.sessionId,target:session.target,method:'catalog',runtimeEpoch:session.runtimeEpoch!,executionScope:scope,input:{}}
  journal.saveCommand(command)
  const sent:CustomerAgentServerFrame[]=[]
  const connect=()=>hub.connect(f.principal,async frame=>{sent.push(frame)},()=>{})
  const hello=(shared:boolean)=>({type:'hello' as const,protocolVersion:1 as const,deviceId:f.target.deviceId,connectorVersion:'protocol-fixture-only',connectorEpoch:'current-connector',workspaces:[],sessions:[{sessionId:session.sessionId,runtimeEpoch:session.runtimeEpoch!,state:'idle' as const,live:true}],...(shared?{sharedExecutionVersion:1 as const}:{})})
  return {journal,hub,session,scope,command,sent,connect,hello}
}

function ownConversation(f:ReturnType<typeof fixture>) {
  const owner=f.access.authenticateCookie('demo_session=provider')
  const own=f.directory.saveProvided('provider',null,{requestId:'provided-own',expectedRevision:0,value:{name:'我的电脑助手',description:'',instructions:'沿原电脑工作',enabled:true,configuration:{agentId:'a-project',executionBinding:f.target,environmentId:null,workspaceType:null,visibility:'private',model:{instanceId:`customer-${f.target.deviceId}-codex`,model:'provider-private-model',reasoningEffort:'high'},skillIds:[]}}})
  const binding=f.access.bindThread(owner,{threadId:'owner-collaboration',projectId:'source',environmentId:null,agentId:'a-project',visibility:'private',executionBinding:f.target,question:{assistantId:own.id,presetRevision:own.revision,configuration:own.configuration}})
  f.access.updateThreadVisibility(owner,binding.threadId,{expectedVisibility:'private',visibility:'project'})
  return {owner,binding,own}
}

it('自用电脑共享原会话后成员无需另分配助手，HTTP沿原能力读取且撤回立即失效',async()=>{
  const f=fixture(),t=ownConversation(f),input={threadId:t.binding.threadId}
  const response=await f.request(input),body=await response.json()
  expect(response.status).toBe(200)
  expect(body).toMatchObject({available:true,profile:'self',target:f.target,capabilities:{models:[{id:'provider-private-model'}]}})
  expect(f.directory.catalog('recipient','source').items).toHaveLength(0)
  expect(f.access.requireQuestionForActor('recipient',t.binding.threadId)?.assistantId).toBe(t.own.id)
  expect(f.access.visibleCustomerProviderInstances(f.access.authenticateCookie('demo_session=recipient')).shared).toContain(`customer-${f.target.deviceId}-codex`)
  f.registry.updateCapabilities(f.principal,{...f.capability,revision:'model-offline',models:[{id:'new-model',supportedReasoningEfforts:['high']}]})
  const recovery=await f.request(input)
  expect(recovery.status).toBe(200)
  expect(await recovery.json()).toMatchObject({available:false,reason:{code:'CUSTOMER_MODEL_UNAVAILABLE'},capabilities:{models:[{id:'new-model'}]}})
  f.registry.updateCapabilities(f.principal,f.capability)
  f.access.updateThreadVisibility(t.owner,t.binding.threadId,{expectedVisibility:'project',visibility:'private'})
  expect((await f.request(input)).status).toBe(404)
  expect((await f.request(input,'provider')).status).toBe(200)
})

it('原电脑共享成员的待处理轮次保留实际调用者，转私有后重连只查收据',async()=>{
  const f=fixture(),t=ownConversation(f),recipient=f.access.authenticateCookie('demo_session=recipient')
  f.access.recordMessageActor(recipient,t.binding.threadId,'collab-command','collab-message')
  expect(f.access.prepareCustomerRun(t.binding.threadId,'collab-run','collab-message')).toBeUndefined()
  expect(f.access.requireCustomerRunActor(t.binding.threadId,'collab-run')).toBe('recipient')
  const db=new DatabaseSync(':memory:'),journal=createCustomerTransportJournal(db),hub=new RemoteDeviceHub(f.access,journal)
  cleanups.push(()=>{hub.close();db.close()})
  f.registry.markConnected(f.principal)
  hub.bind(f.access.getThreadBinding(t.binding.threadId)!,'own-session')
  hub.update('own-session',{runtimeEpoch:'same-epoch',state:'idle'})
  const session=hub.session('own-session')!
  expect(session.executionScope).toBeUndefined()
  expect(session.ownerId).toBe('provider')
  const command={type:'command' as const,commandId:'queued-collab-command',sessionId:session.sessionId,target:session.target,method:'startTurn' as const,runtimeEpoch:'same-epoch',input:{runId:'collab-run'}}
  journal.saveCommand(command)
  const sent:CustomerAgentServerFrame[]=[]
  const hello={type:'hello' as const,protocolVersion:1 as const,deviceId:f.target.deviceId,connectorVersion:'test-original-host',connectorEpoch:'connector',workspaces:[],sessions:[{sessionId:session.sessionId,runtimeEpoch:'same-epoch',state:'idle' as const,live:true}]}
  await hub.connect(f.principal,async frame=>{sent.push(frame)},()=>{}).accept(hello)
  expect(sent.filter(frame=>frame.type==='command')).toEqual([command])
  f.access.updateThreadVisibility(t.owner,t.binding.threadId,{expectedVisibility:'project',visibility:'private'})
  sent.length=0
  await hub.connect(f.principal,async frame=>{sent.push(frame)},()=>{}).accept(hello)
  expect(sent.some(frame=>frame.type==='command')).toBe(false)
  expect(sent).toContainEqual({type:'receiptQuery',commandId:command.commandId,sessionId:session.sessionId})
  expect(()=>f.access.requireCustomerRunActor(t.binding.threadId,'collab-run')).toThrow()
  expect(journal.command(command.commandId)?.command).toEqual(command)
})

it('共享原命令断线恢复保留actual actor及grant，旧客户端不重发，错误grant不能写原收据',async()=>{
  const f=fixture(),t=transportFixture(f),old=t.connect()
  await old.accept(t.hello(false))
  expect(t.sent.some(frame=>frame.type==='command')).toBe(false)
  expect(t.sent).toContainEqual(expect.objectContaining({type:'error',code:'SHARED_PROTOCOL_REQUIRED'}))
  t.sent.length=0
  const current=t.connect()
  await current.accept(t.hello(true))
  expect(t.sent.filter(frame=>frame.type==='command')).toEqual([t.command])
  expect(t.scope.actorId).toBe('recipient');expect(t.scope.providerId).toBe('provider')
  await expect(current.accept({type:'receipt',commandId:t.command.commandId,sessionId:t.session.sessionId,state:'failed',grantId:'different-grant',error:{code:'fixture-only',message:'不可覆盖原收据'}})).rejects.toMatchObject({code:'RECEIPT_SCOPE_CHANGED'})
  expect(t.journal.command(t.command.commandId)?.receipt).toBeUndefined()
  await current.accept({type:'receipt',commandId:t.command.commandId,sessionId:t.session.sessionId,state:'failed',grantId:t.scope.grantId,error:{code:'fixture-only',message:'协议核对，不执行真实任务'}})
  expect(t.journal.command(t.command.commandId)?.receipt).toMatchObject({state:'failed',grantId:t.scope.grantId})
})

it('共享撤回后的重连只核对原收据，不把待处理原命令重新投递执行',async()=>{
  const f=fixture(),t=transportFixture(f)
  f.directory.shareProvided('provider',f.preset.id,'target',{requestId:'withdraw-reconnect',expectedRevision:1,enabled:false})
  await t.connect().accept(t.hello(true))
  expect(t.sent.some(frame=>frame.type==='command')).toBe(false)
  expect(t.sent).toContainEqual({type:'receiptQuery',commandId:t.command.commandId,sessionId:t.session.sessionId,grantId:t.scope.grantId})
  expect(t.journal.command(t.command.commandId)?.command).toEqual(t.command)
})
