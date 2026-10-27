import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, rm, lstat, unlink, writeFile, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createCustomerPlatformToolsBridge, type CustomerPlatformToolsBridge } from './platform-tools-bridge.ts'
import type { CustomerPlatformToolRequest } from '../../autoops/contracts/customer-platform-tools.ts'
const run={reference:{version:1 as const,contextId:'context-original'},commandId:'command-original',sessionId:'session-original',runtimeEpoch:'epoch-original',threadId:'thread-original'}
function wire(bridge:CustomerPlatformToolsBridge,value:unknown,options:{session?:string;authorization?:string;method?:string;path?:string}={}) {
  let handle:ReturnType<typeof request>
  const response=new Promise<{status:number;headers:Record<string,any>;body:any}>((resolve,reject)=>{
    const body=value===undefined?undefined:JSON.stringify(value)
    handle=request({socketPath:bridge.socketPath,path:options.path??'/mcp',method:options.method??'POST',headers:{authorization:options.authorization??bridge.authorizationHeader,'content-type':'application/json',accept:'application/json, text/event-stream',...(options.session?{'mcp-session-id':options.session,'mcp-protocol-version':'2025-11-25'}:{})}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',v=>text+=v);res.once('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:text?JSON.parse(text):undefined}));res.once('error',reject)
    });handle.once('error',reject);handle.end(body)
  })
  return {response,cancel:()=>handle.destroy()}
}
async function initialize(b:CustomerPlatformToolsBridge){const result=await wire(b,{jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}}).response;assert.equal(result.status,200);assert.equal(result.body.id,0);return String(result.headers['mcp-session-id'])}
const tool=(id:number,name:string,args:unknown)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})
test('真实UDS MCP初始化、通知、id0和四工具严格绑定原scope，不转发模型身份字段',async t=>{
  const calls:CustomerPlatformToolRequest[]=[]
  const b=await createCustomerPlatformToolsBridge({callTool:async request=>{calls.push(request);return {marker:'fixed-fixture'}}});t.after(()=>b.close());b.activate(run)
  assert.equal((await lstat(b.socketPath)).mode&0o777,0o600)
  const session=await initialize(b)
  assert.equal((await wire(b,{jsonrpc:'2.0',method:'notifications/initialized'},{session}).response).status,202)
  const listed=await wire(b,{jsonrpc:'2.0',id:1,method:'tools/list'},{session}).response
  assert.deepEqual(listed.body.result.tools.map((v:any)=>v.name).sort(),['list_project_materials','query_environment','read_environment','read_project_material'])
  const queries=[tool(0,'list_project_materials',{}),tool(2,'read_project_material',{path:'autoops/workspaces/fixed/proof.txt'}),tool(3,'query_environment',{}),tool(4,'read_environment',{operation:{action:'redis.ttl',connectionId:'redis-fixed',key:'fixture:key'}})]
  for(const query of queries){const result=await wire(b,query,{session}).response;assert.equal(result.body.result?.isError??false,false,JSON.stringify(result.body))}
  assert.equal(calls.length,4)
  assert.deepEqual(calls[0],{reference:run.reference,commandId:run.commandId,sessionId:run.sessionId,runtimeEpoch:run.runtimeEpoch,call:{tool:'list_project_materials',arguments:{}}})
  for(const query of [tool(5,'list_project_materials',{actorId:'forged'}),tool(6,'read_project_material',{path:'proof',inputId:'forged'}),tool(7,'read_environment',{operation:{action:'redis.eval',connectionId:'redis-fixed',script:'write'}}),tool(8,'shell',{command:'id'})]){
    const result=await wire(b,query,{session}).response;assert.ok(result.body.error || result.body.result?.isError)
  }
  assert.equal(calls.length,4)
  assert.equal((await wire(b,tool(9,'query_environment',{}),{session,authorization:'Bearer not-the-session'}).response).status,403)
  assert.equal(b.current('other-thread'),undefined)
})
test('撤回或新轮激活后迟到结果拒绝，旧scope不被换成新scope',async t=>{
  const started=Promise.withResolvers<void>(),result=Promise.withResolvers<unknown>();let signal:AbortSignal|undefined
  const b=await createCustomerPlatformToolsBridge({callTool:async(_request,s)=>{signal=s;started.resolve();return result.promise}});t.after(()=>b.close());b.activate(run)
  const session=await initialize(b), pending=wire(b,tool(0,'query_environment',{}),{session}).response
  await started.promise;b.activate({...run,reference:{version:1,contextId:'next-context'},commandId:'next-command'});result.resolve({secretMarker:'must-not-return'})
  const response=await pending;assert.equal(signal?.aborted,true);if(response.status===503)assert.equal(response.body.code,'CUSTOMER_PLATFORM_TOOL_UNAVAILABLE');else assert.ok(response.body.error || response.body.result?.isError);assert.doesNotMatch(JSON.stringify(response),/secretMarker|must-not-return/)
  b.clear();assert.equal((await wire(b,tool(1,'query_environment',{}),{session}).response).status,403)
})
test('MCP取消id0与HTTP断线中止实际端口；预算和关闭不等待失联端口',async t=>{
  let started=Promise.withResolvers<void>(),cancelled=Promise.withResolvers<void>()
  const b=await createCustomerPlatformToolsBridge({requestTimeoutMs:500,callTool:async(_request,signal)=>{started.resolve();signal.addEventListener('abort',()=>cancelled.resolve(),{once:true});return new Promise(()=>{})}});t.after(()=>b.close());b.activate(run)
  const session=await initialize(b), first=wire(b,tool(0,'query_environment',{}),{session});const firstResult=first.response.catch(()=>undefined)
  await started.promise
  const cancelledAt=performance.now()
  assert.equal((await wire(b,{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:0}},{session}).response).status,202)
  await cancelled.promise;assert.ok(performance.now()-cancelledAt<250,'取消应由MCP通知触发，不能等待500ms预算');await firstResult
  started=Promise.withResolvers<void>();cancelled=Promise.withResolvers<void>()
  const second=wire(b,tool(1,'query_environment',{}),{session});const secondResult=second.response.catch(()=>undefined)
  await started.promise;second.cancel();await cancelled.promise;await secondResult
  started=Promise.withResolvers<void>();cancelled=Promise.withResolvers<void>()
  const third=wire(b,tool(2,'query_environment',{}),{session});const thirdResult=third.response.catch(()=>undefined)
  await started.promise;await cancelled.promise;await thirdResult
  await b.close()
})
test('超出输入和结果上限拒绝；端口错误不包含秘密；close只移除原socket',async t=>{
  let mode='large',calls=0
  const directory=await realpath(await mkdtemp('/tmp/ao-tools-fixture-')),socketPath=join(directory,'tools.sock')
  const b=await createCustomerPlatformToolsBridge({socketPath,callTool:async()=>{calls++;if(mode==='large')return {text:'x'.repeat(1024*1024)};throw new Error('PASSWORD_FIXTURE_SHOULD_NOT_LEAK')}});t.after(async()=>{await b.close();await rm(directory,{recursive:true,force:true})});b.activate(run)
  const session=await initialize(b)
  let result=await wire(b,tool(1,'query_environment',{}),{session}).response;assert.equal(result.body.result.isError,true)
  mode='error';result=await wire(b,tool(2,'query_environment',{}),{session}).response;assert.doesNotMatch(JSON.stringify(result),/PASSWORD_FIXTURE/)
  result=await wire(b,tool(3,'read_project_material',{path:'x'.repeat(128*1024)}),{session}).response;assert.equal(result.status,413);assert.equal(calls,2)
  await unlink(socketPath);await writeFile(socketPath,'replacement-fixture');await b.close();assert.equal(await readFile(socketPath,'utf8'),'replacement-fixture')
})

test('MCP GET遵循既有服务未开启订阅的405合同，close排空会话资源',async t=>{
  const b=await createCustomerPlatformToolsBridge({callTool:async()=>({fixture:true})});t.after(()=>b.close());b.activate(run)
  const session=await initialize(b)
  const started=performance.now()
  await new Promise<void>((resolve,reject)=>{
    const req=request({socketPath:b.socketPath,path:'/mcp',method:'GET',headers:{authorization:b.authorizationHeader,accept:'text/event-stream','mcp-session-id':session,'mcp-protocol-version':'2025-11-25'}},response=>{
      assert.equal(response.statusCode,405);assert.ok(performance.now()-started<500)
      response.destroy();resolve()
    });req.once('error',reject);req.end()
  })
  await b.close()
})

test('旧轮本地MCP授权和协议会话不能借新轮active引用读取新资料',async t=>{
  const contexts:string[]=[]
  const b=await createCustomerPlatformToolsBridge({callTool:async request=>{contexts.push(request.reference.contextId);return {fixture:true}}});t.after(()=>b.close());b.activate(run)
  const oldAuthorization=b.authorizationHeader,session=await initialize(b)
  b.activate({...run,commandId:'next-command',reference:{version:1,contextId:'next-context'}})
  const stale=await wire(b,tool(0,'query_environment',{}),{session,authorization:oldAuthorization}).response
  assert.equal(stale.status,403);assert.deepEqual(contexts,[])
  const current=await initialize(b)
  const fresh=await wire(b,tool(1,'query_environment',{}),{session:current}).response
  assert.equal(fresh.body.result.isError??false,false);assert.deepEqual(contexts,['next-context'])
})
