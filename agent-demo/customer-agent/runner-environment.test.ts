import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { CustomerAgentStore } from './store.ts'
import { createCustomerRunnerFactory } from './runner-environment.ts'
import { CustomerAgentExecutor } from './executor.ts'
import { createHeadlessCodexRunner } from '../../vendor/t3code/apps/server/src/provider/HeadlessCodexRunner.ts'
import { writeFakeCli } from '../../vendor/t3code/packages/provider-testing/src/fakeCli.ts'
import type { HeadlessCodexRunnerOptions } from '../../vendor/t3code/apps/server/src/provider/HeadlessCodexRunner.ts'

const gatewayName='AUTOOPS_FIXTURE_SHARED_GATEWAY_KEY'
const personalName='AUTOOPS_FIXTURE_PERSONAL_MODEL_KEY'
function fixture(t: import('node:test').TestContext) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'autoops-runner-env-'))),directory=join(root,'source')
  mkdirSync(directory)
  const store=new CustomerAgentStore(join(root,'state')),workspace=store.register(directory,'project','运行器环境夹具')
  const profilePath=join(root,'profile.json')
  const profile={version:1,id:'fixture',revision:1,imageDigest:`sha256:${'a'.repeat(64)}`,skills:[],gateway:{url:'https://fixture.invalid/v1',authorizationEnv:gatewayName}}
  writeFileSync(profilePath,JSON.stringify(profile),{mode:0o600});store.setSharedProfile(workspace.registeredWorkspaceId,profilePath)
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
  return {root,directory,store,workspace,profilePath,profile}
}

test('正式原生目录进程及重连等价的第二次启动不继承共享网关密钥，保留自用凭据与模型',async t=>{
  const f=fixture(t),log=join(f.root,'environment.jsonl')
  const previousGateway=process.env[gatewayName],previousPersonal=process.env[personalName],previousPath=process.env.PATH
  assert.equal(previousGateway,undefined);assert.equal(previousPersonal,undefined)
  process.env[gatewayName]='fixture-only-shared-secret';process.env[personalName]='fixture-only-personal-secret';process.env.PATH=`${dirname(process.execPath)}:${previousPath??''}`
  t.after(()=>{delete process.env[gatewayName];delete process.env[personalName];if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath})
  const transcript=readFileSync(new URL('../../vendor/t3code/apps/server/src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson',import.meta.url),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  const responses=Object.fromEntries(transcript.filter(entry=>entry.type==='emit_inbound'&&entry.frame?.id!==undefined&&entry.frame.result).map(entry=>[entry.label,entry.frame.result]))
  const binaryPath=writeFakeCli({directory:f.root,name:'codex',source:`
    import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
    appendFileSync(${JSON.stringify(log)},JSON.stringify({gatewayPresent:process.env[${JSON.stringify(gatewayName)}]!==undefined,personalKept:process.env[${JSON.stringify(personalName)}]==='fixture-only-personal-secret'})+'\\n');
    const responses=${JSON.stringify(responses)};const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;let result;
      if(message.method==='model/list')result={data:[{id:'fixture-personal-model',model:'fixture-personal-model',displayName:'个人实际模型夹具',description:'Fixture',hidden:false,isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium'}]}],nextCursor:null};
      else if(message.method==='skills/list')result={data:[{cwd:${JSON.stringify(f.directory)},errors:[],skills:[]}]};else result=responses[message.method];
      send(result===undefined?{id:message.id,error:{code:-32601,message:'fixture unsupported'}}:{id:message.id,result});});
  `})
  const factory=createCustomerRunnerFactory(f.store,options=>createHeadlessCodexRunner({...options,binaryPath}))
  for(const explicit of [false,true])for(let reconnect=0;reconnect<2;reconnect++){
    const runner=await factory({instanceId:'customer-fixture-codex',cwd:f.directory,localPolicy:{approvalPolicy:'on-request',sandboxMode:'read-only',networkAccess:false},...(explicit?{environment:{PATH:process.env.PATH,HOME:f.root}}:{}),onEvent:()=>{}})
    try{const catalog=await runner.catalog();assert.deepEqual(catalog.models.map(model=>model.slug),['fixture-personal-model'])}finally{await runner.close()}
  }
  const started=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert(started.length>=2,'必须实际创建两次原生目录进程')
  assert(started.every(item=>item.gatewayPresent===false),'实际self目录子进程收到共享网关密钥')
  assert(started.every(item=>item.personalKept===true),'不能删除自用模型凭据')
  assert.equal(process.env[gatewayName],'fixture-only-shared-secret','host正式gateway仍需按原键读取')
})

const selfOptions=(cwd:string):HeadlessCodexRunnerOptions=>({instanceId:'customer-fixture-codex',cwd,onEvent:()=>{}})
const fakeRunner=()=>({processGeneration:'fixture-only',catalog:async()=>({models:[],skills:[]}),close:async()=>{},dispatch:async()=>null})

test('只过滤已登记profile授权键；每次新self读取最新profile，不修改host环境',async t=>{
  const f=fixture(t),secondName='AUTOOPS_FIXTURE_SECOND_GATEWAY_KEY'
  assert.equal(process.env[gatewayName],undefined);assert.equal(process.env[secondName],undefined)
  process.env[gatewayName]='fixture-first';process.env[secondName]='fixture-second'
  t.after(()=>{delete process.env[gatewayName];delete process.env[secondName]})
  const environments:NodeJS.ProcessEnv[]=[]
  const factory=createCustomerRunnerFactory(f.store,async options=>{environments.push(options.environment!);return fakeRunner()})
  await factory(selfOptions(f.directory))
  assert.equal(environments[0]![gatewayName],undefined);assert.equal(environments[0]![secondName],'fixture-second')
  assert(Object.hasOwn(environments[0]!,gatewayName),'必须抵消底层宿主环境再次合并')
  writeFileSync(f.profilePath,JSON.stringify({...f.profile,revision:2,gateway:{...f.profile.gateway,authorizationEnv:secondName}}))
  await factory(selfOptions(f.directory))
  assert.equal(environments[1]![gatewayName],undefined);assert.equal(environments[1]![secondName],undefined)
  f.store.setSharedProfile(f.workspace.registeredWorkspaceId)
  await factory(selfOptions(f.directory))
  assert.equal(environments[2]![gatewayName],undefined);assert.equal(environments[2]![secondName],undefined)
  assert.equal(process.env[gatewayName],'fixture-first');assert.equal(process.env[secondName],'fixture-second')
  assert.notEqual(environments[0],process.env)
})

test('shared及self已有显式environment保持原值与优先级，不用host替代',async t=>{
  const f=fixture(t)
  const environment={PATH:'/fixture/shared/path',HOME:'/home/autoops',LANG:'C.UTF-8'}
  const options={...selfOptions(f.directory),environment,externalSandbox:true}
  let observed:HeadlessCodexRunnerOptions|undefined
  await createCustomerRunnerFactory(f.store,async input=>{observed=input;return fakeRunner()})(options)
  assert.equal(observed!.externalSandbox,options.externalSandbox)
  assert.deepEqual(observed!.environment,{...environment,[gatewayName]:undefined})
  assert.deepEqual(environment,{PATH:'/fixture/shared/path',HOME:'/home/autoops',LANG:'C.UTF-8'},'不得修改原隔离环境')
  assert.equal(Object.hasOwn(environment,gatewayName),false)
})

test('未配置shared profile的自用目录保留原环境与凭据',async t=>{
  const f=fixture(t);f.store.setSharedProfile(f.workspace.registeredWorkspaceId)
  assert.equal(process.env[personalName],undefined);process.env[personalName]='fixture-personal-only'
  t.after(()=>{delete process.env[personalName]})
  let observed:NodeJS.ProcessEnv|undefined
  await createCustomerRunnerFactory(f.store,async options=>{observed=options.environment;return fakeRunner()})(selfOptions(f.directory))
  assert.equal(observed![personalName],'fixture-personal-only')
  assert.equal(observed!.PATH,process.env.PATH)
})

test('共享profile缺失或损坏时公开能力发现仍返回原自用模型，不发布共享能力',async t=>{
  const f=fixture(t);let started=0,closed=0
  const factory=createCustomerRunnerFactory(f.store,async()=>{started++;return {...fakeRunner(),catalog:async()=>({models:[{slug:'personal-fixture',name:'个人实际模型',isCustom:false,capabilities:null}],skills:[]}),close:async()=>{closed++}}})
  const executor=new CustomerAgentExecutor({store:f.store,deviceId:'fixture-device',runnerFactory:factory,notify:()=>{}})
  for(const content of [undefined,'{invalid json',JSON.stringify({...f.profile,skills:[join(f.root,'missing-skill')]})]){
    if(content===undefined)rmSync(f.profilePath);else writeFileSync(f.profilePath,content,{mode:0o600})
    const catalog=await executor.capabilities(f.store.workspaces()[0]!)
    assert.deepEqual(catalog.models.map(model=>model.id),['personal-fixture'])
    assert.equal(catalog.sharedProfile,undefined)
  }
  assert.equal(started,3,'共享失败不能阻断或替代自用能力发现')
  assert.equal(closed,3,'每次目录发现都关闭原生连接')
})

test('首次启动的共享依赖无效仍过滤配置合法键；后续文件损坏与撤回保留已见键',async t=>{
  const f=fixture(t)
  process.env[gatewayName]='fixture-invalid-shared-key';process.env[personalName]='fixture-personal-key'
  t.after(()=>{delete process.env[gatewayName];delete process.env[personalName]})
  writeFileSync(f.profilePath,JSON.stringify({...f.profile,skills:[join(f.root,'missing-skill')]}))
  const environments:NodeJS.ProcessEnv[]=[]
  const factory=createCustomerRunnerFactory(f.store,async options=>{environments.push(options.environment!);return fakeRunner()})
  await factory(selfOptions(f.directory))
  writeFileSync(f.profilePath,'{invalid json');await factory(selfOptions(f.directory))
  f.store.revoke(f.workspace.registeredWorkspaceId);rmSync(f.profilePath);await factory(selfOptions(f.directory))
  for(const environment of environments){
    assert(Object.hasOwn(environment,gatewayName))
    assert.equal(environment[gatewayName],undefined)
    assert.equal(environment[personalName],'fixture-personal-key')
  }
  assert.equal(process.env[gatewayName],'fixture-invalid-shared-key')
})

test('无效过滤提示不读取符号链接、可改写或超额配置，也不删除其他自用键',async t=>{
  const f=fixture(t),realProfile=join(f.root,'real-profile.json')
  process.env[gatewayName]='fixture-unreadable-key';process.env[personalName]='fixture-personal-key'
  t.after(()=>{delete process.env[gatewayName];delete process.env[personalName]})
  rmSync(f.profilePath);writeFileSync(realProfile,JSON.stringify(f.profile),{mode:0o600});symlinkSync(realProfile,f.profilePath)
  const values=[()=>{},()=>{rmSync(f.profilePath);writeFileSync(f.profilePath,JSON.stringify(f.profile),{mode:0o666});chmodSync(f.profilePath,0o666)},()=>{chmodSync(f.profilePath,0o600);writeFileSync(f.profilePath,JSON.stringify(f.profile)+' '.repeat(64*1024))},()=>writeFileSync(f.profilePath,JSON.stringify({gateway:{authorizationEnv:'invalid-name'}}))]
  for(const prepare of values){
    prepare();let observed:NodeJS.ProcessEnv|undefined
    await createCustomerRunnerFactory(f.store,async options=>{observed=options.environment;return fakeRunner()})(selfOptions(f.directory))
    assert.equal(observed![gatewayName],'fixture-unreadable-key','不能猜测从未读到的授权键')
    assert.equal(observed![personalName],'fixture-personal-key')
  }
})

test('登记profile被替换为FIFO时不挂住公开自用能力发现与共享失败收束',t=>{
  if(process.platform==='win32'){t.skip('FIFO边界在Unix运行环境验证');return}
  const f=fixture(t);rmSync(f.profilePath);execFileSync('mkfifo',[f.profilePath],{env:{PATH:'/usr/bin:/bin'}})
  const code=`import {createCustomerRunnerFactory} from ${JSON.stringify(new URL('./runner-environment.ts',import.meta.url).href)};
    import {CustomerAgentStore} from ${JSON.stringify(new URL('./store.ts',import.meta.url).href)};
    import {CustomerAgentExecutor} from ${JSON.stringify(new URL('./executor.ts',import.meta.url).href)};
    const store=new CustomerAgentStore(${JSON.stringify(join(f.root,'state'))});let started=0,closed=0,personalKept=false;
    const runnerFactory=createCustomerRunnerFactory(store,async options=>{started++;personalKept=options.environment[${JSON.stringify(personalName)}]==='fixture-personal-only';return {catalog:async()=>({models:[{slug:'personal',name:'个人模型',isCustom:false,capabilities:null}],skills:[]}),close:async()=>{closed++}}});
    const executor=new CustomerAgentExecutor({store,deviceId:'fixture',runnerFactory,notify:()=>{}});
    const result=await executor.capabilities(store.workspaces()[0]);store.close();
    console.log(JSON.stringify({started,closed,personalKept,models:result.models.map(model=>model.id),hasShared:Boolean(result.sharedProfile)}));`
  const child=spawnSync(process.execPath,['--input-type=module','--eval',code],{cwd:f.root,env:{PATH:dirname(process.execPath),HOME:f.root,LANG:'C.UTF-8',[personalName]:'fixture-personal-only'},timeout:2000,killSignal:'SIGKILL',encoding:'utf8'})
  assert.equal(child.error,undefined,'FIFO阻断了自用runner；只终止本次隔离probe')
  assert.equal(child.status,0)
  assert.deepEqual(JSON.parse(child.stdout),{started:1,closed:1,personalKept:true,models:['personal'],hasShared:false})
})

test('撤回且旧profile缺失仍过滤本进程已见键，不阻塞另一个自用目录',async t=>{
  const f=fixture(t),other=join(f.root,'other');mkdirSync(other);f.store.register(other,'other-project','其他自用目录')
  assert.equal(process.env[gatewayName],undefined);process.env[gatewayName]='fixture-revoked-key';t.after(()=>{delete process.env[gatewayName]})
  const environments:NodeJS.ProcessEnv[]=[]
  const factory=createCustomerRunnerFactory(f.store,async options=>{environments.push(options.environment!);return fakeRunner()})
  await factory(selfOptions(other));f.store.revoke(f.workspace.registeredWorkspaceId);rmSync(f.profilePath)
  await factory(selfOptions(other))
  assert.equal(environments[1]![gatewayName],undefined)
  assert.equal(environments[1]!.PATH,process.env.PATH)
  // 新进程无法从已删除文件恢复未知键名，但已撤回登记不能使正常自用目录永久不可启动。
  await createCustomerRunnerFactory(f.store,async()=>fakeRunner())(selfOptions(other))
})

test('首次self启动也收集仍可读取的已撤回profile键',async t=>{
  const f=fixture(t);f.store.revoke(f.workspace.registeredWorkspaceId)
  assert.equal(process.env[gatewayName],undefined);process.env[gatewayName]='fixture-revoked-first';t.after(()=>{delete process.env[gatewayName]})
  let observed:NodeJS.ProcessEnv|undefined
  await createCustomerRunnerFactory(f.store,async options=>{observed=options.environment;return fakeRunner()})(selfOptions(f.directory))
  assert.equal(observed![gatewayName],undefined)
})
