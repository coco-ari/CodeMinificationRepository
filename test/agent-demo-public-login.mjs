import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startBrowser } from './helpers/prototype-browser.mjs'

// 只检查公开登录页；不输入账号密码、不点击登录、不读取 Cookie 或浏览器业务存储。
assert(process.env.AGENT_DEMO_URL, '请设置公开登录页 AGENT_DEMO_URL')
process.env.PROTOTYPE_URL = process.env.AGENT_DEMO_URL
const output = path.resolve('.test-artifacts/agent-demo-public-login')
await mkdir(output, { recursive: true })
const report = {
  testedAt: new Date().toISOString(),
  mode: 'public-only',
  loginSubmitted: false,
  credentialsEntered: false,
  cookiesRead: false,
  freshBrowserProfile: true,
  sizes: [],
  failures: [],
  boundary: '独立桌面 Chrome 的尺寸模拟；不是 iOS Safari 或软键盘验收。',
}
let browser
try {
  browser = await startBrowser('agent-demo-public-login')
  await browser.visible('.workbench-demo-login')
  await browser.command('DOM.enable')
  await browser.command('CSS.enable')
  for (const [width, height] of [
    [390, 844],
    [1280, 900],
  ]) {
    await browser.viewport(width, height)
    await browser.evaluate(
      'document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))',
    )
    const state = await browser.evaluate(`(()=>{
      const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      return {
        width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,
        documentHeight:document.documentElement.scrollHeight,
        bodyFontFamily:getComputedStyle(document.body).fontFamily,
        loginFontFamily:getComputedStyle(document.querySelector('.workbench-demo-login')).fontFamily,
        card:rect(document.querySelector('.workbench-demo-login-card')),
        heading:{text:document.querySelector('.workbench-demo-login h1').textContent,rect:rect(document.querySelector('.workbench-demo-login h1'))},
        inputs:Array.from(document.querySelectorAll('.workbench-demo-login input')).map(n=>({
          label:n.getAttribute('aria-label'),fontSize:getComputedStyle(n).fontSize,
          fontFamily:getComputedStyle(n).fontFamily,lineHeight:getComputedStyle(n).lineHeight,
          rect:rect(n)
        })),
        buttons:Array.from(document.querySelectorAll('.workbench-demo-login button')).filter(n=>n.getClientRects().length).map(n=>({
          text:n.textContent.trim(),fontSize:getComputedStyle(n).fontSize,
          fontFamily:getComputedStyle(n).fontFamily,rect:rect(n)
        })),
        scripts:Array.from(document.scripts).map(n=>n.src).filter(Boolean),
        stylesheets:Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(n=>n.href)
      };
    })()`)
    const document = await browser.command('DOM.getDocument')
    const heading = await browser.command('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '.workbench-demo-login h1',
    })
    state.headingPlatformFonts = await browser.command('CSS.getPlatformFontsForNode', {
      nodeId: heading.nodeId,
    })
    const image = await browser.command('Page.captureScreenshot', { format: 'png' })
    state.screenshot = path.join(output, `login-${width}x${height}.png`)
    await writeFile(state.screenshot, Buffer.from(image.data, 'base64'))
    report.sizes.push(state)
    assert(state.documentWidth <= width, `${width}px 页面横向溢出`)
    assert(state.card.x >= 0 && state.card.right <= width, `${width}px 登录卡片横向裁切`)
    assert(state.card.y >= 0 && state.card.bottom <= height, `${width}px 登录卡片纵向裁切`)
    assert.match(state.bodyFontFamily, /^"?PingFang SC"?/)
    assert.equal(state.loginFontFamily, state.bodyFontFamily)
    assert.equal(state.inputs.length, 2)
    for (const input of state.inputs) {
      assert.equal(input.fontFamily, state.bodyFontFamily)
      assert(input.rect.x >= 0 && input.rect.right <= width, `${input.label} 横向裁切`)
      if (width < 768) {
        assert.equal(input.fontSize, '16px', `${input.label} 手机字号不是16px`)
        assert(
          input.rect.width >= 40 && input.rect.height >= 40,
          `${input.label} 手机触控区域小于40×40`,
        )
      }
    }
    assert(
      state.buttons.some((button) => button.text === '登录'),
      '缺少可见登录按钮',
    )
    for (const button of state.buttons) {
      assert(button.rect.x >= 0 && button.rect.right <= width, `${button.text} 按钮横向裁切`)
      assert(button.rect.y >= 0 && button.rect.bottom <= height, `${button.text} 按钮纵向裁切`)
      if (width < 768)
        assert(
          button.rect.width >= 40 && button.rect.height >= 40,
          `${button.text} 手机触控区域小于40×40`,
        )
    }
    assert(
      state.headingPlatformFonts.fonts.some(
        (font) => /PingFang/.test(font.familyName) && font.glyphCount >= 5,
      ),
      '中文标题没有使用可识别的 PingFang 字形',
    )
  }
} catch (error) {
  report.failures.push(error.stack)
} finally {
  if (browser) {
    report.runtimeErrors = browser.errors
    report.browserWarnings = browser.warnings
    await browser.close()
    report.ownChromeClosed = true
  }
  report.passed = report.failures.length === 0 && !report.runtimeErrors?.length
  report.testSha256 = createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex')
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({ passed: report.passed, report: path.join(output, 'report.json') }, null, 2),
  )
}
if (!report.passed) process.exitCode = 1
