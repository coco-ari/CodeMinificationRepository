// @effect-diagnostics nodeBuiltinImport:off -- 此业务边界只用同步摘要生成幂等标识，异步执行仍由 T3 管理。
import { createHash } from 'node:crypto'
import { AutoOpsAccessError, configuredAutoOpsAccess, type AutoOpsAccess } from './access.mjs'
import { configuredWorkspaceManagement, type WorkspaceManagement } from './workspace-management.ts'
import { configuredEnvironmentMcp } from './environment-mcp-runtime.ts'
import { environmentRunScope } from './environment-run-inputs.ts'

type WorkspaceInputs = Pick<
  WorkspaceManagement,
  'captureAgentInput' | 'readInput' | 'inputFiles' | 'readInputFile' | 'readInputContent' | 'retainInputForNativeBinding'
>

export function createBusinessRunInputs(access: AutoOpsAccess, workspace: WorkspaceInputs) {
  return {
    async prepare(
      threadId: string,
      runId: string,
      inheritedRunId?: string,
      signal?: AbortSignal,
      messageId?: string,
      editCommandId?: string,
      modelSelection?: unknown,
    ) {
      const existing = access.getRunInput(threadId, runId)
      if (existing && !existing.actorVerified)
        throw new AutoOpsAccessError(
          409,
          'THREAD_ACTOR_UNVERIFIED',
          '旧共享任务缺少可核验的实际调用者，不能继承创建者执行权限',
        )
      if (existing) {
        const scope = access.requireRunInputThread(threadId, existing.actorId,runId)
        access.requireQuestionForActor(existing.actorId, threadId, modelSelection)
        if (messageId) {
          try {
            if (
              (editCommandId
                ? access.requireQueuedEditActor(threadId, editCommandId, runId)
                : access.requireMessageActor(threadId, messageId)
              ).actorId !== existing.actorId
            )
              throw new AutoOpsAccessError(409, 'THREAD_INPUT_CONFLICT', '任务已固定其他调用者')
          } catch (error) {
            if (!(error instanceof AutoOpsAccessError) || error.code !== 'MESSAGE_ACTOR_MISSING')
              throw error
          }
        }
        workspace.retainInputForNativeBinding({projectId:scope.binding.projectId,inputId:existing.inputId,inputOwnerId:existing.inputOwnerId,workspaceType:scope.binding.workspaceType??'internal'})
        return workspace.readInput(scope.binding.projectId, existing.inputId, existing.inputOwnerId)
      }
      const original = inheritedRunId ? access.getRunInput(threadId, inheritedRunId) : undefined
      if (original && !original.actorVerified)
        throw new AutoOpsAccessError(
          409,
          'THREAD_ACTOR_UNVERIFIED',
          '原共享任务缺少可核验的实际调用者，不能生成恢复执行身份',
        )
      if (inheritedRunId && !original)
        throw new AutoOpsAccessError(
          409,
          'THREAD_INPUT_MISSING',
          '恢复任务的原资料输入不存在，不能改读最新内容',
        )
      let actorId: string
      try {
        if (!messageId)
          throw new AutoOpsAccessError(409, 'MESSAGE_ACTOR_MISSING', '消息缺少可信调用者记录')
        actorId = (
          editCommandId
            ? access.requireQueuedEditActor(threadId, editCommandId, runId)
            : access.requireMessageActor(threadId, messageId)
        ).actorId
      } catch (error) {
        // 既有已接受任务只能按其持久收据恢复；新任务没有调用者记录时拒绝继承创建者身份。
        if (
          !(error instanceof AutoOpsAccessError) ||
          error.code !== 'MESSAGE_ACTOR_MISSING' ||
          !original
        )
          throw error
        actorId = original.actorId
      }
      const { binding } = access.requireRunInputThread(threadId, actorId,runId)
      access.requireQuestionForActor(actorId, threadId, modelSelection)
      if (original) {
        workspace.retainInputForNativeBinding({projectId:binding.projectId,inputId:original.inputId,inputOwnerId:original.inputOwnerId,workspaceType:binding.workspaceType??'internal'})
        const captured = workspace.readInput(
          binding.projectId,
          original.inputId,
          original.inputOwnerId,
        )
        access.bindRunInput(threadId, runId, captured.id, actorId, original.inputOwnerId)
        return captured
      }
      const requestId =
        'agent-run-' +
        createHash('sha256')
          .update(JSON.stringify([threadId, runId, actorId]))
          .digest('hex')
      const created=access.recordRunInputRequest(threadId,runId,requestId,actorId)
      const captured = await workspace.captureAgentInput(
        binding.projectId,
        { requestId, workspaceType: binding.workspaceType ?? 'internal' },
        actorId,
        signal,
        !created,
      )
      access.completeRunInputRequest({threadId,runId,projectId:binding.projectId,requestId,actorId,workspaceType:binding.workspaceType??'internal'},captured.id)
      access.requireRunInputThread(threadId, actorId,runId)
      access.requireQuestionForActor(actorId, threadId, modelSelection)
      access.bindRunInput(threadId, runId, captured.id, actorId)
      workspace.retainInputForNativeBinding({projectId:binding.projectId,inputId:captured.id,inputOwnerId:actorId,workspaceType:binding.workspaceType??'internal'})
      return captured
    },
    require(threadId: string, inputId: string, runId?: string) {
      const input = access.requireRunInput(threadId, inputId, runId)
      const scope = access.requireRunInputThread(threadId, input.actorId,input.runId)
      const capture = workspace.readInput(
        scope.binding.projectId,
        input.inputId,
        input.inputOwnerId,
      )
      if (capture.workspaceType !== (scope.binding.workspaceType ?? 'internal'))
        throw new AutoOpsAccessError(
          403,
          'THREAD_INPUT_FORBIDDEN',
          '资料输入不属于当前内部或外部范围',
        )
      return { ...scope, input, capture }
    },
  }
}

export async function prepareBusinessRunContext(
  threadId: string,
  runId: string,
  inheritedRunId?: string,
  signal?: AbortSignal,
  messageId?: string,
  editCommandId?: string,
  modelSelection?: unknown,
) {
  const access = configuredAutoOpsAccess()
  if (!access) return undefined
  const binding = access.getThreadBinding(threadId)
  if (binding?.executionBinding.kind === 'customer') {
    access.prepareCustomerRun(threadId, runId, messageId, editCommandId, modelSelection, inheritedRunId)
    if(!binding.question?.configuration.workspaceType&&!binding.question?.configuration.environmentId)return undefined
    const context=access.prepareCustomerToolRun(threadId,runId,messageId,editCommandId,modelSelection,inheritedRunId)
    if(context.scope.configuration.workspaceType!==null)
      await createBusinessRunInputs(access,configuredWorkspaceManagement(access)).prepare(threadId,runId,inheritedRunId,signal,messageId,editCommandId,modelSelection)
    access.requireCustomerToolRun(context.reference)
    configuredEnvironmentMcp(access).prepareRun({threadId,runId,actorId:context.scope.actorId,projectId:context.scope.projectId,environmentId:context.scope.configuration.environmentId},inheritedRunId)
    access.requireCustomerToolRun(context.reference)
    access.completeCustomerToolRun(threadId,runId)
    return {key:'autoops_customer_tool_input',text:'本轮已固定所选平台资料和环境只读工具输入；未选择的范围不可读取，后续更新不替换本轮原件。'}
  }
  const capture = await createBusinessRunInputs(
    access,
    configuredWorkspaceManagement(access),
  ).prepare(threadId, runId, inheritedRunId, signal, messageId, editCommandId, modelSelection)
  const run = access.getRunInput(threadId, runId)!
  const environmentMcp = configuredEnvironmentMcp(access).prepareRun(
    environmentRunScope(access, threadId, runId), inheritedRunId,
  )
  const instructions = access.questionInstructions(run.actorId, threadId, modelSelection)
  return {
    key: 'autoops_turn_input',
    text: `${instructions ? `本次助手角色指令（不扩大既有权限）：\n${instructions}\n\n` : ''}本轮任务已自动固定当前可用资料。后续同步或编辑不改变本轮输入，下一轮重新获取。业务工具的 inputId 参数必须使用下列标识。用户明确引用的文件路径保持原样，用 read_project_material 读取所选内容；引用路径中的输入标识可以与工具 inputId 参数不同。源码同步失败不代表已授权引用不可读，先读取所选文件再判断。sourceWarnings 表示更新失败但所列源码仍可读取，按 repositories 中的真实提交分析，不得声称已确认远端最新状态；sourceErrors 才表示对应仓库不可读取。历史资料只表示当时事实，不得冒充当前最新状态。\n${JSON.stringify(
      {
        inputId: capture.id,
        runId,
        projectId: capture.projectId,
        workspaceType: capture.workspaceType,
        capturedAt: capture.createdAt,
        revision: capture.revision,
        environmentMcp,
        sourceErrors: capture.sourceErrors ?? [],
        sourceWarnings: capture.sourceWarnings ?? [],
        root: `autoops/${capture.projectId}/inputs/${capture.id}`,
        repositories:
          capture.workspaceType === 'external'
            ? []
            : capture.repositories.map((repository) => ({
                path: repository.source.mountPath,
                commit: repository.commit,
              })),
      },
    )}`,
  }
}
