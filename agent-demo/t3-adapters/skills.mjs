import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { BUILTIN_BUSINESS_SKILLS } from './builtin-skills.mjs'
import { AutoOpsAccessError } from './access.mjs'
import { prepareScopedBusinessSkills, scopedBusinessSkillsForCwd } from './scoped-skills.mjs'

export const BUSINESS_SKILL_TOOLS = Object.freeze(['list_project_materials','read_project_document','read_project_material','read_attachment','query_environment','read_environment','ask_user','create_report'])
const allowedTools = new Set(BUSINESS_SKILL_TOOLS)
export function readBusinessSkillRegistry(dataDirectory) {
  const library = join(dataDirectory,'t3','skills-library.json')
  const path = existsSync(library) ? library : join(dataDirectory,'t3','skills-registry.json')
  let value = {version:1,skills:BUILTIN_BUSINESS_SKILLS.map(skill=>({...skill}))}
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('管理员技能目录必须是普通 JSON 文件且不超过 1 MiB')
    value = JSON.parse(readFileSync(path,'utf8'))
  }
  if (value.version !== 1 || !Array.isArray(value.skills) || value.skills.length > 32) throw new Error('管理员技能目录版本或数量无效')
  const names = new Set()
  const skills=value.skills.map(skill => {
    if (Object.keys(skill).some(key => !['name','displayName','description','instructions','tools','enabled','builtin'].includes(key)) || !/^[a-z][a-z0-9-]{0,56}$/.test(skill.name) || names.has(skill.name)) throw new Error('技能名称或字段无效')
    names.add(skill.name)
    if (typeof skill.description !== 'string' || !skill.description.trim() || skill.description.length > 500 || typeof skill.instructions !== 'string' || !skill.instructions.trim() || Buffer.byteLength(skill.instructions) > 32768) throw new Error('技能正文或说明无效')
    if (!Array.isArray(skill.tools) || skill.tools.length === 0 || skill.tools.some(tool => !allowedTools.has(tool))) throw new Error('技能只能引用已授权的资料、提问和会话报告工具')
    if (skill.displayName !== undefined && (typeof skill.displayName !== 'string' || !skill.displayName.trim() || skill.displayName.length>80)) throw new Error('技能显示名称无效')
    if (skill.enabled !== undefined && typeof skill.enabled !== 'boolean') throw new Error('技能启用状态无效')
    return {...skill,enabled:skill.enabled!==false}
  })
  return {version:1,skills}
}
export const businessSkillsRevision = registry => createHash('sha256').update(JSON.stringify(registry)).digest('hex')
export const readBusinessSkills = dataDirectory => readBusinessSkillRegistry(dataDirectory).skills.filter(skill=>skill.enabled).map(skill=>({...skill,name:`autoops-${skill.name}`}))
export const businessSkillContents = skill => `---\nname: ${skill.name.startsWith('autoops-')?skill.name:`autoops-${skill.name}`}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n# 适用范围\n仅使用当前会话已经授予的业务工具：${skill.tools.join('、')}。不安装插件、不运行脚本、不读取宿主文件；此技能不会扩大任何权限。\n\n${skill.instructions}\n`

export function manageBusinessSkills(dataDirectory,codexHome,access,principal,input) {
  const current=access.refresh(principal)
  if(current.role!=='admin')throw new AutoOpsAccessError(403,'SKILL_MANAGEMENT_FORBIDDEN','只有管理员可以管理工作台共享技能')
  const registry=readBusinessSkillRegistry(dataDirectory)
  if(input.revision!==businessSkillsRevision(registry))throw new AutoOpsAccessError(409,'SKILL_REVISION_CONFLICT','技能目录已更新，请刷新后重试')
  let next
  if(input.action==='import') {
    const skill=input.skill
    if(!skill||registry.skills.some(entry=>entry.name===skill.name)||registry.skills.length>=32)throw new AutoOpsAccessError(409,'SKILL_ALREADY_EXISTS','技能名称重复或目录已满，请使用不同的 name')
    next={version:1,skills:[...registry.skills,{...skill,enabled:true,builtin:false}]}
  } else if(input.action==='toggle') {
    const name=String(input.name||'').replace(/^autoops-/,'')
    if(typeof input.enabled!=='boolean'||!registry.skills.some(skill=>skill.name===name))throw new AutoOpsAccessError(400,'INVALID_SKILL','技能或启用状态无效')
    next={version:1,skills:registry.skills.map(skill=>skill.name===name?{...skill,enabled:input.enabled}:skill)}
  } else throw new AutoOpsAccessError(400,'INVALID_SKILL_ACTION','技能操作无效')
  // Keep the legacy registry intact so an older release can still start after
  // a code rollback; the new library and its user changes remain recoverable.
  const root=join(dataDirectory,'t3'),path=join(root,'skills-library.json')
  mkdirSync(root,{recursive:true,mode:0o700})
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('技能目录不能是符号链接')
  const previous=existsSync(path)?readFileSync(path):null
  const temporary=path+`.tmp-${process.pid}`
  try {
    writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'})
    renameSync(temporary,path)
    readBusinessSkillRegistry(dataDirectory)
    prepareBusinessSkills(dataDirectory,codexHome)
  } catch(error) {
    if(existsSync(temporary))rmSync(temporary)
    if(previous===null)rmSync(path,{force:true});else writeFileSync(path,previous,{mode:0o600})
    prepareBusinessSkills(dataDirectory,codexHome)
    throw error
  }
  return readBusinessSkillRegistry(dataDirectory)
}

export function resolveBusinessSkillMentions(text,env=process.env,binding) {
  if(!env.AUTOOPS_T3_DATA_DIR)return []
  const names=[...new Set([...String(text||'').matchAll(/(?:^|\s)\p{Sc}(autoops-[a-z][a-z0-9-]*)(?![a-z0-9-])/gu)].map(match=>match[1]))]
  if(!binding) {if(names.length)throw new AutoOpsAccessError(403,'SKILL_SCOPE_REQUIRED','请先选择项目、助手与工作区后使用技能');return []}
  const context=prepareScopedBusinessSkills(env.AUTOOPS_T3_DATA_DIR,binding,{lock:false})
  return names.map(name=>{
    const skill=context.skills.find(skill=>skill.name===name)
    if(!skill)throw new AutoOpsAccessError(409,'SKILL_NOT_AVAILABLE','所选技能已停用或不属于当前助手、项目和工作区，请重新选择')
    return {type:'skill',name,path:skill.path}
  })
}

/** Retire the old globally-readable namespace. Scoped copies are created only
 * after a scope is authorized; legacy library data itself remains untouched. */
export function prepareBusinessSkills(_dataDirectory, codexHome) {
  const root=join(codexHome,'skills')
  mkdirSync(root,{recursive:true,mode:0o700})
  if(lstatSync(root).isSymbolicLink())throw new Error('原生技能目录不能是符号链接')
  for(const item of readdirSync(root,{withFileTypes:true}))if(item.name.startsWith('autoops-'))rmSync(join(root,item.name),{recursive:true,force:true})
  return []
}

/** Metadata remains an intersection with the actual upstream skills/list. */
export function filterBusinessSkills(nativeSkills, env=process.env,cwd) {
  if(!env.AUTOOPS_T3_DATA_DIR)return nativeSkills
  const registered=scopedBusinessSkillsForCwd(env.AUTOOPS_T3_DATA_DIR,cwd)
  const canonical=path=>existsSync(path)?realpathSync(path):resolve(path)
  return nativeSkills.filter(skill=>registered.some(entry=>entry.name===skill.name&&canonical(entry.path)===canonical(skill.path))&&skill.enabled).map(skill=>{
    const metadata=registered.find(entry=>entry.name===skill.name)
    return metadata?.displayName?{...skill,displayName:metadata.displayName}:skill
  })
}
export const businessSlashCommands = (commands, env=process.env) => env.AUTOOPS_T3_DATA_DIR ? commands.filter(command=>command.name==='compact') : commands

/** Codex 0.159.2 searches these native host roots in addition to CODEX_HOME.
 * Disable their actual documents, rather than only hiding metadata in the UI.
 * Business workspace files are admin-owned; model tools cannot write new skills.
 */
export function businessSkillRules(dataDirectory, codexHome, options={}) {
  // Scoped cwd roots are never scanned or globally enabled here.
  const roots=new Set([join(codexHome,'skills'),join(options.userHome||homedir(),'.agents','skills'),'/etc/codex/skills'])
  const workspaceRoot=join(dataDirectory,'t3','workspaces')
  const workspaces=existsSync(workspaceRoot)?readdirSync(workspaceRoot,{withFileTypes:true}).filter(item=>item.isDirectory()).map(item=>join(workspaceRoot,item.name)):[]
  for(const start of [process.cwd(),workspaceRoot,join(dataDirectory,'t3','skill-contexts'),...workspaces]) {
    let directory=resolve(start)
    while(true){ roots.add(join(directory,'.agents','skills'));roots.add(join(directory,'.codex','skills'));const parent=dirname(directory);if(parent===directory)break;directory=parent }
  }
  for(const root of options.extraRoots||[])roots.add(root)
  const found=new Set(),seen=new Set()
  const visit=(path,depth=0)=>{
    if(!existsSync(path))return
    if(depth>32||seen.size>8192)throw new Error('原生技能目录超出安全扫描范围')
    const canonical=realpathSync(path)
    if(seen.has(canonical))return
    seen.add(canonical)
    const stat=lstatSync(canonical)
    if(stat.isFile()) {if(path.endsWith('/SKILL.md'))found.add(canonical);return}
    if(stat.isDirectory())for(const item of readdirSync(canonical))visit(join(canonical,item),depth+1)
  }
  for(const root of roots)visit(root)
  return Array.from(found,path=>({path,enabled:false}))
}
