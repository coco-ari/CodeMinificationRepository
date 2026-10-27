// 仅在独占临时目录装配真实owner，所有身份/凭据均为离线测试值。
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createAutoOpsAccess, initializeAutoOpsAccessSchema } from '../agent-demo/t3-adapters/access.mjs'
import { createAssistantDirectory, questionConfigurationPolicy } from '../agent-demo/t3-adapters/assistants/index.ts'
import { readBusinessModels } from '../agent-demo/t3-adapters/models.mjs'
import { resolveSkillLibrary } from '../agent-demo/t3-adapters/skill-library.mjs'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'
import { createWorkspaceAuthoring } from '../agent-demo/t3-adapters/workspace-authoring/index.ts'
import { createWorkspaceManagement } from '../agent-demo/t3-adapters/workspace-management.ts'
import { createProjectCredentialService } from '../agent-demo/t3-adapters/credentials.ts'
import { createBusinessRunInputs } from '../agent-demo/t3-adapters/thread-inputs.ts'
import { createBusinessResourceCatalog } from '../agent-demo/t3-adapters/resources.mjs'
import { createEnvironmentMcp } from '../agent-demo/t3-adapters/environment-mcp/index.ts'
import { sharedProfileVerifier } from '../agent-demo/t3-adapters/shared-profile-approvals.ts'
import { decodeContract } from '../autoops/contracts/index.ts'
import { SaveAssistantCommand, QuestionConfiguration } from '../autoops/contracts/assistants.ts'
import { OrchestrationV2Command, OrchestrationV2ThreadLaunchInput } from '../vendor/t3code/packages/contracts/src/orchestrationV2.ts'
// 正式T3合同必须用其已锁定Effect实例解码，不能借root未打patch的另一个实例。
const nativeSchema = await import(createRequire(new URL('../vendor/t3code/packages/contracts/package.json', import.meta.url)).resolve('effect/Schema'))
const nativeDecode = (schema,value) => nativeSchema.decodeUnknownSync(schema,{onExcessProperty:'error'})(value)
export { decodeContract, QuestionConfiguration, SaveAssistantCommand }
export const digest = value => createHash('sha256').update(value).digest('hex')
export const selection = preset => ({ assistantId:preset.id, presetRevision:preset.revision, configuration:preset.configuration })
export function dispatch(threadId, modelSelection, patch={}) {
 return nativeDecode(OrchestrationV2Command,{type:'message.dispatch',createdBy:'user',creationSource:'web',commandId:randomUUID(),threadId,messageId:randomUUID(),text:'离线受控资料读取回归',attachments:[],dispatchMode:{type:'start_immediately'},modelSelection,...patch})
}
export function launch(threadId, modelSelection, patch={}) {
 return nativeDecode(OrchestrationV2ThreadLaunchInput,{commandId:randomUUID(),threadId,projectId:'project',title:'离线C7回归',modelSelection,runtimeMode:'approval-required',interactionMode:'default',workspaceStrategy:{type:'root'},initialMessage:{messageId:randomUUID(),text:'离线问答',attachments:[]},...patch})
}
export async function fixture(t,{shared=false}={}) {
 const previous=process.env.AUTOOPS_CUSTOMER_AGENTS;process.env.AUTOOPS_CUSTOMER_AGENTS='1'
 const directory=mkdtempSync(join(tmpdir(),'autoops-c7-owner-red-'))
 const bindingDb=new DatabaseSync(join(directory,'access.sqlite')),sessionDb=new DatabaseSync(join(directory,'sessions.sqlite'))
 initializeAutoOpsAccessSchema(bindingDb);sessionDb.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)')
 const providerMember={userId:'provider',role:'developer',status:'active',environmentIds:['test'],workspaceAccess:'internal',canAdjustChat:true}
 const readerMember={...providerMember,userId:'reader',role:'reader',canAdjustChat:false}
 const managerMember={...providerMember,userId:'manager',role:'project_admin',environmentIds:['test','production']}
 const catalog={users:['provider','reader','manager','outsider'].map(id=>({id,name:id,role:'member',kind:'internal'})),projects:[{id:'project',name:'离线专属项目',memberIds:['provider','reader','manager'],memberships:[providerMember,readerMember,managerMember],environments:[{id:'test',name:'测试'},{id:'production',name:'生产'}],documents:[],resources:[]}],agents:[{id:'a-project',name:'开发助手',projectIds:['project']}]}
 if(shared){catalog.projects.push({...structuredClone(catalog.projects[0]),id:'target-project',name:'接收项目'});catalog.agents[0].projectIds.push('target-project')}
 for(const user of catalog.users)sessionDb.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(user.id),user.id,'offline-csrf',Date.now()+600000)
 // 首先经旧公开owner登记已有普通自用对话，再由当前owner读取同一SQLite；不插造绑定行。
 const legacy=createAutoOpsAccess({sessionDb,bindingDb,catalog}),registry=legacy.customerRegistry
 const paired=registry.consumePairing(registry.createPairing('provider').pairingCode,{label:'离线本人电脑'})
 const machine=registry.authenticateToken(paired.deviceToken)
 const target={kind:'customer',deviceId:paired.device.id,registeredWorkspaceId:'owned-directory',workspaceBindingRevision:1,runtimeId:'codex'}
 registry.registerWorkspace(machine,{registeredWorkspaceId:target.registeredWorkspaceId,projectId:'project',label:'已登记目录',workspaceBindingRevision:1,runtimeId:'codex'})
 registry.markConnected(machine)
 registry.updateCapabilities(machine,{registeredWorkspaceId:target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex',revision:'offline-real-catalog',protocolVersion:1,assistantConfiguration:true,workspaceFiles:true,models:[{id:'customer-real-model',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'low'}],skills:[]})
 const profile={id:'offline-readonly-profile',revision:1,digest:'a'.repeat(64),imageDigest:'sha256:'+'b'.repeat(64),policy:'linux-docker-readonly-v1'},approvalFile=join(directory,'shared-profile-approvals.json')
 if(shared){const {deviceId,updatedAt,...capabilities}=registry.getCapabilities('provider',target);registry.updateCapabilities(machine,{...capabilities,platformToolsVersion:1,sharedProfile:{...profile,models:capabilities.models,skills:[]}});writeFileSync(approvalFile,JSON.stringify([{providerId:'provider',sourceProjectId:'project',target,profile,validationId:'offline-owner-policy-fixture-not-os-proof',verifiedAt:'2026-10-27T00:00:00Z'}]),{mode:0o600})}
 const verifySharedProfile=sharedProfileVerifier(()=>shared?approvalFile:undefined)
 const principal=legacy.authenticateCookie('demo_session=provider'),oldThread=randomUUID()
 legacy.reserveThread(principal,{threadId:oldThread,projectId:'project',environmentId:null,agentId:'a-project',visibility:'private',executionBinding:target});legacy.markThreadAccepted(oldThread)
 let assistants
 const access=createAutoOpsAccess({sessionDb,bindingDb,catalog,customerRegistry:registry,questions:()=>assistants})
 mkdirSync(join(directory,'t3'))
 writeFileSync(join(directory,'t3/models-catalog.json'),JSON.stringify({version:1,source:'https://offline.example.invalid/catalog',models:[{id:'platform-real-model',name:'离线目录模型',reasoningLevels:['low'],defaultReasoning:'low',inputModalities:['text'],contextWindow:null,supportsReasoningEffortUpdates:true}]}))
 const policy=questionConfigurationPolicy({projects:()=>catalog.projects,agents:()=>catalog.agents,models:()=>readBusinessModels(directory,'platform-real-model'),skills:(projectId,agentId,workspaceType)=>resolveSkillLibrary(directory,{projectId,agentId,workspaceType}),customers:()=>registry,verifySharedProfile})
 const options={dataDir:directory,membership:(actor,project)=>access.requireProjectActionForActor(actor,project,'chat.use'),manage:(actor,project)=>access.requireProjectActionForActor(actor,project,'project.manage'),validate:policy,verifySharedProfile,providers:{registry:()=>registry,displayName:actor=>catalog.users.find(u=>u.id===actor)?.name??''},validateTarget(project,value){assert(catalog.projects.some(p=>p.id===project));if(value.kind==='member')assert(catalog.users.some(u=>u.id===value.id))}}
 assistants=createAssistantDirectory(options)
 const store=createWorkspaceStore({dataDir:directory,authorizeTask:({actorId,projectId})=>access.requireWorkspaceReader(actorId,projectId)})
 await store.ensureProject(access.requireProject(access.authenticateCookie('demo_session=manager'),'project'))
 if(shared)await store.ensureProject(access.requireProject(access.authenticateCookie('demo_session=manager'),'target-project'))
 const authoring=createWorkspaceAuthoring({dataDir:directory,authorize:(actor,project,action)=>action==='read'?access.requireWorkspaceReader(actor,project):action==='external-read'?access.requireWorkspaceInputReader(actor,project,'external'):access.requireWorkspaceActor(actor,project)})
 const credentials=createProjectCredentialService({databasePath:join(directory,'credentials.sqlite'),keyPath:join(directory,'credential.key'),initializeKeyIfNew:true,authorize:(actor,project,action)=>access.requireCredentialActor(actor,project,action)})
 const git={validateRepositorySource:value=>value,async resolveRepositoryRef(){assert.fail('本切片不得访问远端Git')},async fetchRepositoryAt(){assert.fail('本切片不得访问远端Git')}}
 const workspace=createWorkspaceManagement({access,store,authoring,credentials,git}),inputs=createBusinessRunInputs(access,workspace),resources=createBusinessResourceCatalog({access,workspaceInputs:workspace,workspaceStore:store})
 // 本切片只验证环境snapshot与授权边界；没有启用连接，不注入模拟驱动或访问真实协议。
 const mcp=createEnvironmentMcp({dataDir:directory,credentials,drivers:{},authorizeManage:(actor,project,environment)=>{const m=access.requireProjectActionForActor(actor,project,'project.manage');assert(m.environmentIds.includes(environment))},authorizeQuery:(actor,project,environment)=>environment===null?access.requireProjectActionForActor(actor,project,'chat.use'):access.requireEnvironmentQueryForActor(actor,project,environment)})
 const bytes=Buffer.from('C7_REAL_SQLITE_CURRENT_INPUT\n固定离线原件')
 authoring.upload('project',{requestId:randomUUID(),expectedRevision:authoring.overview('project','manager').revision,path:'docs/proof.txt',conflict:'replace',size:bytes.length,sha256:digest(bytes)},bytes,'manager')
 if(shared){const targetBytes=Buffer.from('C7_RECIPIENT_PROJECT_CURRENT_INPUT');authoring.upload('target-project',{requestId:randomUUID(),expectedRevision:authoring.overview('target-project','manager').revision,path:'docs/proof.txt',conflict:'replace',size:targetBytes.length,sha256:digest(targetBytes)},targetBytes,'manager')}
 t.after(async()=>{await mcp.close();await workspace.close();await store.close();assistants.close();bindingDb.close();sessionDb.close();rmSync(directory,{recursive:true,force:true});if(previous===undefined)delete process.env.AUTOOPS_CUSTOMER_AGENTS;else process.env.AUTOOPS_CUSTOMER_AGENTS=previous})
 const customerConfiguration=patch=>decodeContract(QuestionConfiguration,{agentId:'a-project',executionBinding:target,environmentId:null,workspaceType:null,visibility:'private',model:{instanceId:`customer-${target.deviceId}-codex`,model:'customer-real-model',reasoningEffort:'high'},skillIds:[],...patch})
 const details=configuration=>({name:'离线回归助手',description:'',instructions:'只读原件',enabled:true,configuration})
 const command=configuration=>decodeContract(SaveAssistantCommand,{requestId:randomUUID(),expectedRevision:0,value:details(configuration)})
 const modelSelection={instanceId:`customer-${target.deviceId}-codex`,model:'customer-real-model',options:[{id:'reasoningEffort',value:'high'}]}
 async function platformRun(actor='provider') {
  const configuration=decodeContract(QuestionConfiguration,{agentId:'a-project',executionBinding:{kind:'platform'},environmentId:'test',workspaceType:'internal',visibility:'private',model:{instanceId:'codex',model:'platform-real-model',reasoningEffort:'low'},skillIds:[]})
  const preset=assistants.save('manager','project',null,command(configuration))
  assistants.assign('manager','project',{requestId:randomUUID(),expectedRevision:0,target:{kind:'member',id:actor},assistantIds:[preset.id],defaultAssistantId:preset.id})
  const threadId=randomUUID(),p=access.authenticateCookie('demo_session='+actor)
  access.reserveThread(p,{threadId,projectId:'project',environmentId:'test',agentId:'a-project',visibility:'private',workspaceType:'internal',executionBinding:{kind:'platform'},question:selection(preset)});access.markThreadAccepted(threadId)
  const message=dispatch(threadId,{instanceId:'codex',model:'platform-real-model',options:[{id:'reasoningEffort',value:'low'}]})
  access.recordMessageActor(p,threadId,message.commandId,message.messageId)
  const runId='run:thread:'+threadId+':ordinal:1',input=await inputs.prepare(threadId,runId,undefined,undefined,message.messageId,undefined,message.modelSelection)
  return {threadId,runId,input,preset,message,actor}
 }
 return {directory,bindingDb,sessionDb,catalog,providerMember,readerMember,access,principal:access.authenticateCookie('demo_session=provider'),registry,target,machine,profile,deviceToken:paired.deviceToken,policy,oldThread,modelSelection,customerConfiguration,command,details,platformRun,inputs,resources,mcp,workspace,get assistants(){return assistants},reopenAssistants(){assistants.close();assistants=createAssistantDirectory(options)}}
}
