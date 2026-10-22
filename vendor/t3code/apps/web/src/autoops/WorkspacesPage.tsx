import { useEffect, useState, type FormEvent } from 'react'
import { ArrowDownToLineIcon, ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon, GitBranchIcon, MessageSquarePlusIcon, PlusIcon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon } from 'lucide-react'
import { WorkspacePageHeader } from '~/components/WorkspacePageHeader'
import { SidebarInset } from '~/components/ui/sidebar'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Toggle, ToggleGroup } from '~/components/ui/toggle-group'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Spinner } from '~/components/ui/spinner'
import { Checkbox } from '~/components/ui/checkbox'
import { randomUUID } from '~/lib/utils'
import { readAutoOpsHost } from './hostConfig'
import {
  cancelWorkspaceTask, generateExternalWorkspace, generateWorkspacePackages,
  importWorkspaceRepository, loadWorkspaceContent, loadWorkspaces, loadWorkspaceTree,
  publishWorkspace, startWorkspaceConversation, workspaceFileDownloadUrl, workspacePackageUrl,
  type WorkspaceContent, type WorkspaceOverview, type WorkspaceRelease, type WorkspaceTask,
  type WorkspaceTreeEntry, type WorkspaceVersion,
} from './workspaces'

const tabs = [{ id: 'internal', name: '内部工作区' }, { id: 'external', name: '外部工作区' }, { id: 'packages', name: '部署发布' }] as const
type Tab = typeof tabs[number]['id']
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN')
const sizeLabel = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
const errorLabel = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'
const taskActive = (task: WorkspaceTask) => task.status === 'queued' || task.status === 'running'

export function AutoOpsWorkspacesPage() {
  const host = readAutoOpsHost()
  const [projectId, setProjectId] = useState(host?.projects[0]?.id ?? '')
  if (!host || !projectId) return <Empty><EmptyHeader><EmptyTitle>没有可用的项目工作区</EmptyTitle></EmptyHeader></Empty>
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">工作区</h1>
        <div className="max-w-52 min-w-0">
          <Select value={projectId} onValueChange={(value) => { if (typeof value === 'string') setProjectId(value) }}>
            <SelectTrigger size="sm" aria-label="工作区项目"><SelectValue>{host.projects.find((project) => project.id === projectId)?.name}</SelectValue></SelectTrigger>
            <SelectPopup>{host.projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectPopup>
          </Select>
        </div>
      </WorkspacePageHeader>
      <ProjectWorkspaces key={projectId} projectId={projectId} />
    </SidebarInset>
  )
}

function ProjectWorkspaces({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>('internal')
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [selectedInternal, setSelectedInternal] = useState('')
  const [selectedExternal, setSelectedExternal] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [followTaskId, setFollowTaskId] = useState<string | null>(null)
  const running = overview?.tasks.some(taskActive) ?? false

  useEffect(() => {
    const controller = new AbortController()
    void loadWorkspaces(projectId, controller.signal).then((next) => {
      setOverview(next)
      setError(null)
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorLabel(cause)) })
    return () => controller.abort()
  }, [projectId, refresh])

  useEffect(() => {
    if (!running) return
    const timer = window.setTimeout(() => setRefresh((value) => value + 1), 1200)
    return () => window.clearTimeout(timer)
  }, [running, overview, refresh])

  useEffect(() => {
    const task = overview?.tasks.find((entry) => entry.id === followTaskId)
    if (!task || taskActive(task)) return
    if (task.versionId && task.status === 'completed') {
      if (task.type === 'import') setSelectedInternal(task.versionId)
      if (task.type === 'external') setSelectedExternal(task.versionId)
    }
    setFollowTaskId(null)
  }, [overview, followTaskId])

  const mutate = async (action: () => Promise<WorkspaceTask | WorkspaceVersion>) => {
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if ('stage' in result) setFollowTaskId(result.id)
      const next = await loadWorkspaces(projectId)
      setOverview(next)
      return true
    } catch (cause) {
      setError(errorLabel(cause))
      return false
    } finally { setBusy(false) }
  }

  const internal = overview?.internalVersions ?? []
  const external = overview?.externalVersions ?? []
  const currentInternal = internal.find((version) => version.id === selectedInternal) ?? internal[0]
  const currentExternal = external.find((version) => version.id === selectedExternal) ?? external[0]
  const source = internal.find((version) => version.id === sourceId) ?? currentInternal

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-y px-4 py-2 sm:px-6">
        <ToggleGroup aria-label="工作区分类" variant="segmented" value={[tab]} onValueChange={(value) => {
          const next = value[0]
          if (next === 'internal' || next === 'external' || next === 'packages') setTab(next)
        }}>{tabs.map((item) => <Toggle key={item.id} value={item.id}>{item.name}</Toggle>)}</ToggleGroup>
        <Button variant="ghost" size="icon-sm" aria-label="刷新工作区" disabled={busy} onClick={() => setRefresh((value) => value + 1)}><RefreshCwIcon /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6">
          {error ? <Alert variant="error"><AlertTitle>工作区操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
          {!overview ? error ? <div><Button size="sm" variant="outline" onClick={() => setRefresh((value) => value + 1)}>重新加载</Button></div> : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" />正在读取工作区…</div> : <>
            {overview.tasks.length > 0 ? <Tasks tasks={overview.tasks.map((task) => task.versionId && overview.externalVersions.some((version) => version.id === task.versionId && version.status === 'published') ? {...task, message:'检查已完成，外部工作区版本已发布'} : task)} busy={busy} onCancel={(id) => void mutate(() => cancelWorkspaceTask(projectId, id))} /> : null}
            {tab === 'internal' ? <>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1"><VersionPicker versions={internal} selected={currentInternal} onChange={setSelectedInternal} label="内部版本" /></div>
                <Button variant="outline" size="sm" onClick={() => setShowImport((value) => !value)}><GitBranchIcon />{showImport ? '收起导入' : '导入仓库'}</Button>
                {currentInternal ? <ConversationButton projectId={projectId} version={currentInternal} /> : null}
              </div>
              {showImport ? <RepositoryImport busy={busy || running || overview.import?.supported === false} limits={overview.import} onImport={async (url, branch) => {
                await mutate(() => importWorkspaceRepository(projectId, url, branch, randomUUID()))
              }} /> : null}
              {currentInternal ? <>
                <VersionSummary version={currentInternal} />
                <p className="text-xs text-muted-foreground">内部原始资料保留 Git 信息。对话固定使用所选版本，资料以只读方式提供给智能体。</p>
                <FileBrowser key={currentInternal.id} projectId={projectId} version={currentInternal} />
              </> : <WorkspaceEmpty title="还没有内部工作区" description="导入 HTTPS Git 仓库，保存原始源码、文档和原型的固定版本。" />}
            </> : tab === 'external' ? <>
              <section className="flex flex-col gap-3 border-b pb-5" aria-label="生成外部工作区">
                <h2 className="text-sm font-medium">生成外部版本</h2>
                <VersionPicker versions={internal} selected={source} onChange={setSourceId} label="来源内部版本" />
                <p className="text-xs text-muted-foreground">去除所有 Git 历史并执行脱敏，保持原有目录。原始工作区不会被修改；未完成检查的版本不能用于对话。</p>
                <RedactionForm disabled={busy || running || !source} onGenerate={(rules) => void mutate(() => generateExternalWorkspace(projectId, source!.id, rules, randomUUID()))} />
              </section>
              {currentExternal ? <>
                <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><VersionPicker versions={external} selected={currentExternal} onChange={setSelectedExternal} label="外部版本" /></div><ConversationButton projectId={projectId} version={currentExternal} /></div>
                <VersionSummary version={currentExternal} />
                <ExternalReport key={currentExternal.id} projectId={projectId} version={currentExternal} busy={busy} onPublish={(confirmed, excluded) => void mutate(() => publishWorkspace(projectId, currentExternal.id, confirmed, excluded))} />
                <FileBrowser key={currentExternal.id} projectId={projectId} version={currentExternal} />
              </> : <WorkspaceEmpty title="还没有外部工作区" description="从内部固定版本生成，检查完成后再发布给外部对话使用。" />}
            </> : <>
              <section className="flex flex-col gap-3 border-b pb-5" aria-label="生成部署包">
                <h2 className="text-sm font-medium">生成源码部署包</h2>
                <VersionPicker versions={internal} selected={source} onChange={setSourceId} label="打包内部版本" />
                <p className="text-xs text-muted-foreground">直接从内部版本生成前后端 ZIP，保留构建所需目录与依赖声明，排除 Git 和缓存。下载部署包后，再传输到对应服务器部署。</p>
                <PackageForm disabled={busy || running || !source} onGenerate={(services) => void mutate(() => generateWorkspacePackages(projectId, source!.id, services, randomUUID()))} />
              </section>
              {overview.releases.length ? <div className="flex flex-col divide-y">{overview.releases.map((release) => <Release key={release.id} projectId={projectId} release={release} sourceName={internal.find((version) => version.id === release.sourceVersionId)?.name ?? release.sourceVersionId} />)}</div> : <WorkspaceEmpty title="还没有部署包" description="选择内部版本，按需生成前端、后端或两者的源码包。" />}
            </>}
          </>}
        </div>
      </div>
    </div>
  )
}

function WorkspaceEmpty({ title, description }: { title: string; description: string }) {
  return <Empty size="compact"><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>
}

function VersionPicker({ versions, selected, onChange, label }: { versions: WorkspaceVersion[]; selected: WorkspaceVersion | undefined; onChange: (id: string) => void; label: string }) {
  return <div className="flex max-w-md flex-col gap-1.5"><Label>{label}</Label><Select value={selected?.id ?? ''} disabled={!versions.length} onValueChange={(value) => { if (typeof value === 'string') onChange(value) }}><SelectTrigger size="sm" aria-label={label}><SelectValue>{selected?.name ?? '暂无可用版本'}</SelectValue></SelectTrigger><SelectPopup>{versions.map((version) => <SelectItem value={version.id} key={version.id}>{version.name}{version.status === 'pending_review' ? ' · 待复核' : version.status === 'failed' ? ' · 失败' : ''}{version.isExample ? ' · 示例项目' : ''}</SelectItem>)}</SelectPopup></Select></div>
}

function ConversationButton({ projectId, version }: { projectId: string; version: WorkspaceVersion }) {
  return <Button size="sm" variant="outline" disabled={version.status !== 'published'} onClick={() => startWorkspaceConversation(projectId, version)}><MessageSquarePlusIcon />新建对话</Button>
}

function VersionSummary({ version }: { version: WorkspaceVersion }) {
  return <div className="flex flex-col gap-2 text-xs text-muted-foreground">
    <div className="flex flex-wrap items-center gap-2"><Badge variant={version.status === 'published' ? 'success' : version.status === 'pending_review' ? 'warning' : 'error'}>{version.status === 'published' ? '可用' : version.status === 'pending_review' ? '待复核' : '失败'}</Badge>{version.isExample ? <Badge variant="secondary">示例项目</Badge> : null}<span>{version.fileCount} 个文件 · {sizeLabel(version.byteLength)}</span><time dateTime={version.createdAt}>{dateLabel(version.createdAt)}</time></div>
    {version.source.repositories.length ? <div className="flex flex-wrap gap-x-4 gap-y-1">{version.source.repositories.map((repository) => <span key={repository.path} className="break-all font-mono" title={repository.commit}>{repository.path || '.'} · {repository.commit.slice(0, 12)}</span>)}</div> : null}
    <span className="break-all font-mono" title="固定版本内容校验">SHA-256 {version.source.contentHash}</span>
  </div>
}

function Tasks({ tasks, busy, onCancel }: { tasks: WorkspaceTask[]; busy: boolean; onCancel: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const settled = tasks.filter((task) => !taskActive(task))
  const visible = [...tasks.filter(taskActive), ...(expanded ? settled : settled.slice(0, 3))]
  return <section className="flex flex-col divide-y border-b" aria-label="工作区任务" aria-live="polite">{visible.map((task) => <div key={task.id} className="flex items-start gap-2 py-2">
    <div className="pt-0.5">{taskActive(task) ? <Spinner size="sm" /> : null}</div>
    <div className="min-w-0 flex-1 text-xs"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{task.type === 'import' ? '仓库导入' : task.type === 'external' ? '外部工作区生成' : task.type === 'packages' ? '部署包生成' : '工作区任务'}</span><Badge size="sm" variant={task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : 'secondary'}>{({ queued: '等待中', running: '执行中', completed: '已完成', failed: '失败', interrupted: '已中断' } as const)[task.status]}</Badge></div><p className={task.status === 'failed' ? 'mt-1 break-words text-destructive' : 'mt-1 break-words text-muted-foreground'}>{task.error ?? task.message}</p></div>
    {taskActive(task) ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => onCancel(task.id)}>取消</Button> : null}
  </div>)}{settled.length > 3 ? <div className="py-2"><Button variant="ghost" size="xs" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起任务记录' : `查看其余 ${settled.length - 3} 条任务记录`}</Button></div> : null}</section>
}

function RepositoryImport({ busy, limits, onImport }: { busy: boolean; limits: WorkspaceOverview['import']; onImport: (url: string, branch: string) => Promise<void> }) {
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [error, setError] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('请填写不带账号密码的 HTTPS 仓库地址。')
      setError(null)
      void onImport(url.trim(), branch.trim())
    } catch (cause) { setError(errorLabel(cause)) }
  }
  return <form className="flex flex-col gap-3 border-b pb-4" onSubmit={submit} aria-label="导入原始仓库">
    <div className="flex flex-col gap-1.5"><Label htmlFor="workspace-repository">HTTPS 仓库地址</Label><Input id="workspace-repository" type="url" placeholder="https://github.com/组织/项目.git" required value={url} onValueChange={setUrl} disabled={busy} /></div>
    <div className="max-w-xs"><Label htmlFor="workspace-branch">分支</Label><div className="mt-1.5"><Input id="workspace-branch" value={branch} onValueChange={setBranch} required disabled={busy} /></div></div>
    <p className="text-xs text-muted-foreground">当前支持{limits?.hosts.join('、') ?? '公开代码托管平台'}的公开 HTTPS Git 仓库。将保留仓库结构、Git 信息及选定分支的固定提交。{limits ? `导入上限 ${sizeLabel(limits.maxBytes)}、${limits.maxFiles.toLocaleString('zh-CN')} 个文件。` : ''}</p>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <div><Button size="sm" type="submit" disabled={busy || !url.trim() || !branch.trim()}>{busy ? <Spinner size="sm" /> : <GitBranchIcon />}导入并保存版本</Button></div>
  </form>
}

function RedactionForm({ disabled, onGenerate }: { disabled: boolean; onGenerate: (rules: Array<{ find: string; replace: string }>) => void }) {
  const [rules, setRules] = useState<Array<{ id: string; find: string; replace: string }>>([])
  const submit = (event: FormEvent) => { event.preventDefault(); onGenerate(rules.filter((rule) => rule.find).map(({ find, replace }) => ({ find, replace }))) }
  return <form onSubmit={submit} className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium">额外脱敏规则</span><span className="text-xs text-muted-foreground">平台凭证与私钥规则始终生效。</span></div>
    {rules.map((rule, index) => <div key={rule.id} className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><Input aria-label={`规则 ${index + 1} 原始文本`} placeholder="需要替换的文本" size="sm" value={rule.find} required disabled={disabled} onValueChange={(value) => setRules((values) => values.map((entry) => entry.id === rule.id ? { ...entry, find: value } : entry))} /></div><span className="text-xs text-muted-foreground">→</span><div className="min-w-0 flex-1"><Input aria-label={`规则 ${index + 1} 替换文本`} placeholder="替换为（可留空）" size="sm" value={rule.replace} disabled={disabled} onValueChange={(value) => setRules((values) => values.map((entry) => entry.id === rule.id ? { ...entry, replace: value } : entry))} /></div><Button variant="ghost" size="icon-sm" aria-label={`删除规则 ${index + 1}`} disabled={disabled} onClick={() => setRules((values) => values.filter((entry) => entry.id !== rule.id))}><Trash2Icon /></Button></div>)}
    <div className="flex flex-wrap items-center gap-2"><Button variant="ghost" size="sm" disabled={disabled || rules.length >= 30} onClick={() => setRules((values) => [...values, { id: randomUUID(), find: '', replace: '' }])}><PlusIcon />添加替换</Button><Button type="submit" size="sm" disabled={disabled}><ShieldCheckIcon />生成外部版本</Button></div>
  </form>
}

function ExternalReport({ projectId, version, busy, onPublish }: { projectId: string; version: WorkspaceVersion; busy: boolean; onPublish: (confirmed: string[], excluded: string[]) => void }) {
  const [decisions, setDecisions] = useState<Record<string, 'keep' | 'exclude'>>({})
  const report = version.report
  if (!report) return null
  const complete = report.pendingFiles.every((file) => decisions[file.path])
  return <section className="flex flex-col gap-3 border-y py-4" aria-label="脱敏检查结果">
    <h2 className="text-sm font-medium">脱敏检查</h2><p className="text-xs text-muted-foreground">移除 {report.removedGitEntries} 处 Git 元数据 · 执行 {report.replacements} 次替换 · 排除 {report.excludedFiles.length} 个文件</p>
    {report.excludedFiles.length ? <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">查看排除的文件</summary><ul className="mt-2 space-y-1 font-mono">{report.excludedFiles.map((path) => <li className="break-all" key={path}>{path}</li>)}</ul></details> : null}
    {version.status === 'pending_review' ? <>
      <Alert variant="warning"><AlertTitle>发布前需要人工复核</AlertTitle><AlertDescription>平台无法检查以下文件的全部内容。请下载检查后逐个选择保留；无法确认时请排除。</AlertDescription></Alert>
      <div className="flex flex-col divide-y">{report.pendingFiles.map((file) => <div key={file.path} className="flex flex-wrap items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="break-all font-mono text-xs">{file.path}</p><p className="mt-1 text-xs text-muted-foreground">{file.reason}</p></div><Button size="xs" variant="outline" render={<a href={workspaceFileDownloadUrl(projectId, version.id, file.path)} download />}><ArrowDownToLineIcon />下载检查</Button><div className="w-40"><Select value={decisions[file.path] ?? 'pending'} disabled={busy} onValueChange={(value) => { if (value === 'keep' || value === 'exclude') setDecisions((previous) => ({ ...previous, [file.path]: value })) }}><SelectTrigger size="sm" aria-label={`复核 ${file.path}`}><SelectValue>{decisions[file.path] === 'keep' ? '已检查，保留' : decisions[file.path] === 'exclude' ? '排除文件' : '请选择处理方式'}</SelectValue></SelectTrigger><SelectPopup><SelectItem value="keep">已检查，保留</SelectItem><SelectItem value="exclude">排除文件</SelectItem></SelectPopup></Select></div></div>)}</div>
      <div><Button size="sm" disabled={busy || !complete} onClick={() => onPublish(Object.keys(decisions).filter((path) => decisions[path] === 'keep'), Object.keys(decisions).filter((path) => decisions[path] === 'exclude'))}>确认并发布版本</Button></div>
    </> : version.status === 'published' ? <p className="text-xs text-muted-foreground">此版本已通过检查并固定保存，可用于全新的外部工作区对话。</p> : null}
  </section>
}

function FileBrowser({ projectId, version }: { projectId: string; version: WorkspaceVersion }) {
  const [selected, setSelected] = useState('')
  return <section className="grid min-h-80 min-w-0 grid-cols-1 overflow-hidden rounded-lg border md:grid-cols-[15rem_minmax(0,1fr)]" aria-label={`${version.name} 文件浏览`}>
    <div className="max-h-72 min-w-0 overflow-auto border-b p-2 md:max-h-[34rem] md:border-r md:border-b-0"><FileTree projectId={projectId} versionId={version.id} selected={selected} onSelect={setSelected} /></div>
    <div className="flex min-h-64 min-w-0 flex-col">{selected ? <FilePreview key={selected} projectId={projectId} versionId={version.id} path={selected} /> : <div className="flex min-h-64 flex-1 items-center justify-center px-5 text-sm text-muted-foreground">选择左侧文件查看内容</div>}</div>
  </section>
}

function FileTree({ projectId, versionId, directory = '', selected, onSelect }: { projectId: string; versionId: string; directory?: string; selected: string; onSelect: (path: string) => void }) {
  const [entries, setEntries] = useState<WorkspaceTreeEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void loadWorkspaceTree(projectId, versionId, directory, controller.signal).then((result) => { setEntries(result.entries); setTruncated(result.truncated); setError(null) }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorLabel(cause)) })
    return () => controller.abort()
  }, [projectId, versionId, directory, attempt])
  if (error) return <div className="p-2 text-xs text-destructive"><p>{error}</p><Button size="xs" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>重试</Button></div>
  if (!entries) return <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground"><Spinner size="xs" />读取文件…</div>
  return <ul className="min-w-0" aria-label={directory || '工作区文件'}>{entries.map((entry) => <TreeEntry key={entry.path} projectId={projectId} versionId={versionId} entry={entry} selected={selected} onSelect={onSelect} />)}{truncated ? <li className="p-2 text-xs text-muted-foreground">目录过大，已截断显示。</li> : !entries.length ? <li className="p-2 text-xs text-muted-foreground">此目录为空</li> : null}</ul>
}

function TreeEntry({ projectId, versionId, entry, selected, onSelect }: { projectId: string; versionId: string; entry: WorkspaceTreeEntry; selected: string; onSelect: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const folder = entry.kind === 'directory'
  return <li className="min-w-0"><Button variant={selected === entry.path ? 'secondary' : 'ghost'} size="sm" className="w-full justify-start" aria-expanded={folder ? expanded : undefined} title={entry.path} onClick={() => folder ? setExpanded((value) => !value) : onSelect(entry.path)}>{folder ? expanded ? <ChevronDownIcon /> : <ChevronRightIcon /> : <FileIcon />}<span className="truncate">{entry.name}</span>{folder ? <FolderIcon /> : null}</Button>{folder && expanded ? <div className="ml-3 border-l pl-1"><FileTree projectId={projectId} versionId={versionId} directory={entry.path} selected={selected} onSelect={onSelect} /></div> : null}</li>
}

function FilePreview({ projectId, versionId, path }: { projectId: string; versionId: string; path: string }) {
  const [content, setContent] = useState<WorkspaceContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void loadWorkspaceContent(projectId, versionId, path, controller.signal).then((result) => { setContent(result); setError(null) }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorLabel(cause)) })
    return () => controller.abort()
  }, [projectId, versionId, path, attempt])
  return <>
    <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2"><span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>{path}</span><Button variant="ghost" size="icon-xs" aria-label={`下载 ${path}`} render={<a href={workspaceFileDownloadUrl(projectId, versionId, path)} download />}><ArrowDownToLineIcon /></Button></div>
    {error ? <div className="flex flex-col items-start gap-3 p-4 text-xs"><p className="text-muted-foreground">{error}</p><Button size="xs" variant="outline" onClick={() => setAttempt((value) => value + 1)}>重试预览</Button></div> : !content ? <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Spinner size="sm" />读取内容…</div> : <><pre className="max-h-[30rem] min-w-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed"><code>{content.contents}</code></pre><div className="border-t px-3 py-2 text-xs text-muted-foreground">{sizeLabel(content.byteLength)}{content.truncated ? ' · 文件过大，预览已截断，可下载查看完整内容。' : ''}</div></>}
  </>
}

function PackageForm({ disabled, onGenerate }: { disabled: boolean; onGenerate: (services: Array<'frontend' | 'backend'>) => void }) {
  const [frontend, setFrontend] = useState(true)
  const [backend, setBackend] = useState(true)
  return <div className="flex flex-wrap items-center gap-4"><Label className="flex items-center gap-2"><Checkbox checked={frontend} disabled={disabled} onCheckedChange={setFrontend} />前端源码包</Label><Label className="flex items-center gap-2"><Checkbox checked={backend} disabled={disabled} onCheckedChange={setBackend} />后端源码包</Label><Button size="sm" disabled={disabled || (!frontend && !backend)} onClick={() => onGenerate([...(frontend ? ['frontend' as const] : []), ...(backend ? ['backend' as const] : [])])}>生成部署包</Button></div>
}

function Release({ projectId, release, sourceName }: { projectId: string; release: WorkspaceRelease; sourceName: string }) {
  return <section className="flex min-w-0 flex-col gap-3 py-4" aria-label={release.name}><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">{release.name}</h2><time className="text-xs text-muted-foreground" dateTime={release.createdAt}>{dateLabel(release.createdAt)}</time></div><p className="text-xs text-muted-foreground">来源：{sourceName}</p><div className="flex flex-col gap-3">{release.services.map((service) => <div key={service.service} className="flex min-w-0 flex-wrap items-center gap-2"><Button size="sm" variant="outline" render={<a href={workspacePackageUrl(projectId, release.id, service.service)} download />}><ArrowDownToLineIcon />{service.service === 'frontend' ? '下载前端 ZIP' : '下载后端 ZIP'}</Button><span className="text-xs text-muted-foreground">{sizeLabel(service.size)}</span><code className="min-w-0 break-all text-xs text-muted-foreground" title="SHA-256">{service.sha256}</code></div>)}</div><div><Button size="xs" variant="ghost" render={<a href={workspacePackageUrl(projectId, release.id, 'manifest')} download />}><ArrowDownToLineIcon />下载 manifest.json</Button></div><details className="text-xs"><summary className="cursor-pointer text-muted-foreground">查看交付清单</summary><pre className="mt-2 max-h-64 overflow-auto border p-3 font-mono"><code>{JSON.stringify(release.manifest, null, 2)}</code></pre></details></section>
}
