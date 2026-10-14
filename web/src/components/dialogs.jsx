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
  modeName,
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
            {busy && <LoaderCircle className="animate-spin" />}确认
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
        description="发布分支在环境与服务中选择，不会改变这里的默认下载分支。"
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
function ServiceForm({ item, onClose, onSave }) {
  const { data } = useConsole()
  const [serviceKind, setServiceKind] = useState(item?.kind || 'java')
  const hasTargets = data.targets.some((target) => target.serviceId === item?.id)
  return (
    <FormDialog
      title={item ? '编辑服务' : '新增服务'}
      description={`项目：${data.project.name}`}
      onClose={onClose}
      submitLabel="保存服务"
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
          choices={candidates.map((s) => [
            s.id,
            `${s.name} · ${modeName(s.mode)} · ${s.online ? '在线' : '未在线'}`,
          ])}
        />
      ) : (
        <Notice>暂无可绑定的服务器，请先接入新服务器。</Notice>
      )}
    </FormDialog>
  )
}
function SourceForm({ item, onClose }) {
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
      description={`${find('environments', environmentId)?.name} / ${item.name}`}
      onClose={onClose}
      submitLabel="保存源码配置"
      onSubmit={async () => {
        await request(
          `${endpoint}/environment-sources`,
          { environmentId, serviceId: item.id, sourceProjectId: repository, branch },
          'PUT',
        )
        onClose()
        await refresh()
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
function ReleaseForm({ item: { target, action }, onClose }) {
  const { data, find, endpoint, request, navigate } = useConsole()
  const [releases, setReleases] = useState(null),
    [error, setError] = useState('')
  useEffect(() => {
    if (action !== 'rollback') return
    let active = true
    request(`${endpoint}/targets/${target.id}/releases`)
      .then((result) => {
        if (active)
          setReleases(
            result.releases.filter(
              (r) =>
                r.id !== target.currentRelease?.id &&
                r.available !== false &&
                !['failed', 'deleted'].includes(r.status),
            ),
          )
      })
      .catch((e) => {
        if (active && e.name !== 'AbortError') setError(e.message)
      })
    return () => {
      active = false
    }
  }, [])
  const source = data.environmentSources.find(
    (s) => s.environmentId === target.environmentId && s.serviceId === target.serviceId,
  )
  return (
    <FormDialog
      title={`${actionNames[action]}服务`}
      description="请核对本次操作的项目、环境与部署目标。"
      onClose={onClose}
      submitLabel={`确认${actionNames[action]}`}
      onSubmit={async (input) => {
        if (action === 'rollback' && !input.releaseId) throw new Error('还没有可回退的历史版本')
        const result = await request(`${endpoint}/tasks`, {
          targetId: target.id,
          action,
          ...(action === 'rollback' ? { releaseId: input.releaseId } : {}),
        })
        onClose()
        navigate('tasks', result.task.id, target.environmentId)
      }}
    >
      <dl className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-4">
        <Detail label="项目">{data.project.name}</Detail>
        <Detail label="环境">{find('environments', target.environmentId)?.name}</Detail>
        <Detail label="服务">{find('services', target.serviceId)?.name}</Detail>
        <Detail label="服务器">{find('servers', target.serverId)?.name}</Detail>
        <Detail label="仓库">
          {data.repositories.find((r) => r.id === source?.sourceProjectId)?.name}
        </Detail>
        <Detail label="发布分支">{source?.branch}</Detail>
      </dl>
      {action === 'rollback' &&
        (error ? (
          <Notice error>{error}</Notice>
        ) : releases?.length ? (
          <Field
            name="releaseId"
            label="恢复到版本"
            choices={releases.map((r) => [r.id, `${short(r.revision)} · ${date(r.createdAt)}`])}
            required
          />
        ) : (
          <Notice>{releases ? '还没有可回退的历史版本' : '正在加载历史版本…'}</Notice>
        ))}
      <Notice>
        {target.config?.kind === 'static'
          ? action === 'deploy'
            ? '构建所选源码并切换站点版本，随后验证页面。共用 Nginx 保持运行。'
            : '恢复所选版本的静态目录并验证页面，无需重新构建或重启 Nginx。'
          : action === 'deploy'
            ? '本次固定源码版本，编译、更新此目标并检查健康状态。其他部署目标继续运行。'
            : action === 'restart'
              ? '重启会短暂中断这个服务，随后重新检查健康状态。'
              : '恢复所选版本的镜像与部署配置，并执行健康检查。'}
      </Notice>
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
  if (kind === 'release') return <ReleaseForm item={item} onClose={onClose} />
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
        <Field
          name="mode"
          label="管理方式"
          defaultValue="observe"
          choices={[
            ['observe', '仅观察（Jenkins 继续发布）'],
            ['managed', '平台管理'],
          ]}
        />
        <Notice>
          Agent 需要 Linux、Docker 和
          Compose。平台管理模式允许构建镜像和更新容器；仅观察模式只采集已登记容器状态。
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
export function TaskDialog({ id, onClose }) {
  const { request, endpoint, nameOfTarget, find, version } = useConsole()
  const [task, setTask] = useState(null),
    [logs, setLogs] = useState([]),
    [error, setError] = useState('')
  const cursor = useRef(0),
    output = useRef(null),
    nearBottom = useRef(true),
    pollRef = useRef(() => {})
  useEffect(() => {
    let active = true,
      busy = false,
      timer
    async function poll() {
      if (busy || !active) return
      busy = true
      try {
        const result = await request(`${endpoint}/tasks/${id}?after=${cursor.current}`)
        if (!active) return
        setTask(result.task)
        setError('')
        const extra = result.logs
          .filter((l) => l.seq > cursor.current)
          .sort((a, b) => a.seq - b.seq)
        if (extra.length) {
          cursor.current = extra.at(-1).seq
          setLogs((old) => [...old, ...extra])
        }
        if (cursor.current < result.task.lastSeq) timer = setTimeout(poll, 150)
      } catch (e) {
        if (active && e.name !== 'AbortError') setError(`日志暂时不可用：${e.message}`)
      } finally {
        busy = false
      }
    }
    pollRef.current = poll
    poll()
    const interval = setInterval(poll, 2000)
    return () => {
      active = false
      clearInterval(interval)
      clearTimeout(timer)
    }
  }, [id, endpoint])
  useEffect(() => {
    pollRef.current()
  }, [version])
  useEffect(() => {
    if (nearBottom.current && output.current) output.current.scrollTop = output.current.scrollHeight
  }, [logs])
  const outcome = task?.result
  const stages =
    task?.action === 'deploy'
      ? ['preparing', 'queued', 'downloading', 'building', 'deploying', 'verifying']
      : ['queued', 'deploying', 'verifying']
  return (
    <FormDialog
      wide
      title="发布详情"
      description={task ? nameOfTarget(find('targets', task.targetId)) : '正在加载任务和日志…'}
      onClose={onClose}
      footer={
        <DialogFooter>
          <Button type="button" variant="outline" data-close onClick={onClose}>
            关闭详情
          </Button>
        </DialogFooter>
      }
    >
      {error && <Notice error>{error}</Notice>}
      {task && (
        <>
          <dl
            id="deploy-task-info"
            className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/25 p-4"
          >
            <Detail label="部署目标">{nameOfTarget(find('targets', task.targetId))}</Detail>
            <Detail label="任务结果">
              <Status value={task.status}>{resultName(task)}</Status>
            </Detail>
            <Detail label="源码版本">
              {revisionOf(task) || (finished(task) ? '—' : '准备中')}
            </Detail>
            <Detail label="总耗时">{duration(task)}</Detail>
            <Detail label="开始时间">{date(task.startedAt || task.createdAt)}</Detail>
            <Detail label="结束时间">{task.finishedAt ? date(task.finishedAt) : '进行中'}</Detail>
          </dl>
          <div
            id="deploy-task-progress"
            className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
          >
            {stages.map((stage) => {
              const entries = (task.stageHistory || []).filter((e) => e.stage === stage)
              const current = entries.some((e) => !e.finishedAt) && !finished(task)
              const ms = entries.reduce(
                (sum, e) =>
                  sum +
                  (e.durationMs ??
                    Math.max(
                      0,
                      (e.finishedAt ? Date.parse(e.finishedAt) : Date.now()) -
                        Date.parse(e.startedAt),
                    )),
                0,
              )
              return (
                <div
                  key={stage}
                  className={`stage-step rounded-md border p-3 ${entries.length ? (current ? 'active border-primary bg-accent' : 'complete bg-muted/50') : 'text-muted-foreground'}`}
                >
                  <p className="text-xs font-medium">{stageLabel(stage, task.config?.kind)}</p>
                  <p className="mt-1 text-xs">
                    {entries.length
                      ? duration({
                          startedAt: new Date(0).toISOString(),
                          finishedAt: new Date(ms).toISOString(),
                        })
                      : finished(task)
                        ? '无阶段记录'
                        : '等待执行'}
                  </p>
                </div>
              )
            })}
          </div>
          <div id="deploy-task-result" className="space-y-2">
            {task.error && <Notice error>{task.error}</Notice>}
            {typeof outcome === 'string' ? (
              <Notice>{outcome}</Notice>
            ) : (
              outcome && (
                <>
                  {outcome.message && <Notice>{outcome.message}</Notice>}
                  {outcome.error && outcome.error !== task.error && (
                    <Notice error>失败原因：{outcome.error}</Notice>
                  )}
                  {outcome.rollback && (
                    <Notice>
                      自动回退：
                      {{ succeeded: '成功', failed: '失败', unavailable: '没有可恢复的基线' }[
                        outcome.rollback.status || outcome.rollback
                      ] ||
                        outcome.rollback.status ||
                        String(outcome.rollback)}
                      {outcome.rollback.error && `；回退失败原因：${outcome.rollback.error}`}
                    </Notice>
                  )}
                  {outcome.cleanupError && (
                    <Notice error>失败发布清理异常：{outcome.cleanupError}</Notice>
                  )}
                  {(outcome.image || outcome.release?.image) && (
                    <p className="break-all font-mono text-xs">
                      镜像：{outcome.image || outcome.release.image}
                    </p>
                  )}
                  {outcome.release?.kind === 'static' && (
                    <p className="break-all font-mono text-xs">
                      静态版本：{outcome.release.artifact}
                    </p>
                  )}
                </>
              )
            )}
          </div>
        </>
      )}
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-semibold">执行日志</h3>
        <span className="text-xs text-muted-foreground">断线自动补传 · 按原始顺序显示</span>
      </div>
      <pre
        ref={output}
        id="deploy-task-logs"
        aria-label="执行日志"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
        }}
        className="h-64 max-w-full overflow-auto rounded-lg border bg-zinc-950 p-4 font-mono text-xs leading-6 text-zinc-200 sm:h-80"
      >
        {logs
          .map(
            (line) =>
              `[${date(line.at)}] ${line.stage ? `[${stageLabel(line.stage, task?.config?.kind)}] ` : ''}${line.message}\n`,
          )
          .join('')}
      </pre>
    </FormDialog>
  )
}
