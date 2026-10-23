import { readdir } from 'node:fs/promises'
import { cruise } from 'dependency-cruiser'
import config from '../.dependency-cruiser.cjs'

async function sources(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`
    if (entry.isDirectory()) files.push(...(await sources(file)))
    else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) files.push(file)
  }
  return files
}

const files = [...(await sources('autoops/contracts')), ...(await sources('autoops/server'))]
if (!files.length) throw new Error('模块边界检查没有找到源文件')
const report = await cruise(files, {
  ...config.options,
  ruleSet: config,
  validate: true,
  outputType: 'json',
})
const result = typeof report.output === 'string' ? JSON.parse(report.output) : report.output
const scanned = new Set(result.modules.map((module) => module.source.replaceAll('\\', '/')))
const missing = files.filter((file) => !scanned.has(file))
if (missing.length) throw new Error(`模块边界检查漏扫文件：${missing.join('、')}`)
for (const violation of result.summary.violations) {
  console.error(`${violation.rule.name}: ${violation.from} → ${violation.to}`)
}
if (result.summary.error > 0) process.exitCode = 1
else
  console.log(
    `模块边界通过：完整扫描 ${files.length} 个源文件，${result.summary.totalCruised} 个模块`,
  )
