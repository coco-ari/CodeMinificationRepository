import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { loadSharedDockerProfile, retireSharedContainer, sharedCodexConfiguration, sharedContainerArguments } from './shared-docker-profile.ts'
import { createSharedDockerRuntime } from './shared-docker-profile.ts'
import * as Effect from 'effect/Effect'
import type { SharedExecutionScope } from '../../autoops/contracts/shared-execution.ts'

async function fixture(t:import('node:test').TestContext) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'autoops-shared-profile-test-'))),skills=join(root,'skills'),file=join(root,'profile.json')
  await mkdir(skills);await writeFile(join(skills,'SKILL.md'),'---\nname: isolated-analysis\ndescription: 只读隔离验收技能\n---\n读取已授权资料。')
  const value={version:1,id:'linux-readonly',revision:1,imageDigest:`sha256:${'a'.repeat(64)}`,skills:[skills],gateway:{url:'https://models.invalid/v1',authorizationEnv:'FIXTURE_MODEL_TOKEN'}}
  await writeFile(file,JSON.stringify(value),{mode:0o600})
  t.after(()=>rm(root,{recursive:true,force:true}))
  return {root,skills,file,value}
}
test('提供者明确的本机技能内容决定隔离profile修订摘要，不读取环境秘密',async t=>{
  const f=await fixture(t),first=await loadSharedDockerProfile(f.file)
  assert.equal(first.skillFiles.length,1)
  assert.equal(first.skillFiles[0]?.bytes.includes('只读隔离验收技能'),true)
  assert.equal(JSON.stringify(first.descriptor).includes('FIXTURE_MODEL_TOKEN'),false)
  await writeFile(join(f.skills,'SKILL.md'),'已更新的明确技能范围')
  assert.notEqual((await loadSharedDockerProfile(f.file)).descriptor.digest,first.descriptor.digest)
})
test('profile宽权限、未知字段与技能符号链接均拒绝，不能借目录别名读取宿主私有文件',async t=>{
  const f=await fixture(t)
  await chmod(f.file,0o666)
  await assert.rejects(loadSharedDockerProfile(f.file),{code:'shared_profile_invalid'})
  await chmod(f.file,0o600)
  await writeFile(f.file,JSON.stringify({...f.value,privileged:true}))
  await assert.rejects(loadSharedDockerProfile(f.file),{code:'shared_profile_invalid'})
  await writeFile(f.file,JSON.stringify(f.value))
  const privateFile=join(f.root,'provider-private.txt');await writeFile(privateFile,'PRIVATE_FIXTURE_ONLY')
  await symlink(privateFile,join(f.skills,'escape.txt'))
  await assert.rejects(loadSharedDockerProfile(f.file),{code:'shared_profile_invalid'})
})
test('共享profile公开读取有界拒绝FIFO，不等待本机写入者',async t=>{
  if(process.platform==='win32'){t.skip('FIFO边界在Unix运行环境验证');return}
  const f=await fixture(t);await rm(f.file);execFileSync('mkfifo',[f.file],{env:{PATH:'/usr/bin:/bin'}})
  const code=`import assert from 'node:assert/strict';import {loadSharedDockerProfile} from ${JSON.stringify(new URL('./shared-docker-profile.ts',import.meta.url).href)};
    await assert.rejects(loadSharedDockerProfile(${JSON.stringify(f.file)}),{code:'shared_profile_invalid'});console.log('bounded-rejection');`
  const child=spawnSync(process.execPath,['--input-type=module','--eval',code],{cwd:f.root,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'C.UTF-8'},timeout:2000,killSignal:'SIGKILL',encoding:'utf8'})
  assert.equal(child.error,undefined,'FIFO公开读取超时；只终止本次隔离probe')
  assert.equal(child.status,0)
  assert.equal(child.stdout.trim(),'bounded-rejection')
})
test('隔离进程端口只允许固定本机镜像与独立挂载，禁止root及带逗号挂载注入',async t=>{
  const f=await fixture(t),profile=await loadSharedDockerProfile(f.file)
  const input={profile,workspace:{registeredWorkspaceId:'source',workspaceBindingRevision:1,runtimeId:'codex' as const,projectId:'source-project',label:'来源',realPath:join(f.root,'source'),identity:'fixture-only',revoked:false,policy:{approvalPolicy:'on-request' as const,sandboxMode:'read-only' as const,networkAccess:false}},name:'test-owned-container',cidFile:join(f.root,'id'),home:join(f.root,'home'),configuration:join(f.root,'config.toml'),attachments:join(f.root,'attachments'),gateway:join(f.root,'gateway'),entry:join(f.root,'entry.mjs'),uid:1000,gid:1000,command:'codex',args:['app-server']}
  const args=sharedContainerArguments(input)
  assert.equal(args.includes('--privileged'),false)
  assert.equal(args.includes('host'),false)
  assert.equal(args[args.indexOf('--network')+1],'none')
  assert.equal(args[args.indexOf('--user')+1],'1000:1000')
  assert.equal(args.includes(profile.descriptor.imageDigest),true)
  const frozenSkills=sharedContainerArguments({...input,skillsReadonly:true})
  assert.equal(frozenSkills.includes(`type=bind,src=${join(input.home,'.codex','skills')},dst=/home/autoops/.codex/skills,readonly,bind-recursive=disabled`),true,'目录确认后实际推理进程必须只读挂载提供者显式技能')
  assert.throws(()=>sharedContainerArguments({...input,uid:0}),{code:'shared_user_required'})
  assert.throws(()=>sharedContainerArguments({...input,attachments:'/tmp/fixture,src=/secret'}),{code:'shared_mount_invalid'})
})
test('共享profile在模型provider子表之外固定禁用web与动态强度，并拒绝来源项目配置',()=>{
  const source='/srv/source/with "quoted" name'
  const config=sharedCodexConfiguration(source,['/srv/source/.agents/skills/unapproved/SKILL.md'])
  const topLevel=config.split('[model_providers.autoops_shared]')[0]!
  assert.match(topLevel,/^web_search = "disabled"$/m)
  assert.match(topLevel,/\[features\]\nreasoning_effort_override = false/)
  assert.match(topLevel,/^image_generation = false$/m)
  assert.ok(config.includes(`[projects.${JSON.stringify(source)}]\ntrust_level = "untrusted"`))
  assert.match(config,/\[\[skills.config\]\]\npath = "\/srv\/source\/\.agents\/skills\/unapproved\/SKILL.md"\nenabled = false/)
})
test('断线后原容器身份损坏或inspect事实不完整时保留收据，不能重新启动',async t=>{
  const f=await fixture(t),cidFile=join(f.root,'container.id'),cid='a'.repeat(64)
  for(const value of ['damaged-original-id',cid]) {
    await writeFile(cidFile,value)
    const actions:ReadonlyArray<string>[]=[]
    await assert.rejects(retireSharedContainer(cidFile,async args=>{actions.push(args);return '[{}]'},'fixture-container'),{code:'shared_execution_unknown'})
    assert.equal(await readFile(cidFile,'utf8'),value)
    assert.equal(actions.some(args=>args[0]==='rm'),false)
  }
})
test('只回收Docker证实停止的原容器，运行中及查询异常均不清原状态',async t=>{
  const f=await fixture(t),cidFile=join(f.root,'container.id'),cid='b'.repeat(64)
  await writeFile(cidFile,cid)
  await assert.rejects(retireSharedContainer(cidFile,async()=>JSON.stringify([{Id:cid,Name:'/fixture-container',State:{Running:true}}]),'fixture-container'),{code:'shared_execution_unknown'})
  assert.equal(await readFile(cidFile,'utf8'),cid)
  await assert.rejects(retireSharedContainer(cidFile,async()=>{throw new Error('bounded fixture')},'fixture-container'),{code:'shared_execution_unknown'})
  assert.equal(await readFile(cidFile,'utf8'),cid)
  const actions:ReadonlyArray<string>[]=[]
  await assert.rejects(retireSharedContainer(cidFile,async()=>JSON.stringify([{Id:cid,Name:'/other-container',State:{Running:false}}]),'fixture-container'),{code:'shared_execution_unknown'})
  await retireSharedContainer(cidFile,async args=>{actions.push(args);return JSON.stringify([{Id:cid,Name:'/fixture-container',State:{Running:false}}])},'fixture-container')
  assert.deepEqual(actions,[['inspect',cid],['rm',cid]])
  await assert.rejects(readFile(cidFile),{code:'ENOENT'})
})
test('本机进程端口停止结果不明时重复close仍返回原失败，不允许清理原恢复状态',async t=>{
  const f=await fixture(t),source=join(f.root,'source'),state=join(f.root,'state')
  await mkdir(source);await mkdir(state)
  const original=Object.getOwnPropertyDescriptor(process,'platform')!
  // 只进入同一关闭所有者的隔离端口，不启动 Docker，也不作为真实 Linux OS 验收。
  Object.defineProperty(process,'platform',{value:'linux'})
  const profile=(await loadSharedDockerProfile(f.file)).descriptor,target={kind:'customer' as const,deviceId:'device',registeredWorkspaceId:'source',workspaceBindingRevision:1,runtimeId:'codex' as const}
  const scope:SharedExecutionScope={grantId:'failure-fixture-only',actorId:'caller',providerId:'provider',projectId:'project',sourceProjectId:'source',threadId:'thread',runId:'run',assistantId:'assistant',presetRevision:1,shareRevision:1,allocation:{kind:'member',id:'caller',revision:1},capabilityRevision:'fixture-only',profile,target,model:{instanceId:'customer-device-codex',model:'no-model-call',reasoningEffort:null},skillIds:[]}
  let name='',stops=0
  const cid='c'.repeat(64),run=async(args:ReadonlyArray<string>)=>{
    if(args[0]==='info')return 'linux'
    if(args[0]==='image')return JSON.stringify([{Id:profile.imageDigest}])
    if(args[0]==='inspect')return JSON.stringify([{Id:cid,Name:`/${name}`,State:{Running:true}}])
    if(args[0]==='stop'){stops++;throw new Error('本次端口夹具停止未知')}
    throw new Error('未预期的Docker端口调用')
  }
  try {
    const runtime=await createSharedDockerRuntime({directory:state,workspace:{...target,projectId:'source',label:'本次临时夹具',realPath:source,identity:'fixture',revoked:false,sharedProfilePath:f.file,policy:{approvalPolicy:'on-request',sandboxMode:'read-only',networkAccess:false}},sessionId:'session',scope,discovery:true,authorize:async()=>{},run})
    const command=await Effect.runPromise(runtime.options.agentScope!.wrap({command:'node',args:[],name:'not-launched'}))
    name=command.args[command.args.indexOf('--name')+1]!
    const cidFile=command.args[command.args.indexOf('--cidfile')+1]!
    await writeFile(cidFile,cid)
    await assert.rejects(runtime.close(),{code:'shared_stop_unknown'})
    await assert.rejects(runtime.close(),{code:'shared_stop_unknown'})
    assert.equal(stops,1)
    assert.equal(await readFile(cidFile,'utf8'),cid)
  } finally {Object.defineProperty(process,'platform',original)}
})
test('临时native目录进程结束后收束其已核对容器，两次目录启动不能把attach退出当停止',async t=>{
  const f=await fixture(t),source=join(f.root,'source'),state=join(f.root,'state')
  await mkdir(source);await mkdir(state)
  const original=Object.getOwnPropertyDescriptor(process,'platform')!
  Object.defineProperty(process,'platform',{value:'linux'})
  const profile=(await loadSharedDockerProfile(f.file)).descriptor,target={kind:'customer' as const,deviceId:'device',registeredWorkspaceId:'source',workspaceBindingRevision:1,runtimeId:'codex' as const}
  const scope:SharedExecutionScope={grantId:'catalog-lifecycle-fixture',actorId:'caller',providerId:'provider',projectId:'project',sourceProjectId:'source',threadId:'thread',runId:'run',assistantId:'assistant',presetRevision:1,shareRevision:1,allocation:{kind:'member',id:'caller',revision:1},capabilityRevision:'fixture-only',profile,target,model:{instanceId:'customer-device-codex',model:'no-model-call',reasoningEffort:null},skillIds:[]}
  let name='',running=false,stops=0,removes=0
  const cid='d'.repeat(64),run=async(args:ReadonlyArray<string>)=>{
    if(args[0]==='info')return 'linux'
    if(args[0]==='image')return JSON.stringify([{Id:profile.imageDigest}])
    if(args[0]==='inspect')return JSON.stringify([{Id:cid,Name:`/${name}`,State:{Running:running}}])
    if(args[0]==='stop'){stops++;running=false;return cid}
    if(args[0]==='rm'){assert.equal(running,false);removes++;return cid}
    throw new Error('未预期的Docker端口调用')
  }
  let runtime:Awaited<ReturnType<typeof createSharedDockerRuntime>>|undefined
  try {
    runtime=await createSharedDockerRuntime({directory:state,workspace:{...target,projectId:'source',label:'本次目录生命周期夹具',realPath:source,identity:'fixture',revoked:false,sharedProfilePath:f.file,policy:{approvalPolicy:'on-request',sandboxMode:'read-only',networkAccess:false}},sessionId:'session',scope,discovery:true,authorize:async()=>{},run})
    const firstCatalog=await runtime.options.openCatalogProcess!()
    const launch=await Effect.runPromise(firstCatalog.agentScope.wrap({command:'codex',args:['app-server'],name:'codex-catalog'}))
    name=launch.args[launch.args.indexOf('--name')+1]!
    const cidFile=launch.args[launch.args.indexOf('--cidfile')+1]!
    await writeFile(cidFile,cid);running=true
    // attach进程退出不改变Docker事实；普通wrap必须继续拒绝，不隐式杀旧进程。
    await assert.rejects(Effect.runPromise(runtime.options.agentScope!.wrap({command:'codex',args:['app-server'],name:'codex-catalog'})),{code:'shared_catalog_busy'})
    await assert.rejects(runtime.options.openCatalogProcess!(),{code:'shared_catalog_busy'})
    assert.equal(stops,0)
    await runtime.configureSkillCatalog([])
    await firstCatalog.close()
    const secondCatalog=await runtime.options.openCatalogProcess!()
    await Effect.runPromise(secondCatalog.agentScope.wrap({command:'codex',args:['app-server'],name:'codex-catalog'}))
    assert.equal(stops,1,'只有已完成目录进程的回调能按已确认CID停止容器')
    assert.equal(removes,1)
    await writeFile(cidFile,cid);running=true
    await secondCatalog.close()
    assert.equal(stops,2);assert.equal(removes,2)
    await assert.rejects(readFile(cidFile),{code:'ENOENT'})
    const neverLaunched=await runtime.options.openCatalogProcess!()
    await neverLaunched.close()
    // 上一目录以及从未启动目录的重复、迟到回调不能终止随后真正启动的主 app-server。
    await Effect.runPromise(runtime.options.agentScope!.wrap({command:'codex',args:['app-server'],name:'codex'}))
    await writeFile(cidFile,cid);running=true
    await firstCatalog.close();await secondCatalog.close();await neverLaunched.close()
    assert.equal(stops,2);assert.equal(running,true)
    const rejectedCatalog=await runtime.options.openCatalogProcess!()
    await assert.rejects(Effect.runPromise(rejectedCatalog.agentScope.wrap({command:'codex',args:['app-server'],name:'codex-catalog'})),{code:'shared_execution_unknown'})
    await rejectedCatalog.close()
    assert.equal(stops,2,'未成功取得launch归属的目录回调不能终止正在运行的主进程')
    assert.equal(await readFile(cidFile,'utf8'),cid)
    await runtime.close();runtime=undefined
    assert.equal(stops,3);assert.equal(removes,3)
  } finally {try {if(runtime)await runtime.close()} finally {Object.defineProperty(process,'platform',original)}}
})
test('目录lease停止未知时保留原CID与同一失败，并阻止随后新启动',async t=>{
  const f=await fixture(t),source=join(f.root,'source'),state=join(f.root,'state')
  await mkdir(source);await mkdir(state)
  const original=Object.getOwnPropertyDescriptor(process,'platform')!
  Object.defineProperty(process,'platform',{value:'linux'})
  const profile=(await loadSharedDockerProfile(f.file)).descriptor,target={kind:'customer' as const,deviceId:'device',registeredWorkspaceId:'source',workspaceBindingRevision:1,runtimeId:'codex' as const}
  const scope:SharedExecutionScope={grantId:'catalog-stop-fixture',actorId:'caller',providerId:'provider',projectId:'project',sourceProjectId:'source',threadId:'thread',runId:'run',assistantId:'assistant',presetRevision:1,shareRevision:1,allocation:{kind:'member',id:'caller',revision:1},capabilityRevision:'fixture-only',profile,target,model:{instanceId:'customer-device-codex',model:'no-model-call',reasoningEffort:null},skillIds:[]}
  let name='',stops=0
  const cid='e'.repeat(64),run=async(args:ReadonlyArray<string>)=>{
    if(args[0]==='info')return 'linux'
    if(args[0]==='image')return JSON.stringify([{Id:profile.imageDigest}])
    if(args[0]==='inspect')return JSON.stringify([{Id:cid,Name:`/${name}`,State:{Running:true}}])
    if(args[0]==='stop'){stops++;throw new Error('停止结果待核实的本次夹具')}
    throw new Error('不能移除未知运行')
  }
  let runtime:Awaited<ReturnType<typeof createSharedDockerRuntime>>|undefined
  try {
    runtime=await createSharedDockerRuntime({directory:state,workspace:{...target,projectId:'source',label:'目录停止未知夹具',realPath:source,identity:'fixture',revoked:false,sharedProfilePath:f.file,policy:{approvalPolicy:'on-request',sandboxMode:'read-only',networkAccess:false}},sessionId:'session',scope,discovery:true,authorize:async()=>{},run})
    const lease=await runtime.options.openCatalogProcess!()
    const launch=await Effect.runPromise(lease.agentScope.wrap({command:'codex',args:['app-server'],name:'codex-catalog'}))
    name=launch.args[launch.args.indexOf('--name')+1]!
    const cidFile=launch.args[launch.args.indexOf('--cidfile')+1]!
    await writeFile(cidFile,cid)
    const first=lease.close(),repeat=lease.close()
    assert.equal(first,repeat)
    await assert.rejects(first,{code:'shared_execution_unknown'})
    await assert.rejects(repeat,{code:'shared_execution_unknown'})
    assert.equal(stops,1)
    assert.equal(await readFile(cidFile,'utf8'),cid)
    await assert.rejects(runtime.options.openCatalogProcess!(),{code:'shared_profile_closed'})
    await assert.rejects(Effect.runPromise(runtime.options.agentScope!.wrap({command:'codex',args:['app-server'],name:'codex'})),{code:'shared_profile_closed'})
  } finally {try {if(runtime)await assert.rejects(runtime.close(),{code:'shared_stop_unknown'})} finally {Object.defineProperty(process,'platform',original)}}
})
