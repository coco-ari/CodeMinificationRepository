import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {chromium} from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'
import {T3LiveClient} from './helpers/t3-live-client.mjs'
if(process.env.T3_IMAGES_LIVE!=='1')throw Error('Set T3_IMAGES_LIVE=1 for actual vision-model test')
const origin=process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887';assert.notEqual(new URL(origin).port,'8787')
const output='.test-artifacts/t3-live/images.json',report={startedAt:new Date().toISOString(),origin,kind:'actual-native-image-and-history'}
const c=new T3LiveClient(origin),browser=await chromium.launch({headless:true})
const snapshot=async id=>(await c.http(`/api/orchestration/threads/${id}`)).projection
async function finish(id,ordinal){for(let i=0;i<180;i++){let p=await snapshot(id),r=p.runs.find(x=>x.ordinal===ordinal);if(r&&['completed','failed','interrupted','cancelled'].includes(r.status)){assert.equal(r.status,'completed');return p}await new Promise(r=>setTimeout(r,800))}throw Error('Image native turn timeout')}
try{
 await mkdir('.test-artifacts/t3-live',{recursive:true});const page=await browser.newPage({viewport:{width:560,height:260}})
 await page.setContent('<html><body style="margin:0;background:#fff;font:54px sans-serif"><div style="padding:32px">AUTOOPS <b>5729</b></div><div style="display:flex;height:100px"><i style="background:#1a9c42;width:50%"></i><i style="background:#e33434;width:50%"></i></div></body></html>')
 const bytes=await page.screenshot();await writeFile('.test-artifacts/t3-live/vision-fixture.png',bytes)
 await c.login();await c.connect();const {threadId}=await c.createThread('稍后会上传一张验收图片。现在只回复“准备查看”。',{title:'T3真实历史图片验收'});report.threadId=threadId;await finish(threadId,1)
 const metadata={type:'image',name:'vision-fixture.png',mimeType:'image/png',sizeBytes:bytes.length},upload=await c.rpc('attachments.createUploadUrl',metadata)
 const response=await fetch(origin+'/api/agent-demo/t3'+upload.relativeUrl,{method:'POST',headers:{cookie:c.cookie,origin,'content-type':'application/octet-stream','x-demo-csrf':c.bootstrap.csrfToken},body:bytes});assert.ok(response.ok)
 await c.rpc('orchestration.dispatchCommand',{type:'message.dispatch',createdBy:'user',creationSource:'web',commandId:randomUUID(),threadId,messageId:randomUUID(),text:'请直接查看本次图片，回答图中四位数字及下方两个色块从左到右的颜色。不要根据文件名猜测，不调用外部工具。',attachments:[{...metadata,id:upload.attachmentId}],modelSelection:c.bootstrap.fixedModel,dispatchMode:{type:'start_immediately'}})
 let p=await finish(threadId,2),answer=p.messages.filter(x=>x.runId===p.runs.at(-1).id&&x.role==='assistant').map(x=>x.text).join('\n');assert.match(answer,/5729/);assert.match(answer,/绿/);assert.match(answer,/红/)
 report.firstImageAnswer=answer;report.nativeThread=p.providerThreads[0].nativeThreadRef;report.attachment=p.messages.flatMap(x=>x.attachments).find(x=>x.type==='image')
 c.close();await c.connect();await c.send(threadId,'请回看上轮图片（本轮不再上传），再次回答图中四位数字和左侧色块颜色。')
 p=await finish(threadId,3);answer=p.messages.filter(x=>x.runId===p.runs.at(-1).id&&x.role==='assistant').map(x=>x.text).join('\n');assert.match(answer,/5729/);assert.match(answer,/绿/);assert.equal(p.providerThreads[0].nativeThreadRef.nativeId,report.nativeThread.nativeId)
 report.historyAnswer=answer;const file=await fetch(origin+`/api/agent-demo/t3/autoops/attachments/${encodeURIComponent(report.attachment.id)}`,{headers:{cookie:c.cookie,origin}});assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes)
 report.persistedBytes=bytes.length;report.status='passed'
}catch(error){report.status='failed';report.error=error.message;report.detail=error.detail;process.exitCode=1}finally{c.close();await browser.close();report.completedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,threadId:report.threadId}))}
