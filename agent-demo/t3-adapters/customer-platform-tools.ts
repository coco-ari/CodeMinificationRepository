import { decodeContract } from '../../autoops/contracts/index.ts'
import { CustomerPlatformToolCall, type CustomerPlatformToolReference } from '../../autoops/contracts/customer-platform-tools.ts'
import { AutoOpsAccessError, type AutoOpsAccess } from './access.mjs'
import { createBusinessRunInputs } from './thread-inputs.ts'
import type { WorkspaceManagement } from './workspace-management.ts'
import type { EnvironmentMcp } from './environment-mcp/index.ts'
import { createAutoOpsBusinessTools } from './business-tools.mjs'
import { createBusinessResourceCatalog } from './resources.mjs'

/** 只协调既有资料及环境所有者；设备入口仍须核原命令、原生运行及当前调用者。 */
export function createCustomerPlatformTools(
  access: AutoOpsAccess,
  workspace: WorkspaceManagement,
  mcp: Pick<EnvironmentMcp,'readRun'|'invoke'>,
) {
  const inputs=createBusinessRunInputs(access,workspace)
  const environmentScope=(context:NonNullable<ReturnType<AutoOpsAccess['customerToolRun']>>)=>({
    actorId:context.scope.actorId,projectId:context.scope.projectId,environmentId:context.scope.configuration.environmentId,
    threadId:context.threadId,runId:context.runId,
  })
  return {
    async invoke(reference:CustomerPlatformToolReference,input:unknown,authorizeNative:()=>void|Promise<void>,signal?:AbortSignal) {
      const call=decodeContract(CustomerPlatformToolCall,input)
      await authorizeNative()
      const current=access.requireCustomerToolRun(reference),context=current.context
      if(!context.preparedAt)throw new AutoOpsAccessError(409,'CUSTOMER_TOOL_CONTEXT_PENDING','本轮平台工具输入尚未完成')
      const recheck=async()=>{await authorizeNative();const next=access.requireCustomerToolRun(reference);if(JSON.stringify(next.context)!==JSON.stringify(context))throw new AutoOpsAccessError(403,'CUSTOMER_TOOL_CONTEXT_CHANGED','本轮平台工具原件已改变')}
      let result:Record<string,unknown>
      if(call.tool==='query_environment')result={source:'environment_mcp_catalog',...mcp.readRun(environmentScope(context))}
      else if(call.tool==='read_environment')result={...await mcp.invoke(environmentScope(context),call.arguments.operation,signal)}
      else {
        if(!context.inputId||!current.binding.workspaceType)throw new AutoOpsAccessError(403,'CUSTOMER_TOOL_MATERIALS_NOT_SELECTED','本轮没有选择平台资料，不能默认读取内部资料')
        const authorized=inputs.require(context.threadId,context.inputId,context.runId),capture=authorized.capture
        const authorizeThread=(threadId:string,actorId?:string)=>{
          if(threadId!==context.threadId||(actorId!==undefined&&actorId!==context.scope.actorId))throw new AutoOpsAccessError(403,'CUSTOMER_TOOL_CONTEXT_FORBIDDEN','不能改变本轮工具调用者或线程')
          return access.requireCustomerToolRun(reference)
        }
        const tools=createAutoOpsBusinessTools({authorizeThread,materialInput:{id:capture.id,workspaceType:capture.workspaceType,createdAt:capture.createdAt,revision:capture.revision,sourceErrors:capture.sourceErrors??[],sourceWarnings:capture.sourceWarnings??[],repositories:capture.repositories.map(repository=>({path:repository.source.mountPath,commit:repository.commit})),files:workspace.inputFiles(capture.projectId,capture.id,context.scope.actorId).map(file=>({...file,name:file.path.split('/').at(-1)!})),read:async()=>{throw new Error('仅使用所属资料读取入口')}},loadAttachments:()=>[],loadAttachmentBytes:async()=>{throw new Error('此工具未开放附件')},storeArtifact:()=>{throw new Error('此工具未开放报告')},renderPdf:async()=>{throw new Error('此工具未开放报告')}})
        if(call.tool==='list_project_materials')result=await tools.listMaterials(context.threadId)
        else {
          const catalog=createBusinessResourceCatalog({access,workspaceInputs:workspace,authorizeToolThread:authorizeThread})
          result=await catalog.readForThread(context.threadId,call.arguments.path,context.inputId,[],{runId:context.runId,actorId:context.scope.actorId,referencePaths:[],attachmentIds:[],acceptedAt:context.createdAt})
        }
      }
      await recheck()
      return result
    },
  }
}
