// AutoOps scopes the upstream Codex directory discovery and skill input protocol.
// The central library is immutable; only copies selected by an authorized scope
// are exposed below a session cwd. No global model-readable library is mounted.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, linkSync, rmSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { AutoOpsAccessError, configuredAutoOpsAccess } from './access.mjs'
import { parseDocument } from 'yaml'
import { resolveSkillLibrary, readSkillLibraryVersion } from './skill-library.mjs'

const fail = (message='技能不存在或不属于当前授权范围', code='SKILL_SCOPE_FORBIDDEN') => { throw new AutoOpsAccessError(403,code,message) }
const digest = value => createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex')
const contextRoot = directory => join(resolve(directory),'t3','skill-contexts')
const idPattern = /^[a-f0-9]{64}$/
const scopeOf = value => ({projectId:value.projectId,agentId:value.agentId,workspaceType:value.workspaceType||'internal',...(value.workspaceVersionId?{workspaceVersionId:value.workspaceVersionId}:{}),...(value.environmentId?{environmentId:value.environmentId}:{}),...((value.skillIds ?? value.question?.configuration.skillIds) !== undefined ? {skillIds:[...(value.skillIds ?? value.question.configuration.skillIds)].sort()} : {})})
const scopeEqual = (a,b) => JSON.stringify(scopeOf(a))===JSON.stringify(scopeOf(b))
const safeFile = (root,path) => {
  if(typeof path!=='string'||path.includes('\\')||path.startsWith('/')||path.includes('\0')||path.split('/').some(p=>!p||p==='.'||p==='..'))fail()
  const target=join(root,path)
  let current=root
  if(!existsSync(current)||lstatSync(current).isSymbolicLink())fail('技能包目录无效')
  for(const segment of path.split('/')) {current=join(current,segment);if(!existsSync(current)||lstatSync(current).isSymbolicLink())fail('技能文件无效或已改变')}
  if(!lstatSync(target).isFile()||relative(realpathSync(root),realpathSync(target)).startsWith('..'))fail()
  return target
}
function readJson(path) {
  if(!existsSync(path)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()||lstatSync(path).size>2*1024*1024)fail('技能范围快照无效')
  return JSON.parse(readFileSync(path,'utf8'))
}
function publishThreadBinding(path,value) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700})
  if(lstatSync(dirname(path)).isSymbolicLink())fail()
  const tmp=`${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'})
    // 原子发布完整收据，避免并发进程覆盖已登记的范围和历史归属。
    try {linkSync(tmp,path)}catch(error){if(error.code!=='EEXIST')throw error}
  }finally{rmSync(tmp,{force:true})}
}
function authorizeScope(access,principal,input) {
  if(!access||!principal)fail()
  if(input.threadId) return access.requireThread(principal,input.threadId)
  if(input.skillIds!==undefined&&(!Array.isArray(input.skillIds)||input.skillIds.length>32||input.skillIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id))))fail('技能选择格式无效')
  const scope=scopeOf(input)
  if(!['internal','external'].includes(scope.workspaceType)||!scope.projectId||!scope.agentId)fail('请先选择项目、助手和工作区')
  const bootstrap=access.bootstrap(principal)
  const project=bootstrap.projects.find(project=>project.id===scope.projectId)
  if(!project?.agents.some(agent=>agent.id===scope.agentId))fail()
  access.requireWorkspace(principal,scope.projectId,scope.workspaceType,scope.workspaceVersionId,scope.environmentId)
  if(scope.environmentId)access.requireEnvironment(principal,scope.projectId,scope.environmentId)
  return scope
}
function runtimeBytes(entry,file,bytes) {
  if(file.path!=='SKILL.md')return bytes
  const match=/^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(bytes.toString('utf8'))
  if(!match)fail('技能指令格式无效')
  const doc=parseDocument(match[1],{uniqueKeys:true});if(doc.errors.length)fail('技能指令格式无效');doc.set('name',entry.name)
  return Buffer.from(`---\n${doc.toString()}---\n${match[2]}`)
}
function runtimeFile(entry,file) {
  const source=readFileSync(safeFile(entry.packageRoot,file.path))
  if(source.length!==file.size||digest(source)!==file.sha256)fail('技能库文件已改变','SKILL_PACKAGE_CHANGED')
  return runtimeBytes(entry,file,source)
}
const skillIdentities=entries=>entries.map(({skillId,id,name,versionId,contentHash})=>({skillId:skillId||id,name,versionId,contentHash})).sort((a,b)=>a.name.localeCompare(b.name))
function materialize(directory,scope,entries) {
  const identity={version:1,scope:scopeOf(scope),skills:skillIdentities(entries)}
  const snapshotId=digest(identity),root=join(contextRoot(directory),snapshotId),manifest=join(root,'snapshot.json')
  if(!existsSync(manifest)) {
    mkdirSync(contextRoot(directory),{recursive:true,mode:0o700})
    if(lstatSync(contextRoot(directory)).isSymbolicLink())fail()
    const staging=join(contextRoot(directory),`.staging-${randomUUID()}`)
    mkdirSync(staging,{mode:0o700})
    try {
      for(const entry of entries) {
        if(!/^autoops-[a-z][a-z0-9-]{0,56}$/.test(entry.name))fail('技能名称无效')
        const root=join(staging,'.agents','skills',entry.name)
        mkdirSync(root,{recursive:true,mode:0o700})
        for(const file of entry.files) {
          const bytes=readFileSync(safeFile(entry.packageRoot,file.path))
          if(bytes.length!==file.size||digest(bytes)!==file.sha256)fail('技能内容已改变，请重新检查技能库','SKILL_PACKAGE_CHANGED')
          const target=join(root,file.path)
          mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,runtimeBytes(entry,file,bytes),{mode:0o400,flag:'wx'})
        }
      }
      writeFileSync(join(staging,'snapshot.json'),JSON.stringify(identity)+'\n',{mode:0o400,flag:'wx'})
      try {renameSync(staging,root)}catch(error){if(!existsSync(manifest))throw error}
    } finally {rmSync(staging,{recursive:true,force:true})}
  }
  return readContext(directory,snapshotId)
}
function readContext(directory,snapshotId) {
  if(!idPattern.test(snapshotId))fail()
  const root=join(contextRoot(directory),snapshotId),identity=readJson(join(root,'snapshot.json'))
  if(identity.version!==1||digest(identity)!==snapshotId)fail('技能范围快照已改变')
  const skills=identity.skills.map(record=>{
    const entry=readSkillLibraryVersion(directory,record.skillId,record.versionId)
    if(entry.contentHash!==record.contentHash||entry.name!==record.name||entry.readiness!=='ready')fail('技能版本不再完整','SKILL_PACKAGE_CHANGED')
    const packageRoot=join(root,'.agents','skills',entry.name)
    const files=entry.files.map(file=>{const expected=runtimeFile(entry,file),bytes=readFileSync(safeFile(packageRoot,file.path));if(!bytes.equals(expected))fail('会话固定技能文件已改变','SKILL_PACKAGE_CHANGED');return {...file,size:bytes.length,sha256:digest(bytes)}})
    return {...entry,files,packageRoot,path:join(packageRoot,'SKILL.md')}
  })
  return {snapshotId,scope:identity.scope,skills,physicalCwd:root,cwd:`autoops/skill-context/${snapshotId}`}
}
function assertCurrent(directory,context,{strict=false}={}) {
  const allowed=new Set(resolveSkillLibrary(directory,context.scope).map(entry=>entry.skillId||entry.id))
  const skills=context.skills.filter(entry=>allowed.has(entry.skillId||entry.id))
  if(strict&&skills.length!==context.skills.length)throw new AutoOpsAccessError(409,'SKILL_CONTEXT_STALE','技能列表已更新，请重试。')
  return {...context,skills}
}
const lockPath=(directory,threadId)=>join(contextRoot(directory),'threads',digest(threadId)+'.json')
const receiptPath=(directory,threadId,snapshotId)=>join(contextRoot(directory),'threads',`${digest(threadId)}-${snapshotId}.json`)
function assertThreadScope(directory,path,threadId,binding) {
  const saved=readJson(path)
  if(!idPattern.test(saved.snapshotId))fail()
  const identity=readJson(join(contextRoot(directory),saved.snapshotId,'snapshot.json'))
  if(saved.threadId!==threadId||digest(identity)!==saved.snapshotId||!scopeEqual(identity.scope,binding))fail('会话技能绑定与当前范围不一致')
}
export function prepareScopedBusinessSkills(directory,binding,{lock=true}={}) {
  const threadId=binding.nativeParentThreadId||binding.threadId,saved=threadId?lockPath(directory,threadId):null
  if(saved&&existsSync(saved))assertThreadScope(directory,saved,threadId,binding)
  // 会话只固定业务范围；新旧对话每次都按当前分配生成目录。
  const context=materialize(directory,binding,resolveSkillLibrary(directory,scopeOf(binding)))
  if(lock&&saved) {
    publishThreadBinding(saved,{threadId,snapshotId:context.snapshotId})
    assertThreadScope(directory,saved,threadId,binding)
    // 不可变收据仅证明历史文件归属，不再把首次技能清单锁定到后续轮次。
    publishThreadBinding(receiptPath(directory,threadId,context.snapshotId),{threadId,snapshotId:context.snapshotId})
  }
  return context
}
function authorizeSnapshotViewer(directory,context,{access,principal}) {
  authorizeScope(access,principal,context.scope)
  const current=resolveSkillLibrary(directory,context.scope)
  if(JSON.stringify(skillIdentities(current))===JSON.stringify(skillIdentities(context.skills)))return
  // A project/assistant assignment grants only its current version. Older
  // snapshots belong to the conversations that pinned them, so require actual
  // visibility of one such locked conversation before exposing their files or
  // metadata from the process-wide provider cache.
  const threads=join(contextRoot(directory),'threads')
  if(existsSync(threads)&&!lstatSync(threads).isSymbolicLink())for(const entry of readdirSync(threads,{withFileTypes:true})) {
    if(!entry.isFile()||!/^[a-f0-9]{64}(?:-[a-f0-9]{64})?\.json$/.test(entry.name))continue
    try {
      const saved=readJson(join(threads,entry.name))
      if(saved.snapshotId!==context.snapshotId||typeof saved.threadId!=='string'||![digest(saved.threadId)+'.json',`${digest(saved.threadId)}-${context.snapshotId}.json`].includes(entry.name))continue
      const binding=access.requireThread(principal,saved.threadId)
      if(binding.scopeState==='locked'&&scopeEqual(binding,context.scope))return
    }catch{/* Missing, revoked or private conversations confer no access. */}
  }
  fail('此技能快照属于无权查看的历史对话，请使用当前对话的技能范围')
}
export function resolveBusinessSkillContext(directory,input,{access=configuredAutoOpsAccess(),principal}={}) {
  const scope=authorizeScope(access,principal,input)
  // 候选目录和下一轮执行共同使用当前分配，不受历史清单影响。
  const context=prepareScopedBusinessSkills(directory,scope,{lock:false})
  if(scope.threadId&&scope.scopeState!=='locked')authorizeSnapshotViewer(directory,context,{access,principal})
  return {cwd:context.cwd,snapshotId:context.snapshotId,skills:context.skills.map(({name,displayName,description,versionId,contentHash})=>({name,displayName,description,versionId,contentHash,enabled:true}))}
}
export function authorizeBusinessSkillCwd(directory,cwd,{access=configuredAutoOpsAccess(),principal}={}) {
  const match=typeof cwd==='string'&&/^autoops\/skill-context\/([a-f0-9]{64})$/.exec(cwd)
  if(!match)fail('技能目录只能使用当前项目与助手的授权范围')
  const context=readContext(directory,match[1])
  authorizeSnapshotViewer(directory,context,{access,principal})
  // A stale picker must not expose metadata for a newly revoked assignment.
  assertCurrent(directory,context,{strict:true})
  return context.physicalCwd
}
export function scopedBusinessSkillsForCwd(directory,cwd) {
  const root=contextRoot(directory),path=resolve(String(cwd||'')),id=relative(root,path)
  if(!idPattern.test(id))return []
  return assertCurrent(directory,readContext(directory,id)).skills
}
export function scopedBusinessSkillPolicy(directory,binding) {
  return policyForContext(prepareScopedBusinessSkills(directory,binding))
}
export function scopedBusinessSkillPolicyForCwd(directory,cwd) {
  const id=relative(contextRoot(directory),resolve(String(cwd||'')))
  if(!idPattern.test(id))fail('运行器缺少当前会话的技能范围')
  return policyForContext(assertCurrent(directory,readContext(directory,id),{strict:true}))
}
function policyForContext(context) {
  return {context,resources:context.skills.map(skill=>{
    const resourcesRoot=`autoops/skills/${context.snapshotId}/${skill.name}`
    return {name:skill.name,versionId:skill.versionId,instructionsPath:`${resourcesRoot}/SKILL.md`,resourcesRoot}
  }),config:{
    'skills.include_instructions':context.skills.length>0,
    'skills.config':context.skills.map(skill=>({path:skill.path,enabled:true})),
    'permissions.agent_demo.filesystem':{':root':'deny',...Object.fromEntries(context.skills.map(skill=>[skill.packageRoot,'read']))},
  }}
}
function authorizedSkillContext(directory,contextId,{access=configuredAutoOpsAccess(),principal,threadId}={}) {
  const context=readContext(directory,contextId)
  if(threadId) {
    const binding=principal?access.requireThread(principal,threadId):access.requireToolThread(threadId).binding
    const current=prepareScopedBusinessSkills(directory,binding,{lock:false})
    const ownerThreadId=binding.nativeParentThreadId||binding.threadId
    const historical=[lockPath(directory,ownerThreadId),receiptPath(directory,ownerThreadId,contextId)].some(path=>{
      if(!existsSync(path))return false
      const saved=readJson(path)
      return saved.threadId===ownerThreadId&&saved.snapshotId===contextId
    })
    if(!scopeEqual(binding,context.scope)||(current.snapshotId!==contextId&&!historical))fail()
    if(principal&&binding.scopeState!=='locked')authorizeSnapshotViewer(directory,context,{access,principal})
  } else authorizeSnapshotViewer(directory,context,{access,principal})
  return assertCurrent(directory,context)
}
export function readScopedSkillResource(directory,contextId,name,path,options={}) {
  const skill=authorizedSkillContext(directory,contextId,options).skills.find(entry=>entry.name===name)
  if(!skill)fail()
  const file=skill.files.find(file=>file.path===path)
  if(!file)fail('技能文件不存在')
  const bytes=readFileSync(safeFile(skill.packageRoot,path))
  if(bytes.length!==file.size||digest(bytes)!==file.sha256)fail('技能文件已改变','SKILL_PACKAGE_CHANGED')
  return {name:path.split('/').at(-1),path,mime:file.mime||'text/plain',bytes,versionId:skill.versionId,binary:file.binary===true,sourceUrl:`/api/agent-demo/t3/autoops/skill-library/contexts/${contextId}/files/${encodeURIComponent(name)}?path=${encodeURIComponent(path)}`}
}
export function readScopedSkillResourceForThread(directory,threadId,path,access=configuredAutoOpsAccess()) {
  const match=typeof path==='string'&&/^autoops\/skills\/([a-f0-9]{64})\/(autoops-[a-z][a-z0-9-]*)(?:\/(.+))?$/.exec(path)
  if(!match)fail()
  const relativePath=match[3]||''
  if(relativePath&&(relativePath.includes('\\')||relativePath.includes('\0')||relativePath.split('/').some(segment=>!segment||segment==='.'||segment==='..')))fail()
  const skill=authorizedSkillContext(directory,match[1],{access,threadId}).skills.find(entry=>entry.name===match[2])
  if(!skill)fail()
  if(!skill.files.some(file=>file.path===relativePath)) {
    const prefix=relativePath?relativePath+'/':'',entries=new Map()
    for(const file of skill.files)if(file.path.startsWith(prefix)) {
      const tail=file.path.slice(prefix.length),name=tail.split('/')[0],isDirectory=tail.includes('/')
      entries.set(name,{path:`${path}/${name}`,name,kind:isDirectory?'directory':'file',...(!isDirectory?{mime:file.mime,byteLength:file.size}:{})})
    }
    if(!entries.size)fail('技能目录不存在')
    return {path,kind:'directory',versionId:skill.versionId,source:'skill_package',entries:[...entries.values()].sort((a,b)=>a.name.localeCompare(b.name))}
  }
  const resource=readScopedSkillResource(directory,match[1],match[2],relativePath,{access,threadId})
  const metadata={path,name:resource.name,mime:resource.mime,byteLength:resource.bytes.length,versionId:resource.versionId,sourceUrl:resource.sourceUrl,source:'skill_package'}
  if(resource.binary)return {...metadata,encoding:'binary',content:null,message:'该资源为二进制文件，已提供授权预览和下载链接；当前工具没有读取或分析其正文。'}
  const limit=256*1024
  return {...metadata,encoding:'utf8',content:resource.bytes.subarray(0,limit).toString('utf8'),truncated:resource.bytes.length>limit}
}

/** Provider caches are process-wide. Project every emission for its viewer and
 * keep physical roots out of the browser; never authorize by cached metadata.
 * Customer catalogs are owner-filtered by RPC and retain their independent local skills. */
export function filterBusinessProviderResult(directory,value,{access=configuredAutoOpsAccess(),principal}={}) {
  if(!value||typeof value!=='object')return value
  const projectProvider=provider=>provider.instanceId?.startsWith('customer-')?provider:({...provider,skills:[],...(Array.isArray(provider.workspaceSnapshots)?{workspaceSnapshots:provider.workspaceSnapshots.flatMap(snapshot=>{
    try {
      const id=relative(contextRoot(directory),resolve(String(snapshot.cwd||'')))
      if(!idPattern.test(id))return []
      const context=readContext(directory,id)
      authorizeSnapshotViewer(directory,context,{access,principal})
      const current=assertCurrent(directory,context,{strict:true})
      return [{...snapshot,cwd:context.cwd,skills:(snapshot.skills||[]).filter(skill=>current.skills.some(entry=>entry.name===skill.name&&entry.path===skill.path)&&skill.enabled).map(skill=>({...skill,path:`/api/agent-demo/t3/autoops/skill-library/contexts/${id}/files/${encodeURIComponent(skill.name)}?path=SKILL.md`}))}]
    }catch{return []}
  })}:{})})
  // Native config uses either a direct providers field or one under payload.
  return {...value,...(Array.isArray(value.providers)?{providers:value.providers.map(projectProvider)}:{}),...(value.payload&&typeof value.payload==='object'?{payload:filterBusinessProviderResult(directory,value.payload,{access,principal})}:{}),...(value.config&&typeof value.config==='object'?{config:filterBusinessProviderResult(directory,value.config,{access,principal})}:{})}
}
