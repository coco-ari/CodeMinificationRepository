// Exercise the real primary-action selector. Never write the saved preference
// or call the API in place of choosing the action in the visible interface.
export async function clickComposerAction(browser, delivery) {
  const label =
    delivery === 'steer' ? '引导当前执行' : delivery === 'queue' ? '排队到下一轮' : '发送'
  const selector = `[aria-label="${label}"]`
  const available = await browser.evaluate(
    `Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`,
  )
  if (!available && delivery !== 'send') {
    await browser.click('[aria-label="选择运行中发送方式"]')
    await browser.clickText(label, '[role="menuitemradio"]')
  }
  await browser.click(selector)
}

export async function expandQueue(browser) {
  const selector = '[aria-label="展开下一轮队列"]'
  const open = await browser.evaluate(
    'Boolean(document.querySelector(\'[aria-label="收起下一轮队列"]\')?.getClientRects().length)',
  )
  if (open) return
  // The backend receipt may precede the SSE commit that adds the second row.
  await browser.visible(selector)
  await browser.click(selector)
}
