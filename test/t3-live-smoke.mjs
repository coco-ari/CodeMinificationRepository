import { T3LiveClient } from './helpers/t3-live-client.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
const client=new T3LiveClient(process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887')
try {
  const bootstrap=await client.login();await client.connect()
  const config=await client.rpc('server.getConfig')
  console.log(JSON.stringify({connected:true,model:bootstrap.fixedModel,configKeys:Object.keys(config)}))
  const {threadId}=await client.createThread('这是迁移后的首次真实连通验证。不要调用工具，只回复“T3 原生对话已接通”。')
  console.log(JSON.stringify({created:threadId}))
  const started=Date.now();let projection
  while(Date.now()-started<180000) {
    projection=await client.projection(threadId)
    const runs=projection.runs||[];const latest=runs.at(-1)
    if(latest&&['completed','failed','interrupted','cancelled'].includes(latest.status))break
    await new Promise(resolve=>setTimeout(resolve,1000))
  }
  await mkdir('.test-artifacts/t3-live',{recursive:true})
  await writeFile('.test-artifacts/t3-live/first-turn.json',JSON.stringify({threadId,projection},null,2))
  console.log(JSON.stringify({threadId,runs:projection?.runs?.map(({id,status,failure})=>({id,status,failure})),messages:projection?.messages?.map(({role,text})=>({role,text})),providerThreads:projection?.providerThreads?.map(({id,nativeThreadRef})=>({id,nativeThreadRef}))}))
}catch(error){console.error(JSON.stringify({message:error.message,detail:error.detail}));process.exitCode=1}finally{client.close()}
