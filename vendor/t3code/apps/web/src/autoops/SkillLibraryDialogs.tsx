import { useRef, useState, type ReactNode } from 'react'
import { UploadIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from '~/components/ui/dialog'
import {
  type LibrarySkill,
  type SkillAssignment,
  type SkillLibrary,
  type SkillLibraryAction,
  type SkillTargetType,
  GLOBAL_SKILL_TARGET,
  skillScopeNames,
  inheritedSkillAssignment,
  canManageSkillScope,
  skillVersionName,
  skillSourceName,
} from './skillLibrary'

export type SkillDialogProps = {
  busy: boolean
  error: string | null
  onClose: () => void
  finalFocus: () => HTMLElement | null
}
export type SkillMutate = (action: SkillLibraryAction, success: string) => Promise<boolean>
function ErrorMessage({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive wrap-anywhere">
      {error}
    </p>
  ) : null
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
    </div>
  )
}
const sample =
  '---\nname: project-readiness\ndescription: 根据授权项目资料检查发布准备情况\nmetadata:\n  display-name: 项目发布检查\nallowed-tools:\n  - list_project_materials\n  - read_project_document\n---\n\n阅读当前项目的授权资料，列出已确认事项和缺失信息。引用真实来源，不编造结论。'

export function SkillImportDialog({
  skill,
  busy,
  error,
  onClose,
  finalFocus,
  mutate,
}: SkillDialogProps & { skill?: LibrarySkill; mutate: SkillMutate }) {
  const [mode, setMode] = useState<'file' | 'markdown' | 'git'>('file')
  const [contents, setContents] = useState('')
  const [file, setFile] = useState<{
    name: string
    size: number
    action: SkillLibraryAction
  } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subdirectory, setSubdirectory] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const disabled = busy || reading
  const canSubmit =
    mode === 'file'
      ? !!file
      : mode === 'markdown'
        ? !!contents.trim()
        : /^https:\/\//i.test(url.trim()) && /^[a-f\d]{40}$/i.test(ref.trim())
  const submit = async () => {
    if (!canSubmit || disabled) return
    const action: SkillLibraryAction | undefined =
      mode === 'file'
        ? file?.action
        : mode === 'markdown'
          ? { action: 'import-markdown', contents }
          : {
              action: 'import-git',
              url: url.trim(),
              ref: ref.trim(),
              ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}),
            }
    if (!action) return
    if (
      await mutate(
        { ...action, ...(skill ? { skillId: skill.id } : {}) },
        skill ? '新版本已导入，已有分配保持不变。' : 'skill已导入。',
      )
    )
      onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !disabled) onClose()
      }}
    >
      <DialogPopup finalFocus={finalFocus} showCloseButton={!disabled} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill ? '导入skill新版本' : '导入skill'}</DialogTitle>
          <DialogDescription>
            {skill
              ? `${skill.displayName} · name 须与原skill一致`
              : '支持 SKILL.md、ZIP 和公开 Git 仓库。'}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <ToggleGroup
            value={[mode]}
            variant="segmented"
            aria-label="skill导入方式"
            disabled={disabled}
            onValueChange={(values) => {
              const next = values[0]
              if (next === 'file' || next === 'markdown' || next === 'git') {
                setMode(next)
                setFileError(null)
              }
            }}
          >
            <Toggle value="file">上传文件</Toggle>
            <Toggle value="markdown">粘贴正文</Toggle>
            <Toggle value="git">Git 仓库</Toggle>
          </ToggleGroup>
          {mode === 'file' ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => fileRef.current?.click()}
              >
                <UploadIcon />
                {reading ? '正在读取文件…' : '选择 SKILL.md 或 ZIP'}
              </Button>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept=".md,.zip,text/markdown,application/zip"
                aria-label="skill包文件"
                onChange={(event) => {
                  const chosen = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (!chosen) return
                  setFile(null)
                  setFileError(null)
                  const archive = chosen.name.toLowerCase().endsWith('.zip')
                  if (chosen.size > (archive ? 16 * 1024 * 1024 : 128 * 1024)) {
                    setFileError(archive ? 'ZIP 不能超过 16 MiB。' : 'SKILL.md 不能超过 128 KiB。')
                    return
                  }
                  if (!archive && !chosen.name.toLowerCase().endsWith('.md')) {
                    setFileError('请选择 SKILL.md 或 ZIP skill包。')
                    return
                  }
                  setReading(true)
                  void (async () => {
                    const action: SkillLibraryAction = archive
                      ? {
                          action: 'import-archive',
                          archiveBase64: await fileBase64(chosen),
                          fileName: chosen.name,
                        }
                      : { action: 'import-markdown', contents: await chosen.text() }
                    setFile({ name: chosen.name, size: chosen.size, action })
                  })()
                    .catch(() => setFileError('文件读取失败，请重新选择。'))
                    .finally(() => setReading(false))
                }}
              />
              {file ? (
                <p className="text-sm wrap-anywhere">
                  {file.name} · {(file.size / 1024).toFixed(1)} KiB
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  ZIP 内须包含 SKILL.md，可附带参考资料和模板。
                </p>
              )}
            </>
          ) : mode === 'markdown' ? (
            <>
              <Textarea
                aria-label="SKILL.md 正文"
                value={contents}
                disabled={disabled}
                rows={12}
                placeholder={sample}
                onChange={(event) => setContents(event.currentTarget.value)}
              />
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={() => setContents(sample)}
              >
                填写示例
              </Button>
            </>
          ) : (
            <>
              <Field label="公开 HTTPS 仓库">
                <Input
                  aria-label="skill Git 仓库地址"
                  value={url}
                  disabled={disabled}
                  placeholder="https://github.com/组织/仓库"
                  onChange={(event) => setUrl(event.currentTarget.value)}
                />
              </Field>
              <Field label="提交版本">
                <Input
                  aria-label="skill Git 提交 SHA"
                  value={ref}
                  disabled={disabled}
                  font="mono"
                  placeholder="40 位提交 SHA"
                  onChange={(event) => setRef(event.currentTarget.value)}
                />
              </Field>
              <Field label="skill所在子目录（选填）">
                <Input
                  aria-label="skill Git 子目录"
                  value={subdirectory}
                  disabled={disabled}
                  placeholder="skills/project-review"
                  onChange={(event) => setSubdirectory(event.currentTarget.value)}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                支持 GitHub、GitLab、Gitee 和 Codeberg 的公开仓库，不接受账号口令或令牌。
              </p>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            导入后自动检查；依赖脚本或未开放工具的skill仅可查看。
          </p>
          <ErrorMessage error={fileError ?? error} />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={disabled} onClick={onClose}>
            取消
          </Button>
          <Button disabled={disabled || !canSubmit} onClick={() => void submit()}>
            {busy ? '正在导入与检查…' : '导入并检查'}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return btoa(binary)
}

export function SkillAssignmentDialog({
  catalog,
  projectId,
  allowedScopes = ['global', 'project', 'assistant'],
  initialSkillId,
  initialTargetType,
  initialTargetId,
  assignment,
  busy,
  error,
  onClose,
  finalFocus,
  mutate,
}: SkillDialogProps & {
  catalog: SkillLibrary
  projectId: string
  allowedScopes?: SkillTargetType[]
  initialSkillId?: string
  initialTargetType?: SkillTargetType
  initialTargetId?: string
  assignment?: SkillAssignment
  mutate: SkillMutate
}) {
  const [skillId, setSkillId] = useState(assignment?.skillId ?? initialSkillId ?? '')
  const [targetType, setTargetType] = useState<SkillTargetType>(
    assignment?.targetType ?? initialTargetType ?? 'project',
  )
  const [assistantId, setAssistantId] = useState(assignment?.targetId ?? initialTargetId ?? '')
  const [selectedVersionId, setVersionId] = useState(assignment?.versionId ?? '')
  const [enabled, setEnabled] = useState(assignment?.enabled ?? true)
  const skill = catalog.skills.find((entry) => entry.id === skillId)
  const versions = skill?.versions.filter((version) => version.readiness === 'ready') ?? []
  const version =
    versions.find((entry) => entry.id === selectedVersionId) ??
    versions.find((entry) => entry.id === skill?.latestVersionId) ??
    versions[0]
  const assistants = catalog.assistants.filter(
    (entry) => entry.projectId === projectId && entry.executionKind === 'platform',
  )
  const targetId =
    targetType === 'global'
      ? GLOBAL_SKILL_TARGET
      : targetType === 'project'
        ? projectId
        : assistantId
  const validTarget =
    targetType !== 'assistant' || assistants.some((entry) => entry.id === assistantId)
  const inherited = skill
    ? inheritedSkillAssignment(catalog, skill.id, targetType, projectId)
    : undefined
  const canManage =
    allowedScopes.includes(targetType) && canManageSkillScope(catalog, targetType, projectId)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogPopup finalFocus={finalFocus} showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{assignment ? '调整启用范围' : '启用 skill'}</DialogTitle>
          <DialogDescription>
            上层启用后，下层自动继承；关闭上层后按下层配置生效。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Field label="skill">
            <Select
              value={skillId}
              disabled={busy || !!assignment}
              onValueChange={(value) => {
                if (typeof value === 'string') {
                  setSkillId(value)
                  setVersionId('')
                }
              }}
            >
              <SelectTrigger aria-label="分配的skill">
                <SelectValue placeholder="选择 skill" />
              </SelectTrigger>
              <SelectPopup>
                {catalog.skills.map((entry) => (
                  <SelectItem
                    key={entry.id}
                    value={entry.id}
                    disabled={
                      !entry.enabled ||
                      !entry.versions.some((version) => version.readiness === 'ready')
                    }
                  >
                    {entry.displayName}
                    {!entry.enabled ? ' · 已停用' : ''}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="启用范围">
            <ToggleGroup
              value={[targetType]}
              variant="segmented"
              disabled={busy || !!assignment}
              aria-label="skill启用范围"
              onValueChange={(values) => {
                const next = values[0]
                if (next === 'global' || next === 'project' || next === 'assistant')
                  setTargetType(next)
              }}
            >
              {allowedScopes.includes('global') ? (
                <Toggle value="global" disabled={!catalog.canManage}>
                  所有项目
                </Toggle>
              ) : null}
              {allowedScopes.includes('project') ? <Toggle value="project">当前项目</Toggle> : null}
              {allowedScopes.includes('assistant') ? (
                <Toggle value="assistant">指定助手</Toggle>
              ) : null}
            </ToggleGroup>
          </Field>
          {targetType === 'assistant' ? (
            <Field label="当前项目的助手">
              <Select
                value={assistantId}
                disabled={busy || !!assignment || !assistants.length}
                onValueChange={(value) => {
                  if (typeof value === 'string') setAssistantId(value)
                }}
              >
                <SelectTrigger aria-label="分配目标助手">
                  <SelectValue placeholder="选择助手" />
                </SelectTrigger>
                <SelectPopup>
                  {assistants.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground">
              {targetType === 'global'
                ? '所有当前及后续项目均可使用。'
                : `${catalog.projects.find((entry) => entry.id === projectId)?.name ?? '当前项目'}的所有对话均可使用。`}
            </p>
          )}
          {inherited ? (
            <p role="status" className="text-sm text-muted-foreground">
              已继承“{skillScopeNames[inherited.targetType]}”。关闭上层后可在此单独设置。
            </p>
          ) : null}
          <Field label="固定版本">
            <Select
              value={version?.id ?? ''}
              disabled={busy || !!inherited || !versions.length}
              onValueChange={(value) => {
                if (typeof value === 'string') setVersionId(value)
              }}
            >
              <SelectTrigger aria-label="分配skill版本">
                <SelectValue placeholder="没有可用版本" />
              </SelectTrigger>
              <SelectPopup>
                {versions.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {skillVersionName(entry)}
                    {entry.id === skill?.latestVersionId ? ' · 最新' : ''}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          {assignment ? (
            <Field label="此范围状态">
              <ToggleGroup
                variant="segmented"
                value={[enabled ? 'enabled' : 'disabled']}
                disabled={busy || !!inherited}
                aria-label="skill范围状态"
                onValueChange={(values) => {
                  if (values[0]) setEnabled(values[0] === 'enabled')
                }}
              >
                <Toggle value="enabled">启用</Toggle>
                <Toggle value="disabled">关闭</Toggle>
              </ToggleGroup>
            </Field>
          ) : null}
          <ErrorMessage error={error} />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              busy || !canManage || !!inherited || !skill?.enabled || !version || !validTarget
            }
            onClick={async () => {
              if (
                skill &&
                version &&
                validTarget &&
                !inherited &&
                canManage &&
                (await mutate(
                  {
                    action: 'assign',
                    skillId: skill.id,
                    versionId: version.id,
                    targetType,
                    targetId,
                    ...(targetType === 'assistant' ? { projectId } : {}),
                    enabled,
                  },
                  '启用范围已保存。',
                ))
              )
                onClose()
            }}
          >
            {busy ? '正在保存…' : '保存范围'}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

export function SkillDetailsDialog({
  skill,
  catalog,
  busy,
  error,
  onClose,
  finalFocus,
  mutate,
  onEdit,
  allowedScopes = ['global', 'project', 'assistant'],
}: SkillDialogProps & {
  skill: LibrarySkill
  catalog: SkillLibrary
  mutate: SkillMutate
  allowedScopes?: SkillTargetType[]
  onEdit: (assignment: SkillAssignment) => void
}) {
  const assignments = catalog.assignments.filter((entry) => entry.skillId === skill.id)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogPopup finalFocus={finalFocus} showCloseButton={!busy} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>skill分配与版本</DialogTitle>
          <DialogDescription>{skill.displayName}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <section aria-label="当前分配">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">当前分配</h3>
            {assignments.length ? (
              <div className="divide-y divide-border/60">
                {assignments.map((entry) => {
                  const target = (
                    entry.targetType === 'global'
                      ? [{ id: GLOBAL_SKILL_TARGET, name: '所有项目' }]
                      : entry.targetType === 'assistant'
                        ? catalog.assistants
                        : catalog.projects
                  ).find((target) => target.id === entry.targetId)
                  const version = skill.versions.find((version) => version.id === entry.versionId)
                  return (
                    <div
                      key={entry.id}
                      data-skill-assignment={entry.id}
                      className="flex min-w-0 flex-wrap items-center gap-2 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm" title={target?.name}>
                          {skillScopeNames[entry.targetType]} · {target?.name ?? '不可见目标'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">
                          · {version ? skillVersionName(version) : '版本不可用'}
                          {!entry.enabled ? ' · 已停用' : ''}
                        </p>
                      </div>
                      {allowedScopes.includes(entry.targetType) &&
                      canManageSkillScope(
                        catalog,
                        entry.targetType,
                        entry.projectId ?? entry.targetId,
                      ) ? (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() => onEdit(entry)}
                          >
                            调整
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                { action: 'unassign', assignmentId: entry.id },
                                '已撤销此范围，按其余启用范围生效。',
                              )
                            }
                          >
                            撤销分配
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">尚未设置启用范围。</p>
            )}
          </section>
          <section aria-label="skill版本记录">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">版本记录</h3>
            <div className="divide-y divide-border/60">
              {skill.versions.map((version) => (
                <div className="space-y-1 py-2 text-xs" key={version.id}>
                  <p className="font-medium">
                    {skillVersionName(version)}
                    {version.id === skill.latestVersionId ? ' · 最新' : ''}
                  </p>
                  <p className="text-muted-foreground">
                    {skillSourceName(version.source)} · {version.fileCount} 个文件 ·{' '}
                    {(version.byteLength / 1024).toFixed(1)} KiB
                  </p>
                  {version.source.url ? (
                    <p className="text-muted-foreground break-all">
                      {version.source.url}
                      {version.source.subdirectory ? ` / ${version.source.subdirectory}` : ''}
                    </p>
                  ) : null}
                  {version.source.commit ? (
                    <p className="font-mono break-all">{version.source.commit}</p>
                  ) : null}
                  <p className="text-muted-foreground break-all">内容校验：{version.contentHash}</p>
                  <p
                    className={
                      version.readiness === 'ready'
                        ? 'text-muted-foreground'
                        : 'text-warning-foreground'
                    }
                  >
                    {version.readiness === 'ready'
                      ? '运行条件已满足'
                      : `运行条件未满足：${version.reason ?? '请检查skill包'}`}
                  </p>
                </div>
              ))}
            </div>
          </section>
          <ErrorMessage error={error} />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            关闭
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

export function SkillDeleteDialog({
  skill,
  assignedCount,
  busy,
  error,
  onClose,
  finalFocus,
  mutate,
}: SkillDialogProps & { skill: LibrarySkill; assignedCount: number; mutate: SkillMutate }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogPopup finalFocus={finalFocus} showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>删除skill</DialogTitle>
          <DialogDescription>
            将“{skill.displayName}”从skills移除。
            {assignedCount
              ? `该skill有 ${assignedCount} 项分配，请先撤销分配后删除。`
              : '历史轮次保留其固定执行版本，后续不能再分配或调用此skill。'}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ErrorMessage error={error} />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={busy || assignedCount > 0}
            onClick={async () => {
              if (await mutate({ action: 'delete', skillId: skill.id }, 'skill已从中央库移除。'))
                onClose()
            }}
          >
            {busy ? '正在删除…' : '删除skill'}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
