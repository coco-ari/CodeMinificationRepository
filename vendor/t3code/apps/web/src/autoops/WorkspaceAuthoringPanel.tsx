import { AutoOpsRequestError } from './apiClient'
import { useWorkspaceFileScroll } from './useWorkspaceFileScroll'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  FolderOpenIcon,
  GitBranchIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  UploadIcon,
} from 'lucide-react'
import { ReadOnlyWorkspaceFiles } from '~/components/files/ReadOnlyWorkspaceFiles'
import type { ReadOnlyFileSource } from '~/components/files/readOnlyFileSource'
import { FileSurfaceAction } from '~/components/files/fileSurfaceChrome'
import { WorkspacePageContainer } from '~/components/WorkspacePageContainer'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '~/components/ui/menu'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Spinner } from '~/components/ui/spinner'
import { usePrimaryEnvironmentId } from '~/state/environments'
import { ModuleHeader, ModuleSidebar, ModuleSidebarItem } from './ModuleWorkspace'
import { readSelection, saveSelection } from './workspaceViewState'
import { useWorkspaceAuthoring } from './useWorkspaceAuthoring'
import { workspaceFailureMessage } from './workspaceFeedback'
import {
  authoringFileUrl,
  loadAuthoringContent,
  loadAuthoringTree,
  searchAuthoringFiles,
  type AuthoringReceipt,
  type WorkspaceCredentialMetadata,
  type WorkspaceMaterialEntry,
  type WorkspaceRepositorySource,
  type WorkspaceAuthoringOverview,
} from './workspaceAuthoring'
import {
  WorkspaceAuthoringFocus,
  AuthoringNotice,
  WorkspaceAuthoringConfirm,
  WorkspaceCredentialDialog,
  WorkspaceFileEditDialog,
  WorkspaceSourceDialog,
  WorkspaceUploadDialog,
  sourceRoles,
} from './WorkspaceAuthoringDialogs'

export type WorkspaceSection = 'current' | 'sources'
function sourceStatusLabel(
  status: NonNullable<WorkspaceAuthoringOverview['sourceStatus']>[number] | undefined,
) {
  if (!status || status.status === 'unsynced') return '未同步'
  if (status.status === 'synced') return `已同步 ${status.commit?.slice(0, 12) ?? ''}`
  if (status.status === 'queued') return '等待同步'
  if (status.status === 'syncing') return '正在同步'
  return workspaceFailureMessage(status.error?.code, '同步失败，请重试。')
}
export function WorkspaceAuthoringNavigation({
  section,
  onChange,
}: {
  section: WorkspaceSection
  onChange: (section: WorkspaceSection) => void
}) {
  return (
    <div className="space-y-1" aria-label="工作区视图">
      <ModuleSidebarItem
        icon={FolderOpenIcon}
        label="当前资料"
        selected={section === 'current'}
        onClick={() => onChange('current')}
      />
      <ModuleSidebarItem
        icon={GitBranchIcon}
        label="源码来源"
        selected={section === 'sources'}
        onClick={() => onChange('sources')}
      />
    </div>
  )
}

type AuthoringDialog =
  | { type: 'source'; source?: WorkspaceRepositorySource }
  | { type: 'credential'; credential?: WorkspaceCredentialMetadata }
  | { type: 'remove-source'; source: WorkspaceRepositorySource }
  | { type: 'revoke-credential'; credential: WorkspaceCredentialMetadata }
  | { type: 'file'; action: 'mkdir' | 'save' | 'move' | 'delete'; entry?: WorkspaceMaterialEntry }
  | { type: 'upload' }
  | null

export function WorkspaceAuthoring({
  projectId,
  section,
  manager,
  onSection,
  onAccepted,
  navigation,
  actions,
  taskRevision = '',
  taskActive = false,
}: {
  projectId: string
  section: 'current' | 'sources'
  manager: boolean
  onSection: (section: WorkspaceSection) => void
  onAccepted: (receipt: AuthoringReceipt) => void
  navigation?: ReactNode
  actions?: ReactNode
  taskRevision?: string
  taskActive?: boolean
}) {
  const controller = useWorkspaceAuthoring(
    projectId,
    manager,
    (receipt) => {
      if ('entry' in receipt && receipt.entry) {
        setSelected(receipt.entry.path)
        setTrail(undefined)
      }
      onAccepted(receipt)
    },
    taskRevision,
  )
  const [dialog, setDialog] = useState<AuthoringDialog>(null)
  const panelRoot = useRef<HTMLDivElement | null>(null)
  const dialogReturnFocus = useRef<HTMLElement | null>(null)
  const [selected, setSelected] = useState<string | null>(() =>
    readSelection(`${projectId}:authoring:file`),
  )
  const [trail, setTrail] = useState<string | undefined>()
  const overview = controller.overview
  const entry = overview?.entries.find((item) => item.path === selected)
  const previousEntry = useRef<WorkspaceMaterialEntry | undefined>(undefined)
  useEffect(() => {
    if (overview && previousEntry.current?.path === selected && !entry) {
      const parent = selected?.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : ''
      setSelected(parent || null)
      setTrail(undefined)
    }
    previousEntry.current = entry
  }, [overview, entry, selected])
  const selectedSource = overview?.sources.find(
    (source) => selected === source.mountPath || selected?.startsWith(`${source.mountPath}/`),
  )
  const readingRevision =
    entry?.revision ??
    overview?.sourceStatus?.find((status) => status.sourceId === selectedSource?.id)?.versionId ??
    String(overview?.revision ?? '')
  const open = (value: AuthoringDialog) => {
    const active = document.activeElement
    const origin =
      value?.type === 'source' && value.source
        ? `source:${value.source.id}`
        : value?.type === 'remove-source'
          ? `source:${value.source.id}`
          : value?.type === 'credential' && value.credential
            ? `credential:${value.credential.id}`
            : value?.type === 'revoke-credential'
              ? `credential:${value.credential.id}`
              : value?.type === 'file' && value.entry
                ? 'file-actions'
                : 'toolbar'
    dialogReturnFocus.current =
      active instanceof HTMLElement && panelRoot.current?.contains(active)
        ? active
        : (panelRoot.current?.querySelector<HTMLElement>(
            `[data-authoring-focus="${CSS.escape(origin)}"]`,
          ) ?? null)
    controller.clearError()
    setDialog(value)
  }
  const close = () => setDialog(null)
  const restoreFocus = () =>
    dialogReturnFocus.current?.isConnected
      ? dialogReturnFocus.current
      : (panelRoot.current?.querySelector<HTMLElement>('[data-authoring-focus="toolbar"]') ?? null)
  const disabled = controller.busy || !overview
  const syncDisabled =
    disabled || taskActive || controller.hasPending() || !overview?.sources.length
  const fileRevision = `${overview?.revision ?? 0}:${overview?.sourceStatus?.map((source) => `${source.sourceId}:${source.commit ?? ''}`).join(':') ?? ''}`
  useEffect(() => {
    if (controller.accessDenied) {
      setDialog(null)
      setSelected(null)
    }
  }, [controller.accessDenied])
  useEffect(() => {
    saveSelection(`${projectId}:authoring:file`, selected ?? '')
  }, [projectId, selected])
  return (
    <WorkspaceAuthoringFocus value={restoreFocus}>
      <div ref={panelRoot} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ModuleSidebar
          label="工作区"
          header={
            <>
              {navigation}
              <WorkspaceAuthoringNavigation section={section} onChange={onSection} />
            </>
          }
        >
          {null}
        </ModuleSidebar>
        <ModuleHeader
          title="工作区"
          detail={section === 'current' ? '当前资料' : '源码来源'}
          actions={
            <>
              {actions}
              <FileSurfaceAction
                label="刷新当前资料"
                disabled={controller.busy}
                onPress={controller.refresh}
              >
                <RefreshCwIcon />
              </FileSurfaceAction>
              {manager ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="工作区操作"
                        data-authoring-focus="toolbar"
                      />
                    }
                  >
                    <MoreHorizontalIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem disabled={disabled} onClick={() => open({ type: 'upload' })}>
                      <UploadIcon />
                      上传资料
                    </MenuItem>
                    <MenuItem
                      disabled={disabled}
                      onClick={() => open({ type: 'file', action: 'mkdir' })}
                    >
                      新建目录
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem disabled={disabled} onClick={() => open({ type: 'source' })}>
                      <GitBranchIcon />
                      添加源码来源
                    </MenuItem>
                    <MenuItem disabled={disabled} onClick={() => open({ type: 'credential' })}>
                      <KeyRoundIcon />
                      添加仓库凭证
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      disabled={syncDisabled}
                      onClick={() => void controller.submit({ kind: 'sync' })}
                    >
                      <RefreshCwIcon />
                      同步源码
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
            </>
          }
        />
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {!overview ? '正在读取…' : taskActive ? '正在处理…' : ''}
            {!manager ? ' · 只读' : ''}
          </span>
          {manager ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  open(section === 'current' ? { type: 'upload' } : { type: 'source' })
                }
              >
                {section === 'current' ? <UploadIcon /> : <PlusIcon />}
                {section === 'current' ? '上传资料' : '添加来源'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={syncDisabled}
                onClick={() => void controller.submit({ kind: 'sync' })}
              >
                同步源码
              </Button>
            </>
          ) : null}
          {section === 'current' && entry ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="当前文件操作"
                    data-authoring-focus="file-actions"
                  />
                }
              >
                文件操作
              </MenuTrigger>
              <MenuPopup align="end">
                {entry.kind === 'file' ? (
                  <MenuItem
                    render={
                      <a
                        href={authoringFileUrl(projectId, entry.path, entry.revision).replace(
                          '&inline=1',
                          '',
                        )}
                        download={entry.name}
                      />
                    }
                  >
                    下载原件
                  </MenuItem>
                ) : null}
                {manager && entry.editable ? (
                  <MenuItem
                    disabled={disabled}
                    onClick={() => open({ type: 'file', action: 'save', entry })}
                  >
                    编辑正文
                  </MenuItem>
                ) : null}
                {manager ? (
                  <>
                    <MenuItem
                      disabled={disabled}
                      onClick={() => open({ type: 'file', action: 'move', entry })}
                    >
                      重命名或移动
                    </MenuItem>
                    <MenuItem
                      disabled={disabled}
                      onClick={() => open({ type: 'file', action: 'delete', entry })}
                    >
                      删除资料
                    </MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
        {!dialog && (controller.error || controller.pending) ? (
          <div className="shrink-0 space-y-2 p-3">
            <AuthoringNotice controller={controller} />
          </div>
        ) : null}
        {section === 'current' && entry?.extraction && entry.extraction.status !== 'ready' ? (
          <div
            className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground"
            role="status"
          >
            <span className="min-w-0 flex-1 break-words">
              {entry.extraction.status === 'pending'
                ? '原件已保存，正文正在提取。'
                : entry.extraction.status === 'unavailable'
                  ? `原件已保存，正文不可提取${entry.extraction.message ? `：${entry.extraction.message}` : '。'}`
                  : '原件和正文均可用。'}
            </span>
            {manager && entry.extraction.status === 'unavailable' ? (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={disabled || controller.hasPending()}
                onClick={() =>
                  void controller.submit({
                    kind: 'document',
                    action: 'extract',
                    path: entry.path,
                    expectedContentRevision: entry.revision,
                  })
                }
              >
                重新提取正文
              </Button>
            ) : null}
          </div>
        ) : null}
        {overview ? (
          section === 'current' ? (
            <WorkspaceCurrentFiles
              projectId={projectId}
              revision={fileRevision}
              readingRevision={readingRevision}
              onDenied={controller.denyRead}
              selected={selected || null}
              trail={trail}
              onOpen={(path) => {
                setSelected(path)
                setTrail(undefined)
              }}
              onFolder={(path, nextTrail) => {
                setSelected(path || null)
                setTrail(nextTrail)
              }}
            />
          ) : (
            <ScrollArea contentSizing="viewport" radius="none" className="min-h-0 flex-1">
              <WorkspacePageContainer>
                <SettingsSection
                  title="Git 仓库来源"
                  headerAction={
                    <Badge variant="outline" size="sm">
                      {overview.sources.length}
                    </Badge>
                  }
                >
                  {overview.sources.length ? (
                    overview.sources.map((source) => (
                      <SettingsRow
                        key={source.id}
                        title={<span className="break-all">{source.name}</span>}
                        description={
                          <span className="block break-all">
                            {sourceRoles.find((role) => role.value === source.role)?.label} ·{' '}
                            {source.url}
                            <br />
                            {source.refKind === 'default'
                              ? '远端默认分支'
                              : `${source.refKind}：${source.ref}`}{' '}
                            → {source.mountPath}
                            {source.sourcePath ? `（仓库内 ${source.sourcePath}）` : ''}
                            <br />
                            {sourceStatusLabel(
                              overview.sourceStatus?.find(
                                (status) => status.sourceId === source.id,
                              ),
                            )}
                          </span>
                        }
                        control={
                          manager ? (
                            <Menu>
                              <MenuTrigger
                                render={
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={`管理来源 ${source.name}`}
                                    data-authoring-focus={`source:${source.id}`}
                                  />
                                }
                              >
                                <MoreHorizontalIcon />
                              </MenuTrigger>
                              <MenuPopup align="end">
                                <MenuItem onClick={() => open({ type: 'source', source })}>
                                  编辑来源
                                </MenuItem>
                                <MenuItem onClick={() => open({ type: 'remove-source', source })}>
                                  移除来源
                                </MenuItem>
                              </MenuPopup>
                            </Menu>
                          ) : null
                        }
                      />
                    ))
                  ) : (
                    <p className="px-4 py-5 text-sm text-muted-foreground">还没有源码来源。</p>
                  )}
                </SettingsSection>
                {manager ? (
                  <SettingsSection
                    title="仓库凭证"
                    headerAction={
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => open({ type: 'credential' })}
                      >
                        添加凭证
                      </Button>
                    }
                  >
                    {controller.credentials.length ? (
                      controller.credentials.map((credential) => (
                        <SettingsRow
                          key={credential.id}
                          title={<span className="break-all">{credential.name}</span>}
                          description={`版本 ${credential.version} · ${credential.revoked ? '已撤回' : '可用'}`}
                          control={
                            <Menu>
                              <MenuTrigger
                                render={
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={`管理凭证 ${credential.name}`}
                                    data-authoring-focus={`credential:${credential.id}`}
                                  />
                                }
                              >
                                <MoreHorizontalIcon />
                              </MenuTrigger>
                              <MenuPopup align="end">
                                <MenuItem onClick={() => open({ type: 'credential', credential })}>
                                  替换凭证
                                </MenuItem>
                                <MenuItem
                                  disabled={credential.revoked}
                                  onClick={() => open({ type: 'revoke-credential', credential })}
                                >
                                  撤回凭证
                                </MenuItem>
                              </MenuPopup>
                            </Menu>
                          }
                        />
                      ))
                    ) : (
                      <p className="px-4 py-5 text-sm text-muted-foreground">
                        私有仓库需要添加凭证。
                      </p>
                    )}
                  </SettingsSection>
                ) : null}
              </WorkspacePageContainer>
            </ScrollArea>
          )
        ) : controller.error ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>当前资料不可用</EmptyTitle>
              <EmptyDescription>保留当前项目，刷新后可重新读取。</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={controller.refresh}>
              重试
            </Button>
          </Empty>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        )}
        {dialog?.type === 'source' ? (
          <WorkspaceSourceDialog controller={controller} source={dialog.source} onClose={close} />
        ) : null}
        {dialog?.type === 'credential' ? (
          <WorkspaceCredentialDialog
            controller={controller}
            credential={dialog.credential}
            onClose={close}
          />
        ) : null}
        {dialog?.type === 'file' ? (
          <WorkspaceFileEditDialog
            projectId={projectId}
            controller={controller}
            action={dialog.action}
            entry={dialog.entry}
            onClose={close}
          />
        ) : null}
        {dialog?.type === 'upload' ? (
          <WorkspaceUploadDialog controller={controller} onClose={close} />
        ) : null}
        {dialog?.type === 'remove-source' ? (
          <WorkspaceAuthoringConfirm
            title="移除源码来源"
            controller={controller}
            onClose={close}
            onConfirm={() =>
              controller.submit({ kind: 'source', action: 'remove', id: dialog.source.id })
            }
          >
            移除「{dialog.source.name}」？后续同步不再获取此仓库；已有任务与历史引用保留。
          </WorkspaceAuthoringConfirm>
        ) : null}
        {dialog?.type === 'revoke-credential' ? (
          <WorkspaceAuthoringConfirm
            title="撤回仓库凭证"
            controller={controller}
            onClose={close}
            onConfirm={() =>
              controller.submit({
                kind: 'credential',
                action: 'revoke',
                id: dialog.credential.id,
                expectedCredentialRevision: dialog.credential.revision,
              })
            }
          >
            撤回「{dialog.credential.name}」后，使用此凭证的新获取操作将被拒绝。
          </WorkspaceAuthoringConfirm>
        ) : null}
      </div>
    </WorkspaceAuthoringFocus>
  )
}

export function WorkspaceCurrentFiles({
  projectId,
  revision,
  readingRevision,
  onDenied,
  selected,
  trail,
  onOpen,
  onFolder,
}: {
  projectId: string
  revision: number | string
  readingRevision: string
  onDenied: (cause: unknown) => void
  selected: string | null
  trail: string | undefined
  onOpen: (path: string) => void
  onFolder: (path: string, trail: string | undefined) => void
}) {
  const environmentId = usePrimaryEnvironmentId()
  const root = useRef<HTMLElement | null>(null)
  const denied = useRef(onDenied)
  denied.current = onDenied
  useWorkspaceFileScroll(
    root,
    `${projectId}:authoring:scroll:${readingRevision}:${selected ?? ''}`,
    environmentId ? `${environmentId}:${revision}` : null,
  )
  const source = useMemo<ReadOnlyFileSource>(() => {
    const read = async <T,>(operation: () => Promise<T>) => {
      try {
        return await operation()
      } catch (cause) {
        if (cause instanceof AutoOpsRequestError && (cause.status === 401 || cause.status === 403))
          denied.current(cause)
        throw cause
      }
    }
    return {
      id: `authoring:${projectId}:${revision}`,
      allowReferences: false,
      mentionPath: (path) => `autoops/${projectId}/current/${path}`,
      list: (path) => read(() => loadAuthoringTree(projectId, path)),
      search: (query, limit) => read(() => searchAuthoringFiles(projectId, query, limit)),
      async metadata(path) {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        const tree = await read(() => loadAuthoringTree(projectId, parent))
        if (tree.entries.find((entry) => entry.path === path)?.kind === 'directory')
          return { kind: 'directory' }
        const content = await read(() => loadAuthoringContent(projectId, path))
        return {
          kind: 'file',
          name: path.split('/').at(-1) ?? path,
          mimeType: content.mime,
          sizeBytes: content.size,
          url: authoringFileUrl(projectId, path, content.revision),
        }
      },
    }
  }, [projectId, revision])
  if (!environmentId)
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>文件连接正在建立</EmptyTitle>
          <EmptyDescription>连接就绪后显示当前项目资料。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <section
      ref={root}
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      aria-label="当前资料文件浏览"
    >
      <ReadOnlyWorkspaceFiles
        environmentId={environmentId}
        cwd={source.id}
        projectName="当前资料"
        relativePath={selected}
        source={source}
        folderTrail={trail}
        onOpenFile={onOpen}
        onNavigateFolder={onFolder}
      />
    </section>
  )
}
