import { createServer, connect } from 'node:net'
import { spawn } from 'node:child_process'

// 容器没有外部网络，唯一模型出口是该会话只读挂载的私有 Unix socket。
const [cwd,command,...args]=process.argv.slice(2)
if(!cwd?.startsWith('/') || !command)process.exit(64)
const relay=createServer(client=>{
  const upstream=connect('/autoops/gateway/model.sock')
  client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy())
  client.pipe(upstream).pipe(client)
})
await new Promise((resolve,reject)=>{relay.once('error',reject);relay.listen(18766,'127.0.0.1',resolve)})
const child=spawn(command,args,{cwd,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/autoops',CODEX_HOME:'/home/autoops/.codex',LANG:'C.UTF-8'},stdio:'inherit'})
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal))
child.on('error',()=>{relay.close();process.exitCode=70})
child.on('exit',(code,signal)=>{relay.close();process.exitCode=code??(signal?128:70)})
