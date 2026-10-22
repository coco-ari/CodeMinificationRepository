import { resolve } from 'node:path'
import { createLegacySnapshot, verifyLegacySnapshot } from '../agent-demo/migrations/legacy-snapshot.mjs'

const [command, ...args] = process.argv.slice(2)
const usage = '用法：node scripts/t3-migrate-data.mjs snapshot <旧库路径> <新恢复包目录> [--native-dir <原生状态目录>] [--quiesced] | verify <恢复包目录>'
try {
  let manifest
  if (command === 'snapshot' && args.length >= 2) {
    const [sourceDb, destination, ...options] = args
    const nativeDirectories = []
    let quiesced = false
    for (let i = 0; i < options.length; i++) {
      if (options[i] === '--quiesced') quiesced = true
      else if (options[i] === '--native-dir' && options[i + 1]) nativeDirectories.push(options[++i])
      else throw new Error(usage)
    }
    manifest = await createLegacySnapshot({ sourceDb, destination, nativeDirectories, quiesced })
    await verifyLegacySnapshot(destination)
    console.log(JSON.stringify({ snapshot: resolve(destination), eventWatermark: manifest.eventWatermark, counts: manifest.tables, cutoverEligible: manifest.cutoverEligible }))
  } else if (command === 'verify' && args.length === 1) {
    manifest = await verifyLegacySnapshot(args[0])
    console.log(JSON.stringify({ verified: true, eventWatermark: manifest.eventWatermark, counts: manifest.tables, cutoverEligible: manifest.cutoverEligible }))
  } else throw new Error(usage)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
