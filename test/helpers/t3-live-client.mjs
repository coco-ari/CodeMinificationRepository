import WebSocket from '../../vendor/t3code/node_modules/.pnpm/ws@8.22.0_bufferutil@4.1.0_utf-8-validate@6.0.6/node_modules/ws/wrapper.mjs'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

export class T3LiveClient {
  constructor(origin) { this.origin=origin;this.pending=new Map();this.next=0;this.events=[] }
  async login(username='admin',password=process.env.AGENT_DEMO_TEST_PASSWORD||'Demo123!') {
    const response=await fetch(this.origin+'/api/agent-demo/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})})
    if(!response.ok)throw new Error(`Login failed ${response.status}`)
    this.cookie=response.headers.get('set-cookie')?.split(';')[0]
    this.bootstrap=await this.http('/autoops/bootstrap')
    return this.bootstrap
  }
  async http(path,method='GET',data) {
    const response=await fetch(this.origin+'/api/agent-demo/t3'+path,{method,headers:{cookie:this.cookie,origin:this.origin,'content-type':'application/json','x-t3-orchestration-protocol':'2',...(this.bootstrap?{'x-demo-csrf':this.bootstrap.csrfToken}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})})
    const body=await response.json()
    if(!response.ok)throw Object.assign(new Error(`HTTP ${response.status}: ${body.code||body.error}`),{status:response.status})
    return body
  }
  async connect() {
    const url=new URL(this.origin+'/api/agent-demo/t3/ws?orchestrationProtocol=2');url.protocol=url.protocol==='https:'?'wss:':'ws:'
    const socket=this.socket=new WebSocket(url,{headers:{cookie:this.cookie,origin:this.origin}})
    socket.on('message',(bytes)=>{const decoded=JSON.parse(bytes.toString());for(const message of Array.isArray(decoded)?decoded:[decoded])this.receive(message)})
    socket.on('error',()=>{})
    socket.on('close',()=>{for(const entry of this.pending.values())entry.reject(new Error('Native RPC disconnected'));this.pending.clear()})
    await once(socket,'open')
    return this
  }
  receive(message) {
    if(message._tag==='Ping')return this.socket.send(JSON.stringify({_tag:'Pong'}))
    const entry=this.pending.get(String(message.requestId))
    if(!entry)return
    if(message._tag==='Chunk') {
      for(const value of message.values||[]) {this.events.push({at:Date.now(),method:entry.method,value});entry.onValue?.(value)}
      this.socket.send(JSON.stringify({_tag:'Ack',requestId:message.requestId}));return
    }
    if(message._tag==='Exit') {
      clearTimeout(entry.timer);this.pending.delete(String(message.requestId))
      if(message.exit?._tag==='Success')entry.resolve(message.exit.value)
      else entry.reject(Object.assign(new Error(`Native RPC ${entry.method} failed`),{detail:message.exit}))
    }
  }
  rpc(method,payload={},options={}) {
    const id=String(++this.next)
    const result=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Native RPC timeout ${method}`))},options.timeout??30000)
      timer.unref();this.pending.set(id,{method,resolve,reject,timer,onValue:options.onValue})
      this.socket.send(JSON.stringify({_tag:'Request',id,tag:method,payload,headers:[]}))
    })
    return result
  }
  async createThread(text,{projectId='p-autoops',environmentId='env-test',visibility='private',title='T3迁移真实验收'}={}) {
    const threadId=randomUUID()
    await this.http('/autoops/thread-bindings','POST',{threadId,projectId,environmentId,agentId:'a-project',visibility})
    const result=await this.rpc('orchestration.launchThread',{commandId:randomUUID(),threadId,projectId,title,generateTitle:false,modelSelection:this.bootstrap.fixedModel,runtimeMode:'approval-required',interactionMode:'default',workspaceStrategy:{type:'root'},initialMessage:{messageId:randomUUID(),text,attachments:[]}}, {timeout:60000})
    return {threadId,result}
  }
  async send(threadId,text,dispatchMode={type:'start_immediately'}) {
    return this.rpc('orchestration.dispatchCommand',{type:'message.dispatch',createdBy:'user',creationSource:'web',commandId:randomUUID(),threadId,messageId:randomUUID(),text,attachments:[],modelSelection:this.bootstrap.fixedModel,dispatchMode})
  }
  projection(threadId) {return this.rpc('orchestration.getThreadProjection',{threadId})}
  close() {this.socket?.close()}
}
