import {DatabaseSync} from 'node:sqlite'
import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {cp,lstat,mkdir,mkdtemp,readdir,readFile,writeFile,chmod,rename,rm} from 'node:fs/promises'
import {dirname,join,relative,resolve,isAbsolute,sep} from 'node:path'
import {createInterface} from 'node:readline'
import {tmpdir} from 'node:os'
const FORMAT='autoops-t3-paired-recovery-v1'
const hash=async path=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex')}
const inside=(parent,child)=>{const p=relative(parent,child);return p===''||(!p.startsWith('..'+sep)&&p!=='..'&&!isAbsolute(p))}
async function inventory(root,directory=root){const result=[];for(const item of await readdir(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())result.push(...await inventory(root,path));else if(item.isFile())result.push({path:relative(root,path).split(sep).join('/'),bytes:(await lstat(path)).size,sha256:await hash(path)});else throw Error('保全目录包含符号链接或特殊文件，拒绝隐式跟随/丢弃：'+relative(root,path))}return result.sort((a,b)=>a.path.localeCompare(b.path))}
async function fresh(path){try{await lstat(path);throw Error('目标已存在，拒绝覆盖：'+path)}catch(error){if(error.code!=='ENOENT')throw error}}
async function secure(root,readonly=false){for(const item of await readdir(root,{withFileTypes:true})){const path=join(root,item.name);if(item.isDirectory())await secure(path,readonly);else if(item.isFile())await chmod(path,readonly?0o400:0o600);else throw Error('保全副本出现特殊文件')}await chmod(root,readonly?0o500:0o700)}
async function canonicalSummary(data){const path=join(data,'t3/userdata/statev2.sqlite');const db=new DatabaseSync(path,{readOnly:true});try{if(Object.values(db.prepare('PRAGMA quick_check').get())[0]!=='ok')throw Error('canonical SQLite integrity failed');const tables={};for(const name of ['orchestration_events','orchestration_v2_projection_threads','orchestration_v2_projection_messages','orchestration_v2_projection_runs','orchestration_v2_projection_provider_turns'])tables[name]=Number(db.prepare(`SELECT count(*) AS count FROM ${name}`).get().count);return {eventWatermark:Number(db.prepare("SELECT coalesce(max(sequence),0) AS value FROM orchestration_events WHERE aggregate_kind = 'project' OR (application_event_version = 2 AND aggregate_kind = 'thread')").get().value),tables}}finally{db.close()}}
async function nativeHeads(root,files){const heads=[];for(const file of files.filter(file=>/\/(sessions|archived_sessions)\/.*\.jsonl$/.test('/'+file.path))){const stream=createReadStream(join(root,file.path)),lines=createInterface({input:stream,crlfDelay:Infinity});let sessionId=null,lineCount=0,lastTimestamp=null,lastType=null;try{for await(const line of lines){if(!line.trim())continue;lineCount++;let item;try{item=JSON.parse(line)}catch{throw Error('原生rollout含非JSON记录：'+file.path)}if(item.type==='session_meta')sessionId=item.payload?.id??sessionId;lastTimestamp=item.timestamp??lastTimestamp;lastType=item.type??null}}finally{lines.close();stream.destroy()}if(!sessionId)throw Error('原生rollout没有真实session_meta.id：'+file.path);heads.push({path:file.path,sessionId,lineCount,lastTimestamp,lastType,sha256:file.sha256,bytes:file.bytes})}return heads}

async function verifyNativeCoverage(source,native){
 const home=join(source,'t3/codex-home');let entries;try{entries=await readdir(home,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return;throw e}
 for(const entry of entries){if(!/^state_\d+\.sqlite$/.test(entry.name))continue;if(!entry.isFile())throw Error('原生索引必须是普通文件');const db=new DatabaseSync(join(home,entry.name),{readOnly:true});try{for(const table of ['threads','rollout_migration_skipped_rollouts']){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;for(const row of db.prepare(`SELECT rollout_path FROM ${table}`).all()){if(row.rollout_path===null)continue;const path=resolve(row.rollout_path);if(!isAbsolute(row.rollout_path)||(!inside(source,path)&&!inside(native,path)))throw Error('原生索引引用未纳入配对快照的外部rollout，请先保全实际原生目录');const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink())throw Error('原生索引引用无效rollout')}}}finally{db.close()}}
}

/** Stopped writers are required across both application DB and native home. */
export async function createT3RecoveryBundle({dataDirectory,destination,nativeDirectory,quiesced=false}){
 if(!quiesced)throw Error('必须先停止全部应用/原生写入者，再声明quiesced')
 const source=resolve(dataDirectory),target=resolve(destination),native=resolve(nativeDirectory||join(source,'t3/codex-home'))
 if(inside(source,target)||inside(target,source)||inside(native,target)||inside(target,native))throw Error('源数据/原生目录与保全目录不能互相包含')
 await fresh(target);await lstat(join(source,'t3/userdata/statev2.sqlite'));await lstat(native)
 await verifyNativeCoverage(source,native)
 const before=await inventory(source),nativeOutside=!inside(source,native),nativeBefore=nativeOutside?await inventory(native):null
 const stage=target+'.partial-'+randomUUID();await mkdir(dirname(target),{recursive:true,mode:0o700});await mkdir(stage,{mode:0o700})
 try{
  await cp(source,join(stage,'data'),{recursive:true,dereference:false,errorOnExist:true,force:false})
  if(nativeOutside)await cp(native,join(stage,'native'),{recursive:true,dereference:false,errorOnExist:true,force:false})
  if(JSON.stringify(before)!==JSON.stringify(await inventory(source))||(nativeOutside&&JSON.stringify(nativeBefore)!==JSON.stringify(await inventory(native))))throw Error('快照期间源文件发生变化，停写边界不成立')
  const canonical=await canonicalSummary(join(stage,'data'))
  await secure(stage)
  const files=await inventory(stage),heads=await nativeHeads(stage,files)
  const manifest={format:FORMAT,createdAt:new Date().toISOString(),quiesced:true,canonical,nativeRelativePath:nativeOutside?'native':'data/'+relative(source,native).split(sep).join('/'),nativeHeads:heads,files,policy:{losslessReverseAvailable:false,restoreMode:'offline-readonly-new-directory',oldSqliteMayOverwriteNewData:false,automaticResumeAllowed:false}}
  await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(stage,target);return manifest
 }catch(error){await rm(stage,{recursive:true,force:true});throw error}
}
export async function verifyT3RecoveryBundle(directory){
 const root=resolve(directory),stat=await lstat(join(root,'manifest.json'));if(!stat.isFile()||stat.isSymbolicLink())throw Error('保全清单必须是普通文件')
 const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));if(manifest.format!==FORMAT||manifest.quiesced!==true||!Array.isArray(manifest.files))throw Error('保全清单格式或停写声明无效')
 const actual=await inventory(root),expected=new Map();for(const file of manifest.files){const path=resolve(root,file.path);if(!inside(root,path)||path===root||expected.has(file.path))throw Error('保全文件路径无效');expected.set(file.path,file)}
 if(actual.length!==expected.size+1)throw Error('保全文件清单数量不一致')
 for(const file of actual){if(file.path==='manifest.json')continue;const entry=expected.get(file.path);if(!entry||entry.sha256!==file.sha256||entry.bytes!==file.bytes)throw Error('保全文件校验失败：'+file.path)}
 return manifest
}
export async function restoreT3ReadOnlyBundle({snapshot,destination}){
 const manifest=await verifyT3RecoveryBundle(snapshot),source=resolve(snapshot),target=resolve(destination)
 if(inside(source,target)||inside(target,source))throw Error('只读恢复目标不能与恢复包互相包含')
 await fresh(target);const stage=target+'.partial-'+randomUUID();await mkdir(dirname(target),{recursive:true,mode:0o700})
 try{await cp(source,stage,{recursive:true,dereference:false,errorOnExist:true,force:false});await verifyT3RecoveryBundle(stage);await secure(stage,true);await chmod(stage,0o700);await rename(stage,target);await chmod(target,0o500);return {destination:target,mode:'offline-readonly',eventWatermark:manifest.canonical.eventWatermark,nativeHeads:manifest.nativeHeads.map(({sessionId,sha256})=>({sessionId,sha256})),losslessReverseAvailable:false,executionStarted:false}}
 catch(error){try{await secure(stage,false)}catch{}await rm(stage,{recursive:true,force:true});throw error}
}
export async function compareT3RecoveryBundles(baseline,current){
 const before=await verifyT3RecoveryBundle(baseline),after=await verifyT3RecoveryBundle(current),old=new Map(before.files.map(file=>[file.path,file])),next=new Map(after.files.map(file=>[file.path,file]))
 const added=after.files.filter(file=>!old.has(file.path)).map(file=>file.path),changed=after.files.filter(file=>old.has(file.path)&&old.get(file.path).sha256!==file.sha256).map(file=>file.path),removed=before.files.filter(file=>!next.has(file.path)).map(file=>file.path)
 return {format:'autoops-t3-recovery-diff-v1',baselineWatermark:before.canonical.eventWatermark,currentWatermark:after.canonical.eventWatermark,added,changed,removed,nativeHeadsChanged:after.nativeHeads.filter(head=>before.nativeHeads.find(old=>old.path===head.path)?.sha256!==head.sha256).map(({sessionId,sha256})=>({sessionId,sha256})),directLegacyRollbackAllowed:false,decision:'preserve-new-readonly',losslessReverseAvailable:false}
}

/** Recompute the summary on a scratch copy; never mutate a retained SQLite/WAL pair. */
export async function inspectT3RecoveryBundle(directory) {
 const manifest=await verifyT3RecoveryBundle(directory), scratch=await mkdtemp(join(tmpdir(),'t3-recovery-inspect-'))
 try { await cp(join(resolve(directory),'data/t3/userdata'),join(scratch,'t3/userdata'),{recursive:true}); const canonical=await canonicalSummary(scratch)
  return {verified:true,files:manifest.files.length,canonical,recordedCanonical:manifest.canonical,summaryCorrection:JSON.stringify(canonical)!==JSON.stringify(manifest.canonical),nativeHeads:manifest.nativeHeads,policy:manifest.policy}
 } finally {await rm(scratch,{recursive:true,force:true})}
}
