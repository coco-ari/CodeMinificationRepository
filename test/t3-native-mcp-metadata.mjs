// Opt-in actual Codex metadata/transport check. No turn/start or model request.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareT3Worker } from '../agent-demo/t3-adapters/launcher.mjs'
import { prepareAutoOpsCodexRequest, businessMcpApprovals } from '../agent-demo/t3-adapters/codex-policy.mjs'
import { tokenizeCliArgs } from '../vendor/t3code/packages/shared/src/cliArgs.ts'

const binary=process.env.AUTOOPS_TEST_CODEX_BINARY
assert.ok(binary,'Set AUTOOPS_TEST_CODEX_BINARY to the real Codex executable')
const directory=mkdtempSync(join(tmpdir(),'t3-mcp-native-'))
const requests=[]
const initializationOffers=[]
let pendingForm
const forms=[]
const server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);return res.end()}
  const chunks=[];for await(const chunk of req)chunks.push(chunk)
  const input=JSON.parse(Buffer.concat(chunks).toString());requests.push(input.method);if(input.method==='initialize')initializationOffers.push(input.params?.protocolVersion)
  if(input.id==='form-probe' && input.result){
    res.writeHead(202);res.end();
    const result={content:[{type:'text',text:JSON.stringify(input.result)}]}
    pendingForm.res.end(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:pendingForm.id,result})}\n\n`)
    return
  }
  if(input.id===undefined){res.writeHead(202);return res.end()}
  if(input.method==='tools/call'&&input.params.name==='ask_user'){
    pendingForm={id:input.id,res};res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    res.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:'form-probe',method:'elicitation/create',params:{message:'metadata only form',requestedSchema:{type:'object',properties:{answer:{type:'string',enum:['test','production']}},required:['answer']}}})}\n\n`)
    return
  }
  const result=input.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'metadata-only',version:'1'}}
    :input.method==='tools/list'?{tools:[{name:'read_project_document',description:'metadata-only local fixture',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id']},annotations:{readOnlyHint:true}},{name:'ask_user',description:'metadata-only form',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]}
    :input.method==='tools/call'?{content:[{type:'text',text:'MCP_TRANSPORT_CONFIRMED'}]}
    :input.method==='resources/list'?{resources:[]}:input.method==='resources/templates/list'?{resourceTemplates:[]}:{}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result}))
})
let child
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const key=join(directory,'fake-key');writeFileSync(key,'not-a-real-provider-key',{mode:0o600})
  const config=prepareT3Worker({DATA_DIR:directory,AGENT_DEMO_CODEX_BINARY:binary,AGENT_DEMO_MODEL:'grok-4.6',AGENT_DEMO_CPA_BASE_URL:'https://provider.invalid/v1',AGENT_DEMO_CPA_API_KEY_FILE:key})
  Object.assign(process.env,{AUTOOPS_T3_DATA_DIR:directory,AUTOOPS_T3_CODEX_HOME:config.homePath,AUTOOPS_T3_MODEL:'grok-4.6'})
  child=spawn(binary,['app-server',...tokenizeCliArgs(config.settings.providerInstances.codex.config.launchArgs)],{cwd:directory,env:{...process.env,...config.childEnv,CODEX_HOME:config.homePath},stdio:['pipe','pipe','pipe']})
  const pending=new Map();let next=0,buffer='',stderr=''
  child.stderr.on('data',chunk=>{stderr+=chunk.toString()})
  child.stdout.on('data',chunk=>{buffer+=chunk;let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;const value=JSON.parse(line);if(value.method==='mcpServer/elicitation/request'){forms.push({threadId:value.params.threadId,turnId:value.params.turnId,mode:value.params.mode,requestedSchema:value.params.requestedSchema});child.stdin.write(JSON.stringify({id:value.id,result:{action:'accept',content:{answer:'test'}}})+'\n');continue}const callback=pending.get(value.id);if(callback){pending.delete(value.id);value.error?callback.reject(Error(JSON.stringify(value.error))):callback.resolve(value.result)}}})
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next;const timeout=setTimeout(()=>reject(Error(`Native request timed out: ${method}; ${stderr.slice(-1500)}`)),20000);pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value)},reject:error=>{clearTimeout(timeout);reject(error)}});child.stdin.write(JSON.stringify({id,method,params})+'\n')})
  await rpc('initialize',{clientInfo:{name:'autoops_mcp_metadata',version:'1'},capabilities:{experimentalApi:true}})
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n')
  const base=await rpc('config/read',{includeLayers:false,cwd:directory})
  assert.deepEqual(Object.keys(base.config.mcp_servers??{}),[],'launcher must clear inherited MCP servers')
  const endpoint=`http://127.0.0.1:${server.address().port}/mcp`
  const params=prepareAutoOpsCodexRequest('thread/start',{ephemeral:true,cwd:directory,config:{'mcp_servers.t3-code':{url:endpoint,...businessMcpApprovals()},'mcp_servers.hostile':{url:'http://127.0.0.1:1/mcp'}}})
  if(process.env.AUTOOPS_TEST_APPROVAL_POLICY)params.approvalPolicy=JSON.parse(process.env.AUTOOPS_TEST_APPROVAL_POLICY)
  assert.deepEqual(Object.keys(params.config.mcp_servers),['t3-code'])
  const thread=await rpc('thread/start',params)
  const inventory=await rpc('mcpServerStatus/list',{threadId:thread.thread.id})
  assert.deepEqual(inventory.data.map(item=>item.name),['t3-code'])
  assert.ok(Object.values(inventory.data[0].tools).some(tool=>tool.name==='read_project_document'))
  const result=await rpc('mcpServer/tool/call',{threadId:thread.thread.id,server:'t3-code',tool:'read_project_document',arguments:{id:'fixture'}})
  assert.equal(result.content[0].text,'MCP_TRANSPORT_CONFIRMED')
  const formResult=await rpc('mcpServer/tool/call',{threadId:thread.thread.id,server:'t3-code',tool:'ask_user',arguments:{}})
  console.log(JSON.stringify({diagnostic:'elicitation',approvalPolicy:params.approvalPolicy,forms,response:formResult.content}))
  assert.deepEqual(JSON.parse(formResult.content[0].text),{action:'accept',content:{answer:'test'}})
  assert.equal(forms[0]?.threadId,thread.thread.id)
  console.log(JSON.stringify({status:'passed',nativeThreadId:thread.thread.id,baseMcpServers:[],runtimeMcpServers:inventory.data.map(item=>item.name),initializationOffers,requests,forms,modelRequests:0}))
} finally {child?.kill('SIGTERM');await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true})}
