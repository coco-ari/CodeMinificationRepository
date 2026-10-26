import { useRef, useState } from 'react'
import { GitBranchIcon } from 'lucide-react'
import { Alert, AlertAction, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { DeploymentRepositoryVersionDialog } from './DeploymentRepositoryVersionDialog'
import type { DeploymentServiceSource } from '../deployments'
import type { WorkspaceBuildContext } from '../workspaces'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { validMaterialPath } from '../workspaceAuthoring'
import type {
  WorkspaceDeploymentSourceInput,
  WorkspaceRepositoryRefKind,
  ProjectRepositoryConnection,
} from '../workspaceAuthoring'
export type DeploymentSourceSelection = WorkspaceDeploymentSourceInput['sources'][number]
export const initialDeploymentSource = (
  source: ProjectRepositoryConnection,
  index: number,
  count: number,
): DeploymentSourceSelection => ({
  sourceId: source.id,
  refKind: 'default',
  ref: '',
  mountPath: count === 1 ? 'repository' : `repo-${index + 1}`,
})
export function updateDeploymentSource(
  current: DeploymentSourceSelection,
  change: Partial<DeploymentSourceSelection>,
): DeploymentSourceSelection {
  const next = { ...current, ...change }
  if (next.sourcePath === '') {
    const { sourcePath: _sourcePath, ...value } = next
    return value
  }
  return next
}
export const validDeploymentSourceDirectories = (source: DeploymentSourceSelection) =>
  validMaterialPath(source.mountPath ?? '') &&
  (!source.sourcePath || validMaterialPath(source.sourcePath))
const referenceKinds: Array<{ value: WorkspaceRepositoryRefKind; label: string }> = [
  { value: 'default', label: '默认分支' },
  { value: 'branch', label: '分支' },
  { value: 'tag', label: '标签' },
  { value: 'commit', label: '提交 SHA' },
]

/** 发布与源码包使用相同仓库引用控件，版本选择只修改本次提交草稿。 */
export function DeploymentSourceFields({
  projectId,
  onAccessDenied,
  sources,
  selection,
  disabled,
  onSelect,
  onUpdate,
}: {
  projectId?: string | undefined
  onAccessDenied?: ((cause: unknown) => void) | undefined
  sources: ProjectRepositoryConnection[]
  selection: Record<string, DeploymentSourceSelection>
  disabled: boolean
  onSelect: (source: ProjectRepositoryConnection, checked: boolean) => void
  onUpdate: (sourceId: string, change: Partial<DeploymentSourceSelection>) => void
}) {
  const [versionSource, setVersionSource] = useState<ProjectRepositoryConnection | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  return (
    <>
      <fieldset className="min-w-0 space-y-3" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">源码仓库</legend>
        {sources.map((source) => (
          <div key={source.id} className="min-w-0 space-y-2">
            <Label className="min-w-0">
              <Checkbox
                checked={!!selection[source.id]}
                disabled={disabled}
                onCheckedChange={(checked) => onSelect(source, checked)}
              />
              <span className="min-w-0 truncate" title={source.name}>
                {source.name}
              </span>
            </Label>
            {selection[source.id] ? (
              <div className="flex min-w-0 flex-wrap gap-2 pl-6">
                <Select
                  value={selection[source.id]!.refKind ?? 'default'}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (value)
                      onUpdate(source.id, {
                        refKind: value as WorkspaceRepositoryRefKind,
                        ref: '',
                      })
                  }}
                >
                  <SelectTrigger aria-label={`${source.name}版本类型`}>
                    <SelectValue>
                      {
                        referenceKinds.find((kind) => kind.value === selection[source.id]!.refKind)
                          ?.label
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {referenceKinds.map((kind) => (
                      <SelectItem key={kind.value} value={kind.value}>
                        {kind.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {selection[source.id]!.refKind !== 'default' ? (
                  <Input
                    className="min-w-0 flex-1 basis-40"
                    aria-label={`${source.name}版本引用`}
                    value={selection[source.id]!.ref ?? ''}
                    disabled={disabled}
                    onChange={(event) => onUpdate(source.id, { ref: event.target.value })}
                  />
                ) : null}
                <div className="min-w-0 flex-1 basis-40 space-y-1">
                  <Label htmlFor={`deployment-${source.id}-mount`}>部署挂载目录</Label>
                  <Input
                    id={`deployment-${source.id}-mount`}
                    aria-label={`${source.name}部署挂载目录`}
                    value={selection[source.id]!.mountPath ?? ''}
                    disabled={disabled}
                    onChange={(event) => onUpdate(source.id, { mountPath: event.target.value })}
                  />
                </div>
                <div className="min-w-0 flex-1 basis-40 space-y-1">
                  <Label htmlFor={`deployment-${source.id}-subdirectory`}>仓库子目录</Label>
                  <Input
                    id={`deployment-${source.id}-subdirectory`}
                    aria-label={`${source.name}部署仓库子目录`}
                    placeholder="完整仓库"
                    value={selection[source.id]!.sourcePath ?? ''}
                    disabled={disabled}
                    onChange={(event) => onUpdate(source.id, { sourcePath: event.target.value })}
                  />
                </div>
                {projectId ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`选择${source.name}版本`}
                    onClick={(event) => {
                      trigger.current = event.currentTarget
                      setVersionSource(source)
                    }}
                  >
                    <GitBranchIcon />
                    选择版本
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </fieldset>
      {projectId && versionSource ? (
        <DeploymentRepositoryVersionDialog
          key={versionSource.id}
          projectId={projectId}
          sourceId={versionSource.id}
          sourceName={versionSource.name}
          selection={selection[versionSource.id]!}
          open
          onOpenChange={(open) => {
            if (!open) setVersionSource(null)
          }}
          finalFocus={() => trigger.current}
          onAccessDenied={onAccessDenied}
          onSelect={(value) => onUpdate(versionSource.id, value)}
        />
      ) : null}
    </>
  )
}

export function useDeploymentSourceDraft(
  sources: ProjectRepositoryConnection[],
  service: WorkspaceBuildContext['service'],
  module: string,
  saved?: Pick<DeploymentServiceSource, 'sources' | 'contexts'>,
) {
  const [selection, setSelection] = useState<Record<string, DeploymentSourceSelection>>(() =>
    Object.fromEntries(
      (saved
        ? saved.sources
        : sources.map((source, index) => initialDeploymentSource(source, index, sources.length))
      ).map((entry) => [entry.sourceId, entry]),
    ),
  )
  const [root, setRoot] = useState(
    saved?.contexts.find((entry) => entry.service === service)?.root ??
      (sources.length === 1 ? 'repository' : '.'),
  )
  const chosen = Object.values(selection)
  const missingSources = chosen.some(
    (entry) =>
      !sources.some((source) => source.id === entry.sourceId) ||
      !entry.mountPath ||
      !entry.refKind ||
      typeof entry.ref !== 'string',
  )
  const input = {
    sources: chosen,
    contexts: [{ service, root: root.trim(), workingDirectory: module || '.' }],
  }
  const valid =
    !missingSources &&
    chosen.length > 0 &&
    !!root.trim() &&
    chosen.every(
      (entry) =>
        validDeploymentSourceDirectories(entry) &&
        (entry.refKind === 'default' ? entry.ref === '' : !!entry.ref?.trim()),
    )
  return {
    selection,
    missingSources,
    resetSources: () =>
      setSelection(
        Object.fromEntries(
          sources.map((source, index) => [
            source.id,
            initialDeploymentSource(source, index, sources.length),
          ]),
        ),
      ),
    root,
    setRoot,
    input,
    valid,
    selectSource: (source: ProjectRepositoryConnection, checked: boolean) =>
      setSelection((current) => {
        const next = { ...current }
        if (checked)
          next[source.id] = initialDeploymentSource(
            source,
            sources.findIndex((item) => item.id === source.id),
            sources.length,
          )
        else delete next[source.id]
        return next
      }),
    updateSource: (sourceId: string, change: Partial<DeploymentSourceSelection>) =>
      setSelection((current) => ({
        ...current,
        [sourceId]: updateDeploymentSource(current[sourceId]!, change),
      })),
  }
}

export function DeploymentSourceNotice({
  missing,
  onReset,
  disabled,
}: {
  missing: boolean
  onReset: () => void
  disabled: boolean
}) {
  return missing ? (
    <Alert variant="warning">
      <AlertDescription>保存的来源已变化，请重新选择仓库。</AlertDescription>
      <AlertAction>
        <Button type="button" size="xs" variant="outline" disabled={disabled} onClick={onReset}>
          重新选择仓库
        </Button>
      </AlertAction>
    </Alert>
  ) : null
}
