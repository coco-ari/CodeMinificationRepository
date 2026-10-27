import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type RequestListener} from 'node:http'
import {CustomerAgentHttpClient} from './connection.ts'
import {createCustomerPlatformToolsBridge} from './platform-tools-bridge.ts'
import type {CustomerPlatformToolRequest} from '../../autoops/contracts/customer-platform-tools.ts'
const body:CustomerPlatformToolRequest={reference:{version:1,contextId:'context-original'},sessionId:'session-original',runtimeEpoch:'epoch-original',commandId:'start-original',call:{tool:'query_environment',arguments:{}}}
async function fixture(t:import('node:test').TestContext,handle:RequestListener){
  const server=createServer(handle);server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const port=(server.address() as {port:number}).port
  const client=new CustomerAgentHttpClient(`http://127.0.0.1:${port}`,'fictional-device-token')
  t.after(async()=>{server.closeAllConnections();await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()))})
  return client
}
test('真实既有设备HTTP仅发固定原scope和call，Bearer不进入模型MCP结果',async t=>{
  let count=0
  const client=await fixture(t,async(request,response)=>{
    count++;assert.equal(request.url,'/api/agent-demo/t3/autoops/customer/connector/platform-tools');assert.equal(request.method,'POST');assert.equal(request.headers.authorization,'Bearer fictional-device-token')
    let text='';for await(const part of request)text+=part;assert.deepEqual(JSON.parse(text),body)
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({fixture:'only-authorized-data'}))
  })
  const bridge=await createCustomerPlatformToolsBridge({callTool:(request,signal)=>client.request('connector/platform-tools',request,signal)});t.after(()=>bridge.close());bridge.activate({...body,threadId:'thread-original'})
  const headers={authorization:bridge.authorizationHeader,'content-type':'application/json',accept:'application/json, text/event-stream'}
  const init=await fetch(bridge.endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})});await init.body?.cancel()
  const result=await fetch(bridge.endpoint,{method:'POST',headers:{...headers,'mcp-session-id':init.headers.get('mcp-session-id')!,'mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'query_environment',arguments:{}}})})
  const output=await result.text();assert.match(output,/only-authorized-data/);assert.doesNotMatch(output,/fictional-device-token|epoch-original|start-original/);assert.equal(count,1)
})
test('HTTP撤回拒绝不重试且原始错误正文不泄漏，超限与取消释放流',async t=>{
  let count=0,mode='denied';const closed=Promise.withResolvers<void>()
  const client=await fixture(t,(request,response)=>{
    count++
    if(mode==='denied'){response.writeHead(403);response.end('SECRET_FIXTURE_CENTER_BODY');return}
    if(mode==='large'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({text:'x'.repeat(1024*1024)}));return}
    response.writeHead(200,{'content-type':'application/json'});response.write('{"fixture":');response.once('close',()=>closed.resolve())
  })
  await assert.rejects(client.request('connector/platform-tools',body),error=>error instanceof Error && error.message.includes('HTTP 403') && !error.message.includes('SECRET_FIXTURE'))
  assert.equal(count,1);mode='large';await assert.rejects(client.request('connector/platform-tools',body),/响应超过大小/)
  mode='pending';const controller=new AbortController();const pending=client.request('connector/platform-tools',body,controller.signal);setTimeout(()=>controller.abort(),10);await assert.rejects(pending);await closed.promise
})
