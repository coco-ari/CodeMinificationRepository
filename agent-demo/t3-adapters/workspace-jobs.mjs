import { WorkspaceError } from './workspace-files.mjs'

// 仅负责本工作区存储的任务容量与生命周期，业务状态仍由工作区服务持久化。
export function createWorkspaceJobs({ maxConcurrent = 2, maxQueued = 8, onFailure = (event) => console.error(JSON.stringify(event)) } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4 || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 32)
    throw new RangeError('工作区任务并发数或排队容量无效')
  const jobs = new Map(), queue = [], idle = new Set()
  let running = 0, closed = false
  const notifyIdle = () => { if (!jobs.size) { for (const done of idle) done(); idle.clear() } }
  const report = (taskId) => {
    // 状态存储本身损坏时仍收敛异常；不把路径、源码或原始异常写入诊断。
    try { onFailure({ event: 'workspace.task.persistence_failed', taskId, code: 'WORKSPACE_TASK_STATE_UNAVAILABLE' }) } catch {}
  }
  function drain() {
    while (running < maxConcurrent && queue.length) {
      const job = queue.shift()
      running++
      void Promise.resolve().then(() => job.run(job.controller.signal)).catch(() => report(job.id)).finally(() => {
        running--; jobs.delete(job.id); drain(); notifyIdle()
      })
    }
  }
  function assertCapacity() {
    if (closed) throw new WorkspaceError(503, 'WORKSPACE_STOPPING', '工作区服务正在停止，请稍后重试')
    if (jobs.size >= maxConcurrent + maxQueued) throw new WorkspaceError(429, 'WORKSPACE_TASK_CAPACITY', '工作区任务已达到容量上限，请等待当前任务完成后重试')
  }
  const whenIdle = () => jobs.size ? new Promise((done) => idle.add(done)) : Promise.resolve()
  return {
    assertCapacity,
    assertAccepting() { if (closed) throw new WorkspaceError(503, 'WORKSPACE_STOPPING', '工作区服务正在停止，请稍后重试') },
    stopAccepting() { closed = true },
    submit(id, run) {
      assertCapacity()
      const job = { id, run, controller: new AbortController() }
      jobs.set(id, job); queue.push(job); drain()
    },
    cancel(id) {
      const job = jobs.get(id)
      if (!job) return false
      job.controller.abort()
      const queued = queue.indexOf(job)
      if (queued >= 0) { queue.splice(queued, 1); jobs.delete(id); notifyIdle() }
      return true
    },
    whenIdle,
    async close({ force = false } = {}) { closed = true; if (force) for (const job of jobs.values()) job.controller.abort(); await whenIdle() },
  }
}
