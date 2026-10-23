import { useRef, useState } from 'react'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { randomUUID } from '~/lib/utils'
import { AutoOpsRequestError, autoOpsRequest } from './apiClient'
import type { WorkspaceRepositoryRefKind } from './workspaceAuthoring'
import { inspectAuthoringRequest } from './workspaceAuthoring'
import type { WorkspaceBuildContext } from '../../../../../../autoops/contracts/workspaces.ts'
import { readAutoOpsHost } from './hostConfig'
import {
  generateExternalWorkspace,
  generateWorkspacePackages,
  importWorkspaceRepository,
  loadWorkspaces,
  type WorkspaceTask,
} from './workspaces'

export type WorkspaceTaskInput =
  | { type: 'import'; repositoryUrl: string; branch: string }
  | { type: 'external'; sourceVersionId?: string; rules: Array<{ find: string; replace: string }> }
  | {
      type: 'packages'
      sourceVersionId: string
      services: Array<'frontend' | 'backend'>
      contexts?: WorkspaceBuildContext[]
    }
  | {
      type: 'deployment-packages'
      sources: Array<{ sourceId: string; refKind?: WorkspaceRepositoryRefKind; ref?: string }>
      contexts: WorkspaceBuildContext[]
    }

type PendingSubmission = {
  requestId: string
  type: WorkspaceTaskInput['type']
  digest: string
  input?: WorkspaceTaskInput
}
const taskNames = {
  import: '导入仓库',
  external: '更新外部工作区',
  packages: '生成部署包',
  'deployment-packages': '生成部署包',
}
const taskType = (type: WorkspaceTaskInput['type']) =>
  type === 'deployment-packages' ? 'packages' : type
const keyFor = (projectId: string) =>
  'autoops:workspace-task:' + (readAutoOpsHost()?.principal.id ?? '') + ':' + projectId

function readPending(key: string): PendingSubmission | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as PendingSubmission | null
    if (
      value &&
      typeof value.requestId === 'string' &&
      value.requestId &&
      value.requestId.length <= 160 &&
      typeof value.digest === 'string' &&
      /^[a-f0-9]{64}$/.test(value.digest) &&
      (value.type === 'import' ||
        value.type === 'external' ||
        value.type === 'packages' ||
        value.type === 'deployment-packages')
    ) {
      return { requestId: value.requestId, type: value.type, digest: value.digest }
    }
  } catch {
    // 浏览器存储不可读取时仍可浏览，提交前必须重新验证能否保存恢复信息。
  }
  return null
}

function digestInput(input: WorkspaceTaskInput) {
  // 复用现有依赖，兼容内网 HTTP 页面没有 SubtleCrypto 的环境。
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(input))))
}

/** 仅负责现有工作区任务的提交收据；未知结果一直沿用原输入和原幂等标识。 */
export function useWorkspaceTaskSubmission(
  projectId: string,
  onAccepted: (task: WorkspaceTask) => void,
) {
  const key = keyFor(projectId)
  const [pending, setPending] = useState(() => readPending(key))
  const pendingRef = useRef(pending)
  const locked = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const accepted = useRef(onAccepted)
  accepted.current = onAccepted

  const remember = (value: PendingSubmission) => {
    // 只持久化收据和摘要，替换规则、仓库地址等完整输入只留在内存。
    sessionStorage.setItem(
      key,
      JSON.stringify({ requestId: value.requestId, type: value.type, digest: value.digest }),
    )
    pendingRef.current = value
    setPending(value)
  }
  const clear = () => {
    try {
      sessionStorage.removeItem(key)
    } catch {
      // 清理失败时旧收据仍使用原标识，下次核对不会生成另一项任务。
    }
    pendingRef.current = null
    setPending(null)
  }
  const confirm = (task: WorkspaceTask) => {
    clear()
    setError(null)
    accepted.current(task)
    return true
  }
  const inspect = async (submission: PendingSubmission) => {
    const overview = await loadWorkspaces(projectId)
    if (overview.projectId !== projectId)
      throw new Error('任务核对返回了其他项目，已停止本次操作。')
    const task = overview.tasks.find(
      (task) => task.type === taskType(submission.type) && task.requestId === submission.requestId,
    )
    if (task) return task
    if (submission.type === 'external' || submission.type === 'deployment-packages') {
      const receipt = await inspectAuthoringRequest(projectId, submission.requestId, false)
      if (receipt && 'task' in receipt && receipt.task.type === taskType(submission.type))
        return receipt.task
    }
    return undefined
  }
  const send = (submission: PendingSubmission) => {
    const input = submission.input
    if (!input) throw new Error('请重新填写原输入并提交，以继续核对上次任务。')
    if (input.type === 'deployment-packages')
      return autoOpsRequest<{ task: WorkspaceTask }>(
        `/api/v1/projects/${encodeURIComponent(projectId)}/workspace/deployment-packages`,
        {
          label: '部署源码包',
          body: {
            requestId: submission.requestId,
            sources: input.sources,
            contexts: input.contexts,
          },
        },
      ).then(({ task }) => task)
    if (input.type === 'import')
      return importWorkspaceRepository(
        projectId,
        input.repositoryUrl,
        input.branch,
        submission.requestId,
      )
    if (input.type === 'external')
      return generateExternalWorkspace(
        projectId,
        input.sourceVersionId,
        input.rules,
        submission.requestId,
      )
    return generateWorkspacePackages(
      projectId,
      input.sourceVersionId,
      input.services,
      submission.requestId,
      input.contexts,
    )
  }
  const perform = async (input: WorkspaceTaskInput | null, checkOnly = false): Promise<boolean> => {
    if (locked.current) return false
    locked.current = true
    setBusy(true)
    setError(null)
    let sending = false
    try {
      let submission = pendingRef.current
      if (submission) {
        if (input) {
          if (submission.digest !== digestInput(input)) {
            setError(
              '上次' +
                taskNames[submission.type] +
                '的结果尚未确认。修改输入不会覆盖原请求，请先核对旧任务，再发起新操作。',
            )
            return false
          }
          submission = { ...submission, input: structuredClone(input) }
          pendingRef.current = submission
          setPending(submission)
        }
        const receipt = await inspect(submission)
        if (receipt) return confirm(receipt)
        if (checkOnly) {
          setError('暂未查到上次任务。可使用原请求重试；关闭弹窗不会取消可能已接受的任务。')
          return false
        }
      } else {
        if (!input || checkOnly) return false
        submission = {
          requestId: randomUUID(),
          type: input.type,
          digest: digestInput(input),
          input: structuredClone(input),
        }
        try {
          remember(submission)
        } catch {
          setError('无法保存本次请求的恢复信息，请允许浏览器存储后重试。')
          return false
        }
      }
      if (!submission.input) {
        setError(
          '暂未查到上次任务。刷新后请重新填写原输入并提交，以继续核对；不会自动创建另一项任务。',
        )
        return false
      }
      sending = true
      const task = await send(submission)
      if (
        task.type !== taskType(submission.type) ||
        (task.requestId && task.requestId !== submission.requestId)
      ) {
        throw new Error('任务收据与本次请求不一致，提交结果尚未确认，请先核对任务。')
      }
      return confirm(task)
    } catch (cause) {
      if (
        cause instanceof AutoOpsRequestError &&
        !cause.uncertain &&
        (sending || cause.code === 'CAPTURE_FAILED')
      )
        clear()
      setError(cause instanceof Error ? cause.message : '提交结果尚未确认，请先核对任务。')
      return false
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return {
    busy,
    error,
    pendingLabel: pending ? taskNames[pending.type] : null,
    retryAvailable: !!pending?.input,
    submit: (input: WorkspaceTaskInput) => perform(input),
    check: () => perform(null, true),
    retry: () => perform(null),
  }
}
