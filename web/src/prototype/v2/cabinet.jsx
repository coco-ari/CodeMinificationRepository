import { useEffect, useMemo, useRef, useState } from 'react'
import './cabinet.css'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ImagePlus,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  ServerCog,
  Trash2,
} from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkbench, uid, stamp } from './store'
import {
  Button,
  Input,
  Switch,
  Checkbox,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Picker,
  PageHeader,
  Panel,
  Field,
  Modal,
  Confirm,
  Empty,
  CopyButton,
  DemoScenarios,
  toast,
} from './ui'
import { deriveCabinetTargets } from './cabinet-seed'
import { cabinetQrPng } from './cabinet-qr'
import {
  cabinetResetSnapshot,
  validateCabinetReset,
  applyCabinetReset,
  cabinetQrAvailable,
} from './cabinet-logic'

const PAGE_SIZE = 5
const time = (value) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录'
const authLabels = {
  success: '鉴权成功',
  failed: '鉴权失败',
  unassigned: '未分配 · 503',
  disabled: '目标停用 · 503',
  unknown: '尚未鉴权',
}
const resetScenarios = [
  { value: 'success', label: '正常重置' },
  { value: 'noop', label: '已经重置（无需变更）' },
  { value: 'zero', label: '没有仓位（允许重置）' },
  { value: 'conflict', label: '仓位平台冲突' },
  { value: 'duplicate', label: '重复 IMEI' },
  { value: 'notfound', label: '业务库找不到机柜' },
  { value: 'db-error', label: '数据库连接失败' },
  { value: 'unknown', label: '事务提交结果未知' },
]

function validUrl(value) {
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

function endpoint(target) {
  try {
    return `mqtt.${new URL(target.url).hostname}:1883`
  } catch {
    return 'mqtt.example.invalid:1883'
  }
}

function saveDataUrl(name, dataUrl) {
  const anchor = document.createElement('a')
  anchor.download = name
  anchor.href = dataUrl
  anchor.click()
}

async function compressPhoto(file) {
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('只接受 JPG 或 PNG 照片')
  if (file.size > 20 * 1024 * 1024) throw new Error('照片不能超过 20 MiB')
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.82),
    name: file.name,
    width: canvas.width,
    height: canvas.height,
    updatedAt: stamp(),
  }
}

export function CabinetPage() {
  const { state, user, update, audit } = useWorkbench()
  const [tab, setTab] = useState('devices')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState([])
  const [allocation, setAllocation] = useState('unassigned')
  const [assignOpen, setAssignOpen] = useState(false)
  const [registration, setRegistration] = useState(null)
  const [targetEditor, setTargetEditor] = useState(null)
  const [targetRemoval, setTargetRemoval] = useState(null)
  const [detailId, setDetailId] = useState(null)
  const [qr, setQr] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
  const [photoDeviceId, setPhotoDeviceId] = useState(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [removeDevice, setRemoveDevice] = useState(null)
  const [deleteImei, setDeleteImei] = useState('')
  const [authScenario, setAuthScenario] = useState('success')
  const [refreshAt, setRefreshAt] = useState(Date.now())
  const [authBusy, setAuthBusy] = useState(null)
  const [resetDeviceId, setResetDeviceId] = useState(null)
  const [auditQuery, setAuditQuery] = useState('')
  const [cleanAudit, setCleanAudit] = useState(false)
  const [settings, setSettings] = useState(state.cabinet.settings)
  const photoInput = useRef(null)
  const targets = useMemo(
    () => deriveCabinetTargets(state),
    [state.projects, state.cabinet.manualTargets, state.cabinet.targetOverrides],
  )
  const targetById = Object.fromEntries(targets.map((target) => [target.id, target]))
  const devices = state.cabinet.devices.map((device) => ({
    ...device,
    targetId: targetById[device.targetId] ? device.targetId : null,
  }))
  const filtered = devices.filter((device) => {
    const match = `${device.imei} ${device.label} ${targetById[device.targetId]?.name || ''}`
      .toLowerCase()
      .includes(query.toLowerCase())
    return (
      match &&
      (filter === 'all' || (filter === 'unassigned' ? !device.targetId : Boolean(device.targetId)))
    )
  })
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visible = filtered.slice(
    (Math.min(page, pages) - 1) * PAGE_SIZE,
    Math.min(page, pages) * PAGE_SIZE,
  )
  const allVisibleSelected =
    visible.length > 0 && visible.every((device) => selected.includes(device.id))
  const selectedDevices = devices.filter((device) => selected.includes(device.id))
  const detail = devices.find((device) => device.id === detailId)
  const globalAudit = state.audit
    .filter((entry) => !entry.projectId && entry.action?.includes('机柜'))
    .filter((entry) =>
      `${entry.action} ${entry.object} ${entry.result} ${state.users.find((person) => person.id === entry.actorId)?.name || entry.actor || ''}`.includes(
        auditQuery,
      ),
    )

  useEffect(() => {
    const timer = setInterval(() => setRefreshAt(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    setPage(1)
  }, [query, filter])
  useEffect(() => {
    setSettings(state.cabinet.settings)
  }, [state.cabinet.settings])

  const log = (action, object, result = '成功') =>
    audit({ projectId: null, action, object, result })
  const selectOne = (id) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  const togglePage = () =>
    setSelected((current) =>
      allVisibleSelected
        ? current.filter((id) => !visible.some((device) => device.id === id))
        : [...new Set([...current, ...visible.map((device) => device.id)])],
    )

  function saveAllocation() {
    const target =
      allocation === 'unassigned'
        ? null
        : targets.find((item) => item.id === allocation && item.enabled)
    if (allocation !== 'unassigned' && !target) {
      toast.error('目标已停用或删除，请重新选择')
      return
    }
    const ids = selectedDevices.map((device) => device.id)
    update((draft) => {
      for (const device of draft.cabinet.devices)
        if (ids.includes(device.id)) {
          device.targetId = target?.id || null
          device.revision += 1
        }
    })
    log(
      '机柜批量分配',
      `${selectedDevices.map((device) => device.imei).join('、')} → ${target?.name || '未分配'}`,
    )
    toast.success(`已更新 ${ids.length} 台机柜，下次鉴权生效`)
    setSelected([])
    setAssignOpen(false)
  }

  function register() {
    const imei = registration.imei.trim()
    if (!/^\d{15}$/.test(imei)) {
      toast.error('请输入完整的 15 位 IMEI')
      return
    }
    const existing = devices.find((device) => device.imei === imei)
    if (existing) {
      setRegistration(null)
      setDetailId(existing.id)
      authenticate(existing.id)
      return
    }
    const device = {
      id: uid('cabinet'),
      imei,
      label: registration.label.trim() || '新注册设备',
      targetId: null,
      registeredAt: stamp(),
      photo: null,
      revision: 1,
      lastAuth: {
        status: 'unassigned',
        targetId: null,
        at: stamp(),
        targetUrl: null,
        mqttEndpoint: null,
        requestId: uid('request'),
      },
      platform: {
        platformId: 8,
        agentId: 1001,
        merchantId: 2001,
        branchId: 3001,
        bindTime: stamp(),
        positions: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, platformId: 8 })),
      },
    }
    update((draft) => {
      draft.cabinet.devices.unshift(device)
    })
    log('机柜自动注册', imei, '等待分配 · 鉴权返回 503')
    setRegistration(null)
    setPage(1)
    setQuery('')
    setFilter('all')
    toast.success('设备请求已自动注册，等待人工分配')
  }

  function authenticate(id) {
    if (authBusy) return
    setAuthBusy(id)
    const device = devices.find((item) => item.id === id)
    const target = targetById[device?.targetId]
    const status = !target
      ? 'unassigned'
      : !target.enabled
        ? 'disabled'
        : authScenario === 'failed'
          ? 'failed'
          : 'success'
    setTimeout(() => {
      update((draft) => {
        const current = draft.cabinet.devices.find((item) => item.id === id)
        if (!current) return
        current.lastAuth = {
          status,
          targetId: target?.id || null,
          at: stamp(),
          targetUrl: target?.url || null,
          mqttEndpoint: status === 'success' ? endpoint(target) : null,
          requestId: uid('auth'),
        }
      })
      log('机柜模拟鉴权', device.imei, authLabels[status])
      setAuthBusy(null)
      toast[status === 'success' ? 'success' : 'error'](
        `${authLabels[status]}${status === 'success' ? '，已下发 MQTT 地址' : ''}`,
      )
    }, 650)
  }

  function saveTarget() {
    if (!targetEditor.name.trim() || !validUrl(targetEditor.url)) {
      toast.error('请填写名称及有效的 HTTP(S) 完整鉴权 URL，不含凭据、查询参数或片段')
      return
    }
    const existing = state.cabinet.manualTargets.find((target) => target.id === targetEditor.id)
    const value = {
      ...targetEditor,
      id: targetEditor.id || uid('target'),
      name: targetEditor.name.trim(),
      url: targetEditor.url.trim(),
    }
    update((draft) => {
      if (existing)
        Object.assign(
          draft.cabinet.manualTargets.find((target) => target.id === existing.id),
          value,
        )
      else draft.cabinet.manualTargets.push(value)
    })
    log(existing ? '修改机柜鉴权目标' : '新增机柜鉴权目标', value.name)
    setTargetEditor(null)
    toast.success('鉴权目标已保存')
  }

  function toggleTarget(target, enabled) {
    update((draft) => {
      if (target.automatic) draft.cabinet.targetOverrides[target.id] = { enabled }
      else draft.cabinet.manualTargets.find((item) => item.id === target.id).enabled = enabled
    })
    log(enabled ? '启用机柜鉴权目标' : '停用机柜鉴权目标', target.name)
    toast.success(enabled ? '目标已启用' : '目标已停用，下次鉴权将返回 503')
  }

  function deleteTarget() {
    update((draft) => {
      draft.cabinet.manualTargets = draft.cabinet.manualTargets.filter(
        (target) => target.id !== targetRemoval.id,
      )
      for (const device of draft.cabinet.devices)
        if (device.targetId === targetRemoval.id) {
          device.targetId = null
          device.revision += 1
        }
    })
    log('删除机柜鉴权目标', targetRemoval.name)
    setTargetRemoval(null)
    toast.success('目标已删除，关联机柜已转为未分配')
  }

  function openQr(device) {
    const target = targetById[device.targetId]
    if (!cabinetQrAvailable(device, target)) {
      toast.error('需在当前目标成功鉴权后才能生成二维码')
      return
    }
    try {
      const url = `${new URL(target.url).origin}/device/cabinet.html?sno=${encodeURIComponent(device.imei)}`
      setQr({
        imei: device.imei,
        name: target.name,
        url,
        png: cabinetQrPng(url, device.imei, target.name),
      })
    } catch (error) {
      toast.error(error.message)
    }
  }

  async function uploadPhoto(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !photoDeviceId) return
    setPhotoBusy(true)
    const deviceId = photoDeviceId
    try {
      const photo = await compressPhoto(file)
      update((draft) => {
        const device = draft.cabinet.devices.find((item) => item.id === deviceId)
        if (device) device.photo = photo
      })
      log('更新机柜照片', devices.find((device) => device.id === deviceId)?.imei || deviceId)
      toast.success('照片已保存，已校正方向并移除 EXIF 信息')
    } catch (error) {
      toast.error(error.message || '照片无法读取')
    }
    setPhotoBusy(false)
    setPhotoDeviceId(null)
  }

  function deleteRegistration() {
    if (deleteImei !== removeDevice.imei) return
    update((draft) => {
      draft.cabinet.devices = draft.cabinet.devices.filter(
        (device) => device.id !== removeDevice.id,
      )
    })
    log('删除机柜注册', removeDevice.imei)
    setSelected((current) => current.filter((id) => id !== removeDevice.id))
    setDetailId(null)
    setRemoveDevice(null)
    setDeleteImei('')
    toast.success('本地注册、分配和照片已删除；设备再次请求时将重新注册')
  }

  function saveSettings() {
    if (user.role !== 'admin') return
    if (
      !settings.host.trim() ||
      !settings.database.trim() ||
      !settings.username.trim() ||
      !/^\d+$/.test(String(settings.port)) ||
      Number(settings.port) < 1 ||
      Number(settings.port) > 65535 ||
      !settings.matchIp.trim() ||
      !/^[\da-fA-F:.]+$/.test(settings.matchIp)
    ) {
      toast.error('请填写完整 MySQL 配置、有效端口与匹配 IP')
      return
    }
    update((draft) => {
      draft.cabinet.settings = { ...settings, status: 'untested' }
    })
    log('保存机柜重置配置', settings.database)
    toast.success('全局 MySQL 配置已保存，下一次操作立即使用')
  }

  const targetOptions = [
    { value: 'unassigned', label: '取消分配' },
    ...targets
      .filter((target) => target.enabled)
      .map((target) => ({ value: target.id, label: target.name })),
  ]
  const photoButton = (device) => (
    <Button
      variant="outline"
      size="sm"
      disabled={photoBusy}
      onClick={() => {
        setPhotoDeviceId(device.id)
        photoInput.current?.click()
      }}
    >
      <ImagePlus className="size-4" />
      {device.photo ? '替换照片' : '上传照片'}
    </Button>
  )

  return (
    <div className="wb-page" data-testid="cabinet-page">
      <PageHeader title="全局机柜">
        <Button
          variant="outline"
          onClick={() => {
            setRefreshAt(Date.now())
            toast.success('机柜列表已刷新')
          }}
        >
          <RefreshCw className="size-4" />
          刷新
        </Button>
        <DemoScenarios>
          <Button variant="outline" onClick={() => setRegistration({ imei: '', label: '' })}>
            <Plus className="size-4" />
            模拟设备接入
          </Button>
        </DemoScenarios>
      </PageHeader>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList
          variant="line"
          className="max-w-full overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
        >
          <TabsTrigger value="devices">机柜池</TabsTrigger>
          <TabsTrigger value="targets">鉴权目标</TabsTrigger>
          <TabsTrigger value="settings">重置配置</TabsTrigger>
          <TabsTrigger value="audit">操作审计</TabsTrigger>
        </TabsList>
        <TabsContent value="devices" className="wb-stack">
          <div className="wb-row">
            <div className="relative min-w-48 flex-1">
              <Search className="absolute top-3 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label="搜索机柜"
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 IMEI、机柜名称或目标"
              />
            </div>
            <Picker
              label="机柜分配筛选"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: '全部机柜' },
                { value: 'unassigned', label: '未分配' },
                { value: 'assigned', label: '已分配' },
              ]}
            />
            <span className="wb-muted text-xs">
              {filtered.length} 台 · 每 30 秒刷新 ·{' '}
              {new Date(refreshAt).toLocaleTimeString('zh-CN')}
            </span>
          </div>
          <div className="wb-row">
            <Button
              variant="outline"
              size="sm"
              aria-pressed={allVisibleSelected}
              onClick={togglePage}
              disabled={!visible.length}
            >
              {allVisibleSelected ? '取消选择本页' : '选择本页'}
            </Button>
            <span className="text-sm">已选 {selectedDevices.length} 台</span>
            <Picker
              label="批量分配目标"
              value={allocation}
              onChange={setAllocation}
              options={targetOptions}
            />
            <Button disabled={!selectedDevices.length} onClick={() => setAssignOpen(true)}>
              分配 / 迁移
            </Button>
            {selectedDevices.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                清空选择
              </Button>
            )}
          </div>
          <Panel title="设备列表">
            {!filtered.length ? (
              <Empty>没有符合条件的机柜。新设备首次请求后会自动进入未分配池。</Empty>
            ) : (
              <Table className="wb-cabinet-devices">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">选择</TableHead>
                    <TableHead>机柜</TableHead>
                    <TableHead>当前目标</TableHead>
                    <TableHead>最近鉴权</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((device) => (
                    <TableRow key={device.id}>
                      <TableCell>
                        <label className="inline-flex size-10 cursor-pointer items-center justify-center">
                          <Checkbox
                            aria-label={`选择机柜 ${device.imei}`}
                            checked={selected.includes(device.id)}
                            onCheckedChange={() => selectOne(device.id)}
                          />
                        </label>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="link"
                          className="h-auto p-0 font-medium"
                          onClick={() => setDetailId(device.id)}
                        >
                          {device.label} ↗
                        </Button>
                        <div className="wb-row gap-1 text-xs text-muted-foreground">
                          <span>{device.imei}</span>
                          <CopyButton value={device.imei} label="复制机柜 IMEI" />
                        </div>
                      </TableCell>
                      <TableCell>
                        {targetById[device.targetId]?.name || (
                          <Badge variant="outline">未分配</Badge>
                        )}
                        {targetById[device.targetId]?.enabled === false && (
                          <Badge variant="secondary" className="ml-1">
                            已停用
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <span
                          className={
                            device.lastAuth?.status === 'success'
                              ? 'text-emerald-700'
                              : 'text-amber-700'
                          }
                        >
                          {authLabels[device.lastAuth?.status] || '尚未鉴权'}
                        </span>
                        <div className="wb-muted text-xs">{time(device.lastAuth?.at)}</div>
                        {device.lastAuth?.status === 'success' && (
                          <div className="wb-muted text-xs">MQTT 在线状态未知</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="wb-table-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDetailId(device.id)}
                          >
                            详情
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`机柜二维码 ${device.imei}`}
                            onClick={() => openQr(device)}
                            disabled={!cabinetQrAvailable(device, targetById[device.targetId])}
                          >
                            <QrCode className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="wb-row justify-end pt-3">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="上一页机柜"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-sm">
                {Math.min(page, pages)} / {pages}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="下一页机柜"
                disabled={page >= pages}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </Panel>
        </TabsContent>
        <TabsContent value="targets">
          <Panel
            title="鉴权目标"
            actions={
              <Button onClick={() => setTargetEditor({ name: '', url: '', enabled: true })}>
                <Plus className="size-4" />
                新增手动目标
              </Button>
            }
          >
            {!targets.length ? (
              <Empty>暂无鉴权目标。在项目环境填写鉴权地址，或新增手动目标。</Empty>
            ) : (
              <Table className="wb-cabinet-targets">
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>鉴权地址</TableHead>
                    <TableHead>启用</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {targets.map((target) => (
                    <TableRow key={target.id}>
                      <TableCell>
                        <span className="font-medium">{target.name}</span>
                        <div className="wb-muted text-xs">
                          {target.automatic ? '项目环境自动同步' : '手动目标'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-lg items-start gap-1">
                          <code className="break-all text-xs">{target.url}</code>
                          <CopyButton value={target.url} label="复制鉴权地址" />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Switch
                          aria-label={`启用目标 ${target.name}`}
                          checked={target.enabled}
                          onCheckedChange={(enabled) => toggleTarget(target, enabled)}
                        />
                      </TableCell>
                      <TableCell>
                        {target.automatic ? (
                          <span className="wb-muted text-xs">名称、地址由项目环境管理</span>
                        ) : (
                          <div className="wb-table-actions">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setTargetEditor({ ...target })}
                            >
                              编辑
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`删除目标 ${target.name}`}
                              onClick={() => setTargetRemoval(target)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </TabsContent>
        <TabsContent value="settings">
          <Panel
            title="全局 MySQL 重置配置"
            actions={user.role !== 'admin' && <Badge variant="outline">仅管理员可修改</Badge>}
          >
            <div className="wb-stack">
              <Field label="允许重置 / 解绑">
                <Switch
                  aria-label="允许机柜重置"
                  checked={settings.enabled}
                  disabled={user.role !== 'admin'}
                  onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
                />
              </Field>
              <div className="wb-form-grid">
                <Field label="MySQL 主机">
                  <Input
                    aria-label="机柜 MySQL 主机"
                    value={settings.host}
                    disabled={user.role !== 'admin'}
                    onChange={(event) => setSettings({ ...settings, host: event.target.value })}
                  />
                </Field>
                <Field label="端口">
                  <Input
                    aria-label="机柜 MySQL 端口"
                    value={settings.port}
                    disabled={user.role !== 'admin'}
                    onChange={(event) => setSettings({ ...settings, port: event.target.value })}
                  />
                </Field>
                <Field label="数据库">
                  <Input
                    aria-label="机柜数据库"
                    value={settings.database}
                    disabled={user.role !== 'admin'}
                    onChange={(event) => setSettings({ ...settings, database: event.target.value })}
                  />
                </Field>
                <Field label="用户名">
                  <Input
                    aria-label="机柜数据库用户名"
                    value={settings.username}
                    disabled={user.role !== 'admin'}
                    onChange={(event) => setSettings({ ...settings, username: event.target.value })}
                  />
                </Field>
                <Field label="密码">
                  <Input
                    aria-label="机柜数据库密码"
                    type="password"
                    value={user.role === 'admin' ? settings.password : '••••••••'}
                    disabled={user.role !== 'admin'}
                    autoComplete="off"
                    onChange={(event) => setSettings({ ...settings, password: event.target.value })}
                  />
                </Field>
                <Field
                  label="鉴权目标匹配 IP"
                  hint="目标所有 DNS 解析结果都须匹配；此处 192.0.2.10 为虚构演示地址。"
                >
                  <Input
                    aria-label="鉴权匹配 IP"
                    value={settings.matchIp}
                    disabled={user.role !== 'admin'}
                    onChange={(event) => setSettings({ ...settings, matchIp: event.target.value })}
                  />
                </Field>
                <Field label="TLS">
                  <Switch
                    aria-label="机柜 MySQL TLS"
                    checked={settings.tls}
                    disabled={user.role !== 'admin'}
                    onCheckedChange={(tls) => setSettings({ ...settings, tls })}
                  />
                </Field>
              </div>
              {user.role === 'admin' && (
                <div className="wb-row">
                  <Button onClick={saveSettings}>保存重置配置</Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const success = !settings.host.includes('unreachable') && settings.host.trim()
                      update((draft) => {
                        draft.cabinet.settings.status = success ? 'connected' : 'failed'
                      })
                      log(
                        '测试机柜 MySQL 连接',
                        settings.database,
                        success ? '模拟连接成功' : '连接失败',
                      )
                      toast[success ? 'success' : 'error'](
                        success ? '模拟连接成功' : '模拟连接失败，可修正地址后重试',
                      )
                    }}
                  >
                    测试连接
                  </Button>
                  <span className="wb-muted">
                    {state.cabinet.settings.status === 'connected'
                      ? '模拟连接成功'
                      : state.cabinet.settings.status === 'failed'
                        ? '连接失败'
                        : '尚未测试'}
                  </span>
                </div>
              )}
            </div>
          </Panel>
        </TabsContent>
        <TabsContent value="audit">
          <Panel
            title="全局机柜审计"
            actions={
              user.role === 'admin' && (
                <Button
                  variant="outline"
                  onClick={() => setCleanAudit(true)}
                  disabled={!globalAudit.length}
                >
                  清理审计
                </Button>
              )
            }
          >
            <div className="wb-stack">
              <Input
                aria-label="搜索机柜审计"
                value={auditQuery}
                onChange={(event) => setAuditQuery(event.target.value)}
                placeholder="搜索操作、机柜或结果"
              />
              {!globalAudit.length ? (
                <Empty>暂无机柜操作审计</Empty>
              ) : (
                <Table className="wb-cabinet-audit">
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间 / 操作人</TableHead>
                      <TableHead>操作</TableHead>
                      <TableHead>对象</TableHead>
                      <TableHead>结果</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {globalAudit.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="whitespace-nowrap">
                          {time(entry.createdAt || entry.at)}
                          <div className="wb-muted text-xs">
                            {state.users.find((person) => person.id === entry.actorId)?.name ||
                              entry.actor ||
                              '系统'}
                          </div>
                        </TableCell>
                        <TableCell>{entry.action}</TableCell>
                        <TableCell className="max-w-md break-all whitespace-normal">
                          {entry.object}
                        </TableCell>
                        <TableCell>{entry.result}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </Panel>
        </TabsContent>
      </Tabs>
      <Input
        type="file"
        accept="image/jpeg,image/png"
        aria-label="上传机柜照片文件"
        ref={photoInput}
        style={{ display: 'none' }}
        tabIndex={-1}
        onChange={uploadPhoto}
      />
      <Confirm
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        onConfirm={saveAllocation}
        title="确认分配 / 迁移"
        confirmLabel="保存分配"
      >
        <div className="wb-stack">
          <Field label="选择鉴权目标">
            <Picker
              label="确认分配目标"
              value={allocation}
              onChange={setAllocation}
              options={targetOptions}
            />
          </Field>
          <p>
            将 {selectedDevices.length} 台机柜分配到{' '}
            <strong>{targetById[allocation]?.name || '未分配'}</strong>。
          </p>
          <p>分配在设备下一次鉴权时生效。当前已建立的 MQTT 连接不会被主动断开。</p>
          <div className="wb-code">{selectedDevices.map((device) => device.imei).join('\n')}</div>
        </div>
      </Confirm>
      <Modal
        open={Boolean(registration)}
        onClose={() => setRegistration(null)}
        title="模拟设备首次请求 / 重连"
        footer={<Button onClick={register}>发送模拟请求</Button>}
      >
        <div className="wb-stack">
          <Field label="IMEI">
            <Input
              aria-label="接入机柜 IMEI"
              placeholder="15 位 IMEI"
              value={registration?.imei || ''}
              onChange={(event) => setRegistration({ ...registration, imei: event.target.value })}
            />
          </Field>
          <Field label="机柜名称（可选）">
            <Input
              aria-label="接入机柜名称"
              value={registration?.label || ''}
              onChange={(event) => setRegistration({ ...registration, label: event.target.value })}
            />
          </Field>
          <p className="wb-muted">
            首次请求自动创建未分配注册；已注册 IMEI
            按当前分配鉴权。已删除设备再次请求会重新进入未分配池。
          </p>
        </div>
      </Modal>
      <Modal
        open={Boolean(targetEditor)}
        onClose={() => setTargetEditor(null)}
        title={targetEditor?.id ? '编辑手动鉴权目标' : '新增手动鉴权目标'}
        footer={<Button onClick={saveTarget}>保存目标</Button>}
      >
        <div className="wb-stack">
          <Field label="目标名称">
            <Input
              aria-label="手动目标名称"
              value={targetEditor?.name || ''}
              onChange={(event) => setTargetEditor({ ...targetEditor, name: event.target.value })}
            />
          </Field>
          <Field
            label="完整鉴权 URL"
            hint="HTTP 或 HTTPS，可含端口；手动目标直接使用填写的完整路径。"
          >
            <Input
              aria-label="手动目标 URL"
              value={targetEditor?.url || ''}
              onChange={(event) => setTargetEditor({ ...targetEditor, url: event.target.value })}
              placeholder="https://cabinet.example.invalid/communication/ybt/api/iot/client/con"
            />
          </Field>
          <Field label="启用">
            <Switch
              aria-label="启用手动目标"
              checked={targetEditor?.enabled ?? true}
              onCheckedChange={(enabled) => setTargetEditor({ ...targetEditor, enabled })}
            />
          </Field>
        </div>
      </Modal>
      <Confirm
        open={Boolean(targetRemoval)}
        onClose={() => setTargetRemoval(null)}
        onConfirm={deleteTarget}
        title="删除手动鉴权目标"
        danger
      >
        <p>
          删除「{targetRemoval?.name}」后，其{' '}
          {devices.filter((device) => device.targetId === targetRemoval?.id).length}{' '}
          台机柜转为未分配。机柜注册、照片和审计仍然保留。
        </p>
      </Confirm>
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetailId(null)}
        title={detail ? `${detail.label} · ${detail.imei}` : '机柜详情'}
      >
        <div className="wb-stack">
          {detail && (
            <>
              <dl className="wb-form-grid">
                <Field label="当前分配">{targetById[detail.targetId]?.name || '未分配'}</Field>
                <Field label="注册时间">{time(detail.registeredAt)}</Field>
                <Field label="最近鉴权">
                  {authLabels[detail.lastAuth?.status]} · {time(detail.lastAuth?.at)}
                </Field>
                <Field label="MQTT 连接状态">未知（鉴权成功不代表在线）</Field>
                <Field label="最近请求 ID">
                  <code className="break-all text-xs">{detail.lastAuth?.requestId || '暂无'}</code>
                </Field>
                <Field label="最近下发 MQTT 地址">
                  <code className="break-all text-xs">
                    {detail.lastAuth?.mqttEndpoint || '尚未下发'}
                  </code>
                </Field>
              </dl>
              <Field label="最近鉴权目标">
                <code className="break-all text-xs">{detail.lastAuth?.targetUrl || '无'}</code>
              </Field>
              {detail.targetId &&
                (detail.lastAuth?.targetUrl !== targetById[detail.targetId]?.url ||
                  detail.lastAuth?.targetId !== detail.targetId) && (
                  <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    分配或目标地址已改变，等待设备下一次鉴权。二维码暂不可用。
                  </p>
                )}
              <div className="wb-row">
                <DemoScenarios label="鉴权演示">
                  <Picker
                    label="鉴权模拟结果"
                    value={authScenario}
                    onChange={setAuthScenario}
                    options={[
                      { value: 'success', label: '正常响应' },
                      { value: 'failed', label: '目标超时 / 鉴权失败' },
                    ]}
                  />
                  <Button
                    variant="outline"
                    disabled={Boolean(authBusy)}
                    onClick={() => authenticate(detail.id)}
                  >
                    {authBusy === detail.id ? '正在鉴权…' : '模拟下次鉴权'}
                  </Button>
                </DemoScenarios>
                <Button
                  variant="outline"
                  onClick={() => openQr(detail)}
                  disabled={!cabinetQrAvailable(detail, targetById[detail.targetId])}
                >
                  <QrCode className="size-4" />
                  二维码
                </Button>
              </div>
              <div className="wb-row">
                {detail.photo && (
                  <Button
                    variant="ghost"
                    className="h-auto p-0"
                    onClick={() => setPhotoPreview(detail.photo)}
                    aria-label="预览机柜照片"
                  >
                    <img
                      src={detail.photo.dataUrl}
                      alt={`${detail.label}照片`}
                      className="h-24 w-24 rounded-xl object-cover"
                    />
                  </Button>
                )}
                {photoButton(detail)}
                <span className="wb-muted text-xs">JPG / PNG，最大 20 MiB</span>
              </div>
              <div className="wb-row border-t pt-4">
                <Button
                  variant="outline"
                  disabled={!state.cabinet.settings.enabled}
                  onClick={() => setResetDeviceId(detail.id)}
                >
                  <ServerCog className="size-4" />
                  重置平台 / 解绑
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setSelected([detail.id])
                    setAllocation(detail.targetId || 'unassigned')
                    setDetailId(null)
                    setAssignOpen(true)
                  }}
                >
                  修改分配
                </Button>
                <Button
                  variant="outline"
                  className="text-destructive"
                  onClick={() => {
                    setDeleteImei('')
                    setRemoveDevice(detail)
                  }}
                >
                  <Trash2 className="size-4" />
                  删除注册
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
      <Modal
        open={Boolean(qr)}
        onClose={() => setQr(null)}
        title="机柜二维码"
        footer={
          <Button onClick={() => saveDataUrl(`机柜-${qr.imei}.png`, qr.png)}>
            <Download className="size-4" />
            下载 PNG
          </Button>
        }
      >
        {qr && (
          <div className="wb-stack items-center">
            <img
              src={qr.png}
              alt={`${qr.imei} 可扫码二维码`}
              className="max-h-[55dvh] max-w-full"
            />
            <code className="break-all text-xs">{qr.url}</code>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(photoPreview)}
        onClose={() => setPhotoPreview(null)}
        title="机柜照片"
        footer={
          <Button
            variant="outline"
            onClick={() => saveDataUrl(`机柜照片-${photoPreview.name}`, photoPreview.dataUrl)}
          >
            <Download className="size-4" />
            下载照片
          </Button>
        }
      >
        {photoPreview && (
          <img
            src={photoPreview.dataUrl}
            alt="机柜照片预览"
            className="max-h-[65dvh] w-full rounded-xl object-contain"
          />
        )}
      </Modal>
      <Modal
        open={Boolean(removeDevice)}
        onClose={() => setRemoveDevice(null)}
        title="删除机柜本地注册"
        footer={
          <Button
            variant="destructive"
            disabled={deleteImei !== removeDevice?.imei}
            onClick={deleteRegistration}
          >
            确认删除注册
          </Button>
        }
      >
        <div className="wb-stack">
          <p>
            会删除本地注册、目标分配和照片。业务 MySQL 与审计不变，现有 MQTT
            不会断开。设备再次请求时会以未分配状态重新注册。
          </p>
          <Field label={`输入完整 IMEI：${removeDevice?.imei || ''}`}>
            <Input
              aria-label="确认删除机柜 IMEI"
              value={deleteImei}
              autoComplete="off"
              onChange={(event) => setDeleteImei(event.target.value)}
            />
          </Field>
        </div>
      </Modal>
      <Confirm
        open={cleanAudit}
        onClose={() => setCleanAudit(false)}
        title="清理全局机柜审计"
        danger
        onConfirm={() => {
          if (user.role !== 'admin') return
          const ids = globalAudit.map((entry) => entry.id)
          update((draft) => {
            draft.audit = draft.audit.filter((entry) => !ids.includes(entry.id))
          })
          setCleanAudit(false)
          toast.success(`已清理 ${ids.length} 条审计记录`)
        }}
      >
        <p>
          将永久清理当前筛选出的 {globalAudit.length}{' '}
          条机柜审计，不影响其他平台审计。此操作仅管理员可用。
        </p>
      </Confirm>
      {resetDeviceId && (
        <ResetCabinet deviceId={resetDeviceId} onClose={() => setResetDeviceId(null)} />
      )}
    </div>
  )
}

function ResetCabinet({ deviceId, onClose }) {
  const { state, update, audit } = useWorkbench()
  const [scenario, setScenario] = useState('success')
  const [dnsMode, setDnsMode] = useState('match')
  const [preview, setPreview] = useState(null)
  const [imei, setImei] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [checked, setChecked] = useState(false)
  const device = state.cabinet.devices.find((item) => item.id === deviceId)
  const settings = state.cabinet.settings
  const targets = deriveCabinetTargets(state)
  const target = targets.find((item) => item.id === device?.targetId)
  const snapshot = cabinetResetSnapshot(state, deviceId)
  const resolved =
    dnsMode === 'match'
      ? ['192.0.2.10']
      : dnsMode === 'mixed'
        ? ['192.0.2.10', '192.0.2.11']
        : ['192.0.2.20']
  const matches = resolved.every((ip) => ip === settings.matchIp)
  const stale = preview && snapshot !== preview.snapshot
  const expired = preview && preview.expiresAt <= now
  const log = (action, outcome) =>
    audit({ projectId: null, action, object: device?.imei || deviceId, result: outcome })
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  function readPreview() {
    setError('')
    setResult(null)
    setImei('')
    setChecked(false)
    if (!settings.enabled) {
      setError('全局重置功能已停用')
      return
    }
    if (!device || !target || !target.enabled) {
      setError('请先为机柜分配已启用的鉴权目标')
      return
    }
    if (!matches) {
      setError('目标 DNS 解析结果未全部匹配允许 IP，不能预览或执行重置')
      log('机柜重置预览', '拒绝：DNS 未全部匹配')
      return
    }
    const failures = {
      conflict: '仓位存在多个平台，拒绝重置。请先人工核对业务库。',
      duplicate: '业务库存在重复 IMEI，无法确定唯一机柜。',
      notfound: '业务库找不到此 IMEI 对应机柜。',
      'db-error': '模拟数据库连接失败；未写入任何数据。可检查配置后手动重试预览。',
    }
    if (failures[scenario]) {
      setError(failures[scenario])
      setPreview(null)
      log('机柜重置预览', failures[scenario])
      return
    }
    const current =
      scenario === 'noop'
        ? {
            ...device.platform,
            platformId: 2,
            agentId: null,
            merchantId: null,
            branchId: null,
            bindTime: null,
            positions: device.platform.positions.map((position) => ({
              ...position,
              platformId: 2,
            })),
          }
        : { ...device.platform, positions: scenario === 'zero' ? [] : device.platform.positions }
    setPreview({
      token: uid('preview'),
      expiresAt: Date.now() + 300000,
      snapshot,
      current,
      consumed: false,
    })
    log('机柜重置预览', '只读预览成功，5 分钟内单次有效')
  }

  function execute() {
    if (busy) return
    const validation = validateCabinetReset(state, deviceId, preview, imei, { resolved })
    if (validation) {
      setError(validation)
      return
    }
    setPreview({ ...preview, consumed: true })
    setBusy(true)
    setError('')
    setTimeout(() => {
      let outcome
      update((draft) => {
        outcome = applyCabinetReset(draft, deviceId, preview, imei, {
          resolved,
          unknown: scenario === 'unknown',
        })
      })
      setResult(outcome)
      log('机柜重置 / 解绑', outcome.text)
      setBusy(false)
    }, 750)
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose()
      }}
      title={`重置平台 / 解绑 · ${device?.imei || '已删除设备'}`}
      footer={
        <div className="wb-row">
          <Button
            variant="outline"
            onClick={readPreview}
            disabled={busy || (result?.status === 'unknown' && !checked)}
          >
            {preview ? '重新预览' : '只读预览'}
          </Button>
          <Button
            disabled={
              !preview ||
              preview.consumed ||
              Boolean(stale) ||
              Boolean(expired) ||
              imei !== device?.imei ||
              busy ||
              !matches
            }
            onClick={execute}
          >
            {busy ? '事务处理中…' : '确认重置 / 解绑'}
          </Button>
        </div>
      }
    >
      <div className="wb-stack">
        <div className="wb-row justify-end">
          <DemoScenarios label="重置演示场景">
            <Field label="演示情境">
              <Picker
                label="重置演示情境"
                value={scenario}
                onChange={(value) => {
                  setScenario(value)
                  setPreview(null)
                  setError('')
                  setResult(null)
                }}
                options={resetScenarios}
              />
            </Field>
            <Field label="DNS 解析情境">
              <Picker
                label="重置 DNS 情境"
                value={dnsMode}
                onChange={(value) => {
                  setDnsMode(value)
                  setPreview(null)
                  setError('')
                  setResult(null)
                }}
                options={[
                  { value: 'match', label: '全部 IP 匹配' },
                  { value: 'mixed', label: '多个 IP 部分匹配' },
                  { value: 'mismatch', label: 'IP 不匹配' },
                ]}
              />
            </Field>
          </DemoScenarios>
        </div>
        <dl className="wb-form-grid">
          <Field label="目标">{target?.name || '未分配'}</Field>
          <Field label="数据库">
            {settings.host} / {settings.database}
          </Field>
          <Field label="模拟 DNS 解析">{resolved.join('、')}</Field>
          <Field label="允许的 IP">
            {settings.matchIp} · {matches ? '全部匹配' : '不匹配'}
          </Field>
        </dl>
        <p className="rounded-lg border bg-muted/30 p-3 text-sm">
          每次仅处理当前一台机柜。将 bz_cabinet.platform_id 设为 2，清空
          agent_id、merchant_id、branch_id、bind_time；按机柜 IMEI 匹配
          bz_cabinet_position.cabinet_no，将仓位 platform_id 设为
          2。不改订单、网点、充电宝或当前路由目标。
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          >
            {error}
          </p>
        )}
        {preview && (
          <div className="wb-stack rounded-xl border p-4">
            <div className="wb-row justify-between">
              <strong>只读预览</strong>
              <Badge variant="outline">
                {preview.consumed
                  ? '凭证已使用'
                  : expired
                    ? '凭证已过期'
                    : `${Math.max(0, Math.ceil((preview.expiresAt - now) / 1000))} 秒内单次有效`}
              </Badge>
            </div>
            <Table className="wb-cabinet-reset">
              <TableHeader>
                <TableRow>
                  <TableHead>字段</TableHead>
                  <TableHead>当前值</TableHead>
                  <TableHead>变更后</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[
                  ['platform_id', preview.current.platformId, 2],
                  ['agent_id', preview.current.agentId, 'NULL'],
                  ['merchant_id', preview.current.merchantId, 'NULL'],
                  ['branch_id', preview.current.branchId, 'NULL'],
                  ['bind_time', preview.current.bindTime, 'NULL'],
                  [
                    '匹配仓位数',
                    preview.current.positions.length,
                    `${preview.current.positions.length} 个 → 平台 2`,
                  ],
                ].map(([name, before, after]) => (
                  <TableRow key={name}>
                    <TableCell>{name}</TableCell>
                    <TableCell>{before ?? 'NULL'}</TableCell>
                    <TableCell>{after}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Field label={`输入完整 IMEI：${device?.imei}`}>
              <Input
                aria-label="确认重置机柜 IMEI"
                value={imei}
                autoComplete="off"
                disabled={preview.consumed || busy}
                onChange={(event) => setImei(event.target.value)}
              />
            </Field>
            {stale && !result && (
              <p role="alert" className="text-sm text-red-700">
                绑定、分配或配置已变化，此预览不可执行。
              </p>
            )}
            {expired && !result && (
              <p role="alert" className="text-sm text-red-700">
                预览已过期，需要重新预览。
              </p>
            )}
            {!preview.consumed && (
              <div className="wb-row">
                <DemoScenarios label="过期与冲突演示">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPreview({ ...preview, expiresAt: Date.now() - 1000 })
                      setNow(Date.now())
                    }}
                  >
                    模拟凭证过期
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      update((draft) => {
                        const item = draft.cabinet.devices.find((entry) => entry.id === deviceId)
                        item.platform.branchId = 4002
                        item.revision += 1
                      })
                    }
                  >
                    模拟绑定发生变化
                  </Button>
                </DemoScenarios>
              </div>
            )}
          </div>
        )}
        {result && (
          <div
            className={`rounded-xl border p-4 text-sm ${result.status === 'unknown' ? 'border-amber-300 bg-amber-50 text-amber-900' : result.status === 'failed' ? 'border-red-300 bg-red-50 text-red-900' : 'border-emerald-300 bg-emerald-50 text-emerald-900'}`}
            role="status"
          >
            <p>{result.text}</p>
            {result.status === 'unknown' && (
              <div className="mt-3">
                <Button
                  variant="outline"
                  disabled={checked}
                  onClick={() => {
                    setChecked(true)
                    log('机柜重置结果只读核查', '演示查询：绑定仍为操作前状态')
                    toast.success('模拟只读核查完成：绑定仍为操作前状态，可手动重新预览')
                  }}
                >
                  {checked ? '已核查：绑定仍为操作前状态' : '模拟只读核查'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
