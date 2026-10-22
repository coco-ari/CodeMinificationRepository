import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startBrowser } from './helpers/prototype-browser.mjs'

// 模拟 EasyList 的两条 cosmetic 规则；不安装或控制用户的广告过滤扩展。
// 全程仅操作公开登录页，不填写凭据、不提交登录、不读取 Cookie 或业务存储。
assert(process.env.AGENT_DEMO_URL, '请设置公开登录页 AGENT_DEMO_URL')
process.env.PROTOTYPE_URL = process.env.AGENT_DEMO_URL
const expectCollision = process.env.EXPECT_FILTER_COLLISION === '1'
const output = path.resolve(
  process.env.AGENT_DEMO_FILTER_EVIDENCE_DIR ||
    `.test-artifacts/agent-demo-filter-compat/${expectCollision ? 'before' : 'after'}`,
)
await mkdir(output, { recursive: true })
const cosmeticCSS = '.ad-field,.ad-context {display:none!important}'
const report = {
  testedAt: new Date().toISOString(),
  url: process.env.AGENT_DEMO_URL,
  mode: expectCollision ? 'expected-collision-reproduction' : 'fixed-public-login-regression',
  loginSubmitted: false,
  credentialsEntered: false,
  cookiesRead: false,
  businessStorageRead: false,
  freshBrowserProfile: true,
  filterSimulation: {
    method: 'CDP CSS.createStyleSheet + CSS.setStyleSheetText',
    css: cosmeticCSS,
    source:
      'https://raw.githubusercontent.com/easylist/easylist/master/easylist/easylist_general_hide.txt',
    rules: ['##.ad-field', '##.ad-context'],
    extensionInstalled: false,
  },
  sizes: [],
  failures: [],
  boundary:
    '独立桌面 Chrome 使用公开登录页和两条已确认的 EasyList 样式规则模拟；不是完整过滤列表、用户扩展、真实 Windows 或 iOS Safari 验收。',
}

const stateExpression = `(() => {
  const rect = element => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
  };
  const visible = element => {
    if (!element || !element.getClientRects().length) return false;
    const r = element.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (let n = element; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const inputs = ['用户名','密码'].map(name => {
    const input = document.querySelector('input[aria-label="' + name + '"]');
    const label = input && Array.from(document.querySelectorAll('label')).find(n => n.htmlFor === input.id);
    return {
      name,exists:!!input,id:input?.id,visible:visible(input),rect:rect(input),
      disabled:input?.disabled,readOnly:input?.readOnly,
      parentClass:input?.parentElement.className,
      parentDisplay:input ? getComputedStyle(input.parentElement).display : null,
      label:{exists:!!label,text:label?.textContent.trim(),visible:visible(label),rect:rect(label)}
    };
  });
  const button = document.querySelector('form button[type="submit"]');
  const heading = Array.from(document.querySelectorAll('h1')).find(n => n.textContent.trim() === '登录工作台');
  const card = heading?.closest('[data-slot="card"]');
  return {
    width:innerWidth,height:innerHeight,
    documentWidth:document.documentElement.scrollWidth,
    documentHeight:document.documentElement.scrollHeight,
    card:rect(card),headingVisible:visible(heading),inputs,
    button:{exists:!!button,visible:visible(button),disabled:button?.disabled,rect:rect(button)},
    scripts:Array.from(document.scripts).map(n=>n.src).filter(Boolean),
    stylesheets:Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(n=>n.href)
  };
})()`

function assertInside(rect, width, height, name) {
  assert(rect, `${name} 没有布局矩形`)
  assert(rect.x >= 0 && rect.right <= width + 1, `${name} 横向裁切`)
  assert(rect.y >= 0 && rect.bottom <= height + 1, `${name} 纵向裁切`)
}

let browser
try {
  browser = await startBrowser(`agent-demo-filter-compat-${expectCollision ? 'before' : 'after'}`)
  await browser.visible('input[aria-label="用户名"]')
  await browser.visible('input[aria-label="密码"]')
  await browser.viewport(1280, 900)
  await browser.evaluate('document.fonts.ready')
  report.beforeSimulation = await browser.evaluate(stateExpression)
  for (const input of report.beforeSimulation.inputs) {
    assert(input.visible && input.label.visible, `${input.name} 在模拟过滤前已不可见`)
  }
  await browser.command('DOM.enable')
  await browser.command('CSS.enable')
  const { frameTree } = await browser.command('Page.getFrameTree')
  const { styleSheetId } = await browser.command('CSS.createStyleSheet', {
    frameId: frameTree.frame.id,
  })
  await browser.command('CSS.setStyleSheetText', { styleSheetId, text: cosmeticCSS })

  for (const [width, height] of [
    [390, 844],
    [1280, 900],
  ]) {
    await browser.viewport(width, height)
    await browser.evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
    const state = await browser.evaluate(stateExpression)
    report.sizes.push(state)
    const image = await browser.command('Page.captureScreenshot', { format: 'png' })
    state.screenshot = path.join(output, `login-filter-${width}x${height}.png`)
    await writeFile(state.screenshot, Buffer.from(image.data, 'base64'))

    assert(state.headingVisible, '登录标题不可见')
    assert(state.button.visible, '登录按钮不可见')
    assert(state.button.disabled, '未填密码时登录按钮应禁用')
    assert(state.documentWidth <= width + 1, `${width}px 页面横向溢出`)
    assert(state.documentHeight <= height + 1, `${width}px 页面纵向溢出`)
    assertInside(state.card, width, height, '登录卡片')
    assert.equal(state.inputs.length, 2)
    for (const input of state.inputs) {
      assert(input.exists && input.label.exists, `${input.name} 或其 label 缺失`)
      if (expectCollision) {
        assert.equal(input.visible, false, `${input.name} 未重现过滤隐藏`)
        assert.equal(input.label.visible, false, `${input.name} label 未重现过滤隐藏`)
        assert.equal(input.parentDisplay, 'none', `${input.name} 父容器没有被过滤规则隐藏`)
      } else {
        assert(input.visible && input.label.visible, `${input.name} 或其 label 被过滤规则隐藏`)
        assert.equal(input.disabled, false, `${input.name} 被禁用`)
        assert.equal(input.readOnly, false, `${input.name} 只读`)
        assertInside(input.rect, width, height, input.name)
        assertInside(input.label.rect, width, height, `${input.name} label`)
        const inputSelector = `input[aria-label="${input.name}"]`
        const labelSelector = `label[for="${input.id}"]`
        await browser.click(inputSelector)
        input.clickFocused = await browser.evaluate(
          `document.activeElement === document.querySelector(${JSON.stringify(inputSelector)})`,
        )
        assert(input.clickFocused, `${input.name} 无法通过点击聚焦`)
        await browser.evaluate('document.activeElement.blur()')
        await browser.click(labelSelector)
        input.labelFocusedInput = await browser.evaluate(
          `document.activeElement === document.querySelector(${JSON.stringify(inputSelector)})`,
        )
        assert(input.labelFocusedInput, `${input.name} label 未聚焦关联输入框`)
      }
    }
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
