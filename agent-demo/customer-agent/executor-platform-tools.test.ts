import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {CustomerAgentStore} from './store.ts'
import {CustomerAgentExecutor,type RunnerFactory} from './executor.ts'
import type {CustomerAgentCommand} from '../../vendor/t3code/packages/contracts/src/autoopsRemote.ts'
import type {CustomerPlatformToolRequest} from '../../autoops/contracts/customer-platform-tools.ts'
import type {HeadlessCodexRunnerOptions} from '../../vendor/t3code/apps/server/src/provider/HeadlessCodexRunner.ts'
async function fixture(t:import('node:test').TestContext){
  const root=mkdtempSync(join(tmpdir(),'ao-tools-executor-'));const directory=join(root,'source');mkdirSync(directory)
  const store=new CustomerAgentStore(join(root,'state'));const target=store.register(directory,'project-a','测试独占来源')
  const calls:CustomerPlatformToolRequest[]=[],dispatched:string[]=[];let options:HeadlessCodexRunnerOptions|undefined
  let endpoint:{endpoint:string;authorizationHeader:string;contextId:string}|undefined
  const factory:RunnerFactory=async value=>{options=value;return {processGeneration:'epoch-a',catalog:async()=>({models:[],skills:[]}),close:async()=>{},dispatch:async(method,input:any)=>{
    dispatched.push(method)
    if(method==='startTurn'){
      endpoint=value.readPlatformToolsSession?.(input.threadId)
      await value.onEvent({type:'provider_turn.updated',providerTurn:{id:'turn-a',runAttemptId:input.attemptId,nativeTurnRef:{nativeId:'native-turn'}}})
    }
    return null
  }}}
  const executor=new CustomerAgentExecutor({store,deviceId:'device-a',runnerFactory:factory,notify:()=>{},callPlatformTool:async request=>{calls.push(request);return {fixture:true}}})
  t.after(async()=>{await executor.close();store.close();rmSync(root,{recursive:true,force:true})})
  const command=(method:CustomerAgentCommand['method'],id:string,input:unknown={},extra:Partial<CustomerAgentCommand>={}):CustomerAgentCommand=>({type:'command',sessionId:'session-a',commandId:id,target,method,input,...extra})
  await executor.execute(command('openSession','open-original'))
  const start=command('startTurn','start-original',{threadId:'thread-a',runId:'run-a',attemptId:'attempt-a'},{platformTools:{version:1,contextId:'context-original'}})
  const query=async(id:number)=>{
    assert.ok(endpoint)
    const response=await fetch(endpoint.endpoint,{method:'POST',headers:{authorization:endpoint.authorizationHeader,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})})
    if(response.status!==200){await response.body?.cancel();return {status:response.status}}
    const session=response.headers.get('mcp-session-id')!;await response.body?.cancel()
    const read=await fetch(endpoint.endpoint,{method:'POST',headers:{authorization:endpoint.authorizationHeader,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':session,'mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'query_environment',arguments:{}}})})
    return {status:read.status,body:await read.json() as any}
  }
  return {executor,store,target,calls,dispatched,command,start,query,options:()=>options!,endpoint:()=>endpoint}
}
test('真实SQLite新轮接通本地MCP，原命令重放与steer保留原start引用，终态和下一普通轮移除能力',async t=>{
  const f=await fixture(t)
  assert.equal(f.options().readPlatformToolsSession?.('thread-a'),undefined)
  assert.equal((await f.executor.execute(f.start)).state,'completed')
  assert.equal((await f.query(0)).body.result.isError??false,false)
  assert.deepEqual(f.calls[0]?.reference,{version:1,contextId:'context-original'})
  assert.equal(f.calls[0]?.commandId,'start-original');assert.equal(f.calls[0]?.runtimeEpoch,'epoch-a')
  await f.executor.execute(f.start);assert.equal(f.dispatched.filter(v=>v==='startTurn').length,1)
  assert.equal((await f.executor.execute({...f.start,platformTools:{version:1,contextId:'tampered-context'}})).error?.code,'command_id_conflict')
  assert.equal(f.dispatched.filter(v=>v==='startTurn').length,1)
  await f.executor.execute(f.command('steerTurn','steer-original',{threadId:'thread-a',providerTurnId:'turn-a'},{runtimeEpoch:'epoch-a'}))
  await f.query(1);assert.equal(f.calls[1]?.commandId,'start-original')
  await f.options().onEvent({type:'turn.terminal',providerTurnId:'turn-a'})
  assert.equal(f.store.session('session-a')?.state,'idle');assert.equal((await f.query(2)).status,403)
  assert.equal((await f.executor.execute(f.command('startTurn','plain-next',{threadId:'thread-a',runId:'run-next',attemptId:'attempt-next'}))).state,'completed')
  assert.equal(f.options().readPlatformToolsSession?.('thread-a'),undefined)
})
test('伪引用、不同epoch、非start附加引用在原生执行前拒绝，旧自用无需桥前置',async t=>{
  const f=await fixture(t)
  for(const command of [{...f.start,commandId:'wrong-epoch',runtimeEpoch:'other'}, {...f.start,commandId:'wrong-context',platformTools:{version:1 as const,contextId:'bad\ncontext'}}, f.command('steerTurn','forged-steer',{}, {runtimeEpoch:'epoch-a',platformTools:{version:1,contextId:'foreign'}})]){
    const receipt=await f.executor.execute(command);assert.equal(receipt.state,'failed')
  }
  assert.equal(f.dispatched.includes('startTurn'),false);assert.equal(f.store.session('session-a')?.state,'idle')
  assert.equal((await f.executor.execute(f.command('startTurn','plain',{runId:'run-plain',attemptId:'attempt-plain',threadId:'thread-a'}))).state,'completed')
})
test('本机来源撤回和未知执行立即关闭工具读取，不伪造原任务终态',async t=>{
  const f=await fixture(t);await f.executor.execute(f.start);await f.query(1)
  f.store.revoke(f.target.registeredWorkspaceId);f.executor.enforceLocalRevocations()
  assert.equal((await f.query(2)).status,403);assert.equal(f.calls.length,1)
  assert.equal(f.store.session('session-a')?.state,'active')
  await f.options().onError?.(new Error('fixture lost transport'))
  assert.equal(f.store.session('session-a')?.state,'unknown');assert.equal((await f.query(3)).status,403)
})

test('能力目录只在完整HTTP桥端口存在时声明版本，并改变真实目录revision',async t=>{
  const f=await fixture(t)
  const plain=new CustomerAgentExecutor({store:f.store,deviceId:'device-a',notify:()=>{},runnerFactory:async()=>({processGeneration:'plain-catalog',catalog:async()=>({models:[],skills:[]}),dispatch:async()=>null,close:async()=>{}})})
  const before=await plain.capabilities(f.target),after=await f.executor.capabilities(f.target)
  assert.equal(plain.platformToolsVersion,undefined);assert.equal(before.platformToolsVersion,undefined)
  assert.equal(f.executor.platformToolsVersion,1);assert.equal(after.platformToolsVersion,1)
  assert.notEqual(before.revision,after.revision)
  await plain.close()
})

test('不支持Unix通道的平台不虚报桥能力，显式平台轮拒绝而普通自用仍保留',async t=>{
  const f=await fixture(t),original=Object.getOwnPropertyDescriptor(process,'platform')!
  try {
    Object.defineProperty(process,'platform',{...original,value:'win32'})
    assert.equal(f.executor.platformToolsVersion,undefined)
    assert.equal((await f.executor.execute(f.start)).error?.code,'platform_tools_unavailable')
    assert.equal(f.dispatched.includes('startTurn'),false)
    assert.equal((await f.executor.execute(f.command('startTurn','plain-supported',{threadId:'thread-a',runId:'plain-run',attemptId:'plain-attempt'}))).state,'completed')
  } finally {Object.defineProperty(process,'platform',original)}
})
