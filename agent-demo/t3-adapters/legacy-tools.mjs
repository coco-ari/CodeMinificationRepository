import { configuredAutoOpsAccess } from './access.mjs'
export const LEGACY_BUSINESS_TOOLS=Object.freeze(['list_project_materials','read_project_document','read_attachment','query_environment','ask_user','create_report'])
export function requireLegacyBusinessTool(appThreadId,nativeThreadId,tool,namespace,access=configuredAutoOpsAccess()) {
  if(!access || (namespace!==null && namespace!==undefined) || !LEGACY_BUSINESS_TOOLS.includes(tool)) throw new Error('未授权的旧版业务工具')
  const {binding}=access.requireToolThread(appThreadId)
  if(binding.nativeParentThreadId || binding.compatibilityReadOnly || !binding.continuationVerified || binding.nativeThreadId!==nativeThreadId) throw new Error('旧版工具缺少可靠的原生续接绑定')
  return {server:'t3-code',tool}
}
export function recordLegacyNativeFork(sourceThreadId,targetThreadId,sourceNativeId,targetNativeId,access=configuredAutoOpsAccess()) {
  if(access && sourceThreadId) access.recordLegacyNativeFork(sourceThreadId,targetThreadId,sourceNativeId,targetNativeId)
}
