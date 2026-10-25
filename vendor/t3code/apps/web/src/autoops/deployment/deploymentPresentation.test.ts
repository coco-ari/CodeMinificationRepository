import { describe, expect, it } from 'vite-plus/test'
import type { DeploymentTarget } from '../deployments'
import { deploymentObservationLabel } from './deploymentPresentation'

type ObservationTarget = Pick<DeploymentTarget, 'id' | 'observation' | 'observationStale'>
const target = (change: Partial<ObservationTarget> = {}): ObservationTarget => ({
  id: 'target-one',
  observationStale: false,
  observation: {
    targetId: 'target-one',
    exists: true,
    status: 'running',
    health: 'healthy',
    managed: true,
  },
  ...change,
})

describe('运行观测表达', () => {
  it('过期的健康观测不显示为当前健康', () => {
    expect(deploymentObservationLabel(target({ observationStale: true }))).toBe(
      '观测已过期，当前状态未知',
    )
  })
  it('缺少观测或返回其他目标时保持未知', () => {
    expect(deploymentObservationLabel({ id: 'target-one', observationStale: true })).toBe(
      '尚无运行观测',
    )
    expect(
      deploymentObservationLabel(
        target({
          observation: { targetId: 'other', exists: true, status: 'running', health: 'healthy' },
        }),
      ),
    ).toBe('尚无运行观测')
  })
  it('新鲜观测区分运行、健康失败、无检查和归属异常', () => {
    expect(deploymentObservationLabel(target())).toBe('运行中 · 健康检查通过')
    expect(
      deploymentObservationLabel(
        target({
          observation: {
            targetId: 'target-one',
            exists: true,
            status: 'running',
            health: 'unhealthy',
          },
        }),
      ),
    ).toBe('运行中 · 健康检查失败')
    expect(
      deploymentObservationLabel(
        target({
          observation: { targetId: 'target-one', exists: true, status: 'running', health: 'none' },
        }),
      ),
    ).toBe('运行中 · 未配置健康检查')
    expect(
      deploymentObservationLabel(
        target({
          observation: {
            targetId: 'target-one',
            exists: true,
            status: 'running',
            health: 'healthy',
            managed: false,
          },
        }),
      ),
    ).toBe('运行实例归属不匹配')
  })
})
