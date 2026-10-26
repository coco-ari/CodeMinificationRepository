import type { MembershipDetails } from '../../../../../../autoops/contracts/project-directory.ts'
import type { ProjectRole } from '../../../../../../autoops/contracts/project-access.ts'
import { Checkbox } from '~/components/ui/checkbox'
import { Label } from '~/components/ui/label'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import type { AssistantTarget, QuestionConfiguration } from './projectAssistants'
import {
  projectRoleNames,
  assistantSourceKey,
  type ProjectConfigurationEditor,
} from './projectConfiguration'
function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ id: string; name: string; disabled?: boolean }>
  disabled: boolean
  onChange(value: string): void
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => typeof next === 'string' && onChange(next)}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="请选择">
            {options.find((option) => option.id === value)?.name ??
              (value ? '原选项已不可用' : '请选择')}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id} disabled={option.disabled ?? false}>
              {option.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  )
}
function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange(value: boolean): void
}) {
  return (
    <Label className="flex items-center gap-2">
      <Checkbox
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      {label}
    </Label>
  )
}
export function ProjectConfigurationFields({
  editor,
  disabled,
  onChange,
}: {
  editor: ProjectConfigurationEditor
  disabled: boolean
  onChange(editor: ProjectConfigurationEditor): void
}) {
  if (editor.kind === 'repository') {
    if (editor.remove)
      return <p className="text-sm">移除仓库连接“{editor.name}”？已固定任务保留原来源。</p>
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="repository-name">名称</Label>
          <Input
            id="repository-name"
            value={editor.name}
            maxLength={200}
            required
            disabled={disabled}
            autoFocus
            onChange={(event) => onChange({ ...editor, name: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="repository-url">HTTPS 仓库地址</Label>
          <Input
            id="repository-url"
            type="url"
            value={editor.value.url}
            maxLength={2000}
            required
            disabled={disabled}
            placeholder="https://github.com/team/repository.git"
            onChange={(event) =>
              onChange({ ...editor, value: { ...editor.value, url: event.target.value } })
            }
          />
        </div>
        <Choice
          label="项目凭证"
          value={editor.value.credentialId ?? 'none'}
          disabled={disabled}
          options={[
            { id: 'none', name: '不使用凭证' },
            ...editor.context.credentials.map((value) => ({
              id: value.id,
              name: value.name + (value.revoked ? ' · 已撤销' : ''),
              disabled: value.revoked,
            })),
          ]}
          onChange={(id) => {
            const { credentialId: _credentialId, ...value } = editor.value
            onChange({
              ...editor,
              value: { ...value, ...(id === 'none' ? {} : { credentialId: id }) },
            })
          }}
        />
      </div>
    )
  }
  if (editor.kind === 'member') {
    const value = editor.value,
      project = editor.context.project
    const update = (patch: Partial<MembershipDetails>) =>
      onChange({ ...editor, value: { ...value, ...patch } })
    const roles = Object.entries(projectRoleNames)
      .filter(
        ([id]) =>
          project.candidates.find((user) => user.id === value.userId)?.kind !== 'external' ||
          id === 'external',
      )
      .map(([id, name]) => ({ id, name }))
    return (
      <div className="space-y-4">
        <Choice
          label="成员账号"
          value={value.userId}
          disabled={disabled || editor.revision > 0}
          options={project.candidates.map((user) => ({ id: user.id, name: user.name }))}
          onChange={(id) =>
            update({
              userId: id,
              ...(project.candidates.find((user) => user.id === id)?.kind === 'external'
                ? { role: 'external', environmentIds: [], environmentRoles: {} }
                : {}),
            })
          }
        />
        <Choice
          label="项目角色"
          value={value.role}
          disabled={disabled}
          options={roles}
          onChange={(role) =>
            update({
              role: role as ProjectRole,
              ...(role === 'external' ? { environmentIds: [], environmentRoles: {} } : {}),
              ...(role === 'project_admin' ? { canAdjustChat: true } : {}),
            })
          }
        />
        {value.role !== 'external' && value.role !== 'project_admin' ? (
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">可用环境与覆盖角色</legend>
            {project.project.environments.map((env) => (
              <div key={env.id} className="space-y-2">
                <Check
                  label={env.name}
                  checked={value.environmentIds.includes(env.id)}
                  disabled={disabled}
                  onChange={(checked) => {
                    const environmentRoles = { ...value.environmentRoles }
                    if (!checked) delete environmentRoles[env.id]
                    update({
                      environmentIds: checked
                        ? [...value.environmentIds, env.id]
                        : value.environmentIds.filter((id) => id !== env.id),
                      environmentRoles,
                    })
                  }}
                />
                {value.environmentIds.includes(env.id) ? (
                  <Choice
                    label={`${env.name}角色`}
                    value={value.environmentRoles[env.id] ?? 'inherit'}
                    disabled={disabled}
                    options={[
                      { id: 'inherit', name: '跟随项目角色' },
                      ...(['developer', 'release_operator', 'reader'] as const).map((id) => ({
                        id,
                        name: projectRoleNames[id],
                      })),
                    ]}
                    onChange={(role) => {
                      const environmentRoles = { ...value.environmentRoles }
                      if (role === 'inherit') delete environmentRoles[env.id]
                      else
                        environmentRoles[env.id] = role as
                          'developer' | 'release_operator' | 'reader'
                      update({ environmentRoles })
                    }}
                  />
                ) : null}
              </div>
            ))}
          </fieldset>
        ) : null}
        <Check
          label="允许调整问答配置"
          checked={value.role === 'project_admin' || value.canAdjustChat}
          disabled={disabled || value.role === 'project_admin'}
          onChange={(canAdjustChat) => update({ canAdjustChat })}
        />
        <Check
          label="启用成员授权"
          checked={value.status === 'active'}
          disabled={disabled}
          onChange={(enabled) => update({ status: enabled ? 'active' : 'disabled' })}
        />
        {project.members.find((member) => member.userId === value.userId)?.authorizationPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            保存将启用此成员的新授权。
          </p>
        ) : null}
        {!value.canAdjustChat && value.role !== 'project_admin' ? (
          <p className="text-sm text-muted-foreground">启用前须在“助手”中分配有效默认助手。</p>
        ) : null}
      </div>
    )
  }
  if (editor.kind === 'allocation') {
    const context = editor.context
    const targets = [
      ...Object.entries(projectRoleNames).map(([id, name]) => ({
        id: `role:${id}`,
        name: `角色 · ${name}`,
      })),
      ...context.project.candidates.map((user) => ({
        id: `member:${user.id}`,
        name: `成员 · ${user.name}`,
      })),
    ]
    return (
      <div className="space-y-4">
        <Choice
          label="分配对象"
          value={`${editor.target.kind}:${editor.target.id}`}
          disabled={disabled}
          options={targets}
          onChange={(target) => {
            const [kind, id] = target.split(':') as ['role' | 'member', string]
            const previous = context.assistants.allocations.find(
              (item) => item.target.kind === kind && item.target.id === id,
            )
            onChange({
              ...editor,
              target: { kind, id } as AssistantTarget,
              revision: previous?.revision ?? 0,
              assistantIds: previous?.assistantIds ?? [],
              defaultAssistantId: previous?.defaultAssistantId ?? null,
            })
          }}
        />
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium">可用助手</legend>
          {context.assistants.presets.map((preset) => (
            <Check
              key={preset.id}
              label={preset.name + (preset.enabled ? '' : ' · 已停用')}
              checked={editor.assistantIds.includes(preset.id)}
              disabled={disabled}
              onChange={(checked) =>
                onChange({
                  ...editor,
                  assistantIds: checked
                    ? [...editor.assistantIds, preset.id]
                    : editor.assistantIds.filter((id) => id !== preset.id),
                  defaultAssistantId:
                    !checked && editor.defaultAssistantId === preset.id
                      ? null
                      : editor.defaultAssistantId,
                })
              }
            />
          ))}
        </fieldset>
        <Choice
          label="默认助手"
          value={editor.defaultAssistantId ?? 'none'}
          disabled={disabled}
          options={[
            { id: 'none', name: editor.target.kind === 'member' ? '跟随角色默认' : '不设置默认' },
            ...context.assistants.presets
              .filter((preset) => editor.assistantIds.includes(preset.id))
              .map((preset) => ({ id: preset.id, name: preset.name, disabled: !preset.enabled })),
          ]}
          onChange={(id) => onChange({ ...editor, defaultAssistantId: id === 'none' ? null : id })}
        />
      </div>
    )
  }
  const value = editor.value,
    config = value.configuration,
    choices = editor.context.choices
  const source = choices.sources.find(
    (source) =>
      assistantSourceKey(source.executionBinding) === assistantSourceKey(config.executionBinding),
  )
  const customer = config.executionBinding.kind === 'customer'
  const isolated = customer && config.customerProfile !== undefined
  const model = isolated
    ? undefined
    : source?.models.find((model) => model.id === config.model.model)
  const update = (patch: Partial<QuestionConfiguration>) => {
    const next = { ...config, ...patch }
    if (
      patch.executionBinding &&
      assistantSourceKey(patch.executionBinding) !== assistantSourceKey(config.executionBinding)
    )
      delete next.customerProfile
    onChange({ ...editor, value: { ...value, configuration: next } })
  }
  const skillChoices = isolated
    ? []
    : customer
      ? (source?.skills ?? [])
      : choices.platformSkills.filter(
          (skill) =>
            skill.agentId === config.agentId && skill.workspaceType === config.workspaceType,
        )
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="assistant-name">名称</Label>
        <Input
          id="assistant-name"
          value={editor.name}
          required
          maxLength={120}
          autoFocus
          disabled={disabled}
          onChange={(event) => onChange({ ...editor, name: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="assistant-description">说明（可选）</Label>
        <Textarea
          id="assistant-description"
          value={editor.description}
          maxLength={2000}
          disabled={disabled}
          onChange={(event) => onChange({ ...editor, description: event.target.value })}
        />
      </div>
      <Choice
        label="运行来源"
        value={source?.id ?? 'unavailable'}
        disabled={disabled}
        options={choices.sources.map((source) => ({ id: source.id, name: source.name }))}
        onChange={(id) => {
          const next = choices.sources.find((source) => source.id === id)
          if (!next) return
          update({
            executionBinding: next.executionBinding,
            model: {
              instanceId:
                next.executionBinding.kind === 'platform'
                  ? 'codex'
                  : `customer-${next.executionBinding.deviceId}-codex`,
              model: '',
              reasoningEffort: null,
            },
            skillIds: [],
            ...(next.executionBinding.kind === 'customer'
              ? {
                  agentId: 'a-project',
                  environmentId: null,
                  workspaceType: null,
                  visibility: 'private',
                }
              : { workspaceType: 'internal' }),
          })
        }}
      />
      {source?.reason ? (
        <p role="status" className="text-sm text-muted-foreground">
          {source.reason.message}
        </p>
      ) : null}
      {customer ? (
        <>
          <Choice
            label="运行目录"
            value={isolated ? 'shared' : 'self'}
            disabled
            options={[
              { id: 'self', name: '自用运行器' },
              ...(config.customerProfile
                ? [{ id: 'shared', name: `隔离运行器 · ${config.customerProfile.id}` }]
                : []),
            ]}
            onChange={() => {}}
          />
          {isolated ? (
            <p role="status" className="text-sm text-muted-foreground">
              隔离目录参数请在“我提供的”助手中维护。
            </p>
          ) : null}
        </>
      ) : null}
      <Choice
        label="业务助手"
        value={config.agentId}
        disabled={disabled || customer}
        options={choices.agents.map((agent) => ({ id: agent.id, name: agent.name }))}
        onChange={(agentId) => update({ agentId })}
      />
      <Choice
        label="模型"
        value={config.model.model}
        disabled={disabled || isolated || !source?.models.length}
        options={
          isolated
            ? [{ id: config.model.model, name: config.model.model }]
            : (source?.models.map((model) => ({ id: model.id, name: model.name })) ?? [])
        }
        onChange={(id) => {
          const next = source?.models.find((model) => model.id === id)
          if (next)
            update({
              model: {
                ...config.model,
                model: id,
                reasoningEffort:
                  next.defaultReasoning as QuestionConfiguration['model']['reasoningEffort'],
              },
            })
        }}
      />
      <Choice
        label="思考强度"
        value={config.model.reasoningEffort ?? 'none-supported'}
        disabled={disabled || isolated || !model?.reasoningLevels.length}
        options={
          isolated && config.model.reasoningEffort
            ? [{ id: config.model.reasoningEffort, name: config.model.reasoningEffort }]
            : model?.reasoningLevels.length
              ? model.reasoningLevels.map((id) => ({ id, name: id }))
              : [{ id: 'none-supported', name: '此模型不提供思考档位' }]
        }
        onChange={(reasoningEffort) =>
          update({
            model: {
              ...config.model,
              reasoningEffort: reasoningEffort as QuestionConfiguration['model']['reasoningEffort'],
            },
          })
        }
      />
      {!customer ? (
        <>
          <Choice
            label="资料范围"
            value={config.workspaceType ?? 'internal'}
            disabled={disabled}
            options={[
              { id: 'internal', name: '内部当前资料' },
              { id: 'external', name: '外部当前资料' },
            ]}
            onChange={(workspaceType) =>
              update({ workspaceType: workspaceType as 'internal' | 'external' })
            }
          />
          <Choice
            label="业务环境"
            value={config.environmentId ?? 'none'}
            disabled={disabled}
            options={[
              { id: 'none', name: '无环境' },
              ...editor.context.project.project.environments,
            ]}
            onChange={(environmentId) =>
              update({ environmentId: environmentId === 'none' ? null : environmentId })
            }
          />
          <Choice
            label="会话可见范围"
            value={config.visibility}
            disabled={disabled}
            options={[
              { id: 'private', name: '仅自己' },
              { id: 'project', name: '项目共享' },
            ]}
            onChange={(visibility) => update({ visibility: visibility as 'private' | 'project' })}
          />
        </>
      ) : null}
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">技能</legend>
        {[
          ...skillChoices,
          ...config.skillIds
            .filter((id) => !skillChoices.some((skill) => skill.id === id))
            .map((id) => ({ id, name: `${id} · ${isolated ? '原预设技能' : '已不可用'}` })),
        ].map((skill) => (
          <Check
            key={skill.id}
            label={skill.name}
            checked={config.skillIds.includes(skill.id)}
            disabled={disabled || isolated}
            onChange={(checked) =>
              update({
                skillIds: checked
                  ? [...config.skillIds, skill.id]
                  : config.skillIds.filter((id) => id !== skill.id),
              })
            }
          />
        ))}
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor="assistant-instructions">角色指令（可选）</Label>
        <Textarea
          id="assistant-instructions"
          value={value.instructions}
          maxLength={16000}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...editor, value: { ...value, instructions: event.target.value } })
          }
        />
      </div>
      <Check
        label="启用助手"
        checked={value.enabled}
        disabled={disabled}
        onChange={(enabled) => onChange({ ...editor, value: { ...value, enabled } })}
      />
    </div>
  )
}
