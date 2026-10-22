import { until } from './prototype-browser.mjs'

// Hover through CDP. Calling HTMLElement.click() would bypass both the pointer
// policy and the actual dropdown/sheet trigger composition under regression.
export async function hoverMessageAction(browser, selector) {
  await browser.visible(selector)
  await browser.evaluate(`new Promise(resolve=>{
    document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});
    requestAnimationFrame(()=>requestAnimationFrame(resolve));
  })`)
  const point = await browser.evaluate(`(()=>{
    const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`)
  await browser.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await until(
    () =>
      browser.evaluate(`(()=>{
      const row=document.querySelector(${JSON.stringify(selector)})?.closest('.workbench-demo-message-action-icons');
      return row && getComputedStyle(row).opacity === '1' && getComputedStyle(row).pointerEvents === 'auto';
    })()`),
    `消息操作悬停可交互：${selector}`,
  )
}

export async function clickMessageAction(browser, selector) {
  await hoverMessageAction(browser, selector)
  await browser.click(selector)
}

export const movePointerOutsideMessages = (browser) =>
  browser.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 })
