import { createServer, connect } from 'node:net'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** 两条本机会话出口分别连接独占 UDS；不接收模型选择的地址或端口。 */
export function createSessionRelay(socketPath) {
  const connections=new Set()
  const server=createServer(client=>{
    if(connections.size>=32){client.destroy();return}
    connections.add(client);client.once('close',()=>connections.delete(client))
    const upstream=connect(socketPath)
    connections.add(upstream);upstream.once('close',()=>connections.delete(upstream))
    client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy())
    client.once('close',()=>upstream.destroy());upstream.once('close',()=>client.destroy())
    client.pipe(upstream).pipe(client)
  })
  return {server,close:()=>{for(const socket of connections)socket.destroy();server.close()}}
}
async function main() {
  // 容器没有外部网络；模型和平台工具分别使用本会话只读挂载的私有 Unix socket。
  const [cwd,command,...args]=process.argv.slice(2)
  if(!cwd?.startsWith('/') || !command){process.exitCode=64;return}
  const model=createSessionRelay('/autoops/gateway/model.sock')
  // 无中心固定引用时宿主不创建 tools.sock，任何工具连接都会明确失败。
  const tools=createSessionRelay('/autoops/gateway/tools.sock')
  const close=()=>{model.close();tools.close()}
  try {
    for(const [server,port] of [[model.server,18766],[tools.server,18767]])await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
    const child=spawn(command,args,{cwd,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/autoops',CODEX_HOME:'/home/autoops/.codex',LANG:'C.UTF-8'},stdio:'inherit'})
    for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal))
    child.on('error',()=>{close();process.exitCode=70})
    child.on('exit',(code,signal)=>{close();process.exitCode=code??(signal?128:70)})
  } catch {close();process.exitCode=70}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await main()
