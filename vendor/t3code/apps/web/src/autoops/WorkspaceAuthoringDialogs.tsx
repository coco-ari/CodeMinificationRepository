import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Textarea } from '~/components/ui/textarea'
import { Spinner } from '~/components/ui/spinner'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { formatBytes } from '~/lib/formatBytes'
import {
  authoringDigest,
  loadAuthoringContent,
  uploadDigest,
  validMaterialPath,
  type WorkspaceCredentialMetadata,
  type CredentialUsage,
  type WorkspaceMaterialEntry,
  type WorkspaceRepositorySource,
  type WorkspaceRepositoryUsageInput,
  type WorkspaceUploadInput,
} from './workspaceAuthoring'
import type { WorkspaceAuthoringController } from './useWorkspaceAuthoring'
import { loadProjectRepositories, type ProjectRepositoryConnection } from './projectRepositories'
import { WorkspaceSubmissionNotice } from './WorkspaceActions'
import { WorkspaceRepositoryReference } from './WorkspaceRepositoryReference'

export const WorkspaceAuthoringFocus = createContext<(() => HTMLElement | null) | undefined>(
  undefined,
)

export function AuthoringField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
export function AuthoringSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <AuthoringField label={label}>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === 'string') onChange(next)
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue>
            {options.find((option) => option.value === value)?.label ?? value}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem value={option.value} key={option.value} disabled={option.disabled ?? false}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </AuthoringField>
  )
}
export const sourceRoles = [
  { value: 'frontend', label: '前端' },
  { value: 'backend', label: '后端' },
  { value: 'shared', label: '共享' },
  { value: 'documentation', label: '文档' },
  { value: 'other', label: '其他' },
] as const
const refKinds = [
  { value: 'default', label: '远端默认分支' },
  { value: 'branch', label: '分支' },
  { value: 'tag', label: '标签' },
  { value: 'commit', label: '提交' },
] as const

export function AuthoringNotice({ controller }: { controller: WorkspaceAuthoringController }) {
  return (
    <>
      {controller.error ? (
        <Alert variant="error" role="alert">
          <AlertDescription>{controller.error}</AlertDescription>
        </Alert>
      ) : null}
      <WorkspaceSubmissionNotice
        label={controller.pending?.label ?? null}
        busy={controller.busy}
        paused={controller.recoveryPaused}
        retryAvailable={controller.retryAvailable}
        onCheck={async () => !!(await controller.check())}
        onRetry={async () => !!(await controller.retry())}
      />
    </>
  )
}

type EditorProps = { controller: WorkspaceAuthoringController; onClose: () => void }
function AuthoringDialog({
  title,
  children,
  footer,
  onClose,
  busy,
  dirty = false,
}: {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose: () => void
  busy: boolean
  dirty?: boolean
}) {
  const [discard, setDiscard] = useState(false)
  const finalFocus = useContext(WorkspaceAuthoringFocus)
  const close = () => {
    if (busy) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogPopup className="max-w-2xl" finalFocus={finalFocus}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">{children}</DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              关闭
            </Button>
            {footer}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>放弃尚未保存的修改？</DialogTitle>
          </DialogHeader>
          <DialogPanel>这些输入尚未保存，关闭后需要重新填写。</DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscard(false)}>
              继续编辑
            </Button>
            <Button variant="destructive" onClick={onClose}>
              放弃修改
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  )
}

export function WorkspaceSourceDialog({
  controller,
  source,
  projectId,
  onClose,
}: EditorProps & { projectId: string; source?: WorkspaceRepositorySource | undefined }) {
  const initial: WorkspaceRepositoryUsageInput = {
    id: source?.id ?? '',
    role: source?.role ?? 'other',
    refKind: source?.refKind ?? 'default',
    ref: source?.ref ?? '',
    mountPath: source?.mountPath ?? '',
    ...(source?.sourcePath ? { sourcePath: source.sourcePath } : {}),
  }
  const [repositories, setRepositories] = useState<ProjectRepositoryConnection[] | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setRepositories(null)
    setReadError(null)
    void loadProjectRepositories(projectId, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) setRepositories(result.items)
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return
        setReadError(cause instanceof Error ? cause.message : '项目仓库暂时不可用')
      })
    return () => abort.abort()
  }, [projectId, attempt])
  const [input, setInput] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const form = useId()
  const field = <K extends keyof WorkspaceRepositoryUsageInput>(
    key: K,
    value: WorkspaceRepositoryUsageInput[K],
  ) => setInput((current) => ({ ...current, [key]: value }))
  const save = async () => {
    setError(null)
    try {
      if (!repositories?.some((repository) => repository.id === input.id))
        throw new Error('请选择当前项目可用的仓库。')
      if (
        !validMaterialPath(input.mountPath) ||
        (input.sourcePath && !validMaterialPath(input.sourcePath))
      )
        throw new Error('请填写有效的项目相对目录。')
      if (input.refKind !== 'default' && !input.ref.trim())
        throw new Error('请填写分支、标签或提交。')
      const { sourcePath, ...definition } = input
      if (
        await controller.submit({
          kind: 'source',
          action: 'save',
          source: {
            ...definition,
            ...(sourcePath ? { sourcePath } : {}),
            ref: input.refKind === 'default' ? '' : input.ref.trim(),
          },
        })
      )
        onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '来源输入无效。')
    }
  }
  return (
    <AuthoringDialog
      title={source ? '编辑源码来源' : '添加源码来源'}
      onClose={onClose}
      busy={controller.busy}
      dirty={JSON.stringify(input) !== JSON.stringify(initial)}
      footer={
        <Button
          type="submit"
          form={form}
          disabled={
            controller.busy || !repositories?.some((repository) => repository.id === input.id)
          }
        >
          保存来源
        </Button>
      }
    >
      <form
        id={form}
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <AuthoringSelect
          label="项目仓库"
          value={input.id}
          options={[
            { value: '', label: '请选择仓库' },
            ...(repositories ?? []).map((repository) => ({
              value: repository.id,
              label: repository.name,
              disabled:
                !source && !!controller.overview?.sources.some((item) => item.id === repository.id),
            })),
            ...(source && !repositories?.some((repository) => repository.id === source.id)
              ? [{ value: source.id, label: `${source.name} · 已不可用`, disabled: true }]
              : []),
          ]}
          disabled={controller.busy || !!source || !repositories}
          onChange={(value) => setInput((current) => ({ ...current, id: value, ref: '' }))}
        />
        {readError ? (
          <Alert variant="error">
            <AlertDescription>{readError}</AlertDescription>
            <Button
              variant="outline"
              size="sm"
              disabled={controller.busy}
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试项目仓库
            </Button>
          </Alert>
        ) : null}
        {repositories?.length === 0 ? (
          <p className="text-sm">
            尚无项目仓库。
            <a href={`/projects?projectId=${encodeURIComponent(projectId)}`}>配置项目仓库</a>
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <AuthoringSelect
            label="作用"
            value={input.role}
            options={sourceRoles}
            onChange={(value) => field('role', value as WorkspaceRepositoryUsageInput['role'])}
            disabled={controller.busy}
          />
          <AuthoringSelect
            label="版本引用"
            value={input.refKind}
            options={refKinds}
            onChange={(value) =>
              setInput((current) => ({
                ...current,
                refKind: value as WorkspaceRepositoryUsageInput['refKind'],
                ref: '',
              }))
            }
            disabled={controller.busy}
          />
        </div>
        <WorkspaceRepositoryReference
          key={`${projectId}:${input.id}`}
          projectId={projectId}
          repositoryId={
            repositories?.some((repository) => repository.id === input.id) ? input.id : ''
          }
          refKind={input.refKind}
          value={input.ref}
          disabled={controller.busy}
          onChange={(value) => field('ref', value)}
        />
        <AuthoringField label="工作区挂载目录">
          <Input
            aria-label="工作区挂载目录"
            value={input.mountPath}
            disabled={controller.busy}
            placeholder="src/frontend"
            onChange={(event) => field('mountPath', event.target.value)}
          />
        </AuthoringField>
        <AuthoringField label="仓库内子目录（可选）">
          <Input
            aria-label="仓库内子目录"
            value={input.sourcePath ?? ''}
            disabled={controller.busy}
            placeholder="留空使用完整仓库"
            onChange={(event) => field('sourcePath', event.target.value)}
          />
        </AuthoringField>
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <AuthoringNotice controller={controller} />
      </form>
    </AuthoringDialog>
  )
}

export function WorkspaceCredentialDialog({
  controller,
  credential,
  onClose,
  usage,
  usageReady = true,
}: EditorProps & {
  credential?: WorkspaceCredentialMetadata | undefined
  usage?: ReactNode
  usageReady?: boolean
}) {
  const [name, setName] = useState(credential?.name ?? '')
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const form = useId()
  return (
    <AuthoringDialog
      title={credential ? '替换仓库凭证' : '添加仓库凭证'}
      busy={controller.busy}
      onClose={onClose}
      dirty={!!secret || !!username || name !== (credential?.name ?? '')}
      footer={
        <Button
          type="submit"
          form={form}
          disabled={controller.busy || !usageReady || !name.trim() || !secret}
        >
          保存凭证
        </Button>
      }
    >
      {usage}
      <form
        id={form}
        className="space-y-4"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault()
          if (!usageReady) return
          void controller
            .submit({
              kind: 'credential',
              action: 'save',
              name,
              username,
              secret,
              ...(credential
                ? { id: credential.id, expectedCredentialRevision: credential.revision }
                : {}),
            })
            .then((result) => {
              if (result) {
                setSecret('')
                onClose()
              }
            })
        }}
      >
        <AuthoringField label="凭证名称">
          <Input
            aria-label="凭证名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={controller.busy}
          />
        </AuthoringField>
        <AuthoringField label="用户名">
          <Input
            aria-label="用户名"
            autoComplete="off"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={controller.busy}
          />
        </AuthoringField>
        <AuthoringField label="访问令牌或密码">
          <Input
            aria-label="访问令牌或密码"
            autoComplete="new-password"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            disabled={controller.busy}
          />
        </AuthoringField>
        <AuthoringNotice controller={controller} />
      </form>
    </AuthoringDialog>
  )
}

export type CredentialUsageView =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; value: CredentialUsage }

export function WorkspaceCredentialUsage({
  view,
  onRetry,
}: {
  view: CredentialUsageView
  onRetry(): void
}) {
  if (view.state === 'loading') return <p role="status">正在读取使用关系</p>
  if (view.state === 'error')
    return (
      <div className="space-y-2">
        <Alert variant="error" role="alert">
          <AlertDescription>{view.message}</AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" onClick={onRetry}>
          重试使用关系
        </Button>
      </div>
    )
  const value = view.value
  const repositoryName = (id: string) =>
    value.repositories.find((item) => item.id === id)?.name ?? '仓库'
  return (
    <SettingsSection title="使用关系">
      <p className="px-3 text-xs text-muted-foreground sm:px-4">仅显示当前授权范围内的配置引用。</p>
      <SettingsRow title="仓库">
        {value.repositories.length ? (
          <ul className="space-y-1 break-words">
            {value.repositories.map((item) => (
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
        ) : (
          <p>无可见仓库引用</p>
        )}
      </SettingsRow>
      <SettingsRow title="工作区">
        {value.workspaces.length ? (
          <ul className="space-y-1 break-words">
            {value.workspaces.map((item) => (
              <li key={`${item.repositoryId}:${item.mountPath}`}>
                <span>{item.mountPath}</span>
                <span className="text-muted-foreground">
                  {' '}
                  · {repositoryName(item.repositoryId)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>无可见工作区引用</p>
        )}
      </SettingsRow>
      <SettingsRow title="服务">
        {value.services.length ? (
          <ul className="space-y-1 break-words">
            {value.services.map((item) => (
              <li key={`${item.environmentId}:${item.serviceId}`}>
                <span>{item.serviceName}</span>
                <span className="text-muted-foreground">
                  {' '}
                  · <span>{item.environmentName}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>无可见服务引用</p>
        )}
      </SettingsRow>
      <SettingsRow title="环境连接">
        {value.connections.length ? (
          <ul className="space-y-1 break-words">
            {value.connections.map((item) => (
              <li key={item.connectionId}>
                <span>{item.name}</span>
                <span className="text-muted-foreground">
                  {' '}
                  · {item.environmentName} ·{' '}
                  {{ server: 'SSH', mysql: 'MySQL', redis: 'Redis' }[item.type]} ·{' '}
                  {item.enabled ? '已启用' : '已停用'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>无可见环境连接引用</p>
        )}
      </SettingsRow>
    </SettingsSection>
  )
}

export function WorkspaceCredentialUsageDialog({
  credential,
  children,
  onClose,
}: {
  credential: WorkspaceCredentialMetadata
  children: ReactNode
  onClose(): void
}) {
  return (
    <AuthoringDialog
      title={`${credential.name}的使用关系`}
      busy={false}
      footer={null}
      onClose={onClose}
    >
      {children}
    </AuthoringDialog>
  )
}

export function WorkspaceFileEditDialog({
  projectId,
  entry,
  action,
  controller,
  onClose,
}: EditorProps & {
  projectId: string
  entry?: WorkspaceMaterialEntry | undefined
  action: 'mkdir' | 'save' | 'move' | 'delete'
}) {
  const [path, setPath] = useState(
    action === 'mkdir' ? 'docs/' : (entry?.path ?? 'docs/产品资料/说明.md'),
  )
  const [contents, setContents] = useState('')
  const [original, setOriginal] = useState('')
  const [contentRevision, setContentRevision] = useState(entry?.revision ?? '')
  const [loading, setLoading] = useState(action === 'save' && !!entry)
  const [error, setError] = useState<string | null>(null)
  const form = useId()
  useEffect(() => {
    if (action !== 'save' || !entry) return
    const abort = new AbortController()
    void loadAuthoringContent(projectId, entry.path, abort.signal)
      .then((content) => {
        if (abort.signal.aborted) return
        if (content.revision !== entry.revision)
          throw new Error('文件已变化，请关闭编辑器并刷新后再编辑。')
        if (content.contents === undefined) throw new Error('无法读取可编辑正文，请下载原件核对。')
        setContents(content.contents)
        setOriginal(content.contents)
        setContentRevision(content.revision)
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : '读取正文失败。')
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false)
      })
    return () => abort.abort()
  }, [projectId, entry, action])
  const title = {
    mkdir: '新建资料目录',
    save: entry ? '编辑文本资料' : '新建文本资料',
    move: '重命名或移动',
    delete: '删除资料',
  }[action]
  const save = async () => {
    if (action !== 'delete' && !validMaterialPath(path)) {
      setError('请填写有效的项目相对路径。')
      return
    }
    if (action === 'save' && !/\.(md|txt)$/i.test(path)) {
      setError('在线编辑支持 MD 和 TXT 文件。')
      return
    }
    const command =
      action === 'mkdir'
        ? { kind: 'document' as const, action, path }
        : action === 'move'
          ? {
              kind: 'document' as const,
              action,
              path: entry!.path,
              destination: path,
              expectedContentRevision: entry!.revision,
            }
          : action === 'delete'
            ? {
                kind: 'document' as const,
                action,
                path: entry!.path,
                expectedContentRevision: entry!.revision,
              }
            : {
                kind: 'document' as const,
                action,
                path,
                expectedContentRevision: contentRevision,
                contents,
              }
    if (await controller.submit(command)) onClose()
  }
  return (
    <AuthoringDialog
      title={title}
      busy={controller.busy}
      onClose={onClose}
      dirty={contents !== original || (action === 'move' && path !== entry?.path)}
      footer={
        <Button
          type="submit"
          form={form}
          variant={action === 'delete' ? 'destructive' : 'default'}
          disabled={controller.busy || loading || (action === 'save' && !!error)}
        >
          {action === 'delete' ? '确认删除' : '保存'}
        </Button>
      }
    >
      <form
        id={form}
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        {action === 'delete' ? (
          <p className="break-all">
            删除「{entry?.path}」及其目录内容？已有任务和历史引用仍然保留。
          </p>
        ) : (
          <AuthoringField label="项目相对路径">
            <Input
              aria-label="项目相对路径"
              value={path}
              disabled={controller.busy || (action === 'save' && !!entry)}
              onChange={(event) => {
                setError(null)
                setPath(event.target.value)
              }}
            />
          </AuthoringField>
        )}
        {action === 'save' ? (
          loading ? (
            <Spinner />
          ) : (
            <AuthoringField label="正文">
              <Textarea
                aria-label="资料正文"
                value={contents}
                disabled={controller.busy || !!error}
                onChange={(event) => setContents(event.target.value)}
              />
            </AuthoringField>
          )
        ) : null}
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <AuthoringNotice controller={controller} />
      </form>
    </AuthoringDialog>
  )
}

type UploadRow = {
  file: File
  status: 'waiting' | 'hashing' | 'sending' | 'saved' | 'skipped' | 'unknown' | 'failed'
  message?: string
  digest?: string
}
export function WorkspaceUploadDialog({ controller, onClose }: EditorProps) {
  const [directory, setDirectory] = useState('docs/产品资料')
  const [conflict, setConflict] = useState<WorkspaceUploadInput['conflict']>('keep-both')
  const [rows, setRows] = useState<UploadRow[]>([])
  const [running, setRunning] = useState(false)
  const stopped = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  useEffect(() => {
    const outcome = controller.lastOutcome
    if (!outcome) return
    setRows((current) =>
      current.map((row) =>
        row.digest === outcome.digest
          ? {
              ...row,
              status: 'skipped' in outcome.result && outcome.result.skipped ? 'skipped' : 'saved',
              message: '',
            }
          : row,
      ),
    )
  }, [controller.lastOutcome])
  const busy = running || controller.busy
  const update = (index: number, status: UploadRow['status'], message?: string) =>
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, status, ...(message ? { message } : {}) } : row,
      ),
    )
  const start = async () => {
    if (!validMaterialPath(directory)) {
      setError('请填写有效的目标目录。')
      return
    }
    if (running) return
    setRunning(true)
    stopped.current = false
    setError(null)
    try {
      for (let index = 0; index < rows.length && !stopped.current; index++) {
        const row = rows[index]!
        if (row.status === 'saved' || row.status === 'skipped') continue
        setActiveIndex(index)
        const limit = controller.overview?.limits.maxFileBytes ?? 0
        if (row.file.size > limit) {
          update(index, 'failed', `超过单文件 ${formatBytes(limit)} 限制`)
          continue
        }
        update(index, 'hashing')
        const digest = await uploadDigest(row.file)
        if (stopped.current) {
          update(index, 'waiting')
          break
        }
        update(index, 'sending')
        const command = {
          kind: 'upload' as const,
          path: `${directory}/${row.file.name}`,
          size: row.file.size,
          sha256: digest,
          conflict,
        }
        setRows((current) =>
          current.map((item, rowIndex) =>
            rowIndex === index ? { ...item, digest: authoringDigest(command) } : item,
          ),
        )
        const result = await controller.submit(command, row.file)
        if (!result) {
          update(
            index,
            controller.hasPending() ? 'unknown' : 'failed',
            controller.hasPending() ? '正在确认上传结果…' : '上传失败，请重试。',
          )
          break
        }
        update(index, 'skipped' in result && result.skipped ? 'skipped' : 'saved')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传未完成。')
    } finally {
      setRunning(false)
      setActiveIndex(null)
    }
  }
  const statusLabels = {
    waiting: '待上传',
    hashing: '校验文件',
    sending: '传输中',
    saved: '原件已保存',
    skipped: '已跳过',
    unknown: '待核对',
    failed: '未上传',
  }
  return (
    <AuthoringDialog
      title="上传项目资料"
      busy={busy}
      onClose={onClose}
      dirty={rows.some((row) => row.status === 'waiting' || row.status === 'failed')}
      footer={
        busy ? (
          <Button
            variant="outline"
            onClick={() => {
              stopped.current = true
              controller.cancelTransfer()
            }}
          >
            停止传输
          </Button>
        ) : (
          <Button disabled={!rows.length} onClick={() => void start()}>
            上传资料
          </Button>
        )
      }
    >
      <AuthoringSelect
        label="常用目录"
        value={
          ['docs/产品资料', 'docs/运维文档', 'prototypes'].includes(directory)
            ? directory
            : 'custom'
        }
        options={[
          { value: 'docs/产品资料', label: '产品资料' },
          { value: 'docs/运维文档', label: '运维文档' },
          { value: 'prototypes', label: '原型' },
          { value: 'custom', label: '自定义目录' },
        ]}
        onChange={(value) => setDirectory(value === 'custom' ? 'docs/' : value)}
        disabled={busy}
      />
      <AuthoringField label="目标目录">
        <Input
          aria-label="上传目标目录"
          value={directory}
          disabled={busy || !!controller.pending}
          onChange={(event) => setDirectory(event.target.value)}
        />
      </AuthoringField>
      <AuthoringSelect
        label="同名文件处理"
        value={conflict}
        options={[
          { value: 'keep-both', label: '保留两个文件' },
          { value: 'replace', label: '替换原文件' },
          { value: 'skip', label: '跳过' },
        ]}
        disabled={busy || !!controller.pending}
        onChange={(value) => setConflict(value as WorkspaceUploadInput['conflict'])}
      />
      <AuthoringField label="选择文件">
        <Input
          aria-label="选择上传文件"
          type="file"
          multiple
          disabled={busy}
          onChange={(event) => {
            setRows(
              Array.from(event.target.files ?? []).map((file) => ({ file, status: 'waiting' })),
            )
            setError(null)
          }}
        />
      </AuthoringField>
      <div className="space-y-2" aria-live="polite">
        {rows.map((row, index) => (
          <div key={`${index}:${row.file.name}`} className="min-w-0 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={row.file.name}>
                {row.file.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {statusLabels[row.status]}
                {activeIndex === index && controller.progress !== null
                  ? ` ${controller.progress}%`
                  : ''}
              </span>
            </div>
            {row.message ? <p className="text-xs text-muted-foreground">{row.message}</p> : null}
          </div>
        ))}
      </div>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <AuthoringNotice controller={controller} />
    </AuthoringDialog>
  )
}

export function WorkspaceAuthoringConfirm({
  title,
  children,
  controller,
  onClose,
  onConfirm,
  disabled = false,
}: EditorProps & {
  title: string
  children: ReactNode
  onConfirm: () => Promise<unknown>
  disabled?: boolean
}) {
  return (
    <AuthoringDialog
      title={title}
      busy={controller.busy}
      onClose={onClose}
      footer={
        <Button
          disabled={controller.busy || disabled}
          onClick={() =>
            void onConfirm().then((result) => {
              if (result) onClose()
            })
          }
        >
          确认
        </Button>
      }
    >
      <div className="text-sm">{children}</div>
      <AuthoringNotice controller={controller} />
    </AuthoringDialog>
  )
}
