// Adapted from OpenChamber, MIT License.
// Copyright (c) 2025 Bohdan Triapitsyn.
// openchamber/openchamber@6491f51dbcf05d1e3f7f823049f5f097c96c234b
// packages/ui/src/components/chat/composer/keyboardPolicy.ts
// Full license: /third-party/agent-demo-streaming-NOTICES.txt

export const shouldSubmitEnter = (input) => {
  const isCtrlEnter = input.ctrlKey || input.metaKey
  if (input.isMobile) return isCtrlEnter
  if (input.isDesktopExpanded) return isCtrlEnter
  const enterSendsByDefault = !input.isMobile
  if (!input.enterToSendConfigured) return !input.shiftKey && (enterSendsByDefault || isCtrlEnter)
  const sendsWithEnter = input.enterToSend && !input.shiftKey
  return isCtrlEnter || sendsWithEnter
}
