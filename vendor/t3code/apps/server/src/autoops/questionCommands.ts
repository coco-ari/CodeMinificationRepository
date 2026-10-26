import {
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Threads from '../orchestration-v2/ThreadManagementService.ts'
import {
  AutoOpsAccessError,
  type AutoOpsAccess,
  type AutoOpsPrincipal,
} from '../../../../../../agent-demo/t3-adapters/access.mjs'

type Command = {
  type?: string
  threadId?: string
  runId?: string
  queuedRunId?: string
  targetRunId?: string
  requestId?: string
  modelSelection?: unknown
  dispatchMode?: { type?: string }
  deliveryIntent?: string
}
type Projection = Pick<
  OrchestrationV2ThreadProjection,
  'thread' | 'runs' | 'nodes' | 'runtimeRequests'
>
const fail = (): never => {
  throw new AutoOpsAccessError(
    409,
    'QUESTION_NATIVE_CONTEXT_MISSING',
    '无法核对本次原生任务参数，请恢复连接后重试原请求',
  )
}

/** 读取原生已固定的模型，浏览器不能以省略或伪造模型绕过排队/引导准入。 */
export function questionCommandModels(command: Command, projection: Projection): ModelSelection[] {
  const run = (id: string | null | undefined) =>
    projection.runs.find((run) => run.id === id)?.modelSelection ?? fail()
  if (command.type === 'queued-run.edit' || command.type === 'prepared-run.retry')
    return [run(command.runId)]
  if (command.type === 'queued-message.promote-to-steer')
    return [run(command.queuedRunId), run(command.targetRunId)]
  if (command.type === 'queue.resume')
    return projection.runs.filter((run) => run.status === 'queued').map((run) => run.modelSelection)
  if (command.type === 'runtime-request.respond') {
    const request = projection.runtimeRequests.find((request) => request.id === command.requestId)
    return [run(projection.nodes.find((node) => node.id === request?.nodeId)?.runId)]
  }
  if (command.type !== 'message.dispatch') return []
  const selected = command.modelSelection === undefined ? [projection.thread.modelSelection] : []
  const queued = command.dispatchMode?.type === 'queue_after_active'
  const steered =
    command.dispatchMode?.type === 'steer_active' ||
    (!queued &&
      command.deliveryIntent !== 'restart' &&
      command.dispatchMode?.type !== 'start_immediately')
  return steered
    ? [
        ...selected,
        ...projection.runs
          .filter((run) => ['running', 'waiting', 'starting'].includes(run.status))
          .map((run) => run.modelSelection),
      ]
    : selected
}

export function validateQuestionCommand(
  access: AutoOpsAccess,
  principal: AutoOpsPrincipal,
  method: string,
  payload: unknown,
) {
  return Effect.gen(function* () {
    const command = payload as Command
    if (
      method !== 'orchestration.dispatchCommand' ||
      !command.threadId ||
      !access.getThreadBinding(command.threadId)?.question ||
      ![
        'message.dispatch',
        'queued-run.edit',
        'prepared-run.retry',
        'queued-message.promote-to-steer',
        'queue.resume',
        'runtime-request.respond',
      ].includes(command.type ?? '')
    )
      return
    const threads = yield* Effect.serviceOption(Threads.ThreadManagementService)
    if (Option.isNone(threads))
      return yield* Effect.die(
        new AutoOpsAccessError(503, 'QUESTION_NATIVE_CONTEXT_MISSING', '原生问答参数读取尚未就绪'),
      )
    const projection = yield* threads.value
      .getThreadProjection(ThreadId.make(command.threadId))
      .pipe(Effect.orDie)
    yield* Effect.sync(() => {
      const models = questionCommandModels(command, projection)
      if (!models.length)
        access.requireQuestionForActor(principal.id, command.threadId!, command.modelSelection)
      for (const model of models)
        access.requireQuestionForActor(principal.id, command.threadId!, model)
      if (command.type === 'message.dispatch' && command.modelSelection !== undefined)
        access.requireQuestionForActor(principal.id, command.threadId!, command.modelSelection)
    })
  })
}
