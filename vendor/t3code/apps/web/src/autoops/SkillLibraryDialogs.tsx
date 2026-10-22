import { useRef, useState, type ReactNode } from 'react'
import { UploadIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Checkbox } from '~/components/ui/checkbox'
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
  type SkillWorkspaceType,
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
        skill
          ? '新版本已入库。现有分配仍使用原版本，可在分配中升级。'
          : '技能已入库。请查看运行条件，再分配给助手或项目。',
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
          <DialogTitle>{skill ? '导入技能新版本' : '导入技能'}</DialogTitle>
          <DialogDescription>
            {skill
              ? `为“${skill.displayName}”保存新版本；技能 name 必须保持一致。`
              : '导入完整技能包到中央仓库，再分配给助手或项目。'}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <ToggleGroup
            value={[mode]}
            variant="segmented"
            aria-label="技能导入方式"
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
                aria-label="技能包文件"
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
                    setFileError('请选择 SKILL.md 或 ZIP 技能包。')
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
                  ZIP 内需包含一个技能目录和 SKILL.md。附带参考资料、模板和资源按原目录保存。
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
                  aria-label="技能 Git 仓库地址"
                  value={url}
                  disabled={disabled}
                  placeholder="https://github.com/组织/仓库"
                  onChange={(event) => setUrl(event.currentTarget.value)}
                />
              </Field>
              <Field label="固定提交 SHA">
                <Input
                  aria-label="技能 Git 提交 SHA"
                  value={ref}
                  disabled={disabled}
                  font="mono"
                  placeholder="40 位提交 SHA"
                  onChange={(event) => setRef(event.currentTarget.value)}
                />
              </Field>
              <Field label="技能所在子目录（选填）">
                <Input
                  aria-label="技能 Git 子目录"
                  value={subdirectory}
                  disabled={disabled}
                  placeholder="skills/project-review"
                  onChange={(event) => setSubdirectory(event.currentTarget.value)}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                支持 GitHub、GitLab、Gitee 和 Codeberg
                的公开仓库。固定提交保证导入版本可以追溯；不接受账号口令或令牌。
              </p>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            导入会检查文件和运行条件。依赖任意脚本、Shell
            或未开放工具的技能可保存查看，但当前不能分配执行。
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
  initialSkillId?: string
  initialTargetType?: SkillTargetType
  initialTargetId?: string
  assignment?: SkillAssignment
  mutate: SkillMutate
}) {
  const [skillId, setSkillId] = useState(assignment?.skillId ?? initialSkillId ?? '')
  const [targetType, setTargetType] = useState<SkillTargetType>(
    assignment?.targetType ?? initialTargetType ?? 'agent',
  )
  const [targetId, setTargetId] = useState(assignment?.targetId ?? initialTargetId ?? '')
  const [selectedVersionId, setVersionId] = useState(assignment?.versionId ?? '')
  const [workspaceTypes, setWorkspaceTypes] = useState<SkillWorkspaceType[]>(
    assignment?.workspaceTypes ?? ['internal'],
  )
  const skill = catalog.skills.find((entry) => entry.id === skillId)
  const versions = skill?.versions.filter((version) => version.readiness === 'ready') ?? []
  const version =
    versions.find((entry) => entry.id === selectedVersionId) ??
    versions.find((entry) => entry.id === skill?.latestVersionId) ??
    versions[0]
  const targets = targetType === 'agent' ? catalog.agents : catalog.projects
  const target = targets.find((entry) => entry.id === targetId)
  const changeWorkspace = (type: SkillWorkspaceType, checked: boolean) =>
    setWorkspaceTypes((current) =>
      checked
        ? [...current.filter((entry) => entry !== type), type]
        : current.filter((entry) => entry !== type),
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogPopup finalFocus={finalFocus} showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{assignment ? '调整技能分配' : '分配技能'}</DialogTitle>
          <DialogDescription>
            选定技能版本和使用范围。会话只能使用已授权的文件与工具。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Field label="技能">
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
              <SelectTrigger aria-label="分配的技能">
                <SelectValue placeholder="选择技能" />
              </SelectTrigger>
              <SelectPopup>
                {catalog.skills.map((entry) => (
                  <SelectItem
                    value={entry.id}
                    key={entry.id}
                    disabled={
                      !entry.enabled ||
                      !entry.versions.some((version) => version.readiness === 'ready')
                    }
                  >
                    {entry.displayName}
                    {!entry.enabled
                      ? ' · 已停用'
                      : !entry.versions.some((version) => version.readiness === 'ready')
                        ? ' · 运行条件未满足'
                        : ''}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="固定版本">
            <Select
              value={version?.id ?? ''}
              disabled={busy || !versions.length}
              onValueChange={(value) => {
                if (typeof value === 'string') setVersionId(value)
              }}
            >
              <SelectTrigger aria-label="分配技能版本">
                <SelectValue placeholder="没有可分配版本" />
              </SelectTrigger>
              <SelectPopup>
                {versions.map((entry) => (
                  <SelectItem value={entry.id} key={entry.id}>
                    {skillVersionName(entry)}
                    {entry.id === skill?.latestVersionId ? ' · 最新' : ''}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="分配范围">
            <ToggleGroup
              value={[targetType]}
              variant="segmented"
              disabled={busy || !!assignment}
              aria-label="技能分配范围"
              onValueChange={(values) => {
                const next = values[0]
                if (next === 'agent' || next === 'project') {
                  setTargetType(next)
                  setTargetId('')
                }
              }}
            >
              <Toggle value="agent">助手</Toggle>
              <Toggle value="project">项目</Toggle>
            </ToggleGroup>
          </Field>
          <Field label={targetType === 'agent' ? '助手' : '项目'}>
            <Select
              value={targetId}
              disabled={busy || !!assignment || !targets.length}
              onValueChange={(value) => {
                if (typeof value === 'string') setTargetId(value)
              }}
            >
              <SelectTrigger aria-label={targetType === 'agent' ? '分配目标助手' : '分配目标项目'}>
                <SelectValue placeholder={targets.length ? '选择目标' : '没有可用目标'} />
              </SelectTrigger>
              <SelectPopup>
                {targets.map((entry) => (
                  <SelectItem value={entry.id} key={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="可用工作区">
            <div className="flex flex-wrap gap-4">
              <label className="flex min-h-9 items-center gap-2 text-sm">
                <Checkbox
                  checked={workspaceTypes.includes('internal')}
                  disabled={busy}
                  onCheckedChange={(checked) => changeWorkspace('internal', checked)}
                />
                内部工作区
              </label>
              <label className="flex min-h-9 items-center gap-2 text-sm">
                <Checkbox
                  checked={workspaceTypes.includes('external')}
                  disabled={busy}
                  onCheckedChange={(checked) => changeWorkspace('external', checked)}
                />
                外部工作区
              </label>
            </div>
          </Field>
          <p className="text-xs text-muted-foreground">
            外部可用意味着外部成员可以读取技能说明和附带文件，请先检查其中不含内部资料。更新技能库后，已有分配继续使用此固定版本。
          </p>
          <ErrorMessage error={error} />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || !skill?.enabled || !version || !target || !workspaceTypes.length}
            onClick={async () => {
              if (
                skill &&
                version &&
                target &&
                (await mutate(
                  {
                    action: 'assign',
                    skillId: skill.id,
                    versionId: version.id,
                    targetType,
                    targetId: target.id,
                    workspaceTypes,
                    enabled: true,
                  },
                  '分配已保存，新对话将使用该版本；已有对话保持其固定版本。',
                ))
              )
                onClose()
            }}
          >
            {busy ? '正在保存…' : '保存分配'}
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
}: SkillDialogProps & {
  skill: LibrarySkill
  catalog: SkillLibrary
  mutate: SkillMutate
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
          <DialogTitle>技能分配与版本</DialogTitle>
          <DialogDescription>{skill.displayName}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <section aria-label="当前分配">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">当前分配</h3>
            {assignments.length ? (
              <div className="divide-y divide-border/60">
                {assignments.map((entry) => {
                  const target = (
                    entry.targetType === 'agent' ? catalog.agents : catalog.projects
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
                          {entry.targetType === 'agent' ? '助手' : '项目'} ·{' '}
                          {target?.name ?? '不可见目标'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">
                          {entry.workspaceTypes
                            .map((type) => (type === 'internal' ? '内部' : '外部'))
                            .join('、')}{' '}
                          · {version ? skillVersionName(version) : '版本不可用'}
                          {!entry.enabled ? ' · 已停用' : ''}
                        </p>
                      </div>
                      {catalog.canManage ? (
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
                                '分配已撤销，后续轮次不能再通过此范围使用技能。',
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
              <p className="text-sm text-muted-foreground">尚未分配给助手或项目。</p>
            )}
          </section>
          <section aria-label="技能版本记录">
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
                      : `运行条件未满足：${version.reason ?? '请检查技能包'}`}
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
          <DialogTitle>删除技能</DialogTitle>
          <DialogDescription>
            将“{skill.displayName}”从技能库移除。
            {assignedCount
              ? `该技能有 ${assignedCount} 项分配，请先撤销分配后删除。`
              : '历史轮次保留其固定执行版本，后续不能再分配或调用此技能。'}
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
              if (await mutate({ action: 'delete', skillId: skill.id }, '技能已从中央库移除。'))
                onClose()
            }}
          >
            {busy ? '正在删除…' : '删除技能'}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
