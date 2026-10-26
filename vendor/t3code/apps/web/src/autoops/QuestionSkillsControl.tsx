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
import { loadCustomerAssistantRuntime } from './customerAgents'
import type { AutoOpsThreadScope } from './threadScopes'
import { readAutoOpsHost } from './hostConfig'

/** 沿用现有能力目录；预设只选择可用技能，不拥有另一份技能内容。 */
export function QuestionSkillsControl({
  scope,
  locked,
  disabled,
  onChange,
}: {
  scope: AutoOpsThreadScope
  locked: boolean
  disabled: boolean
  onChange(ids: string[]): void
}) {
  const question = scope.question
  const selected = question?.configuration.skillIds ?? []
  const target = scope.executionBinding
  const key = JSON.stringify([readAutoOpsHost()?.principal.id, scope.projectId, scope.agentId, scope.workspaceType, target, question])
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    key: string
    items: Array<{ id: string; name: string }>
    error?: string
  } | null>(null)
  const floating = useComposerMenuProps()
  useEffect(() => {
    if (!question || (locked && selected.length === 0)) return
    const controller = new AbortController()
    const read = async () => {
      if (target?.kind === 'customer') {
        const catalog = (await loadCustomerAssistantRuntime(scope.projectId, question, controller.signal)).capabilities
        if (!catalog) throw new Error('电脑技能目录尚未就绪')
        return catalog.skills.map(({ id, name }) => ({ id, name }))
      }
      const library = await loadSkillLibrary(controller.signal)
      return library.skills
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
    }
    void read()
      .then((items) => {
        if (!controller.signal.aborted) setState({ key, items })
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            items: [],
            error: cause instanceof Error ? cause.message : '无法读取技能目录',
          })
      })
    return () => controller.abort()
  }, [key, attempt, locked, !!question, locked && selected.length === 0])
  if (!question) return null
  const current = state?.key === key ? state : null
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
            onRetry={() => setAttempt((value) => value + 1)}
          />
        ) : null}
      </>
    )
  return (
    <Menu>
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
            <MenuItem onClick={() => setAttempt((value) => value + 1)}>重试读取技能</MenuItem>
          </>
        ) : !current ? (
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
