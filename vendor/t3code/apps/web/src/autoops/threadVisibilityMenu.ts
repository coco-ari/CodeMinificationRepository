import type { ContextMenuItem, LocalApi } from '@t3tools/contracts'
import { type DraftId, useComposerDraftStore } from '~/composerDraftStore'
import { toastManager } from '~/components/ui/toast'
import { readAutoOpsHost } from './hostSnapshot'
import { questionCanAdjust } from './questionConfiguration'
import {
  loadAutoOpsThreadScope,
  readAutoOpsThreadScope,
  reserveAutoOpsThreadScope,
  setAutoOpsThreadScope,
  type AutoOpsThreadScope,
} from './threadScopes'

type VisibilityAction = 'visibility' | 'visibility:private' | 'visibility:project'
type Target = {
  threadId: string
  projectId: string
  draftId?: DraftId
  canOperate: () => boolean
}

function lockedReason(scope: AutoOpsThreadScope, target: Target): string | null {
  if (target.draftId) {
    const session = useComposerDraftStore.getState().getDraftSession(target.draftId)
    if (!session || session.promotedTo || session.threadId !== target.threadId)
      return '草稿已发送或关闭'
  }
  if (scope.scopeState === 'submitting') return '正在确认发送结果'
  if (
    scope.scopeLocked ||
    scope.scopeState === 'locked' ||
    scope.nativeParentThreadId ||
    scope.compatibilityReadOnly
  )
    return '发送后固定'
  if (!target.canOperate() || !questionCanAdjust(scope)) return '由项目管理员设置'
  if (scope.executionBinding?.kind === 'customer') return '本机对话仅自己可见'
  return null
}

/** 侧栏更多和右键共用入口，只调整未发送范围，沿用原来的授权与锁定规则。 */
export async function showThreadMenuWithVisibility<T extends string>(
  show: LocalApi['contextMenu']['show'],
  items: ReadonlyArray<ContextMenuItem<T>>,
  position: { x: number; y: number },
  target: Target,
): Promise<T | null> {
  const host = readAutoOpsHost()
  if (!host) return show(items, position)
  let scope: AutoOpsThreadScope | undefined
  let failure: string | undefined
  try {
    scope = target.draftId
      ? readAutoOpsThreadScope(target.threadId, target.projectId)
      : await loadAutoOpsThreadScope(target.threadId)
    if (!scope || scope.projectId !== target.projectId) throw new Error('无法读取会话可见范围')
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : '无法读取会话可见范围'
  }
  const reason = scope ? lockedReason(scope, target) : failure
  const visibilityItems: ContextMenuItem<VisibilityAction>[] = scope
    ? [
        {
          id: 'visibility',
          label: `会话可见范围${reason ? ` · ${reason}` : ''}`,
          children: (['private', 'project'] as const).map((value) => ({
            id: `visibility:${value}`,
            label: value === 'private' ? '仅自己' : '项目共享',
            checked: scope!.visibility === value,
            disabled: !!reason,
          })),
        },
      ]
    : [{ id: 'visibility', label: failure ?? '无法读取会话可见范围', disabled: true }]
  const action = await show<T | VisibilityAction>([...visibilityItems, ...items], position)
  if (action !== 'visibility:private' && action !== 'visibility:project')
    return action === 'visibility' ? null : (action as T | null)
  try {
    // 菜单展开期间可能发生发送、权限撤销或切换账号；执行时重读，不覆盖新配置。
    if (readAutoOpsHost()?.principal.id !== host.principal.id)
      throw new Error('账号已切换，请重新打开菜单')
    const current = target.draftId
      ? readAutoOpsThreadScope(target.threadId, target.projectId)
      : await loadAutoOpsThreadScope(target.threadId)
    if (!current || current.projectId !== target.projectId) throw new Error('会话范围不可用')
    const blocked = lockedReason(current, target)
    if (blocked) throw new Error(blocked)
    const visibility = action === 'visibility:private' ? 'private' : 'project'
    if (current.visibility === visibility) return null
    const next: AutoOpsThreadScope = {
      ...current,
      visibility,
      ...(current.question
        ? {
            question: {
              ...current.question,
              configuration: { ...current.question.configuration, visibility },
            },
          }
        : {}),
    }
    if (target.draftId) setAutoOpsThreadScope(target.threadId, next)
    else await reserveAutoOpsThreadScope(target.threadId, next)
  } catch (cause) {
    toastManager.add({
      type: 'error',
      title: '无法更新会话可见范围',
      description: cause instanceof Error ? cause.message : '请重试',
    })
  }
  return null
}
