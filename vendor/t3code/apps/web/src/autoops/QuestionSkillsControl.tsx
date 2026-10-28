import { useEffect, useState } from 'react'
import { BookOpenIcon } from 'lucide-react'
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
} from '~/components/chat/ComposerControl'
import { ComposerContextLabel } from '~/components/ComposerContextLabel'
import { useComposerMenuProps } from '~/components/chat/composerEventScope'
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuCheckboxItem,
  MenuItem,
  MenuGroupLabel,
} from '~/components/ui/menu'
import { ScopeReadError } from './ScopeReadError'
import { ScopeComposerChoice } from './scopeSelection'
import { loadSkillLibrary } from './skillLibrary'
import {
  customerRuntimeRequestKey,
  useCustomerRuntime,
  type CustomerRuntime,
} from './customerAgents'
import type { AutoOpsThreadScope } from './threadScopes'
import { readAutoOpsHost } from './hostConfig'

/** 沿用现有能力目录；预设只选择可用技能，不拥有另一份技能内容。 */
export function QuestionSkillsControl({
  scope,
  locked,
  disabled,
  onChange,
  onReconcileUnavailable,
  customerRuntime,
}: {
  scope: AutoOpsThreadScope
  locked: boolean
  disabled: boolean
  onChange(ids: string[]): void
  onReconcileUnavailable(ids: string[]): void
  customerRuntime?: CustomerRuntime | undefined
}) {
  const question = scope.question
  const selected = question?.configuration.skillIds ?? []
  const target = scope.executionBinding
  const customer = target?.kind === 'customer'
  // 独立范围控件沿原运行器读取；问答页直接复用父级已复核的完整配置结果。
  const standaloneRuntime = useCustomerRuntime(
    customer && question && customerRuntime === undefined && (!locked || selected.length > 0)
      ? scope
      : undefined,
  )
  const runtime = customerRuntime ?? standaloneRuntime
  const key = customer
    ? customerRuntimeRequestKey(scope)
    : JSON.stringify([
        readAutoOpsHost()?.principal.id,
        scope.projectId,
        scope.agentId,
        scope.environmentId,
        scope.workspaceType,
        target,
        question && {
          ...question,
          configuration: { ...question.configuration, model: undefined, skillIds: undefined },
        },
      ])
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    key: string
    items: Array<{ id: string; name: string }>
    error?: string
    waiting: boolean
  } | null>(null)
  const floating = useComposerMenuProps()
  const needsCatalog = !!question && (!locked || selected.length > 0)
  useEffect(() => {
    if (customer || !key || !needsCatalog) return
    const controller = new AbortController()
    let reading = false
    const read = async () => {
      if (reading || controller.signal.aborted) return
      reading = true
      setState((previous) => ({
        key,
        items: previous?.key === key ? previous.items : [],
        waiting: true,
      }))
      try {
        const library = await loadSkillLibrary(controller.signal)
        const items = library.skills
          .filter((skill) => {
            if (!skill.enabled) return false
            const assignment =
              library.assignments.find(
                (value) =>
                  value.skillId === skill.id &&
                  value.targetType === 'project' &&
                  value.targetId === scope.projectId,
              ) ??
              library.assignments.find(
                (value) =>
                  value.skillId === skill.id &&
                  value.targetType === 'agent' &&
                  value.targetId === scope.agentId,
              )
            return (
              assignment?.enabled &&
              assignment.workspaceTypes.includes(scope.workspaceType ?? 'internal') &&
              skill.versions.some(
                (version) => version.id === assignment.versionId && version.readiness === 'ready',
              )
            )
          })
          .map(({ id, displayName }) => ({ id, name: displayName }))
        if (!controller.signal.aborted) setState({ key, items, waiting: false })
      } catch (cause) {
        if (!controller.signal.aborted)
          setState({
            key,
            items: [],
            error: cause instanceof Error ? cause.message : '无法读取技能目录',
            waiting: false,
          })
      } finally {
        reading = false
      }
    }
    const refresh = () => {
      void read()
    }
    void read()
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('autoops:skill-library-changed', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('autoops:skill-library-changed', refresh)
    }
  }, [key, attempt, customer, needsCatalog, scope.projectId, scope.agentId, scope.workspaceType])
  const current = customer
    ? runtime.requestKey === key && !runtime.loading
      ? {
          key,
          items: runtime.catalog?.skills.map(({ id, name }) => ({ id, name })) ?? [],
          ...(runtime.catalog ? {} : { error: runtime.error ?? '电脑技能目录尚未就绪' }),
          waiting: false,
        }
      : null
    : state?.key === key
      ? state
      : null
  useEffect(() => {
    if (locked || disabled || !current || current.waiting || current.error) return
    const valid = selected.filter((id) => current.items.some((item) => item.id === id))
    if (valid.length !== selected.length) onReconcileUnavailable(valid)
  }, [locked, disabled, current, selected, onReconcileUnavailable])
  const retry = () => (customer ? runtime.refresh() : setAttempt((value) => value + 1))
  if (!question) return null
  const summary = selected.length
    ? selected
        .map((id) => current?.items.find((item) => item.id === id)?.name ?? '已选技能')
        .join('、')
    : '无技能'
  if (locked)
    return (
      <>
        <ScopeComposerChoice
          label="技能"
          summary={summary}
          icon={BookOpenIcon}
          value=""
          options={[]}
          locked
          disabled={disabled}
          lockReason="按本次助手配置使用"
          onChange={() => {}}
        />
        {current?.error ? (
          <ScopeReadError
            label="技能目录读取失败"
            error={current.error}
            busy={false}
            onRetry={retry}
          />
        ) : null}
      </>
    )
  return (
    <Menu modal={false}>
      <MenuTrigger
        render={<ComposerControl />}
        aria-label="技能"
        aria-description={summary}
        disabled={disabled}
        data-composer-context-control
      >
        <ComposerControlIcon icon={BookOpenIcon} size="sm" />
        <ComposerContextLabel>{summary}</ComposerContextLabel>
        <ComposerControlChevron />
      </MenuTrigger>
      <MenuPopup side="top" align="start" {...floating}>
        <MenuGroupLabel>技能</MenuGroupLabel>
        {current?.error ? (
          <>
            <MenuItem disabled>{current.error}</MenuItem>
            <MenuItem onClick={retry}>重试读取技能</MenuItem>
          </>
        ) : !current || current.waiting ? (
          <MenuItem disabled>正在读取技能</MenuItem>
        ) : (
          <>
            {current.items.map((item) => (
              <MenuCheckboxItem
                key={item.id}
                checked={selected.includes(item.id)}
                closeOnClick
                onCheckedChange={(checked) =>
                  onChange(
                    checked ? [...selected, item.id] : selected.filter((id) => id !== item.id),
                  )
                }
              >
                {item.name}
              </MenuCheckboxItem>
            ))}
            {!current.items.length ? <MenuItem disabled>当前范围没有可用技能</MenuItem> : null}
            {selected.some((id) => !current.items.some((item) => item.id === id)) ? (
              <MenuItem
                onClick={() =>
                  onChange(selected.filter((id) => current.items.some((item) => item.id === id)))
                }
              >
                移除已不可用技能
              </MenuItem>
            ) : null}
          </>
        )}
      </MenuPopup>
    </Menu>
  )
}
