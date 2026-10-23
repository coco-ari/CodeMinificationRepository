import { describe, expect, it } from 'vite-plus/test'
import type { DeploymentRelease, DeploymentTask } from '../deployments'
import { deriveDeploymentRuntimeStatus } from './deploymentRuntimeStatus'

const time = (minute: number) => `2026-10-23T10:${String(minute).padStart(2, '0')}:00.000Z`
const release = (id = 'release-one', minute = 0): DeploymentRelease => ({
  id,
  targetId: 'target-one',
  createdAt: time(minute),
})
const target = (currentRelease: DeploymentRelease | null = release()) => ({
  id: 'target-one',
  currentRelease,
})
const task = (
  id: string,
  minute: number,
  values: Partial<DeploymentTask> = {},
): DeploymentTask => ({
  id,
  targetId: 'target-one',
  status: 'failed',
  stage: 'verifying',
  createdAt: time(minute),
  updatedAt: time(minute),
  ...values,
})
const failedRecovery = (id = 'failed-recovery', minute = 2) =>
  task(id, minute, {
    result: { rollback: { status: 'failed', error: '隔离测试恢复失败' } },
  })

describe('部署上次确认版本与待核对状态', () => {
  it('没有成功版本时保留未发布状态', () => {
    expect(deriveDeploymentRuntimeStatus(target(null), []).state).toBe('unpublished')
  })

  it('保留成功记录但不将有限历史表示为实时健康探测', () => {
    const current = release()
    expect(deriveDeploymentRuntimeStatus(target(current), [])).toEqual({
      state: 'confirmed',
      message: '已有历史成功收据，显示上次确认版本。',
      confirmedRelease: current,
    })
  })

  it('恢复失败不把上次成功版本当作新的运行结果', () => {
    expect(deriveDeploymentRuntimeStatus(target(), [failedRecovery()])).toMatchObject({
      state: 'uncertain',
      attentionTaskId: 'failed-recovery',
      confirmedRelease: { id: 'release-one' },
    })
  })

  it('新的成功版本覆盖之前恢复失败，输入列表顺序不影响结果', () => {
    const current = release('release-new', 5)
    const confirmed = task('release-new', 5, { status: 'succeeded', result: { release: current } })
    for (const tasks of [
      [failedRecovery(), confirmed],
      [confirmed, failedRecovery()],
    ])
      expect(deriveDeploymentRuntimeStatus(target(current), tasks).state).toBe('confirmed')
  })

  it('恢复成功收据可重新确认原来的旧版本', () => {
    const current = release()
    const restored = task('recovery-later', 5, {
      status: 'rolled_back',
      result: { rollback: { status: 'succeeded', release: current } },
    })
    expect(deriveDeploymentRuntimeStatus(target(current), [failedRecovery(), restored]).state).toBe(
      'confirmed',
    )
  })

  it('不以其他目标的成功或失败影响当前目标', () => {
    const foreign = { ...failedRecovery(), targetId: 'other-target' }
    expect(deriveDeploymentRuntimeStatus(target(), [foreign]).state).toBe('confirmed')
    const foreignSuccess = task('other-success', 5, {
      targetId: 'other-target',
      status: 'succeeded',
      result: { release: release() },
    })
    expect(deriveDeploymentRuntimeStatus(target(), [failedRecovery(), foreignSuccess]).state).toBe(
      'uncertain',
    )
  })

  it.each(['building', 'download', 'queued', 'preparing'])(
    '构建或领取前 %s 失败不表示站点异常',
    (stage) => {
      for (const status of ['failed', 'interrupted'])
        expect(
          deriveDeploymentRuntimeStatus(target(), [task('early-failure', 2, { status, stage })])
            .state,
        ).toBe('confirmed')
    },
  )

  it.each(['deploying', 'verifying', 'rolling_back'])('%s 阶段中断保留未知运行提示', (stage) => {
    expect(
      deriveDeploymentRuntimeStatus(target(), [
        task('interrupted', 2, { status: 'interrupted', stage }),
      ]),
    ).toMatchObject({ state: 'uncertain', attentionTaskId: 'interrupted' })
  })

  it('终态阶段为 interrupted 时继续检查已经进入的切换阶段', () => {
    expect(
      deriveDeploymentRuntimeStatus(target(), [
        task('interrupted', 2, {
          status: 'interrupted',
          stage: 'interrupted',
          stageHistory: [{ stage: 'deploying' }],
        }),
      ]).state,
    ).toBe('uncertain')
  })

  it('首次发布清理失败仍须核对现场', () => {
    expect(
      deriveDeploymentRuntimeStatus(target(null), [
        task('cleanup-failed', 2, {
          result: { rollback: { status: 'unavailable' }, cleanupError: '隔离测试清理失败' },
        }),
      ]),
    ).toMatchObject({ state: 'uncertain', attentionTaskId: 'cleanup-failed' })
  })

  it('活动任务显示待确认并保留上次确认版本', () => {
    expect(
      deriveDeploymentRuntimeStatus(target(), [
        task('active', 2, { status: 'running', stage: 'building' }),
      ]),
    ).toMatchObject({
      state: 'updating',
      activeTaskId: 'active',
      confirmedRelease: { id: 'release-one' },
    })
  })

  it('新活动任务和后续构建前失败都不能抹除原有未闭环风险', () => {
    expect(
      deriveDeploymentRuntimeStatus(target(), [
        task('active', 5, { status: 'queued', stage: 'queued' }),
        task('later-build-failure', 4, { stage: 'building' }),
        failedRecovery(),
      ]),
    ).toMatchObject({
      state: 'uncertain',
      attentionTaskId: 'failed-recovery',
      activeTaskId: 'active',
    })
  })

  it('时间并列或缺失时不推断旧风险已经被成功收据消除', () => {
    const current = release('release-new', 5)
    expect(
      deriveDeploymentRuntimeStatus(target(current), [failedRecovery('same-time', 5)]).state,
    ).toBe('uncertain')
    const missingTime = { ...failedRecovery(), createdAt: 'invalid', updatedAt: 'invalid' }
    expect(deriveDeploymentRuntimeStatus(target(current), [missingTime]).state).toBe('uncertain')
  })
})
