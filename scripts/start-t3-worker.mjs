import { startT3Worker } from '../agent-demo/t3-adapters/launcher.mjs'
import { synchronizeBusinessModels } from '../agent-demo/t3-adapters/models.mjs'
try {
  await synchronizeBusinessModels()
  const child = startT3Worker()
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
  child.on('error', () => { console.error('T3 对话服务启动失败'); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
