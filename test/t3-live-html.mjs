import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {chromium} from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
const origin=process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887'
const id=process.env.T3_HTML_THREAD||'bc76339b-989d-4059-a326-c7e9dbb99be6'
const c=new T3LiveClient(origin),other=new T3LiveClient(origin),browser=await chromium.launch({headless:true})
const report={origin,threadId:id,kind:'readonly-real-native-html-browser',startedAt:new Date().toISOString(),pageErrors:[]}
try{
 await c.login();await c.connect();await other.login('lin')
 const p=(await c.http(`/api/orchestration/threads/${id}`)).projection
 assert.equal(p.runs.at(-1).status,'completed')
 const tools=p.turnItems.filter(x=>x.type==='dynamic_tool'),render=tools.find(x=>x.toolName?.includes('html_render')&&x.status==='completed')
 assert.ok(tools.some(x=>x.toolName?.includes('html_preview')&&x.status==='completed'));assert.ok(render)
 const {item}=await c.rpc('orchestration.getTurnItem',{threadId:id,itemId:render.id})
 const output=item.output;assert.ok(output.htmlRender?.attachmentId)
 const url=await c.rpc('assets.createUrl',{resource:{_tag:'attachment',attachmentId:output.htmlRender.attachmentId,fileName:'验收计数器.html',mimeType:'text/html',disposition:'inline'}})
 const resource=origin+'/api/agent-demo/t3'+url.relativeUrl
 const response=await fetch(resource,{headers:{cookie:c.cookie,origin}});assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/)
 const denied=await fetch(resource,{headers:{cookie:other.cookie,origin}});assert.ok([403,404].includes(denied.status))
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 await context.addCookies([{name:'demo_session',value:c.cookie.slice('demo_session='.length),url:origin}]);const page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message))
 const config=await c.rpc('server.getConfig'),environmentId=config.environment.environmentId
 await page.goto(`${origin}/agent-demo.html#/${environmentId}/${id}`)
 // Locate the original HTML result frame by its rendered document rather than
 // replacing it with test markup or bypassing the native host.
 let actual;for(let i=0;i<120;i++){actual=page.frames().find(f=>f!==page.mainFrame()&&f.url().includes('/api/assets/'));if(actual&&await actual.getByRole('button',{name:'验收加一'}).count())break;await new Promise(r=>setTimeout(r,250))}
 assert.ok(actual,'No native rendered HTML frame');await actual.getByRole('button',{name:'验收加一'}).click();assert.equal(await actual.locator('#count').innerText(),'1')
 await page.screenshot({path:'.test-artifacts/t3-live/html-native-counter.png'})
 report.toolEvents=tools.map(({toolName,status})=>({toolName,status}));report.attachmentId=output.htmlRender.attachmentId;report.privateOtherStatus=denied.status;report.counterAfterClick=1;report.status='passed'
 await context.close()
}catch(error){report.status='failed';report.error=error.message;report.detail=error.detail;process.exitCode=1}finally{c.close();other.close();await browser.close();report.completedAt=new Date().toISOString();await writeFile('.test-artifacts/t3-live/html-v4-followup.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error}))}
