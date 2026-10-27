// @effect-diagnostics nodeBuiltinImport:off -- 本测试只创建并收束自有正式协议夹具进程和临时附件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { createHeadlessCodexRunner } from '../../vendor/t3code/apps/server/src/provider/HeadlessCodexRunner.ts'
import { writeFakeCli } from '../../vendor/t3code/packages/provider-testing/src/fakeCli.ts'
import { CustomerAttachmentCache } from './attachments.ts'
import * as Effect from 'effect/Effect'

for (const mode of ['self', 'shared', 'foreign-session', 'changed-metadata'] as const)
  test(`共享图片沿正式Headless协议：${mode}`, { timeout: 15000 }, async () => {
    const mapped = mode !== 'self'
    const directory = await mkdtemp(join(tmpdir(), 'autoops-shared-image-')),
      log = join(directory, 'requests.ndjson'),
      bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
      digest = createHash('sha256').update(bytes).digest('hex')
    const attachment = {
        type: 'image' as const,
        id: 'thread-image-owned-image',
        name: 'owned.png',
        mimeType: 'image/png',
        sizeBytes: bytes.length,
      },
      cache = new CustomerAttachmentCache(join(directory, 'attachments'), async function* () {
        yield bytes
      })
    await cache.prepare(
      {
        type: 'command',
        commandId: 'command-original',
        sessionId: 'session-image',
        target: {
          registeredWorkspaceId: 'workspace-image',
          workspaceBindingRevision: 1,
          runtimeId: 'codex',
        },
        method: 'startTurn',
        input: { message: { attachments: [attachment] } },
        attachments: [{ id: attachment.id, sizeBytes: bytes.length, sha256: digest }],
      },
      new AbortController().signal,
      () => {},
    )
    const hostPath = cache.resolve('session-image', attachment)
    assert(hostPath)
    const containerPath = '/autoops/attachments/' + basename(hostPath)
    const rows = (
      await readFile(
        new URL(
          '../../vendor/t3code/apps/server/src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson',
          import.meta.url,
        ),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const responses = Object.fromEntries(
      rows
        .filter(
          (row) => row.type === 'emit_inbound' && row.frame?.id !== undefined && row.frame.result,
        )
        .map((row) => [row.label, row.frame.result]),
    )
    const started = rows.find(
      (row) => row.type === 'emit_inbound' && row.frame?.method === 'turn/started',
    ).frame
    const binaryPath = writeFakeCli({
      directory,
      name: 'codex-image-protocol',
      source: `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';const responses=${JSON.stringify(responses)},started=${JSON.stringify(started)};const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},line+'\\n');if(m.id===undefined)return;let result=m.method==='model/list'?{data:[{id:'grok-4.6',model:'grok-4.6',displayName:'Grok 4.6',description:'isolated fixture',hidden:false,isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium'}]}],nextCursor:null}:m.method==='skills/list'?{data:[{cwd:${JSON.stringify(directory)},errors:[],skills:[]}]}:responses[m.method];if(result===undefined)return send({id:m.id,error:{code:-32601,message:'Unsupported fixture method'}});send({id:m.id,result});if(m.method==='turn/start')setImmediate(()=>send(started));});`,
    })
    const model = {
        instanceId: 'customer-image-fixture-codex',
        model: 'grok-4.6',
        options: [{ id: 'reasoningEffort', value: 'medium' }],
      },
      policy = {
        cwd: directory,
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'readOnly' },
      }
    const runner = await createHeadlessCodexRunner({
      instanceId: model.instanceId,
      cwd: directory,
      binaryPath,
      onEvent: () => {},
      externalSandbox: true,
      agentScope: {
        wrap: (value) => Effect.succeed(value),
        oomKilled: () => Effect.succeed(false),
        clear: () => Effect.void,
      },
      resolveAttachmentPath: () => (mapped ? containerPath : hostPath),
      ...(mapped
        ? {
            resolveAttachmentReadPath: (value) =>
              cache.resolve(
                mode === 'foreign-session' ? 'foreign-session' : 'session-image',
                mode === 'changed-metadata' ? { ...value, sizeBytes: value.sizeBytes + 1 } : value,
              ),
          }
        : {}),
    })
    try {
      await runner.dispatch('openSession', {
        threadId: 'thread-image',
        providerSessionId: 'session-image',
        modelSelection: model,
        runtimePolicy: policy,
      })
      const providerThread = await runner.dispatch('ensureThread', {
          threadId: 'thread-image',
          modelSelection: model,
          runtimePolicy: policy,
        }),
        now = '2026-10-27T00:00:00.000Z'
      assert(
        providerThread &&
          typeof providerThread === 'object' &&
          'id' in providerThread &&
          typeof providerThread.id === 'string',
      )
      const turn = {
        appThread: {
          createdBy: 'user',
          creationSource: 'web',
          id: 'thread-image',
          projectId: 'project-image',
          title: 'Image',
          providerInstanceId: model.instanceId,
          modelSelection: model,
          runtimeMode: 'approval-required',
          interactionMode: 'default',
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: 'thread-image',
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId: 'thread-image',
        runId: 'run-image',
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: 'attempt-image',
        rootNodeId: 'node-image',
        providerThread,
        message: {
          createdBy: 'user',
          creationSource: 'web',
          messageId: 'message-image',
          text: '仅识别本次真实PNG',
          attachments: [attachment],
        },
        modelSelection: model,
        runtimePolicy: policy,
      }
      if (mode === 'foreign-session' || mode === 'changed-metadata') {
        await assert.rejects(() => runner.dispatch('startTurn', turn))
        const sent = (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((value) => value.method === 'turn/start')
        assert.equal(sent.length, 0, '读取拒绝不能回退到可呈现路径或发起模型')
        return
      }
      await runner.dispatch('startTurn', turn)
      const requests = (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
        sent = requests.filter((value) => value.method === 'turn/start')
      assert.equal(sent.length, 1)
      const input = sent[0].params.input.find(
        (value: { type?: string; url?: string }) => value.type === 'image',
      )
      assert(
        input && input.url === 'data:image/png;base64,' + bytes.toString('base64'),
        '必须真正发送原PNG原生图片输入，不能退化为文件路径提示词',
      )
    } finally {
      await runner.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
