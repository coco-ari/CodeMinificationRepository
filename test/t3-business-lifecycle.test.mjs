import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createWorkspaceStore } from '../agent-demo/t3-adapters/workspaces.mjs'

const fixtureProject = { id: 'p-shutdown', name: '隔离关闭验证' }
async function workspace(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'autoops-close-'))
  const store = createWorkspaceStore({ dataDir, taskLimits: {maxConcurrent:1,maxQueued:2}, authorizeTask({actorId,projectId}) {
    assert.equal(actorId, 'fixture-manager'); assert.equal(projectId, fixtureProject.id)
  } })
  t.after(async () => { await store.close({force:true}); rmSync(dataDir, {recursive:true,force:true}) })
  await store.ensureProject(fixtureProject, { initialContent: 'example' })
  const input = {sourceVersionId:store.overview(fixtureProject.id).internalVersions[0].id,services:['frontend']}
  return {dataDir,store,input}
}

test('正常关闭排空已接受及排队的真实打包任务，拒绝新写入且重复关闭安全', async t => {
  const {dataDir,store,input} = await workspace(t)
  store.startPackages(fixtureProject.id, {...input,requestId:'first'}, 'fixture-manager')
  store.startPackages(fixtureProject.id, {...input,requestId:'queued'}, 'fixture-manager')
  const closing = store.close()
  assert.throws(() => store.startPackages(fixtureProject.id, {...input,requestId:'new'}, 'fixture-manager'), {code:'WORKSPACE_STOPPING'})
  await assert.rejects(store.ensureProject({id:'p-other',name:'未开始'}), {code:'WORKSPACE_STOPPING'})
  await Promise.all([closing,store.close()])
  const overview = store.overview(fixtureProject.id)
  assert.deepEqual(overview.tasks.map(task=>task.status), ['completed','completed'])
  assert.equal(overview.releases.length,2)
  for (const release of overview.releases) assert.ok(store.packageFile(fixtureProject.id,release.id,'frontend').bytes.byteLength>0)
  assert.deepEqual(readdirSync(join(dataDir,'project-workspaces',fixtureProject.id,'staging')),[])
})

test('显式强制取消等待worker退出并记录中断，不产生未完成源码包', async t => {
  const {dataDir,store,input} = await workspace(t)
  store.startPackages(fixtureProject.id, {...input,requestId:'first'}, 'fixture-manager')
  store.startPackages(fixtureProject.id, {...input,requestId:'queued'}, 'fixture-manager')
  await store.close({force:true})
  const overview = store.overview(fixtureProject.id)
  assert.deepEqual(overview.tasks.map(task=>task.status), ['interrupted','interrupted'])
  assert.equal(overview.releases.length,0)
  assert.deepEqual(readdirSync(join(dataDir,'project-workspaces',fixtureProject.id,'staging')),[])
})

test('关闭等待已进入的工作区初始化完成，Git退出后才清理目录', async t => {
  const dataDir=mkdtempSync(join(tmpdir(),'autoops-initialize-close-'))
  const store=createWorkspaceStore({dataDir,authorizeTask(){assert.fail('初始化不应提交业务任务')}})
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
  const initializing=store.ensureProject(fixtureProject,{initialContent:'example'})
  await store.close()
  await initializing
  assert.equal(store.overview(fixtureProject.id).internalVersions.length,1)
  assert.deepEqual(readdirSync(join(dataDir,'project-workspaces',fixtureProject.id,'staging')),[])
})

test('已启用部署的宿主冷启动即提供安装与Agent入口，无需先访问管理页面', t => {
  const dataDir=mkdtempSync(join(tmpdir(),'autoops-host-cold-'))
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
  const script=`
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { readFile } from 'node:fs/promises';
    import { createBusinessRuntime } from './agent-demo/t3-adapters/business-runtime.mjs';
    import { configuredDeploymentStore } from './agent-demo/t3-adapters/deployments.mjs';
    const db=new DatabaseSync(join(process.env.AUTOOPS_T3_DATA_DIR,'demo.sqlite'));
    db.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)');db.close();
    const runtime=createBusinessRuntime();
    try {
      await runtime.initialize();
      const address=configuredDeploymentStore().agentAddress;
      assert.ok(address && typeof address==='object','宿主初始化完成时部署监听器必须已经就绪');
      const origin='http://127.0.0.1:'+address.port;
      const response=await fetch(origin+'/agent/install.sh');
      assert.equal(response.status,200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile('agent/install.sh'));
      const unauthenticated=await fetch(origin+'/api/agent/v1/heartbeat',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
      assert.equal(unauthenticated.status,401,'冷启动不能绕过Agent鉴权');
      await unauthenticated.arrayBuffer();
      runtime.stopAccepting();await runtime.drain();
      await assert.rejects(fetch(origin+'/agent/install.sh'));
    } finally { await runtime.close(); }
  `
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,AUTOOPS_T3_DATA_DIR:dataDir,AUTOOPS_DEPLOYMENT_ENABLED:'1',AUTOOPS_DEPLOYMENT_AGENT_PORT:'0'},encoding:'utf8',timeout:30000,windowsHide:true})
  assert.equal(result.status,0,result.stderr)
})

test('未启用部署的宿主不初始化部署数据库和监听器', t => {
  const dataDir=mkdtempSync(join(tmpdir(),'autoops-host-disabled-'))
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
  const script=`
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { readdir } from 'node:fs/promises';
    import { createBusinessRuntime } from './agent-demo/t3-adapters/business-runtime.mjs';
    import { configuredDeploymentStore } from './agent-demo/t3-adapters/deployments.mjs';
    const db=new DatabaseSync(join(process.env.AUTOOPS_T3_DATA_DIR,'demo.sqlite'));
    db.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)');db.close();
    const runtime=createBusinessRuntime();
    try {
      assert.ok(await runtime.initialize());
      assert.equal(configuredDeploymentStore(),undefined);
      assert.equal((await readdir(process.env.AUTOOPS_T3_DATA_DIR)).includes('deployment-center'),false);
    } finally { await runtime.close(); }
  `
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,AUTOOPS_T3_DATA_DIR:dataDir,AUTOOPS_DEPLOYMENT_ENABLED:'0',AUTOOPS_DEPLOYMENT_AGENT_PORT:'invalid-unused-port'},encoding:'utf8',timeout:30000,windowsHide:true})
  assert.equal(result.status,0,result.stderr)
})

test('宿主等待部署监听失败并关闭自己取得的资源，不关闭占用端口的其他服务', t => {
  const dataDir=mkdtempSync(join(tmpdir(),'autoops-host-listen-failure-'))
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
  const script=`
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { createServer } from 'node:net';
    import { createBusinessRuntime } from './agent-demo/t3-adapters/business-runtime.mjs';
    import { configuredAutoOpsAccess } from './agent-demo/t3-adapters/access.mjs';
    const db=new DatabaseSync(join(process.env.AUTOOPS_T3_DATA_DIR,'demo.sqlite'));
    db.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)');db.close();
    const existing=createServer();await new Promise(done=>existing.listen(0,'127.0.0.1',done));
    process.env.AUTOOPS_DEPLOYMENT_AGENT_PORT=String(existing.address().port);
    const runtime=createBusinessRuntime();
    try {
      await assert.rejects(runtime.initialize(),{code:'EADDRINUSE'});
      await runtime.close();
      assert.equal(existing.listening,true);
      assert.throws(()=>configuredAutoOpsAccess(),{code:'AUTOOPS_STOPPING'});
    } finally { await runtime.close(); await new Promise(done=>existing.close(done)); }
  `
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,AUTOOPS_T3_DATA_DIR:dataDir,AUTOOPS_DEPLOYMENT_ENABLED:'1'},encoding:'utf8',timeout:30000,windowsHide:true})
  assert.equal(result.status,0,result.stderr)
})

test('宿主初始化尚未完成时停止并关闭，最终不留下监听器且不能重新创建', t => {
  const dataDir=mkdtempSync(join(tmpdir(),'autoops-host-start-close-'))
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
  const script=`
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { createServer } from 'node:net';
    import { createBusinessRuntime } from './agent-demo/t3-adapters/business-runtime.mjs';
    import { configuredDeploymentStore } from './agent-demo/t3-adapters/deployments.mjs';
    const db=new DatabaseSync(join(process.env.AUTOOPS_T3_DATA_DIR,'demo.sqlite'));
    db.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)');db.close();
    const portHolder=createServer();await new Promise(done=>portHolder.listen(0,'127.0.0.1',done));
    const port=portHolder.address().port;await new Promise(done=>portHolder.close(done));
    process.env.AUTOOPS_DEPLOYMENT_AGENT_PORT=String(port);
    const runtime=createBusinessRuntime();
    const starting=runtime.initialize(),store=configuredDeploymentStore();
    runtime.stopAccepting();
    const closing=runtime.close();
    const results=await Promise.allSettled([starting,closing]);
    assert.equal(results[1].status,'fulfilled');
    if(results[0].status==='rejected') assert.equal(results[0].reason.status,503);
    assert.ok(store.agentAddress==null,'初始化期间关闭后不能残留监听器');
    assert.throws(()=>configuredDeploymentStore(),{code:'DEPLOYMENT_STOPPING'});
    await assert.rejects(runtime.initialize(),{code:'AUTOOPS_STOPPING'});
    const rebound=createServer();
    try { await new Promise((done,reject)=>{rebound.once('error',reject);rebound.listen(port,'127.0.0.1',done)}); }
    finally { await new Promise(done=>rebound.close(done)); }
    await runtime.close();
  `
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,AUTOOPS_T3_DATA_DIR:dataDir,AUTOOPS_DEPLOYMENT_ENABLED:'1'},encoding:'utf8',timeout:30000,windowsHide:true})
  assert.equal(result.status,0,result.stderr)
})

for (const force of [false,true]) test(`真实配置宿主${force?'排空预算触发本地取消':'正常排空'}后所有惰性存储均不重建`, t => {
  const dataDir=mkdtempSync(join(tmpdir(),'autoops-host-close-'))
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
  const script=`
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { configuredAutoOpsAssistantDirectory } from './agent-demo/t3-adapters/access-runtime.mjs';
    import { join } from 'node:path';
    import { createHash } from 'node:crypto';
    import { createBusinessRuntime } from './agent-demo/t3-adapters/business-runtime.mjs';
    import { configuredAutoOpsAccess } from './agent-demo/t3-adapters/access.mjs';
    import { configuredWorkspaceStore } from './agent-demo/t3-adapters/workspaces.mjs';
    import { configuredDeploymentStore } from './agent-demo/t3-adapters/deployments.mjs';
    import { configuredPreferences } from './agent-demo/t3-adapters/preferences.mjs';
    import { configuredSettingsPreferences } from './agent-demo/t3-adapters/settings-preferences.mjs';
    import { configuredBusinessArtifactStore } from './agent-demo/t3-adapters/business-tools.mjs';
    const db=new DatabaseSync(join(process.env.AUTOOPS_T3_DATA_DIR,'demo.sqlite'));
    db.exec('CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)');
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update('fixture-session').digest('hex'),'u-admin','fixture-csrf',Date.now()+60000);db.close();
    const runtime=createBusinessRuntime(${force?'{workspaceDrainTimeoutMs:1}':'{}'}),access=await runtime.initialize(),principal=access.authenticateCookie('demo_session=fixture-session');
    const project=access.requireProject(principal,'p-autoops'),workspaces=configuredWorkspaceStore();
    const preferences=configuredPreferences(),settings=configuredSettingsPreferences(),artifacts=configuredBusinessArtifactStore();
    const deployments=configuredDeploymentStore();await deployments.ensureProject(project);
    await workspaces.ensureProject(project,{initialContent:'example'});
    const version=workspaces.overview(project.id).internalVersions[0];
    workspaces.startPackages(project.id,{sourceVersionId:version.id,services:['frontend'],requestId:'drain-fixture'},principal.id);
    process.env.AUTOOPS_T3_MODEL='fixture-model';
    mkdirSync(join(process.env.AUTOOPS_T3_DATA_DIR,'t3'),{recursive:true});
    writeFileSync(join(process.env.AUTOOPS_T3_DATA_DIR,'t3/models-catalog.json'),JSON.stringify({version:1,source:'https://fixture.invalid/v1',models:[{id:'fixture-model',reasoningLevels:[],defaultReasoning:null,inputModalities:['text']}]}));
    const config={agentId:'a-project',executionBinding:{kind:'platform'},environmentId:'env-test',workspaceType:'internal',visibility:'private',skillIds:[],model:{instanceId:'codex',model:'fixture-model',reasoningEffort:null}};
    const preset=configuredAutoOpsAssistantDirectory().save(principal.id,project.id,null,{requestId:'lifecycle-preset',expectedRevision:0,value:{name:'生命周期测试',description:'',instructions:'',enabled:true,configuration:config}});
    access.bindThread(principal,{threadId:'fixture-thread',projectId:project.id,environmentId:'env-test',agentId:'a-project',visibility:'private',workspaceType:'internal',question:{assistantId:preset.id,presetRevision:preset.revision,configuration:config}});
    runtime.stopAccepting();runtime.stopAccepting();
    assert.throws(()=>access.bootstrap(principal),{code:'AUTOOPS_STOPPING'});
    assert.throws(()=>access.requireToolThread('fixture-thread'),{code:'AUTOOPS_STOPPING'});
    await assert.rejects(deployments.createServer(project.id,{}),{code:'DEPLOYMENT_STOPPING'});
    await runtime.drain();
    assert.equal(workspaces.overview(project.id).tasks[0].status,'${force?'interrupted':'completed'}');
    access.markThreadAccepted('fixture-thread');assert.equal(access.getThreadBinding('fixture-thread').scopeState,'locked');
    assert.equal(preferences.revision(principal.id),0);assert.deepEqual(settings.read(principal.id),{});assert.deepEqual(artifacts.list('fixture-thread'),[]);
    const closing=runtime.close();assert.equal(runtime.close(),closing);await closing;
    for(const getter of [configuredAutoOpsAccess,configuredWorkspaceStore,configuredDeploymentStore,configuredPreferences,configuredSettingsPreferences,configuredBusinessArtifactStore])assert.throws(()=>getter(),{status:503});
    assert.throws(()=>access.getThreadBinding('fixture-thread'),/not open|closed/i);
  `
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,AUTOOPS_T3_DATA_DIR:dataDir,AUTOOPS_DEPLOYMENT_ENABLED:'1'},encoding:'utf8',timeout:30000,windowsHide:true})
  assert.equal(result.status,0,result.stderr)
})
