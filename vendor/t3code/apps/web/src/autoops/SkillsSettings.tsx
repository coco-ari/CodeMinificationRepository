import { useEffect, useRef, useState } from 'react'
import { readAutoOpsHost } from './hostConfig'
import { Button } from '~/components/ui/button'
import { Switch } from '~/components/ui/switch'
import { Textarea } from '~/components/ui/textarea'
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from '~/components/ui/dialog'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { usePrimaryEnvironmentId } from '~/state/environments'
import { useProjects } from '~/state/entities'
import { serverEnvironment } from '~/state/server'
import { useAtomCommand } from '~/state/use-atom-command'
import ChatMarkdown from '~/components/ChatMarkdown'
import { ProviderInstanceId } from '@t3tools/contracts'

type Skill = {
  name: string
  displayName: string
  description: string
  enabled: boolean
  builtin: boolean
}
type Catalog = { revision: string; canManage: boolean; skills: Skill[] }
const sample =
  '---\nname: my-project-check\ndescription: 检查当前项目的资料是否齐全\nmetadata:\n  display-name: 项目资料检查\nallowed-tools:\n  - list_project_materials\n  - read_project_document\n---\n\n阅读当前项目的授权资料，列出已确认事项和缺失信息。引用真实资料来源，不编造结论。'

export function AutoOpsSkillsSettings() {
  const host = readAutoOpsHost()
  const environmentId = usePrimaryEnvironmentId()
  const projects = useProjects()
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  })
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [contents, setContents] = useState('')
  const [inspect, setInspect] = useState<Skill | null>(null)
  const [instructions, setInstructions] = useState<string | null>(null)
  const [inspectError, setInspectError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const request = async (input?: object) => {
    const response = await fetch(`${host!.gatewayBasePath}/autoops/skills`, {
      credentials: 'same-origin',
      ...(input
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-demo-csrf': host!.csrfToken },
            body: JSON.stringify(input),
          }
        : {}),
    })
    const result = (await response.json()) as Catalog & { error?: string }
    if (!response.ok) throw new Error(result.error || '技能目录暂时不可用，请重试')
    return result
  }
  useEffect(() => {
    if (!host) return
    let active = true
    void request()
      .then((next) => {
        if (active) setCatalog(next)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '无法读取技能')
      })
    return () => {
      active = false
    }
  }, [host])
  useEffect(() => {
    if (!inspect || !host) return
    const controller = new AbortController()
    setInstructions(null)
    setInspectError(null)
    void fetch(`${host.gatewayBasePath}/autoops/skills/${encodeURIComponent(inspect.name)}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('无法读取技能说明')
        return response.text()
      })
      .then(setInstructions)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setInspectError(cause instanceof Error ? cause.message : '无法读取技能说明')
      })
    return () => controller.abort()
  }, [inspect, host])
  if (!host) return null
  const syncNativeCatalog = async () => {
    if (!environmentId) throw new Error('连接恢复后请点击刷新，同步技能列表。')
    const targets = projects.filter((project) => project.environmentId === environmentId)
    if (!targets.length) throw new Error('项目加载完成后请点击刷新，同步技能列表。')
    for (const project of targets) {
      const refreshed = await refreshProviders({
        environmentId,
        input: {
          instanceId: ProviderInstanceId.make(host.fixedModel.instanceId),
          cwd: project.workspaceRoot,
          fresh: true,
        },
      })
      if (refreshed._tag === 'Failure')
        throw new Error('技能已保存，列表同步暂未完成；请点击刷新重试。')
    }
  }
  const reload = async () => {
    setBusy('refresh')
    setError(null)
    try {
      setCatalog(await request())
      await syncNativeCatalog()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法刷新技能')
    } finally {
      setBusy(null)
    }
  }
  const change = async (input: object) => {
    if (!catalog || busy) return
    setBusy('save')
    setError(null)
    try {
      const next = await request({ ...input, revision: catalog.revision })
      setCatalog(next)
      try {
        await syncNativeCatalog()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '请点击刷新同步技能列表。')
      }
      if ('action' in input && input.action === 'import') {
        setImportOpen(false)
        setContents('')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '技能保存失败')
      try {
        setCatalog(await request())
      } catch {
        /* Keep the last readable catalog and show the failed operation. */
      }
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <SettingsSection
        id="autoops-skills"
        title="技能"
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void reload()}
            >
              刷新
            </Button>
            {catalog?.canManage ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  setError(null)
                  setImportOpen(true)
                }}
              >
                导入技能
              </Button>
            ) : null}
          </div>
        }
      >
        <SettingsRow
          title="使用技能"
          description="在对话中输入 $ 搜索并选择技能，点击技能标签可查看说明。管理员管理的技能由工作台共享，所有项目成员可见。"
        />
        {catalog?.skills.map((skill) => (
          <SettingsRow
            key={skill.name}
            title={
              <span>
                {skill.displayName}
                {skill.builtin ? (
                  <span className="ml-2 text-xs text-muted-foreground">内置</span>
                ) : null}
              </span>
            }
            description={skill.description}
            control={
              <div className="flex items-center gap-3">
                <Button size="xs" variant="ghost" onClick={() => setInspect(skill)}>
                  查看说明
                </Button>
                {catalog.canManage ? (
                  <Switch
                    aria-label={`${skill.enabled ? '停用' : '启用'}技能：${skill.displayName}`}
                    checked={skill.enabled}
                    disabled={busy !== null}
                    onCheckedChange={(enabled) =>
                      void change({ action: 'toggle', name: skill.name, enabled })
                    }
                  />
                ) : (
                  <span role="status" className="text-xs text-muted-foreground">
                    {skill.enabled ? '已启用' : '已停用'}
                  </span>
                )}
              </div>
            }
          />
        ))}
        {catalog?.skills.length === 0 ? (
          <SettingsRow
            title="暂无技能"
            description={
              catalog.canManage
                ? '导入 SKILL.md 后即可在对话中选择使用。'
                : '请联系管理员添加工作台技能。'
            }
          />
        ) : null}
        {!catalog && !error ? <SettingsRow title="正在读取技能…" /> : null}
        {error && !importOpen ? (
          <p role="alert" className="px-4 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsSection>
      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (!busy) setImportOpen(open)
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>导入技能</DialogTitle>
            <DialogDescription>
              导入 SKILL.md
              正文，供工作台所有项目成员使用。技能沿用会话权限；不导入附带脚本、资源或依赖。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => fileRef.current?.click()}
              >
                选择 SKILL.md
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setContents(sample)}
              >
                填写示例
              </Button>
            </div>
            <input
              ref={fileRef}
              hidden
              type="file"
              accept=".md,text/markdown,text/plain"
              aria-label="导入 SKILL.md 文件"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (!file) return
                if (file.size > 48 * 1024) {
                  setError('文件不能超过 48 KiB')
                  return
                }
                void file
                  .text()
                  .then((text) => {
                    setContents(text)
                    setError(null)
                  })
                  .catch(() => setError('文件读取失败，请重新选择'))
              }}
            />
            <Textarea
              aria-label="技能文件内容"
              rows={12}
              value={contents}
              disabled={busy !== null}
              placeholder={sample}
              onChange={(event) => setContents(event.currentTarget.value)}
            />
            <p className="text-xs text-muted-foreground">
              正文中的 name 须唯一。保存后可立即选择；停用会阻止后续调用，已开始的本轮执行保留。
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!contents.trim() || busy !== null}
              onClick={() => void change({ action: 'import', contents })}
            >
              {busy === 'save' ? '正在导入…' : '导入并启用'}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={inspect !== null}
        onOpenChange={(open) => {
          if (!open) setInspect(null)
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{inspect?.displayName} · 使用说明</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {inspectError ? (
              <div className="space-y-2">
                <p role="alert">{inspectError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (inspect) setInspect({ ...inspect })
                  }}
                >
                  重试
                </Button>
              </div>
            ) : instructions === null ? (
              <p role="status">正在读取说明…</p>
            ) : (
              <ChatMarkdown cwd={undefined} text={instructions} />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  )
}
