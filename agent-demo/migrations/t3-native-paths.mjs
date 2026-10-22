import {DatabaseSync} from 'node:sqlite'
import {createReadStream,existsSync,readdirSync,lstatSync,realpathSync} from 'node:fs'
import {readdir,lstat} from 'node:fs/promises'
import {join,relative,resolve,isAbsolute,sep} from 'node:path'
import {createInterface} from 'node:readline'
async function rolloutIndex(home){
 const byId=new Map()
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isSymbolicLink())throw Error('原生rollout不允许符号链接');if(e.isDirectory())await walk(p);else if(e.isFile()&&e.name.endsWith('.jsonl')){const input=createInterface({input:createReadStream(p),crlfDelay:Infinity});let id;try{for await(const line of input){if(!line.trim())continue;const row=JSON.parse(line);if(row.type==='session_meta')id=row.payload?.id;break}}finally{input.close()};if(typeof id!=='string'||!id)throw Error('原生rollout缺少真实session_meta.id');if(byId.has(id))throw Error('原生ID对应多个rollout，拒绝路径重映射');byId.set(id,relative(home,p))}}}
 for(const dir of ['sessions','archived_sessions']){const p=join(home,dir);try{await lstat(p)}catch(e){if(e.code==='ENOENT')continue;throw e}await walk(p)}
 return byId
}
/** Offline-only: repair only cloned native indexes, never source rollouts or their bytes. */
export async function rebaseNativeRolloutPaths({homeDirectory,finalHomeDirectory=homeDirectory,quiesced=false}){
 if(!quiesced)throw Error('原生路径重映射要求全部写入者已停止')
 const home=resolve(homeDirectory),finalHome=resolve(finalHomeDirectory),byId=await rolloutIndex(home),plans=[]
 for(const e of await readdir(home,{withFileTypes:true})){
  if(!/^state_\d+\.sqlite$/.test(e.name))continue
  if(!e.isFile())throw Error('原生状态索引必须是普通文件')
  const db=new DatabaseSync(join(home,e.name),{readOnly:true})
  try{
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").get())continue
   if(!db.prepare('PRAGMA table_info(threads)').all().some(row=>row.name==='rollout_path'))throw Error('不支持的原生threads路径schema')
   const changes=[]
   for(const row of db.prepare('SELECT id,rollout_path FROM threads').all()){
    if(row.rollout_path===null)continue
    const rel=byId.get(row.id)
    if(!rel)throw Error('原生索引引用未保全的rollout：'+row.id)
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Error('原生rollout越出恢复目录')
    const target=join(finalHome,rel)
    if(row.rollout_path!==target)changes.push({id:row.id,path:target})
   }
   const skipped=[]
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rollout_migration_skipped_rollouts'").get()){
    for(const row of db.prepare('SELECT rollout_path FROM rollout_migration_skipped_rollouts').all()){
     const matches=[...byId.values()].filter(rel=>row.rollout_path.endsWith('/'+rel.split(sep).join('/')) || row.rollout_path===join(finalHome,rel))
     if(matches.length!==1)throw Error('原生迁移索引引用未保全或含糊的rollout')
     const path=join(finalHome,matches[0]);if(path!==row.rollout_path)skipped.push({old:row.rollout_path,path})
    }
   }
   plans.push({database:e.name,changes,skipped})
  }finally{db.close()}
 }
 // Validate every database and identity before updating any clone. The importer
 // owns an unpublished staging directory; callers repairing a clone must retain
 // its paired recovery snapshot before invoking this operation.
 for(const plan of plans){if(!plan.changes.length&&!plan.skipped.length)continue;const db=new DatabaseSync(join(home,plan.database));try{db.exec('BEGIN IMMEDIATE');const update=db.prepare('UPDATE threads SET rollout_path=? WHERE id=?');for(const row of plan.changes)update.run(row.path,row.id);if(plan.skipped.length){const skipped=db.prepare('UPDATE rollout_migration_skipped_rollouts SET rollout_path=? WHERE rollout_path=?');for(const row of plan.skipped)skipped.run(row.path,row.old)}db.exec('COMMIT');db.exec('PRAGMA wal_checkpoint(TRUNCATE)')}catch(e){try{db.exec('ROLLBACK')}catch{}throw e}finally{db.close()}}
 return {format:'autoops-native-rollout-rebase-v1',databases:plans.map(p=>({database:p.database,changed:p.changes.length,skippedChanged:p.skipped.length,threadIds:p.changes.map(c=>c.id)})),rollouts:byId.size,finalHomeDirectory:finalHome,sourceRolloutBytesChanged:false}
}

/** Fail closed before any provider starts; paths must refer to retained home data. */
export function assertNativeRolloutPaths(homeDirectory){
 const home=resolve(homeDirectory)
 if(!existsSync(home))return {checked:0}
 const homeStat=lstatSync(home)
 if(!homeStat.isDirectory()||homeStat.isSymbolicLink())throw Error('原生HOME必须是非符号链接目录')
 const canonicalHome=realpathSync(home);let checked=0
 const check=(path)=>{
  if(typeof path!=='string'||!isAbsolute(path))throw Error('原生rollout路径必须为绝对路径')
  const rel=relative(home,path),parts=rel.split(sep)
  if(!['sessions','archived_sessions'].includes(parts[0])||parts.some(p=>p==='..'||p==='')||isAbsolute(rel))throw Error('原生rollout路径越出当前HOME，拒绝启动')
  let part=home
  for(const segment of parts){part=join(part,segment);if(!existsSync(part))throw Error('原生rollout路径不存在，拒绝启动');if(lstatSync(part).isSymbolicLink())throw Error('原生rollout路径不允许符号链接')}
  if(!lstatSync(path).isFile()||!realpathSync(path).startsWith(canonicalHome+sep))throw Error('原生rollout文件越出当前HOME')
  checked++
 }
 for(const entry of readdirSync(home,{withFileTypes:true})){
  if(!/^state_\d+\.sqlite$/.test(entry.name))continue
  if(!entry.isFile()||entry.isSymbolicLink())throw Error('原生状态索引必须是普通文件')
  const db=new DatabaseSync(join(home,entry.name),{readOnly:true})
  try{for(const table of ['threads','rollout_migration_skipped_rollouts']){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue
   if(!db.prepare(`PRAGMA table_info(${table})`).all().some(row=>row.name==='rollout_path'))throw Error('不支持的原生rollout路径schema')
   for(const row of db.prepare(`SELECT rollout_path FROM ${table}`).all())if(row.rollout_path!==null)check(row.rollout_path)
  }}finally{db.close()}
 }
 return {checked}
}
