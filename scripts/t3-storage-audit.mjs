import {DatabaseSync} from 'node:sqlite'
import {lstat,readdir,readFile,writeFile} from 'node:fs/promises'
import {join,relative,resolve} from 'node:path'

// Aggregate metadata only: no message, credential or attachment content is emitted.
// This never deletes canonical events, native rollout files or referenced assets.
const [dataArg,baselineArg,outputArg]=process.argv.slice(2)
if(!dataArg)throw new Error('用法：node scripts/t3-storage-audit.mjs <DATA_DIR> [上次报告.json|-] [输出.json]')
const root=resolve(dataArg),categories={},databases=[]
function category(path){return path.startsWith('t3/codex-home/sessions/')||path.startsWith('t3/codex-home/archived_sessions/')?'nativeHistory':path.startsWith('t3/codex-home/')?'nativeState':path.startsWith('t3/userdata/logs/')?'boundedDiagnosticLogs':path.startsWith('t3/userdata/attachments/')?'attachments':path.startsWith('t3/caches/')?'caches':path.endsWith('.sqlite')||/-wal$|-shm$/.test(path)?'applicationDatabase':'other'}
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  const path=join(dir,entry.name),name=relative(root,path).split('\\').join('/')
  if(entry.isSymbolicLink())continue
  if(entry.isDirectory()){await walk(path);continue}
  if(!entry.isFile())continue
  const size=(await lstat(path)).size,key=category(name);categories[key]=(categories[key]||0)+size
  if(name.endsWith('.sqlite')&&!name.startsWith('t3/codex-home/')&&!name.endsWith('/server-owner.sqlite'))databases.push({path,name,bytes:size})
}}
await walk(root)
const tables=[],unavailableDatabases=[]
const interesting=/^(orchestration_(events|command_receipts)|orchestration_v2_(events|command_receipts|effect_outbox|projection_(threads|runs|provider_turns|messages|turn_items))|business_artifacts|t3_legacy_(import_records|id_map)|thread_bindings|attachments)$/
for(const {path,name} of databases){const db=new DatabaseSync(path,{readOnly:true});try{
  db.exec('PRAGMA busy_timeout=3000')
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name).filter(x=>interesting.test(x))
  for(const table of names){const quoted='"'+table.replaceAll('"','""')+'"',columns=db.prepare(`PRAGMA table_info(${quoted})`).all().map(x=>x.name)
    const payload=columns.includes('payload_json')?'payload_json':columns.includes('data')?'data':undefined
    const row=db.prepare(`SELECT COUNT(*) AS rows${payload?`,COALESCE(SUM(length(${payload})),0) AS payloadBytes`:''} FROM ${quoted}`).get()
    tables.push({database:name,table,...row})
  }
}catch(error){unavailableDatabases.push({database:name,code:error.code||'AUDIT_UNAVAILABLE'})}finally{db.close()}}
const report={format:'autoops-t3-storage-audit-v1',at:new Date().toISOString(),categories,totalBytes:Object.values(categories).reduce((a,b)=>a+b,0),tables,unavailableDatabases,policy:{canonicalHistory:'Never prune events, command receipts or native history by age alone. Retain dependency boundaries and explicit user history.',diagnosticLogs:'Upstream provider event logs: 512 MiB total / 14 days; server traces use upstream rotating sink. Not the canonical event database.',pendingUploads:'Upstream signed upload expiry and stale pending sweep; claimed files are not pending uploads.',backups:'Keep two rolling recovery packages plus pinned migration recovery point until acceptance and rollback window end.',warningBytes:2*1024**3}}
if(baselineArg&&baselineArg!=='-'){
  const before=JSON.parse(await readFile(baselineArg,'utf8'));if(before.format!==report.format)throw new Error('存储基线格式不符')
  report.growth={since:before.at,bytes:report.totalBytes-before.totalBytes,categories:Object.fromEntries(Object.keys(categories).map(key=>[key,categories[key]-(before.categories[key]||0)]))}
}
report.warning=report.totalBytes>report.policy.warningBytes
const serialized=JSON.stringify(report,null,2)+'\n'
if(outputArg)await writeFile(outputArg,serialized,{mode:0o600})
console.log(serialized)
