import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {chromium} from '../vendor/t3code/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs'

const origin=process.env.AGENT_DEMO_URL||'http://192.168.31.157:18887'
if(new URL(origin).port==='8787'&&process.env.T3_PRODUCTION_SMOKE!=='1')throw Error('须显式选择正式入口验证')
const output=path.resolve(process.env.T3_SCROLL_OUTPUT||'.test-artifacts/t3-model-scroll/stage')
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true})
const report={origin,cases:[],errors:[],messageDispatches:0}
async function until(fn,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,80))}throw Error('等待菜单状态超时')}
async function makePage(options={}){
 const context=await browser.newContext({viewport:{width:1440,height:900},locale:'zh-CN',...options}),page=await context.newPage()
 page.on('pageerror',e=>report.errors.push(e.message))
 page.on('websocket',ws=>ws.on('framesent',frame=>{if(String(frame.payload).includes('"message.dispatch"'))report.messageDispatches++}))
 const draftUrl=origin+'/agent-demo.html#/draft/'+randomUUID()
 await page.goto(draftUrl);await page.getByRole('textbox',{name:'用户名'}).fill('admin');await page.getByLabel('密码',{exact:true}).fill(process.env.AGENT_DEMO_TEST_PASSWORD||'Demo123!');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByTestId('composer-editor').waitFor({timeout:60000})
 assert(new URL(page.url()).hash.startsWith('#/draft/'),'只操作本浏览器的独立草稿')
 return {context,page,draftUrl:page.url()}
}
const picker=page=>page.locator('button[data-chat-provider-model-picker="true"]:visible').first()
const menu=page=>page.locator('[data-model-picker-content="true"]')
const scroller=page=>menu(page).locator('[data-slot="combobox-list"] .scrollbar-gutter-stable')
const lastOption=page=>menu(page).getByRole('option').filter({has:page.getByText('Grok Build 0.1',{exact:true})})
async function metrics(page){return scroller(page).evaluate(e=>({top:e.scrollTop,client:e.clientHeight,total:e.scrollHeight,overflow:getComputedStyle(e).overflowY}))}
async function visibleInScroller(page,option){
 const s=await scroller(page).boundingBox(),o=await option.boundingBox();if(!s||!o)return false
 return o.y>=s.y-1&&o.y+o.height<=s.y+s.height+1&&await option.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})
}
async function open(page){await picker(page).click();await page.getByPlaceholder('搜索模型…',{exact:true}).waitFor();await until(async()=> (await metrics(page)).client>100)}
async function theme(page,draftUrl,dark){await page.goto(origin+'/agent-demo.html#/settings/appearance');await page.getByRole('button',{name:dark?'使用深色模式':'使用浅色模式',exact:true}).click();await page.goto(draftUrl);await picker(page).waitFor()}
async function run(name,fn,page){const entry={name};report.cases.push(entry);try{entry.result=await fn();entry.status='passed'}catch(e){entry.status='failed';entry.error=e.stack;entry.failureState=await menu(page).evaluate(root=>({html:root.outerHTML,active:document.activeElement?.outerHTML})).catch(()=>null);await page.screenshot({path:path.join(output,name+'-failed.png')}).catch(()=>{});throw e}finally{await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name,status:entry.status,error:entry.error}))}}
try{
 const {page,draftUrl}=await makePage()
 for(const [name,viewport,dark] of [
  ['desktop-light',{width:1440,height:900},false],['desktop-dark',{width:1440,height:900},true],
  ['narrow-light',{width:390,height:844},false],['narrow-dark',{width:390,height:844},true],
  ['short-desktop',{width:1100,height:480},false],['short-narrow',{width:390,height:480},true],
 ])await run(name,async()=>{
  await page.setViewportSize(viewport);await theme(page,draftUrl,dark);await open(page)
  const initial=await metrics(page);assert(initial.total>initial.client+100);assert.match(initial.overflow,/auto|scroll/)
  const popup=await menu(page).boundingBox();assert(popup.y>=-1);assert(popup.y+popup.height<=viewport.height+1);assert(popup.x>=-1&&popup.x+popup.width<=viewport.width+1)
  const box=await scroller(page).boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,1800)
  await until(async()=>{const m=await metrics(page);return m.top>100&&m.total-m.client-m.top<2})
  assert(await visibleInScroller(page,lastOption(page)),'真实滚动后最后一项完整可见且可点击')
  const bottom=await metrics(page);await page.screenshot({path:path.join(output,name+'-bottom.png')})
  await lastOption(page).click();await until(async()=>!(await menu(page).count()));assert((await picker(page).innerText()).includes('Grok Build 0.1'))
  await open(page);await page.mouse.move(0,0);await page.getByPlaceholder('搜索模型…').press('Home');await until(async()=> (await metrics(page)).top<2)
  await page.getByPlaceholder('搜索模型…').press('End');await until(()=>visibleInScroller(page,lastOption(page)));assert(await lastOption(page).evaluate(e=>e.hasAttribute('data-highlighted')))
  await page.keyboard.press('Enter');await until(async()=>!(await menu(page).count()))
  await open(page);await page.getByPlaceholder('搜索模型…').fill('Grok 4.6');await until(async()=>await menu(page).getByRole('option').count()===1)
  await menu(page).getByRole('option').click();await until(async()=>!(await menu(page).count()));assert((await picker(page).innerText()).includes('Grok 4.6'))
  await open(page);await page.getByPlaceholder('搜索模型…').fill('不存在的模型_SCROLL_EMPTY');await until(async()=>await menu(page).getByRole('option').count()===0);await page.getByPlaceholder('搜索模型…').fill('');await until(async()=> (await metrics(page)).total>(await metrics(page)).client+100)
  await page.keyboard.press('Escape');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth))
  return {viewport,dark,initial,bottom,wheelBottomSelectable:true,keyboardEndSelectable:true,searchAndClear:true,popupFits:true}
 },page)
 const touch=await makePage({viewport:{width:390,height:844},hasTouch:true,isMobile:true})
 await run('touch-swipe',async()=>{
  await open(touch.page);const initial=await metrics(touch.page),box=await scroller(touch.page).boundingBox(),cdp=await touch.context.newCDPSession(touch.page)
  const x=box.x+box.width/2,start=box.y+box.height-25,end=box.y+25
  for(let swipe=0;swipe<4;swipe++){
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:start}]})
   for(let step=1;step<=12;step++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start+(end-start)*step/12}]});await touch.page.waitForTimeout(16)}
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await touch.page.waitForTimeout(200)
  }
  await until(()=>visibleInScroller(touch.page,lastOption(touch.page)));const bottom=await metrics(touch.page);assert(bottom.top>100);await lastOption(touch.page).tap();await until(async()=>!(await menu(touch.page).count()));assert((await picker(touch.page).innerText()).includes('Grok Build 0.1'));await cdp.detach();return {initial,bottom,touchBottomSelectable:true}
 },touch.page)
 assert.deepEqual(report.errors,[]);assert.equal(report.messageDispatches,0)
}catch(e){report.fatal=e.stack;process.exitCode=1}
finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close()}
