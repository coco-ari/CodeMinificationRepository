import { useEffect, useRef, useState } from 'react'
import { Copy, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { DialogFooter } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { Field, FormDialog, Action, Detail, Notice, Status } from './shared'
import { TargetForm } from './target-form'
import {
  useConsole,
  date,
  short,
  actionNames,
  copy,
  downloadPage,
  downloadUrl,
  resultName,
  revisionOf,
  duration,
  stageLabel,
  finished,
} from '@/lib/console'

export function Confirmation({ value, onClose }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const returnFocus = useRef(document.activeElement)
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.current?.isConnected) returnFocus.current.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{value.title}</AlertDialogTitle>
          <AlertDialogDescription>{value.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                await value.action()
                onClose()
              } catch (e) {
                if (e.name !== 'AbortError') setError(e.message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy && <LoaderCircle className="animate-spin" />}
            {value.confirmLabel || '确认'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
export function CredentialForm({ item, onClose, onSaved }) {
  const { request, refresh, notify } = useConsole()
  return (
    <FormDialog
      id="credential-dialog"
      formId="credential-form"
      title={item ? '编辑 Gitee 凭证' : '新增 Gitee 凭证'}
      description="凭证可以被不同项目的代码仓库复用，密码加密保存。"
      onClose={onClose}
      submitLabel="保存凭证"
      onSubmit={async (input) => {
        const result = await request(
          `/api/credentials${item ? `/${item.id}` : ''}`,
          input,
          item ? 'PUT' : 'POST',
        )
        await refresh()
        onSaved?.(result)
        onClose()
        notify('Gitee 凭证已保存')
      }}
    >
      <Field name="name" label="凭证名称" defaultValue={item?.name || ''} required maxLength={80} />
      <Field
        name="username"
        label="Gitee 用户名"
        defaultValue={item?.username || ''}
        required
        autoComplete="off"
      />
      <Field
        name="password"
        label={item ? '新密码 / Token（留空保留原值）' : '密码 / Token'}
        type="password"
        required={!item}
        autoComplete="new-password"
      />
    </FormDialog>
  )
}
function RepositoryForm({ item, onClose }) {
  const { data, request, endpoint, open, refresh, notify } = useConsole()
  const [credential, setCredential] = useState(item?.credentialId || ''),
    [adding, setAdding] = useState(false),
    [enabled, setEnabled] = useState(item?.enabled ?? true)
  return (
    <>
      <FormDialog
        id="project-dialog"
        formId="project-form"
        title={item ? '编辑仓库' : '添加仓库'}
        description="发布分支在服务配置中选择，不会改变这里的默认下载分支。"
        onClose={onClose}
        submitLabel="保存仓库"
        onSubmit={async (input) => {
          const result = await request(
            `${endpoint}/repositories${item ? `/${item.id}` : ''}`,
            { ...input, credentialId: credential, enabled },
            item ? 'PUT' : 'POST',
          )
          onClose()
          await refresh()
          if (result.token) open('secret', result)
          else notify('仓库配置已保存')
        }}
      >
        <Field
          name="name"
          label="仓库名称"
          defaultValue={item?.name || ''}
          required
          maxLength={80}
        />
        <Field
          name="repository"
          label="Gitee 仓库地址"
          defaultValue={item?.repository || ''}
          required
          type="url"
          placeholder="https://gitee.com/team/service.git"
        />
        <Field
          name="branch"
          label="默认下载分支"
          defaultValue={item?.branch || 'main'}
          required
          maxLength={200}
        />
        <div className="space-y-2">
          <Field
            id="project-credential"
            name="credentialId"
            label="访问凭证"
            choices={[
              ['', '公开仓库（不使用凭证）'],
              ...data.credentials.map((c) => [c.id, c.name]),
            ]}
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
          />
          <Button
            id="repository-add-credential"
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
          >
            ＋ 新增 Gitee 凭证
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <Switch id="repository-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="repository-enabled">启用源码交付</Label>
        </div>
      </FormDialog>
      {adding && (
        <CredentialForm
          onClose={() => setAdding(false)}
          onSaved={(result) => setCredential(result.id)}
        />
      )}
    </>
  )
}
export function ServiceForm({ item, onClose, onSave, step = false }) {
  const { data } = useConsole()
  const [serviceKind, setServiceKind] = useState(item?.kind || 'java')
  const hasTargets = data.targets.some((target) => target.serviceId === item?.id)
  return (
    <FormDialog
      title={item ? '编辑服务' : '新增服务'}
      description={`项目：${data.project.name}。服务名称和模块对所有环境生效。`}
      onClose={onClose}
      submitLabel={step ? '保存并配置源码' : '保存服务'}
      onSubmit={(input) => onSave({ ...input, kind: serviceKind })}
    >
      <Field name="name" label="服务名称" required maxLength={80} defaultValue={item?.name || ''} />
      <Field
        name="kind"
        label="服务类型"
        value={serviceKind}
        disabled={hasTargets}
        choices={[
          ['java', 'Java 服务'],
          ['static', '前端静态站点（Vue / React）'],
        ]}
        onChange={(event) => setServiceKind(event.target.value)}
        hint={
          hasTargets
            ? '已有部署目标，服务类型保持不变。'
            : '前端构建为静态文件，由现有共用 Nginx 提供访问。'
        }
      />
      <Field
        key={serviceKind}
        name="module"
        label={serviceKind === 'static' ? '前端项目目录' : 'Maven 模块'}
        required
        defaultValue={item?.module || '.'}
        placeholder={serviceKind === 'static' ? '. 或 frontend' : '. 或 api'}
        hint={
          serviceKind === 'static'
            ? '相对仓库根目录，目录中应有 package.json 和依赖锁文件；不包含 SSR。'
            : '发布时同时编译该模块及其公共依赖。'
        }
      />
    </FormDialog>
  )
}
function BindingForm({ onClose }) {
  const { data, request, endpoint, refresh } = useConsole()
  const [candidates, setCandidates] = useState(null),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    request(`${endpoint}/server-candidates`)
      .then((result) => {
        if (active)
          setCandidates(result.servers.filter((s) => !data.servers.some((b) => b.id === s.id)))
      })
      .catch((e) => {
        if (active && e.name !== 'AbortError') setError(e.message)
      })
    return () => {
      active = false
    }
  }, [])
  return (
    <FormDialog
      title="绑定已接入服务器"
      description="复用现有 Agent，无需重复安装。"
      onClose={onClose}
      submitLabel="绑定服务器"
      onSubmit={async (input) => {
        if (!input.serverId) throw new Error('暂无可绑定的服务器，请先接入新服务器')
        await request(`${endpoint}/servers/${input.serverId}`, {}, 'PUT')
        onClose()
        await refresh()
      }}
    >
      {error ? (
        <Notice error>{error}</Notice>
      ) : !candidates ? (
        <p role="status">正在加载服务器…</p>
      ) : candidates.length ? (
        <Field
          name="serverId"
          label="服务器"
          required
          choices={candidates.map((s) => [s.id, `${s.name} · ${s.online ? '在线' : '未在线'}`])}
        />
      ) : (
        <Notice>暂无可绑定的服务器，请先接入新服务器。</Notice>
      )}
    </FormDialog>
  )
}
export function SourceForm({ item, onClose, onSaved }) {
  const { data, environmentId, find, endpoint, request, refresh } = useConsole()
  const selected = data.environmentSources.find(
    (s) => s.environmentId === environmentId && s.serviceId === item.id,
  )
  const [repository, setRepository] = useState(
    selected?.sourceProjectId || data.repositories[0]?.id || '',
  )
  const [branch, setBranch] = useState(selected?.branch || data.repositories[0]?.branch || '')
  return (
    <FormDialog
      title="配置环境源码"
      description={`${find('environments', environmentId)?.name} / ${item.name}。仓库和分支对该环境的所有部署位置生效。`}
      onClose={onClose}
      submitLabel={onSaved ? '保存并配置部署' : '保存源码配置'}
      onSubmit={async () => {
        await request(
          `${endpoint}/environment-sources`,
          { environmentId, serviceId: item.id, sourceProjectId: repository, branch },
          'PUT',
        )
        await refresh()
        if (onSaved) onSaved()
        else onClose()
      }}
    >
      <Field
        name="sourceProjectId"
        label="代码仓库"
        value={repository}
        choices={data.repositories.map((r) => [r.id, `${r.name}${r.enabled ? '' : '（已停用）'}`])}
        onChange={(e) => {
          setRepository(e.target.value)
          setBranch(data.repositories.find((r) => r.id === e.target.value)?.branch || '')
        }}
      />
      <Field
        name="branch"
        label="发布分支"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        required
        maxLength={200}
        hint="不会修改仓库的默认下载分支；已创建任务使用原快照。"
      />
    </FormDialog>
  )
}
export function Dialogs({ value, onClose }) {
  const { request, endpoint, open, refresh, notify, enter, scope, data, reloadSession } =
    useConsole()
  const { kind, item } = value
  const save = async (resource, input) => {
    const result = await request(
      `${endpoint}/${resource}${item ? `/${item.id}` : ''}`,
      input,
      item ? 'PUT' : 'POST',
    )
    onClose()
    await refresh()
    return result
  }
  if (kind === 'credential') return <CredentialForm item={item} onClose={onClose} />
  if (kind === 'repository') return <RepositoryForm item={item} onClose={onClose} />
  if (kind === 'binding') return <BindingForm onClose={onClose} />
  if (kind === 'source') return <SourceForm item={item} onClose={onClose} />
  if (kind === 'target') return <TargetForm item={item} onClose={onClose} />
  if (kind === 'workspace')
    return (
      <FormDialog
        title={item ? '编辑项目' : '创建项目'}
        description="在项目内管理仓库、服务器、环境和服务。新项目默认创建测试、生产两个环境。"
        onClose={onClose}
        submitLabel="保存项目"
        onSubmit={async (input) => {
          const result = await request(
            `/api/workspaces${item ? `/${item.id}` : ''}`,
            input,
            item ? 'PUT' : 'POST',
          )
          onClose()
          if (item) await refresh()
          else enter(result.id)
        }}
      >
        <Field
          name="name"
          label="项目名称"
          required
          maxLength={80}
          defaultValue={item?.name || ''}
          placeholder="例如：订单服务"
        />
        <Field
          name="description"
          label="项目说明"
          multiline
          rows={3}
          maxLength={500}
          defaultValue={item?.description || ''}
        />
      </FormDialog>
    )
  if (kind === 'environment')
    return (
      <FormDialog
        title={item ? '编辑环境' : '新增环境'}
        description={`项目：${data.project.name}`}
        onClose={onClose}
        submitLabel="保存环境"
        onSubmit={(input) => save('environments', input)}
      >
        <Field
          name="name"
          label="环境名称"
          required
          maxLength={80}
          defaultValue={item?.name || ''}
          placeholder="例如：预发布"
        />
      </FormDialog>
    )
  if (kind === 'service')
    return (
      <ServiceForm
        item={item}
        onClose={onClose}
        onSave={(input) => save('services', { ...input, applicationId: scope })}
      />
    )
  if (kind === 'server')
    return (
      <FormDialog
        title="接入服务器"
        description={
          scope
            ? '在服务器执行安装命令后，Agent 会自动连接中心并绑定当前项目。'
            : '生成一次性安装命令，让服务器主动连接中心。'
        }
        onClose={onClose}
        submitLabel="生成接入命令"
        onSubmit={async (input) => {
          const result = await request(`${endpoint}/servers`, input)
          onClose()
          await refresh()
          open('install', result)
        }}
      >
        <Field name="name" label="服务器名称" required maxLength={80} />
        <Notice>
          Agent 需要 Linux、Docker 和 Compose。接入后可创建服务并部署，平台只操作自己创建的容器。
        </Notice>
      </FormDialog>
    )
  if (kind === 'install')
    return (
      <FormDialog
        title="接入命令已生成"
        description={`在「${item.server.name}」的终端执行，令牌有效期至 ${date(item.expiresAt)}。`}
        onClose={onClose}
        footer={
          <DialogFooter>
            <Action
              onClick={async () => {
                await copy(item.installCommand)
                notify('安装命令已复制')
              }}
            >
              <Copy />
              复制命令
            </Action>
            <Button type="button" data-close onClick={onClose}>
              已保存
            </Button>
          </DialogFooter>
        }
      >
        <Field
          name="installCommand"
          label="安装命令"
          multiline
          rows={6}
          readOnly
          value={item.installCommand || ''}
          className="font-mono"
        />
        <Notice>命令包含一次性接入令牌，仅在本次显示。请勿发送到公开渠道。</Notice>
      </FormDialog>
    )
  if (kind === 'secret')
    return (
      <FormDialog
        id="secret-dialog"
        title="下载入口已就绪"
        description={`${item.project.name} · 下载密码仅在本次显示，请妥善保存。`}
        onClose={onClose}
        footer={
          <DialogFooter>
            <Button type="button" data-close onClick={onClose}>
              已保存
            </Button>
          </DialogFooter>
        }
      >
        {[
          ['secret-value', '下载密码', item.token],
          ['secret-page', '浏览器下载页面', downloadPage(item.project.id)],
          ['secret-url', 'Jenkins 下载接口', downloadUrl(item.project.id)],
        ].map(([id, label, value]) => (
          <div className="space-y-2" key={id}>
            <Field id={id} label={label} value={value} readOnly />
            <Action
              onClick={async () => {
                await copy(value)
                notify('已复制到剪贴板')
              }}
            >
              <Copy />
              复制{label}
            </Action>
          </div>
        ))}
      </FormDialog>
    )
  if (kind === 'password')
    return (
      <FormDialog
        title="修改管理员密码"
        description="修改后所有管理员会话将失效，需要重新登录。"
        onClose={onClose}
        submitLabel="更新密码"
        onSubmit={async (input) => {
          await request('/api/password', input)
          onClose()
          await reloadSession()
          notify('密码已更新，请重新登录')
        }}
      >
        <Field
          name="currentPassword"
          label="当前密码"
          type="password"
          autoComplete="current-password"
          required
        />
        <Field
          name="password"
          label="新密码"
          type="password"
          minLength={12}
          autoComplete="new-password"
          required
        />
      </FormDialog>
    )
  return null
}
