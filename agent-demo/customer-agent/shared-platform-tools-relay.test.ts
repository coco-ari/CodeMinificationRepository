import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,request} from 'node:http'
import {once} from 'node:events'
import {join} from 'node:path'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {createSessionRelay} from './shared-container-entry.mjs'
import {createCustomerPlatformToolsBridge} from './platform-tools-bridge.ts'

test('容器固定工具relay通过私有UDS运行真实MCP，与模型通道完全独立，关闭排空原连接',async t=>{
  const directory=await realpath(await mkdtemp('/tmp/ao-shared-tools-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  let modelCalls=0,toolCalls=0
  const model=createServer((_req,response)=>{modelCalls++;response.end('fictional-model-only')});model.listen(join(directory,'model.sock'));await once(model,'listening');t.after(()=>new Promise<void>(resolve=>model.close(()=>resolve())))
  const bridge=await createCustomerPlatformToolsBridge({container:true,socketPath:join(directory,'tools.sock'),callTool:async()=>{toolCalls++;return {fixture:'platform-only'}}});t.after(()=>bridge.close())
  bridge.activate({reference:{version:1,contextId:'fixed-context'},commandId:'fixed-command',sessionId:'fixed-session',runtimeEpoch:'fixed-epoch',threadId:'fixed-thread'})
  const relay=createSessionRelay(join(directory,'tools.sock'));relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close())
  const endpoint=`http://127.0.0.1:${(relay.server.address() as {port:number}).port}/mcp`
  const headers={authorization:bridge.authorizationHeader,'content-type':'application/json',accept:'application/json, text/event-stream'}
  const init=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})});assert.equal(init.status,200);await init.body?.cancel()
  const response=await fetch(endpoint,{method:'POST',headers:{...headers,'mcp-session-id':init.headers.get('mcp-session-id')!,'mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'query_environment',arguments:{}}})})
  assert.match(await response.text(),/platform-only/);assert.equal(modelCalls,0);assert.equal(toolCalls,1)
  relay.close();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(relay.server.listening,false)
})
test('未启用平台工具的原自用容器不创建隐式出口，缺失socket明确断线',async t=>{
  const directory=await realpath(await mkdtemp('/tmp/ao-shared-plain-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const relay=createSessionRelay(join(directory,'no-tools.sock'));relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close())
  await assert.rejects(new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:(relay.server.address() as {port:number}).port,path:'/mcp',method:'POST'},resolve);req.once('error',reject);req.end('{}')}))
})
