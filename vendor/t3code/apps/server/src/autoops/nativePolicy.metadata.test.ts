// @effect-diagnostics nodeBuiltinImport:off
import { it, assert, vi } from 'vite-plus/test';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { CodexSettings } from '@t3tools/contracts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareT3Worker } from '../../../../../../agent-demo/t3-adapters/launcher.mjs';
import { prepareScopedBusinessSkills } from '../../../../../../agent-demo/t3-adapters/scoped-skills.mjs';
import { checkCodexProviderStatus, probeCodexSkillsForCwd, withCodexAppServerClient } from '../provider/CodexProvider.ts';

// Opt-in real CLI metadata verification: no turn/start and no model requests.
for (const profile of ['t3-demo-full-v1', 'project-assistant-lite-v1'])
it.skipIf(!process.env.AUTOOPS_TEST_CODEX_BINARY)(`real native probe validates ${profile}, fixed model and registered skills; rejects inherited extra roles`, async () => {
  const directory=mkdtempSync(join(tmpdir(),'t3-native-metadata-'));
  try {
    mkdirSync(join(directory,'t3'),{recursive:true});
    const keyPath=join(directory,'fake-key');
    writeFileSync(keyPath,'metadata-only-not-a-real-key',{mode:0o600});
    writeFileSync(join(directory,'t3/skills-registry.json'),JSON.stringify({version:1,skills:[{name:'test-read',description:'只读测试',instructions:'使用 read_project_document 读取授权资料。',tools:['read_project_document']}]}));
    const config=prepareT3Worker({AUTOOPS_DEMO_PROFILE:profile,DATA_DIR:directory,AGENT_DEMO_MODEL:'grok-4.6',AGENT_DEMO_CODEX_BINARY:process.env.AUTOOPS_TEST_CODEX_BINARY,AGENT_DEMO_CPA_BASE_URL:'https://provider.invalid/v1',AGENT_DEMO_CPA_API_KEY_FILE:keyPath});
    vi.stubEnv('AUTOOPS_DEMO_PROFILE',profile);
    vi.stubEnv('AUTOOPS_T3_DATA_DIR',directory);
    vi.stubEnv('AUTOOPS_T3_MODEL','grok-4.6');
    vi.stubEnv('AUTOOPS_T3_CODEX_HOME',config.homePath);
    const settings=Schema.decodeUnknownSync(CodexSettings)(config.settings.providerInstances.codex.config);
    const probe=()=>Effect.runPromise(checkCodexProviderStatus(settings,undefined,config.childEnv).pipe(Effect.provide(NodeServices.layer)));
    const valid=await probe();
    assert.equal(valid.status,'ready',valid.message);
    assert.deepEqual(valid.models.map(model=>model.slug),['grok-4.6']);
    assert.deepEqual(valid.skills,[]);
    const scoped=prepareScopedBusinessSkills(directory,{threadId:'metadata-only',projectId:'p-autoops',agentId:'a-project',workspaceType:'internal'});
    const skills=await Effect.runPromise(probeCodexSkillsForCwd({binaryPath:config.binaryPath,homePath:config.homePath,launchArgs:settings.launchArgs,cwd:scoped.physicalCwd,environment:config.childEnv}).pipe(Effect.scoped,Effect.provide(NodeServices.layer)));
    assert.deepEqual(skills.map(skill=>skill.name),['autoops-test-read']);
    const other=prepareScopedBusinessSkills(directory,{threadId:'metadata-other',projectId:'p-autoops',agentId:'unassigned',workspaceType:'internal'});
    const hidden=await Effect.runPromise(probeCodexSkillsForCwd({binaryPath:config.binaryPath,homePath:config.homePath,launchArgs:settings.launchArgs,cwd:other.physicalCwd,environment:config.childEnv}).pipe(Effect.scoped,Effect.provide(NodeServices.layer)));
    assert.deepEqual(hidden,[]);
    // Real native thread initialization validates the scoped config, with no turn/model request.
    const started=await Effect.runPromise(Effect.gen(function*(){
      const {client}=yield* withCodexAppServerClient({binaryPath:config.binaryPath,homePath:config.homePath,launchArgs:settings.launchArgs,cwd:scoped.physicalCwd,environment:config.childEnv});
      const baseline = yield* client.request('config/read',{includeLayers:false});
      const filesystem=(baseline.config.permissions as {agent_demo:{filesystem:Record<string,unknown>}}).agent_demo.filesystem;
      assert.equal(filesystem[':root'],'deny');
      assert.deepEqual(Object.keys(filesystem).filter(key=>key!=='glob_scan_max_depth'),[':root']);
      return yield* client.request('thread/start',{cwd:scoped.physicalCwd,model:'grok-4.6'});
    }).pipe(Effect.scoped,Effect.provide(NodeServices.layer)));
    assert.equal(started.thread.cwd,scoped.physicalCwd);
    writeFileSync(join(config.homePath,'config.toml'),'[agents.unregistered]\ndescription="unregistered"\n');
    const rejected=await probe();
    assert.notEqual(rejected.status,'ready');
    assert.match(rejected.message??'',/配置验证失败/);
  } finally {vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true})}
},30000);
