import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, chmod, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import * as Effect from 'effect/Effect'
import {fixedNativeModelCatalog} from '../t3-adapters/native-catalog.mjs'
import {createSharedDockerRuntime, loadSharedDockerProfile, sharedCodexConfiguration, sharedContainerArguments} from './shared-docker-profile.ts'
import type {SharedExecutionScope} from '../../autoops/contracts/shared-execution.ts'

async function fixture(t: import('node:test').TestContext) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'autoops-local-model-catalog-')))
  const catalog=join(root,'models.json'),file=join(root,'profile.json')
  const bytes=JSON.stringify(fixedNativeModelCatalog('provider-fixture-model'))+'\n'
  await writeFile(catalog,bytes,{mode:0o600})
  const value={version:1,id:'explicit-local-catalog',revision:1,imageDigest:`sha256:${'a'.repeat(64)}`,skills:[],modelCatalogPath:catalog,gateway:{url:'https://models.invalid/v1',authorizationEnv:'FIXTURE_ONLY_MODEL_TOKEN'}}
  await writeFile(file,JSON.stringify(value),{mode:0o600})
  t.after(()=>rm(root,{recursive:true,force:true}))
  return {root,catalog,file,bytes,value}
}

test('提供者显式本机模型目录按实际文件字节固定，不用平台模型或首项替代',async t=>{
  const f=await fixture(t),profile=await loadSharedDockerProfile(f.file)
  assert.equal(profile.modelCatalog?.bytes.toString('utf8'),f.bytes)
  assert.equal(profile.modelCatalog?.sha256,createHash('sha256').update(f.bytes).digest('hex'))
  assert.equal(JSON.stringify(profile.descriptor).includes('provider-fixture-model'),false)
  const first=profile.descriptor.digest
  await writeFile(f.catalog,JSON.stringify(fixedNativeModelCatalog('changed-provider-fixture-model'))+'\n')
  assert.notEqual((await loadSharedDockerProfile(f.file)).descriptor.digest,first)
  const custom=fixedNativeModelCatalog('provider-custom-effort')
  custom.models[0]!.supported_reasoning_levels=[{effort:'persistent',description:'提供者真实目录中的强度'}]
  await writeFile(f.catalog,JSON.stringify(custom))
  assert.equal((await loadSharedDockerProfile(f.file)).modelCatalog?.bytes.toString('utf8'),JSON.stringify(custom),'保留原目录强度；原生是否支持由实际CLI裁决')
})

test('无显式目录保留内置来源；显式目录只读挂载到固定路径且配置在provider表之外',async t=>{
  const f=await fixture(t)
  const {modelCatalogPath,...builtin}=f.value
  await writeFile(f.file,JSON.stringify(builtin))
  assert.equal((await loadSharedDockerProfile(f.file)).modelCatalog,undefined)
  assert.doesNotMatch(sharedCodexConfiguration('/srv/source'),/model_catalog_json/)
  await writeFile(f.file,JSON.stringify(f.value))
  const profile=await loadSharedDockerProfile(f.file)
  const config=sharedCodexConfiguration('/srv/source',[],true)
  assert.match(config.split('[model_providers.autoops_shared]')[0]!,/^model_catalog_json = "\/autoops\/model-catalog.json"$/m)
  const snapshot=join(f.root,'snapshot-models.json')
  const args=sharedContainerArguments({profile,workspace:{registeredWorkspaceId:'source',workspaceBindingRevision:1,runtimeId:'codex',projectId:'source-project',label:'来源',realPath:join(f.root,'source'),identity:'fixture',revoked:false,policy:{approvalPolicy:'on-request',sandboxMode:'read-only',networkAccess:false}},name:'catalog-fixture',cidFile:join(f.root,'id'),home:join(f.root,'home'),configuration:join(f.root,'config.toml'),attachments:join(f.root,'attachments'),gateway:join(f.root,'gateway'),entry:join(f.root,'entry.mjs'),uid:1000,gid:1000,command:'codex',args:['app-server'],modelCatalog:snapshot})
  assert(args.includes(`type=bind,src=${snapshot},dst=/autoops/model-catalog.json,readonly,bind-recursive=disabled`))
  assert(!args.some(value=>value.includes(f.catalog)), '容器只能读本次固定字节副本，不挂可变宿主原文件')
})

test('模型目录坏JSON、非目录形状、重复模型、超量、符号链接和宽写权限均明确拒绝',async t=>{
  const f=await fixture(t)
  for(const bytes of ['not-json','[]','{"models":[]}',JSON.stringify({models:[{slug:'same'},{slug:'same'}]}),' '.repeat(1024*1024+1)]) {
    await writeFile(f.catalog,bytes)
    await assert.rejects(loadSharedDockerProfile(f.file),{code:'shared_profile_invalid'})
  }
  await writeFile(f.catalog,f.bytes)
  await writeFile(f.catalog,Buffer.from([0xff,0xfe,0x7b]))
  await assert.rejects(loadSharedDockerProfile(f.file),{code:'shared_profile_invalid'})
  await writeFile(f.catalog,f.bytes)
  await chmod(f.catalog,0o666)
  await assert.rejects(loadSharedDockerProfile(f.file),{code:'shared_profile_invalid'})
  await chmod(f.catalog,0o600)
  const link=join(f.root,'linked-models.json');await symlink(f.catalog,link)
  await writeFile(f.file,JSON.stringify({...f.value,modelCatalogPath:link}))
  await assert.rejects(loadSharedDockerProfile(f.file),{code:'shared_profile_invalid'})
})

test('运行时固定模型文件快照，提供者改原件后旧profile拒绝后续调用',async t=>{
  const f=await fixture(t),source=join(f.root,'source'),state=join(f.root,'state')
  await mkdir(source);await mkdir(state)
  const original=Object.getOwnPropertyDescriptor(process,'platform')!
  Object.defineProperty(process,'platform',{value:'linux'})
  let runtime:Awaited<ReturnType<typeof createSharedDockerRuntime>>|undefined
  try {
    const profile=(await loadSharedDockerProfile(f.file)).descriptor,target={kind:'customer' as const,deviceId:'device',registeredWorkspaceId:'source',workspaceBindingRevision:1,runtimeId:'codex' as const}
    const scope:SharedExecutionScope={grantId:'model-file-fixture-only',actorId:'caller',providerId:'provider',projectId:'target',sourceProjectId:'source-project',threadId:'thread',runId:'run',assistantId:'assistant',presetRevision:1,shareRevision:1,allocation:{kind:'member',id:'caller',revision:1},capabilityRevision:'fixture-only',profile,target,model:{instanceId:'customer-device-codex',model:'provider-fixture-model',reasoningEffort:null},skillIds:[]}
    runtime=await createSharedDockerRuntime({directory:state,workspace:{...target,projectId:'source-project',label:'目录修订夹具',realPath:source,identity:'fixture',revoked:false,sharedProfilePath:f.file,policy:{approvalPolicy:'on-request',sandboxMode:'read-only',networkAccess:false}},sessionId:'session',scope,discovery:true,authorize:async()=>{},run:async args=>args[0]==='info'?'linux':JSON.stringify([{Id:profile.imageDigest}])})
    const launch=await Effect.runPromise(runtime.options.agentScope!.wrap({command:'codex',args:['app-server'],name:'catalog'}))
    const mount=launch.args.find(value=>value.includes('dst=/autoops/model-catalog.json'))!
    assert(mount,'真实进程参数必须有固定模型目录只读挂载')
    const snapshot=mount.match(/src=([^,]+)/)![1]!
    assert.equal(await readFile(snapshot,'utf8'),f.bytes)
    assert.equal((await stat(snapshot)).mode&0o222,0)
    await writeFile(f.catalog,JSON.stringify(fixedNativeModelCatalog('other-model'))+'\n')
    await assert.rejects(runtime.assertCurrent(),{code:'shared_profile_changed'})
    assert.equal(await readFile(snapshot,'utf8'),f.bytes)
  } finally {try {if(runtime)await assert.rejects(runtime.close(),{code:'shared_stop_unknown'})} finally {Object.defineProperty(process,'platform',original)}}
})
