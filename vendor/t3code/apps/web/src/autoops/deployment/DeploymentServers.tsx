import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Link, useBlocker } from '@tanstack/react-router'
import { ProjectId } from '@t3tools/contracts'
import {
  ArrowLeftIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
} from 'lucide-react'
import { useStableCallback } from '~/hooks/useStableCallback'
import { SettingsRow, SettingsSection } from '~/components/settings/settingsLayout'
import { Alert, AlertAction, AlertDescription } from '~/components/ui/alert'
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '~/components/ui/menu'
import { Spinner } from '~/components/ui/spinner'
import { randomUUID } from '~/lib/utils'
import { AutoOpsRequestError, isAutoOpsAccessError } from '../apiClient'
import { readAutoOpsHost } from '../hostSnapshot'
import { Choice } from './DeploymentControls'
import {
  NodeAssignmentFields,
  NodeConnectionPanel,
  NodeInstallationGuide,
  NodeStorageFields,
  nodeStatus as status,
  storageStateText,
  type NodeAssignmentDraft,
} from './DeploymentNodeFields'
import { type NodePageSearch, type NodeReturnContext } from './deploymentNodeNavigation'
import {
  loadDeploymentServers,
  loadDeploymentNodeReceipt,
  loadGlobalDeploymentNodeReceipt,
  loadGlobalDeploymentNodes,
  matchesDeploymentNodeReceipt,
  mutateGlobalDeploymentNode,
  type DeploymentGlobalNodeCatalog,
  mutateDeploymentServer,
  type DeploymentServer,
  type DeploymentServerManagement,
  type DeploymentServerMutation,
  type DeploymentServerRegistration,
} from './deploymentServersApi'

type Props = (
  { scope?: 'project'; projectId: string; environmentId: string } | { scope: 'platform' }
) & {
  embedded?: boolean
  nodeLocation?: NodePageSearch | undefined
  returnContext?: NodeReturnContext | undefined
  onNodeNavigate?: ((search: Pick<NodePageSearch, 'nodeId' | 'nodeView'>) => void) | undefined
  onManageNodes?: ((serverId?: string) => void) | undefined
  onReturn?: (() => void) | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus: ComponentProps<typeof DialogPopup>['finalFocus']
  onAccessDenied: (cause: unknown) => void
  onChanged: () => void
}
type View =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'bind' }
  | { kind: 'assign' | 'connect'; server: DeploymentServer }
  | {
      kind: 'access'
      server: DeploymentServer
      projectId: string
      projectName: string
      allowed: boolean
      expectedRevision: number
    }
  | { kind: 'details'; server: DeploymentServer }
  | { kind: 'unbind'; server: DeploymentServer }
  | { kind: 'revoke'; server: DeploymentServer }
  | { kind: 'delete'; server: DeploymentServer }

const operationLabels = {
  create: '接入节点',
  bind: '绑定节点',
  unbind: '解绑节点',
  revoke: '撤销节点',
  delete: '删除节点',
  storage: '保存存储设置',
  access: '保存项目授权',
  assign: '分配节点',
  registration: '更新安装命令',
}
const time = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '暂无观测'
const bytes = (value: number | null | undefined) =>
  value == null
    ? '—'
    : `${(value / 1024 ** 3).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} GiB`
const usage = (value?: { used: number | null; total: number | null } | null) =>
  value ? `${bytes(value.used)} / ${bytes(value.total)}` : '—'
const message = (cause: unknown) => (cause instanceof Error ? cause.message : '操作失败，请重试。')
const isRegistration = (value: unknown): value is DeploymentServerRegistration => {
  if (!value || typeof value !== 'object') return false
  return (
    'server' in value &&
    'registrationToken' in value &&
    (value.registrationToken === null || typeof value.registrationToken === 'string') &&
    'expiresAt' in value &&
    (value.expiresAt === null || typeof value.expiresAt === 'string')
  )
}

function Field({
  label,
  children,
  inline = false,
}: {
  label: string
  children: (id: string) => ReactNode
  inline?: boolean
}) {
  const id = useId()
  if (inline)
    return (
      <SettingsRow
        title={<Label htmlFor={id}>{label}</Label>}
        control={<div className="w-24">{children(id)}</div>}
      />
    )
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  )
}

function NodeImpact({
  catalog,
  serverId,
  onRevoke,
}: {
  catalog: DeploymentGlobalNodeCatalog
  serverId: string
  onRevoke?: ((projectId: string, projectName: string, revision: number) => void) | undefined
}) {
  const projects = catalog.projects.filter(
    (project) =>
      catalog.projectAccess.some(
        (entry) => entry.projectId === project.id && entry.serverIds.includes(serverId),
      ) ||
      catalog.bindings.some(
        (entry) => entry.projectId === project.id && entry.serverId === serverId,
      ),
  )
  return (
    <div id="deployment-node-assignments" tabIndex={-1}>
      <SettingsSection title="项目与环境">
        {projects.map((project) => {
          const bindings = catalog.bindings.filter(
            (entry) => entry.projectId === project.id && entry.serverId === serverId,
          )
          return (
            <SettingsRow
              key={project.id}
              title={project.name}
              description={
                bindings.length
                  ? `已绑定：${bindings
                      .map(
                        (binding) =>
                          project.environments.find(
                            (environment) => environment.id === binding.environmentId,
                          )?.name ?? binding.environmentId,
                      )
                      .join('、')}`
                  : '尚未绑定环境'
              }
              control={
                <div className="flex flex-wrap gap-2">
                  {bindings.map((binding) => (
                    <Button
                      key={binding.environmentId}
                      variant="outline"
                      size="sm"
                      render={
                        <Link
                          to="/projects"
                          search={{
                            projectId: ProjectId.make(project.id),
                            nodeEnvironmentId: binding.environmentId,
                          }}
                        />
                      }
                    >
                      管理
                      {project.environments.find((value) => value.id === binding.environmentId)
                        ?.name ?? '环境'}
                      节点
                    </Button>
                  ))}
                  {onRevoke &&
                  catalog.projectAccess.some(
                    (value) => value.projectId === project.id && value.serverIds.includes(serverId),
                  ) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onRevoke(
                          project.id,
                          project.name,
                          catalog.projectAccess.find((value) => value.projectId === project.id)!
                            .revision,
                        )
                      }
                    >
                      撤回项目授权
                    </Button>
                  ) : null}
                </div>
              }
            />
          )
        })}
        {!projects.length ? <SettingsRow title="未分配项目" /> : null}
      </SettingsSection>
    </div>
  )
}

function readPending(key: string): DeploymentServerMutation | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? 'null',
    ) as DeploymentServerMutation | null
    return value &&
      Object.hasOwn(operationLabels, value.kind) &&
      typeof value.input?.requestId === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

export function DeploymentServers(props: Props) {
  const identity = readAutoOpsHost()?.principal.id ?? ''
  return (
    <DeploymentServersScope
      key={`${identity}:${props.scope === 'platform' ? 'platform' : `${props.projectId}:${props.environmentId}`}:${props.open}`}
      {...props}
      identity={identity}
    />
  )
}

function DeploymentServersScope(props: Props & { identity: string }) {
  const { open, onOpenChange, finalFocus, onAccessDenied, onChanged, identity } = props
  const platform = props.scope === 'platform'
  const projectId = props.scope === 'platform' ? undefined : props.projectId
  const environmentId = props.scope === 'platform' ? undefined : props.environmentId
  const pendingKey = `autoops:deployment-servers:${identity}:${platform ? 'platform' : `${projectId}:${environmentId}`}`
  const [data, setData] = useState<DeploymentServerManagement | null>(null)
  const [catalog, setCatalog] = useState<DeploymentGlobalNodeCatalog | null>(null)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [pending, setPending] = useState(() => readPending(pendingKey))
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [assignment, setAssignment] = useState<NodeAssignmentDraft>({
    projectId: '',
    environmentIds: [],
    expectedRevision: 1,
    projectOnly: false,
  })
  const [reducePolicy, setReducePolicy] = useState(false)
  const [leaveView, setLeaveView] = useState<View | null>(null)
  const [registration, setRegistration] = useState<DeploymentServerRegistration | null>(null)
  const [name, setName] = useState('')
  const [serverId, setServerId] = useState('')
  const [retainedVersions, setRetainedVersions] = useState('2')
  const [buildCacheGiB, setBuildCacheGiB] = useState('2')
  const [refresh, setRefresh] = useState(0)
  const active = useRef(true)
  const submitting = useRef(false)
  const mutationController = useRef<AbortController | null>(null)
  const handledLocation = useRef('')
  const allowNavigation = useRef(false)
  const dirty =
    view.kind === 'details' &&
    platform &&
    !!view.server.storagePolicy &&
    (retainedVersions !== String(view.server.storagePolicy.retainedVersions) ||
      buildCacheGiB !== String(view.server.storagePolicy.buildCacheGiB))
  const blocker = useBlocker({
    shouldBlockFn: () => !allowNavigation.current && dirty && !pending,
    enableBeforeUnload: dirty && !pending,
    withResolver: true,
  })
  const changed = useStableCallback(onChanged)
  const accessDenied = useStableCallback((cause: unknown) => {
    active.current = false
    setData(null)
    setCatalog(null)
    setView({ kind: 'list' })
    setName('')
    setServerId('')
    setRegistration(null)
    setPending(null)
    setError(null)
    mutationController.current?.abort()
    // 原操作仍由原账号/范围保存；恢复授权后只能 GET 核对，不重新提交。
    onAccessDenied(cause)
    onOpenChange(false)
  })

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      mutationController.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!open || !active.current) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    const poll = async () => {
      if (document.hidden || running || controller.signal.aborted) return
      running = true
      setLoading(true)
      const load = platform
        ? loadGlobalDeploymentNodes(controller.signal).then((result) => {
            if (!controller.signal.aborted && active.current) {
              setCatalog(result)
              setData({
                servers: result.servers,
                availableServers: [],
                canAdmin: true,
                canBind: false,
              })
            }
          })
        : loadDeploymentServers(projectId!, environmentId!, controller.signal).then((result) => {
            if (!controller.signal.aborted && active.current)
              setData({ ...result, canAdmin: false })
          })
      await load
        .then(() => {
          if (!controller.signal.aborted) setLoadError(null)
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || !active.current) return
          if (isAutoOpsAccessError(cause)) accessDenied(cause)
          else setLoadError(message(cause))
        })
        .finally(() => {
          if (!controller.signal.aborted && active.current) setLoading(false)
        })
      running = false
      if (!controller.signal.aborted && active.current && !document.hidden)
        timer = setTimeout(poll, 5000)
    }
    const visible = () => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', visible)
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [platform, projectId, environmentId, open, refresh, accessDenied])

  function go(next: View, discard = false) {
    if (dirty && !pending && !discard) {
      setLeaveView(next)
      return
    }
    allowNavigation.current = true
    setView(next)
    setError(null)
    setNotice(null)
    setReducePolicy(false)
    if (next.kind !== 'connect') setRegistration(null)
    if (next.kind === 'details') {
      setRetainedVersions(String(next.server.storagePolicy?.retainedVersions ?? 2))
      setBuildCacheGiB(String(next.server.storagePolicy?.buildCacheGiB ?? 2))
    }
    if (next.kind === 'assign') {
      const context = props.returnContext
      const project = catalog?.projects.find((value) => value.id === context?.projectId)
      setAssignment({
        projectId: project?.id ?? '',
        environmentIds: project?.environments.some((value) => value.id === context?.environmentId)
          ? [context!.environmentId]
          : [],
        expectedRevision:
          catalog?.projectAccess.find((value) => value.projectId === project?.id)?.revision ?? 1,
        projectOnly: false,
      })
    }
    const target: Pick<NodePageSearch, 'nodeId' | 'nodeView'> | null =
      next.kind === 'list'
        ? {}
        : next.kind === 'create'
          ? { nodeView: 'create' }
          : next.kind === 'details' || next.kind === 'assign' || next.kind === 'connect'
            ? { nodeId: next.server.id, nodeView: next.kind }
            : null
    if (target && props.onNodeNavigate) {
      handledLocation.current = `${target.nodeView ?? 'list'}:${target.nodeId ?? ''}`
      props.onNodeNavigate(target)
    }
    setTimeout(() => {
      allowNavigation.current = false
    }, 0)
  }

  useEffect(() => {
    if (!platform || !props.nodeLocation || !data) return
    const { nodeId, nodeView } = props.nodeLocation
    const kind = nodeView ?? (nodeId ? 'details' : 'list')
    const key = `${kind}:${nodeId ?? ''}`
    if (handledLocation.current === key) return
    handledLocation.current = key
    const server = data.servers.find((value) => value.id === nodeId)
    if (kind === 'list') {
      setView({ kind: 'list' })
      setRegistration(null)
    } else if (kind === 'create') {
      setView({ kind: 'create' })
      setRegistration(null)
    } else if (server) {
      setView({ kind, server })
      if (kind !== 'connect') setRegistration(null)
      setRetainedVersions(String(server.storagePolicy?.retainedVersions ?? 2))
      setBuildCacheGiB(String(server.storagePolicy?.buildCacheGiB ?? 2))
      if (kind === 'assign') {
        const context = props.returnContext
        const project = catalog?.projects.find((value) => value.id === context?.projectId)
        setAssignment({
          projectId: project?.id ?? '',
          environmentIds: project?.environments.some((value) => value.id === context?.environmentId)
            ? [context!.environmentId]
            : [],
          expectedRevision:
            catalog?.projectAccess.find((value) => value.projectId === project?.id)?.revision ?? 1,
          projectOnly: false,
        })
      }
    } else {
      setView({ kind: 'list' })
      setError('此节点不存在或已不可用，请返回节点列表。')
    }
  }, [platform, props.nodeLocation, props.returnContext, data, catalog])

  useEffect(() => {
    if (view.kind !== 'details' || !props.nodeLocation?.nodeSection) return
    const section = props.nodeLocation.nodeSection
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`deployment-node-${section}`)
      target?.scrollIntoView({ block: 'start' })
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [view.kind, props.nodeLocation?.nodeId, props.nodeLocation?.nodeSection])

  async function submit(input: DeploymentServerMutation) {
    if (submitting.current || !active.current || pending) return
    const operation = input
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify(operation))
    } catch {
      setError('浏览器无法保存操作记录，请允许站点存储后重试。')
      return
    }
    setPending(operation)
    setError(null)
    setBusy(true)
    submitting.current = true
    const controller = new AbortController()
    mutationController.current = controller
    try {
      const result = platform
        ? await mutateGlobalDeploymentNode(operation, controller.signal)
        : await mutateDeploymentServer(projectId!, operation, controller.signal)
      if (!active.current || controller.signal.aborted) return
      if ('available' in result && result.available === false) {
        accessDenied(
          new AutoOpsRequestError('操作已保存，当前管理权限已撤销。', 'ACCESS_DENIED', 403),
        )
        return
      }
      setPending(null)
      try {
        sessionStorage.removeItem(pendingKey)
      } catch {
        /* 存储清理失败时仍只按原标识读取收据。 */
      }
      if (
        (operation.kind === 'create' || operation.kind === 'registration') &&
        isRegistration(result)
      ) {
        go({ kind: 'connect', server: result.server }, true)
        setRegistration(result)
      } else if (operation.kind === 'storage' && 'id' in result && 'name' in result) {
        go({ kind: 'details', server: result }, true)
        setNotice('存储设置已保存；实际应用结果以节点报告为准。')
      } else if (operation.kind === 'assign' && selected) {
        go({ kind: 'details', server: selected }, true)
        const project = catalog?.projects.find((value) => value.id === operation.input.projectId)
        const names = operation.input.environmentIds.map(
          (id) => project?.environments.find((value) => value.id === id)?.name ?? id,
        )
        setNotice(
          `已分配给“${project?.name ?? operation.input.projectId}”${names.length ? `，绑定环境：${names.join('、')}` : '，尚未绑定环境'}。`,
        )
      } else {
        go({ kind: 'list' }, true)
        setNotice(`${operationLabels[operation.kind]}成功。`)
      }
      setRefresh((value) => value + 1)
      changed()
    } catch (cause) {
      if (!active.current || controller.signal.aborted) return
      if (isAutoOpsAccessError(cause)) {
        if (cause instanceof AutoOpsRequestError && !cause.uncertain) {
          try {
            sessionStorage.removeItem(pendingKey)
          } catch {
            /* 明确拒绝未接受本次操作。 */
          }
        }
        accessDenied(cause)
        return
      }
      if (cause instanceof AutoOpsRequestError && !cause.uncertain) {
        setPending(null)
        try {
          sessionStorage.removeItem(pendingKey)
        } catch {
          /* 明确拒绝不会生成新业务操作。 */
        }
      }
      setError(
        cause instanceof AutoOpsRequestError && cause.uncertain
          ? '暂时无法确认操作结果，请点击“核对结果”；不会重复提交。'
          : message(cause),
      )
    } finally {
      submitting.current = false
      if (active.current) setBusy(false)
    }
  }

  async function recover() {
    if (!pending || submitting.current || !active.current) return
    const operation = pending
    const controller = new AbortController()
    mutationController.current = controller
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      // 未知请求只读取原收据；目录变化、空收据或网络失败均不构成重新写入的依据。
      const receipt = platform
        ? await loadGlobalDeploymentNodeReceipt(operation.input.requestId, controller.signal)
        : await loadDeploymentNodeReceipt(
            projectId!,
            environmentId!,
            operation.input.requestId,
            controller.signal,
          )
      if (!active.current || controller.signal.aborted) return
      if (!receipt) {
        setError('尚未找到可核对的原收据，操作仍待确认。请稍后再次核对。')
        return
      }
      if (!matchesDeploymentNodeReceipt(operation, receipt, { projectId, environmentId })) {
        throw new Error('返回的原收据与当前操作范围不符，操作仍待确认。')
      }
      if (operation.kind === 'create' || operation.kind === 'registration') {
        if (!('id' in receipt.result) || typeof receipt.result.name !== 'string')
          throw new Error('原节点事实不可核对，操作仍待确认。')
        setRegistration({
          server: receipt.result,
          registrationToken: null,
          expiresAt: null,
          repeated: true,
        })
        go({ kind: 'connect', server: receipt.result }, true)
      } else if (
        operation.kind === 'storage' &&
        'id' in receipt.result &&
        'name' in receipt.result
      ) {
        go({ kind: 'details', server: receipt.result }, true)
        setNotice('已确认存储设置保存成功，等待节点报告应用结果。')
      } else {
        go({ kind: 'list' }, true)
        setNotice(`已确认${operationLabels[operation.kind]}成功。`)
      }
      setPending(null)
      try {
        sessionStorage.removeItem(pendingKey)
      } catch {
        /* 重开仍只 GET 原收据。 */
      }
      setRefresh((value) => value + 1)
      changed()
    } catch (cause) {
      if (!active.current || controller.signal.aborted) return
      if (isAutoOpsAccessError(cause)) accessDenied(cause)
      else setError(message(cause))
    } finally {
      submitting.current = false
      if (active.current) setBusy(false)
    }
  }

  const disabled = busy || !!pending
  const selected =
    'server' in view
      ? (data?.servers.find((value) => value.id === view.server.id) ?? view.server)
      : null
  const canManage = readAutoOpsHost()?.canManageDeploymentNodes === true
  const available =
    data?.availableServers.filter(
      (server) =>
        !server.revoked &&
        !data.servers.some(
          (bound) => bound.id === server.id && bound.environmentId === environmentId,
        ),
    ) ?? []
  const policyValid =
    Number.isInteger(Number(retainedVersions)) &&
    Number(retainedVersions) >= 2 &&
    Number(retainedVersions) <= 20 &&
    Number.isInteger(Number(buildCacheGiB)) &&
    Number(buildCacheGiB) >= 1 &&
    Number(buildCacheGiB) <= 20
  const title = selected
    ? selected.name
    : view.kind === 'create'
      ? '接入节点'
      : view.kind === 'bind'
        ? '绑定已有节点'
        : platform
          ? '平台节点'
          : '部署节点'
  const back = () => go({ kind: 'list' })
  const confirmDisabled =
    disabled ||
    view.kind === 'list' ||
    view.kind === 'connect' ||
    (view.kind === 'assign' &&
      (!assignment.projectId ||
        (!assignment.projectOnly && !assignment.environmentIds.length) ||
        !!selected?.revoked)) ||
    (view.kind === 'create' && !name.trim()) ||
    (view.kind === 'bind' && !serverId) ||
    (view.kind === 'details' &&
      (!policyValid || !data?.canAdmin || !view.server.storagePolicy || selected?.revoked))
  const confirm = () => {
    if (confirmDisabled) return
    const requestId = randomUUID()
    if (view.kind === 'create')
      void submit({ kind: 'create', input: { name: name.trim(), requestId } })
    else if (view.kind === 'bind' && environmentId)
      void submit({ kind: 'bind', serverId, input: { environmentId, requestId } })
    else if (view.kind === 'assign')
      void submit({
        kind: 'assign',
        serverId: view.server.id,
        input: {
          projectId: assignment.projectId,
          environmentIds: assignment.projectOnly ? [] : assignment.environmentIds,
          expectedRevision: assignment.expectedRevision,
          requestId,
        },
      })
    else if (view.kind === 'access')
      void submit({
        kind: 'access',
        serverId: view.server.id,
        projectId: view.projectId,
        input: { allowed: view.allowed, expectedRevision: view.expectedRevision, requestId },
      })
    else if (view.kind === 'delete')
      void submit({ kind: 'delete', serverId: view.server.id, input: { requestId } })
    else if (view.kind === 'revoke')
      void submit({
        kind: view.kind,
        serverId: view.server.id,
        input: { requestId },
      })
    else if (view.kind === 'unbind' && environmentId)
      void submit({
        kind: 'unbind',
        serverId: view.server.id,
        input: { environmentId, requestId },
      })
    else if (view.kind === 'details' && view.server.storagePolicy) {
      if (
        !reducePolicy &&
        (Number(retainedVersions) < view.server.storagePolicy.retainedVersions ||
          Number(buildCacheGiB) < view.server.storagePolicy.buildCacheGiB)
      ) {
        setReducePolicy(true)
        return
      }
      void submit({
        kind: 'storage',
        serverId: view.server.id,
        input: {
          expectedRevision: view.server.storagePolicy.revision,
          retainedVersions: Number(retainedVersions),
          buildCacheGiB: Number(buildCacheGiB),
          requestId,
        },
      })
    }
  }

  const Header = props.embedded ? PageHeader : DialogHeader
  const Title = props.embedded ? PageTitle : DialogTitle
  const Panel = props.embedded ? PagePanel : DialogPanel
  const Footer = props.embedded ? PageFooter : DialogFooter
  const content = (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        confirm()
      }}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        )
          event.preventDefault()
      }}
    >
      <Header>
        <div className="flex min-w-0 items-center gap-2 pr-6">
          {view.kind !== 'list' || registration ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="返回节点列表"
              onClick={back}
              disabled={busy}
            >
              <ArrowLeftIcon />
            </Button>
          ) : null}
          <Title className="min-w-0 break-words">{title}</Title>
          {props.onReturn ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={props.onReturn}>
              返回原环境
            </Button>
          ) : null}
        </div>
      </Header>
      <Panel>
        {leaveView || blocker.status === 'blocked' ? (
          <Alert variant="info">
            <AlertDescription>
              <p>有尚未保存的存储修改。</p>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLeaveView(null)
                    blocker.reset?.()
                  }}
                >
                  继续编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (blocker.status === 'blocked') blocker.proceed()
                    else if (leaveView) go(leaveView, true)
                    setLeaveView(null)
                  }}
                >
                  放弃修改
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert variant="info">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {loadError ? (
          <Alert variant="error">
            <AlertDescription>{loadError}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>
                重新读取节点
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
        {error || (pending && !busy) ? (
          <Alert variant="error">
            <AlertDescription>
              {error ?? `${operationLabels[pending!.kind]}尚未确认，请核对结果。`}
            </AlertDescription>
            {pending ? (
              <AlertAction>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void recover()}>
                  {busy ? <Spinner size="sm" /> : null}核对结果
                </Button>
              </AlertAction>
            ) : null}
            {error &&
            !pending &&
            view.kind === 'details' &&
            selected?.storagePolicy &&
            view.server.storagePolicy?.revision !== selected.storagePolicy.revision ? (
              <AlertAction>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setView({ kind: 'details', server: selected })
                    setError(null)
                    setReducePolicy(false)
                  }}
                >
                  保留输入，按最新配置重新核对
                </Button>
              </AlertAction>
            ) : null}
            {error && !pending && view.kind === 'assign' ? (
              <AlertAction>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAssignment((value) => ({
                      ...value,
                      expectedRevision:
                        catalog?.projectAccess.find((entry) => entry.projectId === value.projectId)
                          ?.revision ?? 1,
                    }))
                    setError(null)
                  }}
                >
                  重新核对项目授权
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        ) : null}
        {view.kind === 'connect' && selected ? (
          <NodeConnectionPanel
            assigned={
              catalog?.projectAccess.some((entry) => entry.serverIds.includes(selected.id)) ?? false
            }
            server={selected}
            registration={registration}
            installation={catalog?.installation}
            disabled={disabled}
            onError={setError}
            onRenew={() =>
              void submit({
                kind: 'registration',
                serverId: selected.id,
                input: { requestId: randomUUID() },
              })
            }
            onAssign={() => go({ kind: 'assign', server: selected })}
            onSkip={back}
          />
        ) : view.kind === 'list' ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {platform ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setName('')
                    go({ kind: 'create' })
                  }}
                  disabled={disabled || !data}
                >
                  <PlusIcon />
                  接入节点
                </Button>
              ) : null}
              {!platform && data?.canBind ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled || !available.length}
                  onClick={() => {
                    setServerId(available[0]?.id ?? '')
                    go({ kind: 'bind' })
                  }}
                >
                  <LinkIcon />
                  绑定已有节点
                </Button>
              ) : null}
              {!platform && canManage && props.onManageNodes ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => props.onManageNodes?.()}
                >
                  管理／接入节点
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto"
                aria-label="刷新节点"
                disabled={loading || busy}
                onClick={() => {
                  setError(null)
                  setRefresh((value) => value + 1)
                }}
              >
                <RefreshCwIcon />
              </Button>
            </div>
            {loading && !data ? (
              <div role="status" className="flex items-center gap-2 py-4 text-muted-foreground">
                <Spinner size="sm" />
                读取节点…
              </div>
            ) : data && !data.servers.length ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {platform
                  ? '尚未接入节点。点击“接入节点”开始。'
                  : available.length
                    ? '当前环境尚未绑定节点，请选择“绑定已有节点”。'
                    : '当前环境尚未绑定节点，且没有可绑定节点。需要先接入节点并授权给此项目。'}
              </p>
            ) : null}
            {!platform && !canManage ? (
              <p className="text-sm text-muted-foreground">
                节点接入和存储设置由平台管理员维护。
                {data?.canBind
                  ? '你可以绑定此项目已获授权的节点。'
                  : '当前账号没有环境节点绑定权限。'}
              </p>
            ) : null}
            {data?.servers.length ? (
              <SettingsSection title="节点" hideTitle>
                {data.servers.map((server) => (
                  <SettingsRow
                    key={`${server.id}:${server.environmentId}`}
                    title={
                      <span className="flex min-w-0 items-center gap-2">
                        <ServerIcon className="size-4 shrink-0" />
                        <span className="break-all">{server.name}</span>
                      </span>
                    }
                    description={
                      server.projectAllowed === false ? (
                        '项目授权已撤回'
                      ) : (
                        <span className="block space-y-1">
                          <span className="block">
                            {status(server)} · {time(server.lastSeenAt)}
                          </span>
                          <span className="block">
                            CPU{' '}
                            {server.metrics?.cpuPercent == null
                              ? '—'
                              : `${server.metrics.cpuPercent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`}{' '}
                            · 内存 {usage(server.metrics?.memory)} · 磁盘{' '}
                            {usage(server.metrics?.disk)} · RTT{' '}
                            {server.metrics?.centerRttMs == null
                              ? '—'
                              : `${server.metrics.centerRttMs} ms`}
                          </span>
                          <span className="block">
                            存储：
                            {server.storagePolicy
                              ? `保留 ${server.storagePolicy.retainedVersions} 个成功版本 · 构建缓存 ${server.storagePolicy.buildCacheGiB} GiB · `
                              : ''}
                            {storageStateText(server)}
                          </span>
                          {platform && catalog ? (
                            <span className="block">
                              {catalog.projectAccess
                                .filter((entry) => entry.serverIds.includes(server.id))
                                .map((entry) => {
                                  const project = catalog.projects.find(
                                    (value) => value.id === entry.projectId,
                                  )
                                  const environments = catalog.bindings
                                    .filter(
                                      (value) =>
                                        value.serverId === server.id &&
                                        value.projectId === entry.projectId,
                                    )
                                    .map(
                                      (value) =>
                                        project?.environments.find(
                                          (env) => env.id === value.environmentId,
                                        )?.name ?? value.environmentId,
                                    )
                                  return `${project?.name ?? entry.projectId}（${environments.join('、') || '尚未绑定环境'}）`
                                })
                                .join('；') || '未分配项目'}
                            </span>
                          ) : null}
                        </span>
                      )
                    }
                    control={
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {platform ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => go({ kind: 'details', server })}
                            >
                              配置节点
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={disabled || server.revoked}
                              onClick={() => go({ kind: 'assign', server })}
                            >
                              分配到项目／环境
                            </Button>
                          </>
                        ) : canManage && props.onManageNodes ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => props.onManageNodes?.(server.id)}
                          >
                            配置节点
                          </Button>
                        ) : null}
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`${server.name}的操作`}
                                disabled={busy}
                              />
                            }
                          >
                            <MoreHorizontalIcon />
                          </MenuTrigger>
                          <MenuPopup align="end">
                            <MenuItem onClick={() => go({ kind: 'details', server })}>
                              查看节点
                            </MenuItem>
                            {!platform && data.canBind ? (
                              <MenuItem
                                disabled={disabled}
                                onClick={() => go({ kind: 'unbind', server })}
                              >
                                解绑节点
                              </MenuItem>
                            ) : null}
                            {data.canAdmin ? (
                              <>
                                <MenuItem
                                  disabled={disabled || server.revoked}
                                  onClick={() => go({ kind: 'revoke', server })}
                                >
                                  撤销节点
                                </MenuItem>
                                <MenuItem
                                  variant="destructive"
                                  disabled={disabled}
                                  onClick={() => go({ kind: 'delete', server })}
                                >
                                  删除节点
                                </MenuItem>
                              </>
                            ) : null}
                          </MenuPopup>
                        </Menu>
                      </div>
                    }
                  />
                ))}
              </SettingsSection>
            ) : null}
          </>
        ) : view.kind === 'create' ? (
          <>
            <NodeInstallationGuide installation={catalog?.installation} />
            <Field label="节点名称">
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onValueChange={setName}
                  required
                  maxLength={80}
                  disabled={disabled}
                />
              )}
            </Field>
          </>
        ) : view.kind === 'bind' ? (
          <Choice
            label="已有节点"
            value={serverId}
            options={available.map((server) => ({
              id: server.id,
              name: `${server.name} · ${status(server)}`,
            }))}
            onChange={setServerId}
            disabled={disabled}
          />
        ) : view.kind === 'assign' && catalog && selected ? (
          <NodeAssignmentFields
            catalog={catalog}
            server={selected}
            draft={assignment}
            onChange={setAssignment}
            disabled={disabled}
          />
        ) : view.kind === 'access' ? (
          <p className="break-words text-sm">
            {view.allowed
              ? `允许“${view.projectName}”使用“${view.server.name}”。项目管理员可将其绑定到环境。`
              : `撤回“${view.projectName}”使用“${view.server.name}”的授权。此项目绑定的全部环境将无法发起新部署，排队任务无法领取；已有任务结果继续保留。`}
          </p>
        ) : view.kind === 'details' && selected ? (
          <>
            <div id="deployment-node-connection" tabIndex={-1}>
              <SettingsSection title="连接信息">
                <SettingsRow
                  title="状态"
                  description={status(selected)}
                  control={
                    platform && !selected.revoked ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => go({ kind: 'connect', server: selected })}
                      >
                        {selected.registeredAt ? '连接排查' : '查看接入指引'}
                      </Button>
                    ) : undefined
                  }
                />
                <SettingsRow title="最近观测" description={time(selected.lastSeenAt)} />
                <SettingsRow title="执行器版本" description={selected.version ?? '未连接'} />
                <SettingsRow
                  title="节点 ID"
                  description={
                    <span className="select-text break-all font-mono">{view.server.id}</span>
                  }
                />
              </SettingsSection>
            </div>
            {platform && catalog ? (
              <>
                <NodeImpact
                  catalog={catalog}
                  serverId={selected.id}
                  onRevoke={
                    disabled
                      ? undefined
                      : (projectId, projectName, expectedRevision) =>
                          go({
                            kind: 'access',
                            server: selected,
                            projectId,
                            projectName,
                            expectedRevision,
                            allowed: false,
                          })
                  }
                />
                <Button
                  variant="outline"
                  disabled={disabled || selected.revoked}
                  onClick={() => go({ kind: 'assign', server: selected })}
                >
                  分配到项目／环境
                </Button>
              </>
            ) : canManage && props.onManageNodes ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => props.onManageNodes?.(selected.id)}
              >
                配置节点
              </Button>
            ) : null}
            <NodeStorageFields
              server={selected}
              canEdit={!!data?.canAdmin}
              disabled={disabled}
              retainedVersions={retainedVersions}
              buildCacheGiB={buildCacheGiB}
              onVersions={(value) => {
                setRetainedVersions(value)
                setReducePolicy(false)
              }}
              onCache={(value) => {
                setBuildCacheGiB(value)
                setReducePolicy(false)
              }}
            />
            {selected.storageStatus?.cache ? (
              <SettingsRow
                title="构建缓存用量"
                description={`${bytes(selected.storageStatus.cache.bytes)} / ${bytes(selected.storageStatus.cache.limitBytes)}`}
              />
            ) : null}
            {reducePolicy ? (
              <Alert variant="info">
                <AlertDescription>
                  降低保留数量或缓存预算后，节点空闲时会清理超额的旧版本或专用缓存，影响此节点全部项目。当前运行和受保护版本仍保留。请确认后再次保存。
                </AlertDescription>
              </Alert>
            ) : null}
          </>
        ) : (
          <>
            <p className="break-words text-sm">
              {view.kind === 'unbind'
                ? `将“${view.server.name}”从当前项目环境解绑。已有部署目标引用该节点时不能解绑。`
                : view.kind === 'revoke'
                  ? `撤销“${view.server.name}”后，该执行器将无法连接，其他项目使用此节点的部署也会受到影响。`
                  : `永久删除“${view.server.name}”的接入记录。关联部署位置、任务、日志和版本记录将一并删除；远端程序和文件不会被卸载。`}
            </p>
            {catalog && (view.kind === 'revoke' || view.kind === 'delete') ? (
              <NodeImpact catalog={catalog} serverId={view.server.id} />
            ) : null}
          </>
        )}
      </Panel>
      {view.kind !== 'list' && view.kind !== 'connect' ? (
        <Footer>
          <Button variant="outline" disabled={busy} onClick={back}>
            返回
          </Button>
          {view.kind !== 'details' ||
          (view.kind === 'details' &&
            data?.canAdmin &&
            view.server.storagePolicy &&
            !view.server.revoked) ? (
            <Button type="submit" disabled={!!confirmDisabled}>
              {busy ? <Spinner size="sm" /> : null}
              {view.kind === 'details'
                ? reducePolicy
                  ? '确认清理影响并保存'
                  : '保存存储设置'
                : view.kind === 'assign'
                  ? '确认分配'
                  : view.kind === 'access'
                    ? view.allowed
                      ? '确认允许'
                      : '确认撤回'
                    : view.kind === 'create'
                      ? '生成安装命令'
                      : view.kind === 'bind'
                        ? '确认绑定'
                        : view.kind === 'unbind'
                          ? '确认解绑'
                          : view.kind === 'revoke'
                            ? '确认撤销'
                            : '确认删除'}
            </Button>
          ) : null}
        </Footer>
      ) : null}
    </form>
  )
  if (props.embedded) return content
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRegistration(null)
        onOpenChange(next)
      }}
    >
      <DialogPopup className="sm:max-w-2xl" finalFocus={finalFocus}>
        {content}
      </DialogPopup>
    </Dialog>
  )
}

function PageHeader({ children }: { children: ReactNode }) {
  return <div className="mb-5">{children}</div>
}
function PageTitle({ children }: { children: ReactNode }) {
  return <h2 className="min-w-0 break-words text-sm font-medium">{children}</h2>
}
function PagePanel({ children }: { children: ReactNode }) {
  return <div className="space-y-4">{children}</div>
}
function PageFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 mt-6 flex justify-end gap-2 border-t bg-background py-3">
      {children}
    </div>
  )
}
