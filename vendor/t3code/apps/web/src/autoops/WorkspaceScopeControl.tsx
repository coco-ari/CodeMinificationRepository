import { useNavigate } from '@tanstack/react-router'
import { FolderGit2Icon, ShieldCheckIcon } from 'lucide-react'
import { MenuItem } from '~/components/ui/menu'
import { autoOpsProjectHref } from './projectNavigation'
import { readAutoOpsHost, type AutoOpsThreadScope } from './hostConfig'
import { ScopeComposerChoice, availableWorkspaceScopes } from './scopeSelection'
export { ScopeComposerChoice } from './scopeSelection'

export function WorkspaceScopeControl({
  projectId,
  scope,
  locked,
  disabled,
  onChange,
}: {
  projectId: string
  scope: AutoOpsThreadScope
  locked: boolean
  disabled: boolean
  onChange: (type: 'internal' | 'external') => void
}) {
  const navigate = useNavigate()
  const project = readAutoOpsHost()?.projects.find((entry) => entry.id === projectId)
  const options = availableWorkspaceScopes(projectId)
  const selected =
    scope.workspaceType ??
    (project?.membership?.workspaceAccess === 'external' ? 'external' : 'internal')
  const summary = `${selected === 'external' ? '外部脱敏' : '内部原始'} · 当前工作区`
  return (
    <ScopeComposerChoice
      labelWidth={9}
      label="对话工作区"
      summary={summary}
      icon={selected === 'external' ? ShieldCheckIcon : FolderGit2Icon}
      value={selected}
      locked={locked}
      disabled={disabled || !options.length}
      options={options}
      onChange={(value) => {
        if (value === 'internal' || value === 'external') onChange(value)
      }}
      footer={
        <>
          <MenuItem disabled>每次运行读取当前资料；已提交任务保留原输入</MenuItem>
          {options.length ? (
            <MenuItem
              onClick={() => void navigate({ href: autoOpsProjectHref('workspaces', projectId) })}
            >
              {project?.capabilities?.['workspace.manage'] === true ? '管理工作区' : '查看工作区'}
            </MenuItem>
          ) : (
            <MenuItem disabled>当前项目没有工作区读取权限</MenuItem>
          )}
        </>
      }
    />
  )
}
