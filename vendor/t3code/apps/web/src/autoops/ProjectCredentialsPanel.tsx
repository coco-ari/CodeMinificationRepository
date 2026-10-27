import { useEffect, useRef, useState } from 'react'
import { EllipsisIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Menu, MenuTrigger, MenuPopup, MenuItem } from '~/components/ui/menu'
import { SettingsSection, SettingsRow } from '~/components/settings/settingsLayout'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { isAutoOpsAccessError } from './apiClient'
import { readAutoOpsHost } from './hostSnapshot'
import { useWorkspaceAuthoring } from './useWorkspaceAuthoring'
import { loadCredentialUsage, type WorkspaceCredentialMetadata } from './workspaceAuthoring'
import {
  AuthoringNotice,
  WorkspaceAuthoringFocus,
  WorkspaceCredentialDialog,
  WorkspaceAuthoringConfirm,
  WorkspaceCredentialUsage,
  WorkspaceCredentialUsageDialog,
  type CredentialUsageView,
} from './WorkspaceAuthoringDialogs'

type Editor =
  | { kind: 'save'; credential?: WorkspaceCredentialMetadata }
  | { kind: 'revoke'; credential: WorkspaceCredentialMetadata }
  | { kind: 'usage'; credential: WorkspaceCredentialMetadata }
export function ProjectCredentialsPanel({
  projectId,
  disabled,
  onChanged,
  onLockChange,
}: {
  projectId: string
  disabled: boolean
  onChanged(): void
  onLockChange(locked: boolean): void
}) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const principal = readAutoOpsHost()?.principal.id ?? ''
  const [usageAttempt, setUsageAttempt] = useState(0)
  const [usageRead, setUsageRead] = useState<{ key: string; view: CredentialUsageView } | null>(
    null,
  )
  const [usageDenied, setUsageDenied] = useState<{
    message: string
    credential: WorkspaceCredentialMetadata
  } | null>(null)
  const credential = editor?.credential
  const usageKey = `${principal}:${projectId}:${credential?.id ?? ''}:${editor?.kind ?? ''}:${usageAttempt}`
  const controller = useWorkspaceAuthoring(projectId, true, (receipt) => {
    if ('credential' in receipt) setEditor(null)
    onChanged()
  })
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({})
  const trigger = useRef<HTMLButtonElement | null>(null)
  const add = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    onLockChange(controller.busy || !!controller.pending || !!editor)
  }, [controller.busy, controller.pending, editor, onLockChange])
  useEffect(() => () => onLockChange(false), [onLockChange])
  useEffect(() => {
    if (controller.accessDenied) setEditor(null)
  }, [controller.accessDenied])
  useEffect(() => {
    if (!credential || controller.accessDenied) return
    const abort = new AbortController()
    void loadCredentialUsage(projectId, credential.id, abort.signal)
      .then((value) => {
        if (abort.signal.aborted || readAutoOpsHost()?.principal.id !== principal) return
        setUsageDenied(null)
        setUsageRead({ key: usageKey, view: { state: 'ready', value } })
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted || readAutoOpsHost()?.principal.id !== principal) return
        const message = cause instanceof Error ? cause.message : '凭证使用关系暂不可用。'
        if (isAutoOpsAccessError(cause)) {
          setUsageDenied({ message, credential })
          setUsageRead(null)
          setEditor(null)
        } else setUsageRead({ key: usageKey, view: { state: 'error', message } })
      })
    return () => abort.abort()
  }, [projectId, principal, credential, usageKey, controller.accessDenied])
  const open = (value: Editor, button: HTMLButtonElement) => {
    trigger.current = button
    controller.clearError()
    setUsageAttempt((attempt) => attempt + 1)
    setEditor(value)
  }
  const unavailable =
    disabled || controller.busy || controller.accessDenied || !!usageDenied || !controller.overview
  const usageView: CredentialUsageView =
    usageRead?.key === usageKey ? usageRead.view : { state: 'loading' }
  const usageReady = usageView.state === 'ready'
  const usage = (
    <WorkspaceCredentialUsage
      view={usageView}
      onRetry={() => setUsageAttempt((value) => value + 1)}
    />
  )
  return (
    <WorkspaceAuthoringFocus
      value={() => (trigger.current?.isConnected ? trigger.current : add.current)}
    >
      <SettingsSection
        title="项目凭证"
        headerAction={
          <Button
            ref={add}
            size="sm"
            variant="ghost"
            disabled={unavailable}
            onClick={(event) => open({ kind: 'save' }, event.currentTarget)}
          >
            添加凭证
          </Button>
        }
      >
        {!editor ? <AuthoringNotice controller={controller} /> : null}
        {usageDenied && !editor ? (
          <>
            <Alert variant="error" role="alert">
              <AlertDescription>{usageDenied.message}</AlertDescription>
            </Alert>
            <Button
              size="sm"
              variant="outline"
              onClick={(event) =>
                open({ kind: 'usage', credential: usageDenied.credential }, event.currentTarget)
              }
            >
              重试使用关系
            </Button>
          </>
        ) : null}
        {controller.error && !editor ? (
          <Button
            size="sm"
            variant="outline"
            disabled={controller.busy}
            onClick={controller.refresh}
          >
            重试凭证配置
          </Button>
        ) : null}
        {!controller.overview && !controller.error ? <p role="status">正在读取凭证</p> : null}
        {controller.credentials.map((credential) => (
          <SettingsRow
            key={credential.id}
            title={credential.name}
            description={`版本 ${credential.version} · ${credential.revoked ? '已撤回' : '可用'}`}
            control={
              <Menu>
                <MenuTrigger
                  ref={(element) => {
                    buttons.current[credential.id] =
                      element instanceof HTMLButtonElement ? element : null
                  }}
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={unavailable}
                      aria-label={`管理凭证 ${credential.name}`}
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    onClick={() => {
                      const button = buttons.current[credential.id]
                      if (button) open({ kind: 'usage', credential }, button)
                    }}
                  >
                    查看使用关系
                  </MenuItem>
                  <MenuItem
                    disabled={credential.revoked}
                    onClick={() => {
                      const button = buttons.current[credential.id]
                      if (button) open({ kind: 'save', credential }, button)
                    }}
                  >
                    替换凭证
                  </MenuItem>
                  <MenuItem
                    disabled={credential.revoked}
                    onClick={() => {
                      const button = buttons.current[credential.id]
                      if (button) open({ kind: 'revoke', credential }, button)
                    }}
                  >
                    撤回凭证
                  </MenuItem>
                </MenuPopup>
              </Menu>
            }
          />
        ))}
        {controller.overview && !controller.accessDenied && !controller.credentials.length ? (
          <SettingsRow title="暂无凭证" />
        ) : null}
      </SettingsSection>
      {editor?.kind === 'save' ? (
        <WorkspaceCredentialDialog
          controller={controller}
          credential={editor.credential}
          usage={editor.credential ? usage : null}
          usageReady={!editor.credential || usageReady}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {editor?.kind === 'revoke' ? (
        <WorkspaceAuthoringConfirm
          title="撤回项目凭证"
          controller={controller}
          disabled={!usageReady}
          onClose={() => setEditor(null)}
          onConfirm={() =>
            controller.submit({
              kind: 'credential',
              action: 'revoke',
              id: editor.credential.id,
              expectedCredentialRevision: editor.credential.revision,
            })
          }
        >
          <p>撤回「{editor.credential.name}」后，使用此凭证的新获取操作将被拒绝。</p>
          {usage}
        </WorkspaceAuthoringConfirm>
      ) : null}
      {editor?.kind === 'usage' ? (
        <WorkspaceCredentialUsageDialog
          credential={editor.credential}
          onClose={() => setEditor(null)}
        >
          {usage}
        </WorkspaceCredentialUsageDialog>
      ) : null}
    </WorkspaceAuthoringFocus>
  )
}
