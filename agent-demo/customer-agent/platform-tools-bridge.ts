// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- 连接程序拥有私有 Unix 通道、HTTP 预算和原生进程关闭边界，协议复用现有 Effect MCP。
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createRelay, connect, type Socket } from 'node:net'
import { chmod, lstat, mkdtemp, realpath, rmdir, unlink, link } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { once } from 'node:events'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as S from 'effect/Schema'
import { McpServer, McpProtocol, Tool, Toolkit } from 'effect/ai'
import * as HttpRouter from 'effect/http/HttpRouter'
import {
  CustomerPlatformToolParameters, isCustomerPlatformToolCall, isCustomerPlatformToolReference,
  type CustomerPlatformToolCall, type CustomerPlatformToolReference, type CustomerPlatformToolRequest,
} from '../../autoops/contracts/customer-platform-tools.ts'

export interface PlatformToolRun {
  readonly reference: CustomerPlatformToolReference
  readonly commandId: string
  readonly sessionId: string
  readonly runtimeEpoch: string
  readonly threadId: string
}
export interface CustomerPlatformToolsBridge {
  readonly endpoint: string
  readonly authorizationHeader: string
  readonly socketPath: string
  activate(run: PlatformToolRun): void
  clear(): void
  current(threadId: string): {endpoint: string; authorizationHeader: string; contextId: string} | undefined
  close(): Promise<void>
}
const failure = () => ({code: 'CUSTOMER_PLATFORM_TOOL_UNAVAILABLE', message: '本轮平台工具不可用，请核对原任务与当前授权'})
function abortable<T>(value:Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(failure())}
    signal.addEventListener('abort',abort,{once:true})
    value.then(result=>{signal.removeEventListener('abort',abort);resolve(result)},()=>{signal.removeEventListener('abort',abort);reject(failure())})
  })
}
const maximumInput = 128 * 1024
const maximumOutput = 1024 * 1024
const descriptions = {
  list_project_materials: '列出本轮已固定且获授权的项目资料。',
  read_project_material: '按列表返回的完整资料路径读取本轮授权资料；不接受宿主路径。',
  query_environment: '列出本轮固定环境实际可用的只读连接与操作。',
  read_environment: '读取本轮固定环境中明确允许的只读操作；不能更换环境或执行身份。',
}
const shared = {success: S.JsonObject, failure: S.Struct({code:S.String,message:S.String}), failureMode:'return' as const}
const toolkit = Toolkit.make(
  Tool.make('list_project_materials', {...shared, description:descriptions.list_project_materials, parameters:Tool.EmptyParams}).annotate(Tool.Readonly,true).annotate(Tool.Strict,true),
  Tool.make('read_project_material', {...shared, description:descriptions.read_project_material, parameters:CustomerPlatformToolParameters.read_project_material}).annotate(Tool.Readonly,true).annotate(Tool.Strict,true),
  Tool.make('query_environment', {...shared, description:descriptions.query_environment, parameters:Tool.EmptyParams}).annotate(Tool.Readonly,true).annotate(Tool.Strict,true),
  Tool.make('read_environment', {...shared, description:descriptions.read_environment, parameters:CustomerPlatformToolParameters.read_environment}).annotate(Tool.Readonly,true).annotate(Tool.Strict,true),
)
function validRun(run: PlatformToolRun): boolean {
  return isCustomerPlatformToolReference(run.reference) && [run.commandId,run.sessionId,run.runtimeEpoch,run.threadId].every(value=>typeof value==='string' && value.length>0 && value.length<=512 && !/[\x00-\x1f\x7f]/.test(value))
}
/** 本地 nonce 只保护该会话私有通道，不是中心设备或资源凭据。 */
export async function createCustomerPlatformToolsBridge(options: {
  callTool: (request: CustomerPlatformToolRequest, signal: AbortSignal) => Promise<unknown>
  /** 共享容器仅挂载本会话的既有私有目录；普通自用则创建独占目录。 */
  socketPath?: string
  container?: boolean
  requestTimeoutMs?: number
}): Promise<CustomerPlatformToolsBridge> {
  const timeout = options.requestTimeoutMs ?? 20_000
  if (!Number.isSafeInteger(timeout) || timeout<1 || timeout>20_000) throw new Error('平台工具预算无效')
  const directory = options.socketPath ? undefined : await realpath(await mkdtemp('/tmp/ao-tools-'))
  if(directory)await chmod(directory,0o700)
  const socketPath = options.socketPath ?? join(directory!, 'tools.sock')
  if(!isAbsolute(socketPath) || await realpath(dirname(socketPath))!==dirname(socketPath))throw new Error('平台工具通道路径无效')
  const parent = await lstat(dirname(socketPath))
  if(!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode&0o077)!==0 || parent.uid!==process.getuid?.())throw new Error('平台工具通道目录不受当前连接程序独占')
  let nonce = `Bearer ${randomBytes(32).toString('hex')}`
  type Generation={run:PlatformToolRun;controller:AbortController;sessions:Set<string>}
  type Protocol={handler:(request:Request)=>Promise<Response>;dispose:()=>Promise<void>}
  let active: (Generation & {protocol:Protocol}) | undefined
  const disposals = new Set<Promise<void>>()
  let closed = false, closeResult:Promise<void>|undefined, running=0
  const requests = new Set<Promise<void>>()
  const sockets = new Set<Socket>(), controllers = new Set<AbortController>()
  const invoke = (captured:Generation,call:CustomerPlatformToolCall) => Effect.tryPromise({
    try: async signal => {
      if(closed || active!==captured || !isCustomerPlatformToolCall(call))throw failure()
      const combined=AbortSignal.any([signal,captured.controller.signal,AbortSignal.timeout(timeout)])
      combined.throwIfAborted()
      const request:CustomerPlatformToolRequest={reference:captured.run.reference,commandId:captured.run.commandId,sessionId:captured.run.sessionId,runtimeEpoch:captured.run.runtimeEpoch,call}
      const result=await abortable(options.callTool(request,combined),combined)
      combined.throwIfAborted()
      if(active!==captured)throw failure()
      const encoded=JSON.stringify(result)
      if(typeof encoded!=='string' || Buffer.byteLength(encoded)>maximumOutput || !result || typeof result!=='object' || Array.isArray(result))throw failure()
      return S.decodeUnknownSync(S.JsonObject)(result)
    }, catch:()=>failure(),
  })
  const protocolFor=(captured:Generation):Protocol=>{
  const handlers=toolkit.toLayer({
    list_project_materials: args=>invoke(captured,{tool:'list_project_materials',arguments:args}),
    read_project_material: args=>invoke(captured,{tool:'read_project_material',arguments:args}),
    query_environment: args=>invoke(captured,{tool:'query_environment',arguments:args}),
    read_environment: args=>invoke(captured,{tool:'read_environment',arguments:args}),
  })
  return HttpRouter.toWebHandler(McpServer.toolkit(toolkit).pipe(
    Layer.provide(handlers), Layer.provideMerge(McpServer.layerHttp({
      name:'AutoOps 只读平台工具',version:'1',path:'/mcp',protocols:[McpProtocol.v2025_11_25,McpProtocol.v2025_06_18],allowSessionTermination:true,
    })),
  ),{disableLogger:true})
  }
  const reject=(response:ServerResponse,status:number)=>{response.writeHead(status,{'content-type':'application/json','connection':'close'});response.end(JSON.stringify(failure()))}
  const handle=async(request:IncomingMessage,response:ServerResponse)=>{
    const supplied=request.headers.authorization
    if(closed || request.url!=='/mcp' || request.headers.origin || !['POST','GET','DELETE'].includes(request.method??'') || typeof supplied!=='string' || Buffer.byteLength(supplied)!==Buffer.byteLength(nonce) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(nonce))){reject(response,403);return}
    const captured=active
    if(!captured){reject(response,403);return}
    if(running>=8){reject(response,429);return}
    running++
    const controller=new AbortController();controllers.add(controller)
    const timer=setTimeout(()=>controller.abort(),timeout)
    const terminate=()=>{request.destroy();response.destroy()}
    controller.signal.addEventListener('abort',terminate,{once:true})
    const abort=()=>{if(!response.writableEnded)controller.abort()}
    request.once('aborted',abort);response.once('close',abort)
    try {
      const chunks:Buffer[]=[];let size=0
      for await(const chunk of request){size+=chunk.length;if(size>maximumInput){reject(response,413);return}chunks.push(Buffer.from(chunk))}
      const headers=new Headers()
      for(const name of ['content-type','accept','mcp-session-id','mcp-protocol-version','last-event-id']){
        const value=request.headers[name];if(typeof value==='string')headers.set(name,value)
      }
      if(active!==captured){reject(response,403);return}
      if(request.method==='POST' && !request.headers['mcp-session-id'] && captured.sessions.size>=16){reject(response,429);return}
      const body=Buffer.concat(chunks)
      const result=await captured.protocol.handler(new Request('http://127.0.0.1/mcp',{method:request.method!,headers,signal:controller.signal,...(body.length?{body}: {})}))
      const session=result.headers.get('mcp-session-id')
      if(session)captured.sessions.add(session)
      if(request.method==='DELETE' && result.ok && typeof request.headers['mcp-session-id']==='string')captured.sessions.delete(request.headers['mcp-session-id'])
      const streaming=request.method==='GET' && result.headers.get('content-type')?.includes('text/event-stream')
      if(streaming){response.writeHead(result.status,Object.fromEntries(result.headers));response.flushHeaders()}
      const output:Buffer[]=[];let bytes=0
      if(result.body)for await(const part of result.body){
        controller.signal.throwIfAborted();bytes+=part.length;if(bytes>maximumOutput)throw failure()
        if(streaming){if(!response.write(part))await once(response,'drain',{signal:controller.signal})}
        else output.push(Buffer.from(part))
      }
      controller.signal.throwIfAborted()
      if(streaming)response.end()
      else {response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.concat(output))}
    } catch {if(!response.headersSent)reject(response,503);else response.destroy()}
    finally {clearTimeout(timer);controllers.delete(controller);request.off('aborted',abort);response.off('close',abort);controller.signal.removeEventListener('abort',terminate);running--}
  }
  const server=createServer((request,response)=>{
    const work=handle(request,response).catch(()=>{response.destroy()})
    requests.add(work);void work.finally(()=>requests.delete(work))
  })
  server.maxHeadersCount=24;server.headersTimeout=timeout;server.requestTimeout=timeout
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));if(sockets.size>16)socket.destroy()})
  // Node close 会删除 listen 名称；用私有绑定名加不覆盖的硬链接发布，避免误删被替换的公开通道。
  const boundDirectory=await realpath(await mkdtemp('/tmp/ao-tools-bind-'))
  await chmod(boundDirectory,0o700)
  const boundPath=join(boundDirectory,'socket')
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(boundPath,()=>{server.off('error',reject);resolve()})})
    await chmod(boundPath,0o600);await link(boundPath,socketPath);await unlink(boundPath)
  } catch(error) {
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()))
    await unlink(boundPath).catch(()=>{});await rmdir(boundDirectory)
    if(directory)await rmdir(directory)
    throw error
  }
  const identity=await lstat(socketPath)
  const relay=options.container ? undefined : createRelay(client=>{
    sockets.add(client);client.once('close',()=>sockets.delete(client))
    if(sockets.size>16){client.destroy();return}
    const upstream=connect(socketPath);sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream))
    client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy())
    client.pipe(upstream).pipe(client)
  })
  try {
    if(relay)await new Promise<void>((resolve,reject)=>{relay.once('error',reject);relay.listen(0,'127.0.0.1',()=>{relay.off('error',reject);resolve()})})
  } catch(error) {
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    const current=await lstat(socketPath).catch(()=>undefined)
    if(current?.ino===identity.ino && current.dev===identity.dev)await unlink(socketPath)
    await rmdir(boundDirectory);if(directory)await rmdir(directory)
    throw error
  }
  const address=relay?.address()
  const endpoint=`http://127.0.0.1:${typeof address==='object'&&address?address.port:18767}/mcp`
  const clear=()=>{
    const previous=active;active=undefined
    if(previous){
      previous.controller.abort();previous.sessions.clear()
      const closing=previous.protocol.dispose();disposals.add(closing)
      void closing.finally(()=>disposals.delete(closing)).catch(()=>{})
    }
  }
  return {endpoint,get authorizationHeader(){return nonce},socketPath,
    activate:run=>{
      if(closed || !validRun(run))throw new Error('平台工具原运行引用无效')
      clear();nonce=`Bearer ${randomBytes(32).toString('hex')}`
      // 每轮独立协议实例和 nonce；旧原生客户端不能借新 active 引用调用。
      const captured={run:structuredClone(run),controller:new AbortController(),sessions:new Set<string>()}
      active=Object.assign(captured,{protocol:protocolFor(captured)})
    },
    clear,
    current:threadId=>active?.run.threadId===threadId?{endpoint,authorizationHeader:nonce,contextId:active.run.reference.contextId}:undefined,
    close:()=>closeResult??=(async()=>{
      closed=true;clear();for(const controller of controllers)controller.abort()
      for(const socket of sockets)socket.destroy()
      await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),...(relay?[new Promise<void>(resolve=>relay.close(()=>resolve()))]:[])])
      await Promise.allSettled([...disposals]);await Promise.allSettled([...requests])
      const current=await lstat(socketPath).catch(()=>undefined)
      if(current?.ino===identity.ino && current.dev===identity.dev)await unlink(socketPath)
      await rmdir(boundDirectory)
      if(directory)await rmdir(directory)
    })(),
  }
}
