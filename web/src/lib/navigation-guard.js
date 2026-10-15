const guards = new Map()
let handler
export function registerGuard(key, isDirty) {
  guards.set(key, isDirty)
  return () => guards.delete(key)
}
export function setGuardHandler(next) {
  handler = next
  return () => {
    if (handler === next) handler = undefined
  }
}
export function hasUnsavedChanges() {
  return [...guards.values()].some((isDirty) => isDirty())
}
export function navigateSafely(action) {
  if (hasUnsavedChanges() && handler)
    handler(() => {
      guards.clear()
      action()
    })
  else action()
}
