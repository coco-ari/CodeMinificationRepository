import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('模块边界真实识别类型导入、深层导入、旧宿主与反向依赖', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autoops-boundaries-'))
  const script = fileURLToPath(
    new URL('../../scripts/check-autoops-boundaries.mjs', import.meta.url),
  )
  const write = async (file, code) => {
    const target = path.join(directory, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, code)
  }
  const run = () =>
    spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', timeout: 30_000 })
  try {
    await write('autoops/contracts/index.ts', 'export type Id = string')
    await write('autoops/server/modules/identity/domain.ts', 'export type Label = string')
    await write(
      'autoops/server/modules/identity/index.ts',
      "export type { Label } from './domain.ts'",
    )
    await write(
      'autoops/server/modules/projects/service.ts',
      "import type { Label } from '../identity/index.ts'; export type Name = Label",
    )
    const valid = run()
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /完整扫描 4 个源文件/)

    await write('src/legacy.ts', 'export type Legacy = string')
    await write(
      'autoops/server/modules/projects/service.ts',
      "import type { Label } from '../identity/domain.ts'; import type { Legacy } from '../../../../src/legacy.ts'; export type Name = Label | Legacy",
    )
    await write(
      'autoops/contracts/index.ts',
      "import type { Name } from '../server/modules/projects/service.ts'; export type Id = Name",
    )
    await write(
      'autoops/server/platform/ports.ts',
      "import type { Name } from '../modules/projects/service.ts'; export type Port = Name",
    )
    await write(
      'autoops/server/modules/identity/domain.ts',
      "import type { Name } from '../projects/service.ts'; export type Label = Name",
    )
    const invalid = run()
    assert.equal(invalid.status, 1, invalid.stderr)
    for (const rule of [
      'identity只通过公开入口被调用',
      '新产品不依赖历史宿主',
      '公共合同不依赖服务端',
      '基础设施不反向依赖业务',
      '领域规则保持纯粹',
      '禁止循环依赖',
    ])
      assert.ok(invalid.stderr.includes(rule), invalid.stderr)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
