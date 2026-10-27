// @effect-diagnostics nodeBuiltinImport:off -- 仅使用临时 SQLite、附件与受控 Docker 命令夹具，不访问真实 Docker。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CustomerAgentExecutor, type RunnerFactory } from './executor.ts'
import { CustomerAgentStore } from './store.ts'
import { loadSharedDockerProfile, sharedRuntimeDirectory } from './shared-docker-profile.ts'
import type { SharedExecutionScope } from '../../autoops/contracts/shared-execution.ts'
import type { CustomerAgentCommand } from '../../vendor/t3code/packages/contracts/src/autoopsRemote.ts'
import type { HeadlessCodexRunnerOptions } from '../../vendor/t3code/apps/server/src/provider/HeadlessCodexRunner.ts'

const bytes = Buffer.from('仅供路径隔离回归的图片字节')
const digest = createHash('sha256').update(bytes).digest('hex')
const image = (id: string) => ({
  type: 'image' as const,
  id,
  name: `${id}.png`,
  mimeType: 'image/png',
  sizeBytes: bytes.length,
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'customer-image-path-')))
  const source = join(root, 'source')
  await mkdir(source)
  const store = new CustomerAgentStore(join(root, 'state'))
  const workspace = store.register(source, 'source-project', '图片路径隔离夹具')
  const observed: HeadlessCodexRunnerOptions[] = []
  const factory: RunnerFactory = async (options) => {
    observed.push(options)
    return {
      processGeneration: `fixture-epoch-${observed.length}`,
      catalog: async () => ({ models: [], skills: [] }),
      close: async () => {},
      dispatch: async (method, input: any) => {
        if (method === 'startTurn') {
          const id = `fixture-turn-${input.attemptId}`
          await options.onEvent({
            type: 'provider_turn.updated',
            providerTurn: { id, runAttemptId: input.attemptId },
          })
          await options.onEvent({ type: 'turn.terminal', providerTurnId: id })
        }
        return null
      },
    }
  }
  const executor = new CustomerAgentExecutor({
    store,
    deviceId: 'fixture-device',
    runnerFactory: factory,
    notify: () => {},
    authorizeShared: async () => {},
    downloadAttachment: async function* () {
      yield bytes
    },
  })
  const command = (
    sessionId: string,
    method: 'openSession' | 'startTurn',
    scope?: SharedExecutionScope,
  ): CustomerAgentCommand => ({
    type: 'command',
    commandId: `${sessionId}-${method}`,
    sessionId,
    target: workspace,
    method,
    input:
      method === 'openSession'
        ? {}
        : {
            runId: `run-${sessionId}`,
            attemptId: `attempt-${sessionId}`,
            message: { attachments: [image(sessionId)] },
          },
    ...(method === 'startTurn'
      ? { attachments: [{ id: sessionId, sizeBytes: bytes.length, sha256: digest }] }
      : {}),
    ...(scope ? { executionScope: scope } : {}),
  })
  return {
    root,
    store,
    workspace,
    executor,
    observed,
    command,
    close: async () => {
      await executor.close()
      store.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('共享执行器分别提供容器路径与宿主缓存路径；跨会话、ID及元数据均不能借用', async () => {
  const f = await fixture(),
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const fakeDocker = join(f.root, 'fixture-docker'),
    dockerLog = join(f.root, 'docker-calls.jsonl')
  const imageDigest = `sha256:${'a'.repeat(64)}`,
    profilePath = join(f.root, 'profile.json')
  // 沿正式 dockerBinary 端口，只回应启动前的两个只读检查；任何真实运行命令均失败。
  await writeFile(
    fakeDocker,
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(dockerLog)},JSON.stringify(args)+'\\n');if(args[0]==='info')console.log('linux');else if(args[0]==='image'&&args[1]==='inspect')console.log(JSON.stringify([{Id:${JSON.stringify(imageDigest)}}]));else process.exitCode=97;\n`,
    { mode: 0o700 },
  )
  await writeFile(
    profilePath,
    JSON.stringify({
      version: 1,
      id: 'image-path-fixture',
      revision: 1,
      imageDigest,
      skills: [],
      dockerBinary: fakeDocker,
      gateway: {
        url: 'https://fixture.invalid/v1',
        authorizationEnv: 'FIXTURE_IMAGE_PATH_UNUSED_TOKEN',
      },
    }),
    { mode: 0o600 },
  )
  f.store.setSharedProfile(f.workspace.registeredWorkspaceId, profilePath)
  const profile = (await loadSharedDockerProfile(profilePath)).descriptor
  const scope = (sessionId: string): SharedExecutionScope => ({
    grantId: `grant-${sessionId}`,
    actorId: `actor-${sessionId}`,
    providerId: 'provider',
    projectId: 'target-project',
    sourceProjectId: f.workspace.projectId,
    threadId: `thread-${sessionId}`,
    runId: `run-${sessionId}`,
    assistantId: 'assistant',
    presetRevision: 1,
    shareRevision: 1,
    allocation: { kind: 'member', id: `actor-${sessionId}`, revision: 1 },
    capabilityRevision: 'fixture-capability',
    profile,
    target: {
      kind: 'customer',
      deviceId: 'fixture-device',
      registeredWorkspaceId: f.workspace.registeredWorkspaceId,
      workspaceBindingRevision: 1,
      runtimeId: 'codex',
    },
    model: {
      instanceId: 'customer-fixture-device-codex',
      model: 'fixture-model',
      reasoningEffort: null,
    },
    skillIds: [],
  })
  const sessions = new Map<string, HeadlessCodexRunnerOptions>()
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    for (const sessionId of ['first', 'second']) {
      const current = scope(sessionId)
      assert.equal(
        (await f.executor.execute(f.command(sessionId, 'openSession', current))).state,
        'completed',
      )
      const options = f.observed.at(-1)!
      assert.equal(options.externalSandbox, true)
      assert.equal(options.resolveAttachmentReadPath!(image(sessionId)), null, '下载前不能返回路径')
      assert.equal(
        (await f.executor.execute(f.command(sessionId, 'startTurn', current))).state,
        'completed',
      )
      const host = options.resolveAttachmentReadPath!(image(sessionId))
      assert(host)
      assert.equal(
        host,
        join(sharedRuntimeDirectory(f.store.directory, current), 'attachments', `${digest}.png`),
      )
      assert.equal(
        options.resolveAttachmentPath!(image(sessionId)),
        `/autoops/attachments/${basename(host)}`,
      )
      assert.deepEqual(await readFile(host), bytes)
      for (const changed of [
        { ...image(sessionId), id: 'not-delivered' },
        { ...image(sessionId), name: 'changed.png' },
        { ...image(sessionId), mimeType: 'image/jpeg' },
        { ...image(sessionId), sizeBytes: bytes.length + 1 },
        { ...image(sessionId), type: 'file' as const },
      ]) {
        assert.equal(options.resolveAttachmentReadPath!(changed), null)
        assert.equal(options.resolveAttachmentPath!(changed), null)
      }
      sessions.set(sessionId, options)
      assert.equal(f.store.session(sessionId)?.state, 'idle')
    }
    assert.notEqual(
      sessions.get('first')!.resolveAttachmentReadPath!(image('first')),
      sessions.get('second')!.resolveAttachmentReadPath!(image('second')),
      '相同字节也必须保留不同共享会话目录',
    )
    assert.equal(sessions.get('first')!.resolveAttachmentReadPath!(image('second')), null)
    assert.equal(sessions.get('second')!.resolveAttachmentReadPath!(image('first')), null)
    assert.equal(sessions.get('first')!.resolveAttachmentPath!(image('second')), null)
    assert.equal(sessions.get('second')!.resolveAttachmentPath!(image('first')), null)
    const calls = (await readFile(dockerLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2)),
      [
        ['info', '--format'],
        ['image', 'inspect'],
        ['info', '--format'],
        ['image', 'inspect'],
      ],
    )
  } finally {
    try {
      await f.close()
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
})

test('自用执行器的图片呈现与字节读取保留原宿主路径，并拒绝其他会话附件', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.executor.execute(f.command('self', 'openSession'))).state, 'completed')
    const options = f.observed.at(-1)!
    assert.equal((await f.executor.execute(f.command('self', 'startTurn'))).state, 'completed')
    const host = options.resolveAttachmentReadPath!(image('self'))
    assert(host)
    assert.equal(host, join(f.store.directory, 'attachments', `${digest}.png`))
    assert.equal(options.resolveAttachmentPath!(image('self')), host)
    assert.deepEqual(await readFile(host), bytes)
    assert.equal(options.externalSandbox, undefined)
    assert.equal(
      (await f.executor.execute(f.command('other-self', 'openSession'))).state,
      'completed',
    )
    assert.equal(f.observed.at(-1)!.resolveAttachmentReadPath!(image('self')), null)
  } finally {
    await f.close()
  }
})
