// @effect-diagnostics nodeBuiltinImport:off -- 客户连接程序拥有本机 Docker 子进程、受限文件与关闭核查，不进入平台 Effect 服务。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as S from 'effect/Schema'
import * as Effect from 'effect/Effect'
import type { AgentScopeShape } from '../../vendor/t3code/packages/shared/src/AgentScope.ts'
import { sharedSessionIdentity, type SharedExecutionScope, type SharedProfileDescriptor } from '../../autoops/contracts/shared-execution.ts'
import type { HeadlessCodexRunnerOptions } from '../../vendor/t3code/apps/server/src/provider/HeadlessCodexRunner.ts'
import { ConnectorError, type LocalWorkspace } from './store.ts'
import { createSharedModelGateway } from './shared-model-gateway.ts'

const Text = S.String.check(S.isMinLength(1), S.isMaxLength(2048))
const Configuration = S.Struct({
  version:S.Literal(1),id:S.String.check(S.isMinLength(1),S.isMaxLength(200)),
  revision:S.Int.check(S.isGreaterThanOrEqualTo(1)),
  imageDigest:S.String.check(S.isPattern(/^sha256:[a-f0-9]{64}$/)),
  skills:S.Array(Text).check(S.isMaxLength(32)),
  gateway:S.Struct({url:Text,authorizationEnv:S.String.check(S.isPattern(/^[A-Z][A-Z0-9_]{0,127}$/))}),
  dockerBinary:S.optionalKey(Text),sudo:S.optionalKey(S.Boolean),
})
type SkillFile = {path:string;bytes:Buffer}
export type LocalSharedProfile = {
  descriptor:SharedProfileDescriptor;configuration:typeof Configuration.Type;
  skillFiles:ReadonlyArray<SkillFile>;
}
const fail = (code:string,message:string):never=>{throw new ConnectorError(code,message)}
const stable = (value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)

/** 只接收提供者本机显式文件；不能由远端 scope 指定宿主挂载、镜像或技能路径。 */
export async function loadSharedDockerProfile(path:string):Promise<LocalSharedProfile> {
  try {
    if(!isAbsolute(path) || await realpath(path)!==path)throw new Error()
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
    let configuration:typeof Configuration.Type
    try {
      const stat=await handle.stat()
      if(!stat.isFile() || stat.size>64*1024 || (stat.mode&0o022)!==0)throw new Error()
      configuration=S.decodeUnknownSync(Configuration,{onExcessProperty:'error'})(JSON.parse(await handle.readFile('utf8')))
    } finally {await handle.close()}
    const upstream=new URL(configuration.gateway.url)
    if(!['https:','http:'].includes(upstream.protocol)||upstream.username||upstream.password||upstream.search||upstream.hash)throw new Error()
    if(configuration.dockerBinary && (!isAbsolute(configuration.dockerBinary)||configuration.dockerBinary.includes(',')))throw new Error()
    const skillFiles:SkillFile[]=[]
    let size=0
    for(const root of configuration.skills) {
      if(!isAbsolute(root)||await realpath(root)!==root)throw new Error()
      const label=createHash('sha256').update(root).digest('hex').slice(0,24)
      const visit=async(directory:string):Promise<void>=>{
        for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
          if(entry.isSymbolicLink())throw new Error()
          const source=join(directory,entry.name)
          if(entry.isDirectory()){await visit(source);continue}
          if(!entry.isFile() || skillFiles.length>=2000)throw new Error()
          const file=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW)
          try {
            const stat=await file.stat()
            if(!stat.isFile()||stat.size>1024*1024||size+stat.size>8*1024*1024)throw new Error()
            const bytes=await file.readFile();size+=bytes.length
            skillFiles.push({path:join(label,relative(root,source)),bytes})
          } finally {await file.close()}
        }
      }
      if(!(await lstat(root)).isDirectory())throw new Error()
      await visit(root)
      if(!skillFiles.some(file=>file.path===join(label,'SKILL.md')))throw new Error()
    }
    const digest=createHash('sha256').update(stable({configuration,skills:skillFiles.map(file=>({path:file.path,sha256:createHash('sha256').update(file.bytes).digest('hex')}))})).digest('hex')
    return {configuration,skillFiles,descriptor:{id:configuration.id,revision:configuration.revision,digest,imageDigest:configuration.imageDigest,policy:'linux-docker-readonly-v1'}}
  } catch {return fail('shared_profile_invalid','本机隔离profile、镜像或技能范围无效，请由提供者核对')}
}

export type DockerRun = (args:ReadonlyArray<string>)=>Promise<string>
export function sharedDockerCommand(profile:LocalSharedProfile):{command:string;prefix:ReadonlyArray<string>} {
  const binary=profile.configuration.dockerBinary??'/usr/bin/docker'
  return profile.configuration.sudo?{command:'/usr/bin/sudo',prefix:['-n',binary]}:{command:binary,prefix:[]}
}
export function dockerClient(profile:LocalSharedProfile):DockerRun {
  const {command,prefix}=sharedDockerCommand(profile)
  return async args=>{
    try {
      const result=await promisify(execFile)(command,[...prefix,...args],{timeout:20_000,maxBuffer:512*1024,env:{PATH:'/usr/bin:/bin:/usr/local/bin',LANG:'C.UTF-8'}})
      return result.stdout
    } catch {return fail('shared_container_unavailable','隔离容器未完成操作；请在提供者本机核对 Docker 状态')}
  }
}
const mount = (source:string,target:string,readonly:boolean)=>{
  if([source,target].some(path=>!isAbsolute(path)||/[\x00-\x1f,]/.test(path)))return fail('shared_mount_invalid','隔离目录路径无效')
  return `type=bind,src=${source},dst=${target}${readonly?',readonly,bind-recursive=disabled':''}`
}
export function sharedContainerArguments(input:{profile:LocalSharedProfile;workspace:LocalWorkspace;name:string;cidFile:string;home:string;configuration:string;attachments:string;gateway:string;entry:string;uid:number;gid:number;command:string;args:ReadonlyArray<string>;skillsReadonly?:boolean}):ReadonlyArray<string> {
  if(input.uid<=0||input.gid<0)return fail('shared_user_required','共享容器必须使用非 root 身份')
  return ['run','--pull=never','--interactive','--name',input.name,'--cidfile',input.cidFile,
    '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges=true',
    '--pids-limit','64','--memory','384m','--cpus','1','--user',`${input.uid}:${input.gid}`,
    '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
    '--mount',mount(input.workspace.realPath,input.workspace.realPath,true),
    '--mount',mount(input.home,'/home/autoops',false),
    ...(input.skillsReadonly?['--mount',mount(join(input.home,'.codex','skills'),'/home/autoops/.codex/skills',true)]:[]),
    '--mount',mount(input.configuration,'/home/autoops/.codex/config.toml',true),
    '--mount',mount(input.attachments,'/autoops/attachments',true),
    '--mount',mount(input.gateway,'/autoops/gateway',true),
    '--mount',mount(input.entry,'/autoops-shared-entry.mjs',true),
    '--env','HOME=/home/autoops','--env','CODEX_HOME=/home/autoops/.codex','--env','PATH=/usr/local/bin:/usr/bin:/bin',
    '--entrypoint','node',input.profile.descriptor.imageDigest,'/autoops-shared-entry.mjs',input.workspace.realPath,input.command,...input.args]
}

export function sharedCodexConfiguration(source:string,disabledSkills:ReadonlyArray<string>=[]):string {
  return 'model_provider = "autoops_shared"\nweb_search = "disabled"\n[features]\nreasoning_effort_override = false\nimage_generation = false\n'+`[projects.${JSON.stringify(source)}]\ntrust_level = "untrusted"\n`+'[model_providers.autoops_shared]\nname = "AutoOps shared gateway"\nbase_url = "http://127.0.0.1:18766/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n'+disabledSkills.map(path=>`\n[[skills.config]]\npath = ${JSON.stringify(path)}\nenabled = false\n`).join('')
}

/** 重新使用持久状态前，核对原容器；不能把客户端断开视为远端已停止。 */
async function inspectSharedContainer(cidFile:string,run:DockerRun,name:string):Promise<{id:string;running:boolean}|undefined> {
  let id:string
  try {
    const handle=await open(cidFile,constants.O_RDONLY|constants.O_NOFOLLOW)
    try {const stat=await handle.stat();if(!stat.isFile()||stat.size>128)throw new Error();id=(await handle.readFile('utf8')).trim()} finally {await handle.close()}
  } catch(error) {
    if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return undefined
    return fail('shared_execution_unknown','原隔离容器身份待核实，保留原任务状态')
  }
  try {
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error()
    const result:unknown=JSON.parse(await run(['inspect',id]))
    if(!Array.isArray(result)||result.length!==1)throw new Error()
    const item=result[0]
    if(item?.Id!==id||item.Name!==`/${name}`||typeof item.State?.Running!=='boolean')throw new Error()
    return {id,running:item.State.Running}
  } catch {return fail('shared_execution_unknown','原隔离容器状态待核实，保留原任务状态')}
}
export async function retireSharedContainer(cidFile:string,run:DockerRun,name:string):Promise<void> {
  const original=await inspectSharedContainer(cidFile,run,name)
  if(!original)return
  if(original.running)return fail('shared_execution_unknown','原隔离容器仍在运行，请先核实原任务')
  try {await run(['rm',original.id]);await rm(cidFile)} catch {return fail('shared_execution_unknown','原隔离容器回收结果待核实，保留原任务状态')}
}

export interface SharedDockerRuntime {
  readonly options:Pick<HeadlessCodexRunnerOptions,'homePath'|'environment'|'agentScope'|'externalSandbox'>
  updateScope(scope:SharedExecutionScope):Promise<void>
  assertCurrent():Promise<void>
  close():Promise<void>
  readonly attachmentDirectory:string
  attachmentPath(path:string):string
  setModelDefaults(models:ReadonlyArray<{id:string;effort:string|null}>):void
  configureSkillCatalog(skills:ReadonlyArray<{path:string;enabled:boolean}>):Promise<void>
  assertSkillCatalog(skills:ReadonlyArray<{path:string;enabled:boolean}>):void
}
export const sharedRuntimeDirectory = (directory:string,scope:SharedExecutionScope)=>join(directory,'shared',createHash('sha256').update(sharedSessionIdentity(scope)!).digest('hex'))
export async function createSharedDockerRuntime(input:{directory:string;workspace:LocalWorkspace;sessionId:string;scope:SharedExecutionScope;authorize:(scope:SharedExecutionScope,signal?:AbortSignal)=>Promise<void>;discovery?:boolean;run?:DockerRun}):Promise<SharedDockerRuntime> {
  if(process.platform!=='linux')return fail('shared_linux_required','此隔离profile仅支持已验证的 Linux Docker 运行器')
  if(!input.workspace.sharedProfilePath)return fail('shared_profile_required','提供者尚未为此来源选择本机隔离profile')
  const contains=(parent:string,child:string)=>{const path=relative(parent,child);return path===''||(!isAbsolute(path)&&path!=='..'&&!path.startsWith(`..${sep}`))}
  if(['/','/proc','/sys','/dev','/tmp','/run','/usr','/bin','/etc','/var','/home/autoops','/autoops'].some(path=>input.workspace.realPath===path||contains(input.workspace.realPath,path)) ||
    contains(input.workspace.realPath,input.directory) || (process.env.HOME && contains(input.workspace.realPath,process.env.HOME)))
    return fail('shared_source_too_broad','共享资料目录不能包含宿主 HOME、连接程序状态或隔离系统目录')
  const profile=await loadSharedDockerProfile(input.workspace.sharedProfilePath)
  if(stable(profile.descriptor)!==stable(input.scope.profile))return fail('shared_profile_changed','本机隔离profile已变更，请重新核验和分配')
  const run=input.run??dockerClient(profile), uid=process.getuid?.()??0,gid=process.getgid?.()??0
  if((await run(['info','--format','{{.OSType}}'])).trim()!=='linux')return fail('shared_linux_required','共享profile需要 Linux Docker daemon')
  const inspected=JSON.parse(await run(['image','inspect',profile.descriptor.imageDigest])) as Array<{Id:string}>
  if(inspected.length!==1||inspected[0]?.Id!==profile.descriptor.imageDigest)return fail('shared_image_changed','隔离镜像与已固定摘要不一致')
  const identity=sharedSessionIdentity(input.scope)!
  const root=sharedRuntimeDirectory(input.directory,input.scope),home=join(root,'home'),attachments=join(root,'attachments')
  const name=`autoops-shared-${createHash('sha256').update(identity).digest('hex').slice(0,32)}`,cidFile=join(root,'container.id')
  // 先确认上次进程确实结束，再更新共享目录；原容器状态不明时不重写原输入。
  await retireSharedContainer(cidFile,run,name)
  for(const path of [join(input.directory,'shared'),root,home,attachments,join(home,'.codex')]){await mkdir(path,{recursive:true,mode:0o700});if((await lstat(path)).isSymbolicLink()||await realpath(path)!==path)return fail('shared_state_invalid','隔离状态目录不能是符号链接');await chmod(path,0o700)}
  const skills=join(home,'.codex','skills')
  await rm(skills,{recursive:true,force:true});await mkdir(skills,{mode:0o700})
  for(const file of profile.skillFiles){const target=join(skills,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,file.bytes,{mode:0o400})}
  const configuration=join(root,'config.toml'),temporary=join(root,'config.next.toml')
  const writeConfiguration=async(value:string)=>{
    await rm(temporary,{force:true})
    const handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o400)
    try {await handle.writeFile(value)} finally {await handle.close()}
    await rename(temporary,configuration)
  }
  await writeConfiguration(sharedCodexConfiguration(input.workspace.realPath))
  const allowedSkills=new Set(profile.skillFiles.filter(file=>basename(file.path)==='SKILL.md').map(file=>`/home/autoops/.codex/skills/${file.path}`))
  // Unix socket 的内核路径长度有限；只有无秘密的会话模型通道使用独占短目录。
  const gatewayDirectory=await realpath(await mkdtemp('/tmp/autoops-gw-'))
  await chmod(gatewayDirectory,0o700)
  const gatewayIdentity=await lstat(gatewayDirectory)
  let scope=input.scope,closed=false,accepting=true,closeResult:Promise<void>|undefined
  const modelDefaults=new Map<string,string|null>()
  const assertCurrent=async(signal?:AbortSignal)=>{
    signal?.throwIfAborted()
    if(closed||!accepting)return fail('shared_profile_closed','共享隔离profile已停止接受新操作')
    if(stable((await loadSharedDockerProfile(input.workspace.sharedProfilePath!)).descriptor)!==stable(scope.profile))return fail('shared_profile_changed','提供者已修改或撤回本机隔离profile')
    if(!input.discovery)await input.authorize(scope,signal)
  }
  const gateway=await createSharedModelGateway({socketPath:join(gatewayDirectory,'model.sock'),scope:()=>scope,
    upstream:{url:profile.configuration.gateway.url,authorization:()=>{const value=process.env[profile.configuration.gateway.authorizationEnv];if(!value)return fail('shared_gateway_credential_missing','模型网关凭据尚未配置');return `Bearer ${value}`}},
    authorize:async(current:SharedExecutionScope,signal:AbortSignal)=>{if(input.discovery)return fail('shared_discovery_only','能力发现不能发起模型执行');await assertCurrent(signal);await input.authorize(current,signal)},
    expectedReasoningEffort:current=>current.model.reasoningEffort??modelDefaults.get(current.model.model)??null,
  })
  let launched=false,skillsReadonly=false
  const agentScope:AgentScopeShape={wrap:({command,args})=>Effect.promise(async()=>{
    await assertCurrent()
    // 旧 cid 必须经 Docker 核对结束，不能仅凭客户端进程消失认定已停止。
    await retireSharedContainer(cidFile,run,name)
    const launch=sharedDockerCommand(profile);launched=true
    return {command:launch.command,args:[...launch.prefix,...sharedContainerArguments({profile,workspace:input.workspace,name,cidFile,home,configuration,attachments,gateway:gatewayDirectory,entry:fileURLToPath(new URL('./shared-container-entry.mjs',import.meta.url)),uid,gid,command,args,skillsReadonly})]}
  }),oomKilled:()=>Effect.succeed(false),clear:()=>Effect.void}
  return {options:{homePath:'/home/autoops/.codex',environment:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/autoops',LANG:'C.UTF-8'},agentScope,externalSandbox:true},
    attachmentDirectory:attachments,attachmentPath:path=>{if(dirname(path)!==attachments)return fail('shared_attachment_scope','附件不属于此隔离会话');return `/autoops/attachments/${basename(path)}`},
    setModelDefaults:models=>{modelDefaults.clear();for(const model of models)modelDefaults.set(model.id,model.effort)},
    configureSkillCatalog:async skills=>{
      if(skills.length>2000||skills.some(skill=>!isAbsolute(skill.path)||skill.path.length>4096||/[\x00-\x1f]/.test(skill.path)))return fail('shared_skill_catalog_invalid','隔离运行器技能目录无效')
      const disabled=[...new Set(skills.filter(skill=>!allowedSkills.has(skill.path)).map(skill=>skill.path))]
      await writeConfiguration(sharedCodexConfiguration(input.workspace.realPath,disabled))
      // 首次只发现目录，不执行模型；重新启动后技能挂载只读，不能在会话内改变已声明能力。
      skillsReadonly=true
    },
    assertSkillCatalog:skills=>{
      const active=skills.filter(skill=>skill.enabled)
      if(active.some(skill=>!allowedSkills.has(skill.path))||[...allowedSkills].some(path=>!active.some(skill=>skill.path===path)))return fail('shared_skill_scope_unverified','实际隔离技能目录与提供者选择不一致，不能开放共享执行')
    },
    assertCurrent,updateScope:async next=>{if(sharedSessionIdentity(next)!==identity)return fail('shared_session_changed','共享会话不能更换身份及资料范围');await input.authorize(next);scope=next;await assertCurrent()},
    close:()=>closeResult??=(async()=>{accepting=false;gateway.stopAccepting();let stopped=false
      try {if(launched){const original=await inspectSharedContainer(cidFile,run,name);if(!original)throw new Error();if(original.running)await run(['stop','--time','5',original.id]);
          await retireSharedContainer(cidFile,run,name);stopped=true}else stopped=true
      }catch{throw new ConnectorError('shared_stop_unknown','隔离容器停止结果待核实；原任务不能自动重做')}
      finally {await gateway.close();closed=true;const current=await lstat(gatewayDirectory);if(current.ino===gatewayIdentity.ino&&current.dev===gatewayIdentity.dev&&(await readdir(gatewayDirectory)).length===0)await rmdir(gatewayDirectory)}
      if(!stopped)return fail('shared_stop_unknown','隔离容器尚未确认停止')
    })(),
  }
}
