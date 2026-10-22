import {readAutoOpsHost} from './hostConfig'
export async function saveAutoOpsPlan(threadId:string,name:string,contents:string):Promise<{name:string;sourceUrl:string}>{
  const host=readAutoOpsHost()
  if(!host)throw new Error('项目资料接口不可用')
  const response=await fetch(`${host.gatewayBasePath}/autoops/plan-materials`,{
    method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-demo-csrf':host.csrfToken},
    body:JSON.stringify({threadId,name,contents}),
  })
  const result=await response.json() as {name:string;sourceUrl:string;error?:string}
  if(!response.ok)throw new Error(result.error||'计划保存失败，请重试')
  return result
}
