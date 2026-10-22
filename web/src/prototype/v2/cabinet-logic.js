import { deriveCabinetTargets } from './cabinet-seed.js'

export function cabinetResetSnapshot(state, deviceId) {
  const device = state.cabinet.devices.find((item) => item.id === deviceId)
  const target = deriveCabinetTargets(state).find((item) => item.id === device?.targetId)
  return JSON.stringify({
    device: device?.platform,
    revision: device?.revision,
    target: target && { id: target.id, url: target.url, enabled: target.enabled },
    settings: state.cabinet.settings,
  })
}

export function validateCabinetReset(
  state,
  deviceId,
  preview,
  confirmation,
  { now = Date.now(), resolved = [] } = {},
) {
  const device = state.cabinet.devices.find((item) => item.id === deviceId)
  const target = deriveCabinetTargets(state).find((item) => item.id === device?.targetId)
  if (!preview || !preview.token) return '请先获取只读预览'
  if (preview.consumed) return '预览凭证已经使用，请重新预览'
  if (preview.expiresAt <= now) return '预览凭证已过期，请重新预览'
  if (!device) return '机柜注册已删除，请关闭并刷新列表'
  if (confirmation !== device.imei) return '完整 IMEI 不匹配'
  if (!state.cabinet.settings.enabled) return '全局重置功能已停用'
  if (!target?.enabled) return '机柜没有可用鉴权目标'
  if (!resolved.length || resolved.some((ip) => ip !== state.cabinet.settings.matchIp))
    return '目标 DNS 解析结果未全部匹配允许 IP'
  if (cabinetResetSnapshot(state, deviceId) !== preview.snapshot)
    return '绑定、分配或配置已发生变化，请重新预览'
  return null
}

// 在更新 store 的同一事务里再次核对快照，避免预览后或模拟请求途中被其他操作修改。
export function applyCabinetReset(state, deviceId, preview, confirmation, options) {
  const error = validateCabinetReset(state, deviceId, preview, confirmation, options)
  if (error) return { status: 'failed', text: error }
  if (options?.unknown)
    return {
      status: 'unknown',
      text: '结果待核查：模拟事务提交后连接中断，无法确定提交结果。系统不会自动重试；请先进行只读核查。',
    }
  const device = state.cabinet.devices.find((item) => item.id === deviceId)
  const before = preview.current
  const noop =
    before.platformId === 2 &&
    !before.agentId &&
    !before.merchantId &&
    !before.branchId &&
    !before.bindTime &&
    before.positions.every((position) => position.platformId === 2)
  if (noop)
    return { status: 'noop', text: '无需变更：机柜与所有仓位已处于平台 2，绑定信息均为空。' }
  device.platform = {
    ...device.platform,
    platformId: 2,
    agentId: null,
    merchantId: null,
    branchId: null,
    bindTime: null,
    positions: before.positions.map((position) => ({ ...position, platformId: 2 })),
  }
  device.revision += 1
  return {
    status: 'success',
    text: `模拟事务成功：机柜及 ${before.positions.length} 个仓位已重置为平台 2，机柜绑定已清空。路由分配保持不变。`,
  }
}

export function cabinetQrAvailable(device, target) {
  return Boolean(
    target?.enabled &&
    device?.lastAuth?.status === 'success' &&
    device.lastAuth.targetId === target.id &&
    device.lastAuth.targetUrl === target.url,
  )
}
