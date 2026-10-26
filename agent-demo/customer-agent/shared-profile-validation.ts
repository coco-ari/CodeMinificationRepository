// @effect-diagnostics nodeBuiltinImport:off -- 手动验收只创建本次临时目标及带固定名称的受管容器，停止不明时保留现场。
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as Effect from 'effect/Effect'
import type { SharedExecutionScope } from '../../autoops/contracts/shared-execution.ts'
import { createSharedDockerRuntime, loadSharedDockerProfile } from './shared-docker-profile.ts'

/** 此程序验证实际 OS 边界；不签发中心许可，也不代替真实跨用户 Codex 及业务授权验收。 */
export async function validateSharedProfile(profilePath:string) {
  const profile=await loadSharedDockerProfile(await realpath(profilePath))
  const root=await realpath(await mkdtemp(join(tmpdir(),'autoops-shared-os-'))),source=join(root,'source'),state=join(root,'state'),privateFile=join(root,'provider-private.txt')
  await mkdir(source);await mkdir(state);await writeFile(join(source,'allowed.txt'),'SOURCE_FIXTURE');await writeFile(privateFile,'HOST_PRIVATE_CANARY')
  const scope:SharedExecutionScope={grantId:'os-probe-only',actorId:'os-caller',providerId:'os-provider',projectId:'os-project',sourceProjectId:'os-source',threadId:'os-probe-thread',runId:'os-probe-run',assistantId:'os-probe-assistant',presetRevision:1,shareRevision:1,allocation:{kind:'member',id:'os-caller',revision:1},capabilityRevision:'os-only',profile:profile.descriptor,target:{kind:'customer',deviceId:'os-probe-device',registeredWorkspaceId:'os-probe-source',workspaceBindingRevision:1,runtimeId:'codex'},model:{instanceId:'customer-os-probe-device-codex',model:'os-only-no-inference',reasoningEffort:null},skillIds:[]}
  let stopped=false,closeAttempted=false
  const runtime=await createSharedDockerRuntime({directory:state,workspace:{registeredWorkspaceId:scope.target.registeredWorkspaceId,workspaceBindingRevision:1,runtimeId:'codex',projectId:scope.sourceProjectId,label:'本次OS隔离验收',realPath:source,identity:'isolated-os-fixture',revoked:false,sharedProfilePath:await realpath(profilePath),policy:{approvalPolicy:'on-request',sandboxMode:'read-only',networkAccess:false}},scope,sessionId:'os-probe-only',discovery:true,authorize:async()=>{throw new Error('OS探测不开放模型执行')}})
  try {
    await runtime.configureSkillCatalog([])
    const code=`
      const fs=require('node:fs');const net=require('node:net');
      const denied=action=>{try{action();return false}catch{return true}};
      const result={sourceRead:fs.readFileSync(${JSON.stringify(join(source,'allowed.txt'))},'utf8')==='SOURCE_FIXTURE',
        sourceWriteDenied:denied(()=>fs.writeFileSync(${JSON.stringify(join(source,'not-allowed.txt'))},'x')),
        privateFileDenied:denied(()=>fs.readFileSync(${JSON.stringify(privateFile)})),
        hostStateDenied:denied(()=>fs.readdirSync(${JSON.stringify(state)})),
        dockerSocketDenied:denied(()=>fs.statSync('/var/run/docker.sock')),
        configWriteDenied:denied(()=>fs.writeFileSync('/home/autoops/.codex/config.toml','changed')),
        skillWriteDenied:denied(()=>fs.writeFileSync('/home/autoops/.codex/skills/unapproved.txt','changed')),
        hostEnvironmentAbsent:!process.env.AUTOOPS_OS_PRIVATE_CANARY,
        writableOwnHome:false,networkDenied:false};
      fs.writeFileSync('/home/autoops/own-result.txt','OWN_RESULT');result.writableOwnHome=true;
      const socket=net.connect({host:'1.1.1.1',port:443});socket.on('connect',()=>{console.log(JSON.stringify(result));socket.destroy()});
      socket.on('error',()=>{result.networkDenied=true;console.log(JSON.stringify(result))});socket.setTimeout(2000,()=>{result.networkDenied=true;socket.destroy();console.log(JSON.stringify(result))});
    `
    const command=await Effect.runPromise(runtime.options.agentScope!.wrap({command:'node',args:['-e',code],name:'os-boundary-probe'}))
    const result=await promisify(execFile)(command.command,[...command.args],{timeout:30_000,maxBuffer:128*1024,env:{PATH:'/usr/bin:/bin:/usr/local/bin',AUTOOPS_OS_PRIVATE_CANARY:'PRIVATE_FIXTURE_ONLY'}})
    const parsed=JSON.parse(result.stdout.trim()) as Record<string,boolean>
    if(Object.keys(parsed).length!==10||Object.values(parsed).some(value=>value!==true))throw new Error('OS隔离探测未全部通过')
    if(await readFile(join(source,'allowed.txt'),'utf8')!=='SOURCE_FIXTURE')throw new Error('原资料被改写')
    closeAttempted=true;await runtime.close();stopped=true
    return {profile:profile.descriptor,checks:parsed,containerStopped:true,sharedBusinessAccepted:false}
  } finally {
    if(!stopped&&!closeAttempted){try{closeAttempted=true;await runtime.close();stopped=true}catch{}}
    if(stopped)await rm(root,{recursive:true,force:true})
    else process.stderr.write(`隔离容器停止待核实，保留本次验收目录：${root}\n`)
  }
}

if(process.argv[1]?.endsWith('shared-profile-validation.ts')) {
  if(!process.argv[2])throw new Error('请指定提供者本机profile JSON绝对路径')
  process.stdout.write(JSON.stringify(await validateSharedProfile(process.argv[2]))+'\n')
}
