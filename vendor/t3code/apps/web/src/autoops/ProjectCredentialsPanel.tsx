import { useEffect, useRef, useState } from 'react'
import { EllipsisIcon } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Menu, MenuTrigger, MenuPopup, MenuItem } from '~/components/ui/menu'
import { SettingsSection, SettingsRow } from '~/components/settings/settingsLayout'
import { useWorkspaceAuthoring } from './useWorkspaceAuthoring'
import type { WorkspaceCredentialMetadata } from './workspaceAuthoring'
import {
  AuthoringNotice,
  WorkspaceAuthoringFocus,
  WorkspaceCredentialDialog,
  WorkspaceAuthoringConfirm,
} from './WorkspaceAuthoringDialogs'

type Editor =
  | { kind: 'save'; credential?: WorkspaceCredentialMetadata }
  | { kind: 'revoke'; credential: WorkspaceCredentialMetadata }
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
  const open = (value: Editor, button: HTMLButtonElement) => {
    trigger.current = button
    controller.clearError()
    setEditor(value)
  }
  const unavailable = disabled || controller.busy || controller.accessDenied || !controller.overview
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
          onClose={() => setEditor(null)}
        />
      ) : null}
      {editor?.kind === 'revoke' ? (
        <WorkspaceAuthoringConfirm
          title="撤回仓库凭证"
          controller={controller}
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
          撤回「{editor.credential.name}」后，使用此凭证的新获取操作将被拒绝。
        </WorkspaceAuthoringConfirm>
      ) : null}
    </WorkspaceAuthoringFocus>
  )
}
