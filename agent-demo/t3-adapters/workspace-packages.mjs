import { Worker } from 'node:worker_threads'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceError } from './workspace-files.mjs'

// 复用文档处理的受限 Worker 模式，压缩不会阻塞问答、权限检查与其他项目请求。
export function buildWorkspacePackages(input, signal) {
  return new Promise((resolveResult, reject) => {
    if (signal.aborted) { reject(new WorkspaceError(409, 'WORKSPACE_TASK_CANCELLED', '任务已取消')); return }
    const directory = process.env.AUTOOPS_BUSINESS_RESOURCES_DIR ? resolve(process.env.AUTOOPS_BUSINESS_RESOURCES_DIR) : dirname(fileURLToPath(import.meta.url))
    const worker = new Worker(resolve(directory, 'workspace-package-worker.mjs'), {
      workerData: input, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    })
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancelled)
      // 等到线程完全停止后才交还临时目录，避免取消清理与后台写入竞争。
      void worker.terminate().then(() => error ? reject(error) : resolveResult(result), () => reject(new WorkspaceError(503, 'WORKSPACE_WORKER_STOP_FAILED', '打包线程未正常停止，请稍后重试')))
    }
    const cancelled = () => finish(new WorkspaceError(409, 'WORKSPACE_TASK_CANCELLED', '任务已取消'))
    const timer = setTimeout(() => finish(new WorkspaceError(504, 'WORKSPACE_PACKAGE_TIMEOUT', '源码打包超时，请缩小工作区后重试')), 60_000)
    signal.addEventListener('abort', cancelled, { once: true })
    worker.once('message', (message) => message.error ? finish(new WorkspaceError(message.error.status, message.error.code, message.error.message)) : finish(null, message.value))
    worker.once('error', () => finish(new WorkspaceError(503, 'WORKSPACE_PACKAGE_FAILED', '源码打包线程失败，原有版本仍可使用')))
    worker.once('exit', () => finish(new WorkspaceError(503, 'WORKSPACE_PACKAGE_EXIT', '源码打包未完成，原有版本仍可使用')))
  })
}
