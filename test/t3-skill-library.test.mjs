import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { createSkillLibrary, resolveSkillLibrary, readSkillLibraryVersion, readSkillLibrary } from '../agent-demo/t3-adapters/skill-library.mjs'
import { handleSkillLibraryRequest } from '../agent-demo/t3-adapters/skill-library-http.mjs'

function fixture(t, legacy) {
  const data = mkdtempSync(join(tmpdir(), 'autoops-skill-library-'))
  if (legacy !== undefined) { mkdirSync(join(data, 't3')); writeFileSync(join(data, 't3/skills-library.json'), JSON.stringify({version:1,skills:legacy})) }
  t.after(() => rmSync(data, {recursive:true,force:true}))
  const library = createSkillLibrary(data)
  const request = (method, input, path='/autoops/skill-library', principal={role:'admin'}) => handleSkillLibraryRequest({ access, principal, dataDirectory:data, method, input, url:new URL(path,'http://localhost') })
  const projects = [{id:'p-a',name:'甲项目',membership:{workspaceAccess:'internal'}},{id:'p-b',name:'乙项目',membership:{workspaceAccess:'external'}}]
  const agents = [{id:'a-project',name:'项目助手',projectIds:['p-a','p-b']},{id:'a-report',name:'报告助手',projectIds:['p-a']}]
  const access = {
    refresh: principal => principal,
    bootstrap: principal => ({projects:principal.role==='external'?[projects[1]]:projects,agents}),
    requireMembership: (principal,id) => { const project=projects.find(p=>p.id===id);if(!project || principal.role==='external'&&id!=='p-b')throw Object.assign(new Error('no'),{status:404});return project.membership },
    requireProject: (principal,id) => access.requireMembership(principal,id),
    requireWorkspaceManager: (principal,id) => { if(principal.role!=='admin'||!projects.some(p=>p.id===id))throw Object.assign(new Error('no'),{status:403}) },
  }
  return {data,library,request,scope:{projectId:'p-a',agentId:'a-project',workspaceType:'internal'}}
}
const markdown = (name, body='阅读资料并列出真实来源。') => `---\nname: ${name}\ndescription: >-\n  一个完整的\n  技能说明\n---\n\n${body}\n`
function add(library, name='review', body) { const c=library.importMarkdown({revision:library.catalog().revision,contents:markdown(name,body)});return c.skills.find(s=>s.name===name) }
function assign(library, skill, extra={}) { return library.assign({revision:library.catalog().revision,skillId:skill.id,versionId:skill.latestVersionId,targetType:'agent',targetId:'a-project',workspaceTypes:['internal'],...extra}) }
function archive(library, entries, extra={}) { return library.importArchive({revision:library.catalog().revision,archiveBase64:Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([path,value])=>[path,Buffer.from(value)])))).toString('base64'),fileName:'skill.zip',...extra}) }

test('迁移内置与已有 JSON，保留停用状态、原文及旧文件，显式空库不重置',t=>{
  const normal=fixture(t)
  assert.equal(normal.library.catalog().skills.length,3)
  assert.equal(resolveSkillLibrary(normal.data,normal.scope).length,3)
  assert.equal(resolveSkillLibrary(normal.data,{...normal.scope,workspaceType:'external'}).length,3)
  const original=[{name:'custom',displayName:'自定义',description:'原有说明',instructions:'不丢失正文',tools:['read_project_document'],enabled:false}]
  const f=fixture(t,original),state=f.library.catalog(),skill=state.skills[0]
  assert.equal(skill.enabled,false);assert.equal(state.assignments.length,2)
  assert.match(readSkillLibraryVersion(f.data,skill.id,skill.latestVersionId).instructions,/不丢失正文/)
  assert.deepEqual(JSON.parse(readFileSync(join(f.data,'t3/skills-library.json'),'utf8')).skills,original)
  assert.equal(fixture(t,[]).library.catalog().skills.length,0)
})

test('导入整个 ZIP 普通文件树、复用包根识别、排除缓存，保留源字节并校验哈希',t=>{
  const {library,data}=fixture(t,[]),contents=markdown('bundle')
  const c=archive(library,{'bundle/SKILL.md':contents,'bundle/references/详情.md':'多层中文资料','bundle/assets/icon.png':'PNG','bundle/.git/config':'private','bundle/__pycache__/x.pyc':'cache'})
  const skill=c.skills[0],version=skill.versions[0]
  assert.deepEqual(version.files.map(f=>f.path),['SKILL.md','assets/icon.png','references/详情.md'])
  assert.equal(version.readiness,'ready');assert.equal(version.fileCount,3)
  assert.equal(library.readFile(skill.id,version.id,'SKILL.md').contents,contents)
  assert.equal(library.readFile(skill.id,version.id,'references/详情.md',true).bytes.toString(),'多层中文资料')
  assert.equal(readSkillLibraryVersion(data,skill.id,version.id).name,'autoops-bundle')
})

test('脚本与依赖完整保存但明确受限，不能伪装可调用，检查不会自动执行',t=>{
  const f=fixture(t,[]),c=archive(f.library,{'SKILL.md':markdown('scripted'),'scripts/run.py':'raise Exception("never run")','requirements.txt':'nonexistent-package'}),skill=c.skills[0]
  assert.throws(()=>assign(f.library,skill),e=>e.code==='SKILL_NOT_READY')
  assert.equal(skill.versions[0].readiness,'restricted')
  assert.match(skill.versions[0].reason,/脚本、依赖/)
  assert.deepEqual(resolveSkillLibrary(f.data,f.scope),[])
  f.library.verify({revision:f.library.catalog().revision,skillId:skill.id,versionId:skill.latestVersionId})
  assert.equal(f.library.catalog().skills[0].versions[0].readiness,'restricted')
})

test('助手与项目分配取并集，同技能项目优先且显式停用阻断助手回退',t=>{
  const f=fixture(t,[]),skill=add(f.library)
  assign(f.library,skill)
  assert.equal(resolveSkillLibrary(f.data,f.scope).length,1)
  assert.equal(resolveSkillLibrary(f.data,{...f.scope,agentId:'a-report'}).length,0)
  assert.equal(resolveSkillLibrary(f.data,{...f.scope,workspaceType:'external'}).length,0)
  assign(f.library,skill,{targetType:'project',targetId:'p-a',enabled:false})
  assert.equal(resolveSkillLibrary(f.data,f.scope).length,0)
  assign(f.library,skill,{targetType:'project',targetId:'p-a',workspaceTypes:['internal','external']})
  assert.equal(resolveSkillLibrary(f.data,{...f.scope,agentId:'a-report',workspaceType:'external'}).length,1)
  const override=f.library.catalog().assignments.find(a=>a.targetType==='project')
  f.library.unassign({revision:f.library.catalog().revision,assignmentId:override.id})
  assert.equal(resolveSkillLibrary(f.data,f.scope).length,1)
})

test('更新生成不可变版本，分配固定旧版本，更新分配后切换且历史可读',t=>{
  const f=fixture(t,[]),skill=add(f.library,'versioned','第一版'),old=skill.latestVersionId
  assign(f.library,skill)
  const updated=f.library.importMarkdown({revision:f.library.catalog().revision,skillId:skill.id,contents:markdown('versioned','第二版')}).skills[0]
  assert.equal(updated.versions.length,2);assert.notEqual(updated.latestVersionId,old)
  assert.equal(resolveSkillLibrary(f.data,f.scope)[0].versionId,old)
  assign(f.library,updated)
  assert.equal(resolveSkillLibrary(f.data,f.scope)[0].versionId,updated.latestVersionId)
  assert.match(readSkillLibraryVersion(f.data,skill.id,old).instructions,/第一版/)
  assert.throws(()=>f.library.importMarkdown({revision:f.library.catalog().revision,skillId:skill.id,contents:markdown('wrong')}),e=>e.code==='SKILL_NAME_MISMATCH')
  const unchanged=f.library.importMarkdown({revision:f.library.catalog().revision,skillId:skill.id,contents:markdown('versioned','第二版')}).skills[0]
  assert.equal(unchanged.versions.length,2)
})

test('停用拦截新使用、重新启用恢复，移除有引用保护且保留历史版本',t=>{
  const f=fixture(t,[]),skill=add(f.library)
  assign(f.library,skill)
  f.library.setEnabled({revision:f.library.catalog().revision,skillId:skill.id,enabled:false})
  assert.deepEqual(resolveSkillLibrary(f.data,f.scope),[])
  assert.match(readSkillLibraryVersion(f.data,skill.id,skill.latestVersionId).instructions,/阅读资料/)
  f.library.setEnabled({revision:f.library.catalog().revision,skillId:skill.id,enabled:true})
  assert.equal(resolveSkillLibrary(f.data,f.scope).length,1)
  assert.throws(()=>f.library.remove({revision:f.library.catalog().revision,skillId:skill.id}),e=>e.code==='SKILL_STILL_ASSIGNED')
  f.library.unassign({revision:f.library.catalog().revision,assignmentId:f.library.catalog().assignments[0].id})
  f.library.remove({revision:f.library.catalog().revision,skillId:skill.id})
  assert.equal(f.library.catalog().skills.length,0)
  assert.ok(readSkillLibraryVersion(f.data,skill.id,skill.latestVersionId))
})

test('过期 revision、重复名字与畸形包均不覆盖索引或版本',t=>{
  const f=fixture(t,[]),revision=f.library.catalog().revision,skill=add(f.library)
  const before=f.library.catalog()
  assert.throws(()=>f.library.setEnabled({revision,skillId:skill.id,enabled:false}),e=>e.code==='SKILL_REVISION_CONFLICT')
  assert.throws(()=>add(f.library),e=>e.code==='SKILL_ALREADY_EXISTS')
  assert.throws(()=>archive(f.library,{'a/SKILL.md':markdown('a'),'b/SKILL.md':markdown('b')}),e=>e.code==='SKILL_PACKAGE_AMBIGUOUS')
  assert.throws(()=>archive(f.library,{'SKILL.md':markdown('a'),'nested/SKILL.md':markdown('b')}),e=>e.code==='SKILL_PACKAGE_AMBIGUOUS')
  assert.throws(()=>archive(f.library,{'../SKILL.md':markdown('a')}),e=>e.code==='SKILL_ARCHIVE_INVALID')
  assert.throws(()=>archive(f.library,{'SKILL.md':markdown('a'),'README.md':'a','readme.md':'b'}),e=>e.code==='SKILL_PATH_CONFLICT')
  assert.throws(()=>f.library.importMarkdown({revision:before.revision,contents:'---\nname: bad\nname: duplicate\ndescription: a\n---\nx'}),e=>e.code==='SKILL_METADATA_INVALID')
  assert.deepEqual(f.library.catalog(),before)
})

test('文件读取防穿越、符号链接与篡改，原版本完整性验证失败不报成功',t=>{
  const f=fixture(t,[]),skill=add(f.library),version=skill.latestVersionId
  assert.throws(()=>f.library.readFile(skill.id,version,'../index.json'),e=>e.code==='SKILL_PATH_INVALID')
  const resolved=readSkillLibraryVersion(f.data,skill.id,version)
  writeFileSync(resolved.path,'changed')
  assert.throws(()=>f.library.readFile(skill.id,version,'SKILL.md'),e=>e.code==='SKILL_CONTENT_CHANGED')
  assert.throws(()=>f.library.verify({revision:f.library.catalog().revision,skillId:skill.id,versionId:version}))
  rmSync(resolved.path);symlinkSync(join(f.data,'t3/skill-library-v2/index.json'),resolved.path)
  assert.throws(()=>f.library.readFile(skill.id,version,'SKILL.md'),e=>e.code==='SKILL_PATH_INVALID')
})

test('跨连接锁阻止覆盖，连接关闭后自动释放且可以恢复写入',t=>{
  const f=fixture(t,[]),db=new DatabaseSync(join(f.data,'t3/skill-library-v2/write-lock.sqlite'))
  db.exec('BEGIN IMMEDIATE')
  assert.throws(()=>add(f.library),e=>e.code==='SKILL_LIBRARY_BUSY')
  db.close()
  assert.doesNotThrow(()=>add(f.library))
})

test('HTTP 管理限制、外部目录过滤与正文授权一致，未分配旧版不可读',async t=>{
  const f=fixture(t,[]),skill=add(f.library)
  assign(f.library,skill)
  const member={role:'external'}
  assert.equal((await f.request('GET',undefined,'/autoops/skill-library',member)).body.skills.length,0)
  await assert.rejects(f.request('POST',{action:'set-enabled',revision:f.library.catalog().revision,skillId:skill.id,enabled:false},'/autoops/skill-library',member),e=>e.status===403)
  const url=`/autoops/skill-library/${skill.id}/versions/${skill.latestVersionId}/content?path=SKILL.md`
  await assert.rejects(f.request('GET',undefined,url,member),e=>e.status===404)
  assign(f.library,skill,{targetType:'project',targetId:'p-b',workspaceTypes:['external']})
  assert.equal((await f.request('GET',undefined,'/autoops/skill-library',member)).body.skills.length,1)
  assert.match((await f.request('GET',undefined,url,member)).body.contents,/阅读资料/)
  assert.equal((await f.request('GET',undefined,url+'&raw=1',member)).file.bytes.toString(),markdown('review'))
  const updated=f.library.importMarkdown({revision:f.library.catalog().revision,skillId:skill.id,contents:markdown('review','新版')}).skills[0]
  await assert.rejects(f.request('GET',undefined,`/autoops/skill-library/${skill.id}/versions/${updated.latestVersionId}/content`,member),e=>e.status===404)
  const result=await f.request('GET',undefined,'/autoops/skill-library',member)
  assert.equal(result.body.skills[0].latestVersionId,skill.latestVersionId)
  await assert.rejects(f.request('POST',{action:'assign',revision:f.library.catalog().revision,skillId:skill.id,versionId:skill.latestVersionId,targetType:'agent',targetId:'unknown',workspaceTypes:['internal']}),e=>e.status===403)
})

test('公开 Git 来源只接受白名单 HTTPS 与完整 commit，拒绝本地凭据和路径注入',async t=>{
  const f=fixture(t,[]),base={revision:f.library.catalog().revision,ref:'a'.repeat(40)}
  for(const url of ['file:///etc','https://user:pass@github.com/a/b','https://localhost/a/b','https://github.com:444/a/b','https://github.com/a/b?x=1','https://github.com/a/b#x']) await assert.rejects(f.library.importGit({...base,url}),e=>e.code==='SKILL_REPOSITORY_INVALID')
  await assert.rejects(f.library.importGit({...base,url:'https://github.com/a/b',ref:'main'}),e=>e.code==='SKILL_COMMIT_REQUIRED')
  await assert.rejects(f.library.importGit({...base,url:'https://github.com/a/b',subdirectory:'../escape'}),e=>e.code==='SKILL_PATH_INVALID')
  assert.equal(readSkillLibrary(f.data).skills.length,0)
})

test('固定 Git 提交与子目录通过真实 Git 引擎导入，源码更新不影响旧版本',async t=>{
  // Test transport maps the validated public URL to an owned local fixture only.
  // Every init/fetch/checkout still runs real Git, including sparse checkout.
  const {execFileSync}=await import('node:child_process')
  const {chmodSync}=await import('node:fs')
  const f=fixture(t,[]),repo=join(f.data,'fixture-repo'),bin=join(f.data,'test-bin')
  mkdirSync(repo);mkdirSync(bin);mkdirSync(join(repo,'skills','tiny'),{recursive:true})
  writeFileSync(join(repo,'skills/tiny/SKILL.md'),markdown('git-example'))
  writeFileSync(join(repo,'skills/tiny/reference.md'),'固定提交资料')
  writeFileSync(join(repo,'unrelated.txt'),'不应加入技能包')
  const run=(...args)=>execFileSync('/usr/bin/git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
  run('init','--quiet');run('add','.');run('-c','user.name=测试','-c','user.email=test@example.invalid','commit','-qm','测试技能')
  const commit=run('rev-parse','HEAD')
  const wrapper=join(bin,'git')
  writeFileSync(wrapper,`#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2).map(arg=>arg==='protocol.file.allow=never'?'protocol.file.allow=always':arg);const i=args.indexOf('remote');if(i>=0&&args[i+1]==='add')args[i+3]=${JSON.stringify(repo)};const result=spawnSync('/usr/bin/git',args,{env:{...process.env,GIT_ALLOW_PROTOCOL:'https:file'},stdio:'inherit'});process.exit(result.status??1);\n`)
  chmodSync(wrapper,0o700)
  const original=process.env.PATH;process.env.PATH=bin+':'+original
  try {
    const result=await f.library.importGit({revision:f.library.catalog().revision,url:'https://github.com/fixture/skills',ref:commit,subdirectory:'skills/tiny'})
    const skill=result.skills[0],version=skill.versions[0]
    assert.equal(version.source.commit,commit);assert.equal(version.source.subdirectory,'skills/tiny')
    assert.deepEqual(version.files.map(file=>file.path),['SKILL.md','reference.md'])
    assert.equal(f.library.readFile(skill.id,version.id,'reference.md').contents,'固定提交资料')
    writeFileSync(join(repo,'skills/tiny/reference.md'),'来源之后变化')
    assert.equal(f.library.readFile(skill.id,version.id,'reference.md').contents,'固定提交资料')
    await assert.rejects(f.library.importGit({revision:f.library.catalog().revision,url:'https://github.com/fixture/skills',ref:commit,subdirectory:'missing'}),e=>e.code==='SKILL_DIRECTORY_INVALID')
  } finally { process.env.PATH=original }
})

test('兼容现有 metadata.display-name 中文显示名',t=>{
  const f=fixture(t,[])
  const catalog=f.library.importMarkdown({revision:f.library.catalog().revision,contents:'---\nname: named\ndescription: 测试\nmetadata:\n  display-name: 中文技能名\n---\n\n指令正文'})
  assert.equal(catalog.skills[0].displayName,'中文技能名')
})

test('纯 Markdown 的命令执行依赖也受限，避免把 CLI 技能误报为可用',t=>{
  const f=fixture(t,[])
  for(const [name,body] of [['shell-example','先执行命令：\n```bash\necho demo\n```'],['cli-example','Run skills-manager-cli first.'],['python-example','运行 python scripts/check.py 完成检查']]) {
    const skill=add(f.library,name,body)
    assert.equal(skill.versions[0].readiness,'restricted')
    assert.match(skill.versions[0].reason,/当前运行器未开放的命令执行/)
    assert.throws(()=>assign(f.library,skill),e=>e.code==='SKILL_NOT_READY')
  }
})
