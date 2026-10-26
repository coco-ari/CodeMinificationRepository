import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
