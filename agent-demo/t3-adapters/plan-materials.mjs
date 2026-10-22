import {AutoOpsAccessError} from './access.mjs'
import {resolveProductProfile} from './product-profile.mjs'

/** Save a canonical plan as an authorized business resource, never a host file. */
export function saveAuthorizedPlan({access,principal,input,projection,store}) {
  if (!resolveProductProfile().capabilities.planMode) throw new AutoOpsAccessError(403,'PRODUCT_CAPABILITY_DISABLED','精简版暂不开放计划资料生成')
  const binding=access.requireThread(principal,input.threadId)
  if(binding.compatibilityReadOnly||binding.nativeParentThreadId)throw new AutoOpsAccessError(403,'PLAN_READ_ONLY','当前会话仅供查看')
  if(typeof input.name!=='string'||input.name.length>160||!input.name.endsWith('.md')||/[\\/\x00-\x1f]/.test(input.name)||typeof input.contents!=='string'||Buffer.byteLength(input.contents)>1024*1024)
    throw new AutoOpsAccessError(400,'INVALID_PLAN_FILE','请输入 Markdown 文件名，不能包含目录')
  if(projection.thread.id!==binding.threadId||projection.thread.deletedAt!==null)throw new AutoOpsAccessError(404,'PLAN_NOT_FOUND','计划不存在或无权访问')
  const plan=projection.plans.find(p=>p.kind==='proposed_plan'&&p.runId&&`${p.markdown.trimEnd()}\n`===input.contents)
  if(!plan)throw new AutoOpsAccessError(409,'PLAN_CHANGED','计划已改变，请刷新后重新保存')
  // Current membership and visibility are checked immediately before the write.
  const current=access.requireThread(principal,input.threadId)
  return store.create({binding:current,runId:plan.runId,name:input.name,mime:'text/markdown',bytes:Buffer.from(input.contents,'utf8')})
}
