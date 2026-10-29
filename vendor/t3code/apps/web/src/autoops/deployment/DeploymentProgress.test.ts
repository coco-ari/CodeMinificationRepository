import { describe, expect, it } from 'vite-plus/test'
import { deploymentProgress, normalizeDeploymentStage } from './DeploymentProgress'
import type { DeploymentTask } from '../deployments'

describe('真实发布阶段', () => {
  const task: DeploymentTask = {
    id: 'task',
    targetId: 'target',
    status: 'running',
    stage: 'build',
    createdAt: '2026-10-30T00:00:00Z',
    stageHistory: [
      { stage: 'download', finishedAt: '2026-10-30T00:00:01Z' },
      { stage: 'build', startedAt: '2026-10-30T00:00:01Z' },
    ],
  }
  it('阶段别名与日志过滤一致，缺失事件不显示完成', () => {
    const stages = deploymentProgress(task)
    expect(normalizeDeploymentStage('download')).toBe('downloading')
    expect(stages.find((row) => row.id === 'downloading')).toMatchObject({
      finished: true,
      active: false,
    })
    expect(stages.find((row) => row.id === 'building')).toMatchObject({
      finished: false,
      active: true,
    })
    expect(stages.find((row) => row.id === 'deploying')).toMatchObject({
      finished: false,
      active: false,
    })
  })
  it('失败只标记实际停止阶段，未知阶段不推测成功', () => {
    const stages = deploymentProgress({ ...task, status: 'failed', stage: 'failed' })
    expect(stages.find((row) => row.id === 'building')).toMatchObject({
      failed: true,
      finished: false,
    })
    expect(stages.find((row) => row.id === 'verifying')).toMatchObject({
      failed: false,
      finished: false,
    })
  })
})
