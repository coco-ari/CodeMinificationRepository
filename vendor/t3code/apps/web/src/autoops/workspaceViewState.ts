import { readAutoOpsHost } from './hostSnapshot'

const selectionKey = (key: string) =>
  `autoops:workspaces:${readAutoOpsHost()?.principal.id ?? ''}:${key}`
export function readSelection(key: string) {
  try {
    return sessionStorage.getItem(selectionKey(key))
  } catch {
    return null
  }
}
export function saveSelection(key: string, value: string) {
  try {
    sessionStorage.setItem(selectionKey(key), value)
  } catch {
    /* 浏览器存储不可用时仍可查看当前页面。 */
  }
}
