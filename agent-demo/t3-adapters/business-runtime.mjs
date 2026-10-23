import { configuredAutoOpsAccess, stopConfiguredAutoOpsAccess, closeConfiguredAutoOpsAccess } from './access.mjs'
import { stopConfiguredWorkspaceStore, closeConfiguredWorkspaceStore } from './workspaces.mjs'
import { stopConfiguredDeploymentStore, closeConfiguredDeploymentStore } from './deployments.mjs'
import { closeConfiguredPreferences } from './preferences.mjs'
import { closeConfiguredSettingsPreferences } from './settings-preferences.mjs'
import { closeConfiguredBusinessArtifactStore } from './business-tools.mjs'

// 宿主只协调已有模块，不拥有另一份任务状态，也不初始化尚未使用的可选存储。
export function createBusinessRuntime({ workspaceDrainTimeoutMs } = {}) {
  const configuredBudget = process.env.AUTOOPS_SHUTDOWN_DRAIN_MS
  const budget = workspaceDrainTimeoutMs ?? (configuredBudget === undefined ? 30_000 : Number(configuredBudget))
  if (!Number.isInteger(budget) || budget < (workspaceDrainTimeoutMs === undefined ? 1000 : 1) || budget > 120_000)
    throw Object.assign(new Error('工作区关闭排空预算无效'), {status:500, code:'AUTOOPS_SHUTDOWN_BUDGET_INVALID'})
  let stopped = false, draining, closing
  const stopAccepting = () => {
    if (stopped) return
    stopped = true
    stopConfiguredAutoOpsAccess()
    stopConfiguredWorkspaceStore()
    stopConfiguredDeploymentStore()
  }
  const drain = () => {
    stopAccepting()
    return draining ||= (async () => {
      let timer, workspaceFinished = false, deploymentFinished = false
      const workspace = closeConfiguredWorkspaceStore().finally(() => { workspaceFinished = true })
      const deployment = closeConfiguredDeploymentStore().finally(() => { deploymentFinished = true })
      // 预算只触发本地任务协作取消；部署结果仍需落盘，不能因此关闭正在使用的数据库。
      timer = setTimeout(() => {
        if (!workspaceFinished) void closeConfiguredWorkspaceStore({force:true}).catch(() => {})
        console.warn(JSON.stringify({event:'autoops.shutdown.drain_budget_exceeded', workspacePending:!workspaceFinished, deploymentPending:!deploymentFinished, code:'AUTOOPS_SHUTDOWN_PENDING'}))
      }, budget)
      const results = await Promise.allSettled([workspace, deployment]).finally(() => clearTimeout(timer))
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, '业务任务关闭失败')
    })()
  }
  return {
    initialize() { return configuredAutoOpsAccess() },
    stopAccepting,
    drain,
    close() {
      stopAccepting()
      return closing ||= (async () => {
        const errors = []
        try { await drain() } catch (error) { errors.push(error) }
        // T3 消费者先由 Effect 释放；身份数据库最后关闭，供任务授权及设备断线落盘。
        for (const close of [closeConfiguredPreferences, closeConfiguredSettingsPreferences, closeConfiguredBusinessArtifactStore, closeConfiguredAutoOpsAccess]) {
          try { close() } catch (error) { errors.push(error) }
        }
        if (errors.length) throw new AggregateError(errors, '业务资源关闭失败')
      })()
    },
  }
}
