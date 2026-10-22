import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCodexBridge, buildRunnerConfig, RUNNER_CONFIG } from '../agent-demo/codex-bridge.mjs'

// 只运行自建假 CLI，模拟协议故障；不会启动真实 Codex、读取真实密钥或访问提供方。
const directory = await mkdtemp(path.join(tmpdir(), 'autoops-cpa-test-'))
const key = randomBytes(32).toString('hex')
const keyFile = path.join(directory, 'synthetic-key')
const inspectFile = path.join(directory, 'child-inspection.json')
const callsFile = path.join(directory, 'calls.jsonl')
const binary = path.join(directory, 'fake-codex.mjs')
const output = path.resolve('.test-artifacts/agent-demo-api/codex-cpa-provider.json')
const token = randomBytes(32).toString('hex')
const evidence = {
  testedAt: new Date().toISOString(),
  passed: false,
  realModelCalls: 0,
  realCodexProcesses: 0,
  credentialSource: '临时随机测试数据，不是凭据',
  checks: [],
}
const check = (label, condition) => {
  assert(condition, label)
  evidence.checks.push(label)
}
let bridge
let childHome
const configuration = {
  provider: 'cpa',
  providerBaseUrl: 'https://x.996788.xyz/v1',
  model: 'grok-4.6',
}
const secretAbsent = (value) => !JSON.stringify(value).includes(key)
try {
  await writeFile(keyFile, key + '\n', { mode: 0o600 })
  await writeFile(
    binary,
    `#!${process.execPath}
import { writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('fake-codex protocol-only'); process.exit(0); }
const secret = process.env.CPA_API_KEY;
writeFileSync(${JSON.stringify(inspectFile)}, JSON.stringify({args:process.argv.slice(2), envKeys:Object.keys(process.env), keyPresent:!!secret, keyInArgv:process.argv.some(x=>x.includes(secret)), home:process.env.HOME, codexHome:process.env.CODEX_HOME, cwd:process.cwd(), homeFiles:readdirSync(process.env.HOME), codexFiles:readdirSync(process.env.CODEX_HOME), cwdFiles:readdirSync(process.cwd())}));
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let count=0;
createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line); appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({method:m.method,params:m.params})+'\\n');
 if(!m.id)return;
 if(m.method==='initialize')return send({id:m.id,result:{}});
 if(m.method==='account/read')return send({id:m.id,error:{message:'must not read account'}});
 if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'thread_'+(++count)},model:m.params.model,modelProvider:m.params.modelProvider,activePermissionProfile:{id:'agent_demo'},approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}}});
 if(m.method==='turn/start'){
   const threadId=m.params.threadId, turnId='turn_'+threadId;
   send({id:m.id,result:{turn:{id:turnId}}});
   process.stderr.write('provider diagnostic '+secret+'\\n');
   const prompt=m.params.input[0].text;
   if(prompt.endsWith('hold'))return;
   setTimeout(()=>send(prompt.endsWith('notification-error')?{method:'error',params:{threadId,turnId,willRetry:false,error:{message:secret}}}:{method:'turn/completed',params:{threadId,turn:{id:turnId,status:prompt.endsWith('success')?'completed':'failed',error:{message:secret}}}}),10);return;
 }
 if(m.method==='turn/steer')return send({id:m.id,error:{code:401,message:secret,data:{body:secret}}});
 if(m.method==='turn/interrupt'){
  send({id:m.id,result:{}});
  return send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:m.params.turnId,status:'interrupted'}}});
 }
 send({id:m.id,result:{}});
});
`,
    { mode: 0o700 },
  )
  const runnerConfig = buildRunnerConfig(configuration)
  check(
    'CPA 配置保留全部原始权限保护',
    Object.entries(RUNNER_CONFIG).every(
      ([k, v]) => JSON.stringify(runnerConfig[k]) === JSON.stringify(v),
    ),
  )
  check(
    'Responses / env_key / 无 OpenAI 鉴权配置',
    runnerConfig['model_providers.cpa'].wire_api === 'responses' &&
      runnerConfig['model_providers.cpa'].env_key === 'CPA_API_KEY' &&
      runnerConfig['model_providers.cpa'].requires_openai_auth === false,
  )
  for (const providerBaseUrl of [
    'http://example.com/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?token=invalid',
  ])
    assert.throws(() => buildRunnerConfig({ ...configuration, providerBaseUrl }))
  evidence.checks.push('拒绝 HTTP、URL 内凭据和查询参数')
  bridge = await createCodexBridge({
    ...configuration,
    enabled: true,
    token,
    binary,
    providerKeyFile: keyFile,
  })
  const { port } = await bridge.listen(0),
    base = `http://127.0.0.1:${port}`
  const request = async (route, body) => {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    })
    return { status: response.status, body: await response.json() }
  }
  const before = (await request('/health')).body
  check(
    '初始化仅为 configured，不声称模型已验证',
    before.liveAvailable &&
      before.readiness === 'configured' &&
      before.modelVerified === false &&
      before.provider === 'cpa' &&
      before.name === 'Codex App Server',
  )
  const inspection = JSON.parse(await readFile(inspectFile, 'utf8'))
  childHome = inspection.home
  evidence.childEnvironmentKeys = inspection.envKeys
  check(
    '只向子进程环境注入合成密钥，argv 无密钥',
    inspection.keyPresent && !inspection.keyInArgv && secretAbsent(inspection.args),
  )
  // macOS CoreFoundation 可在进程启动时补充字符编码标记；它不是继承的凭据。
  check(
    '子进程不继承其他 API key 或个人环境',
    inspection.envKeys.every((k) =>
      [
        'PATH',
        'HOME',
        'CODEX_HOME',
        'TMPDIR',
        'LANG',
        'CPA_API_KEY',
        ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []),
      ].includes(k),
    ),
  )
  check(
    '独立空 HOME / CODEX_HOME / cwd',
    inspection.home !== process.env.HOME &&
      inspection.codexHome !== process.env.CODEX_HOME &&
      inspection.home !== inspection.codexHome &&
      [inspection.homeFiles, inspection.codexFiles, inspection.cwdFiles].every(
        (a) => a.length === 0,
      ),
  )
  const run = async (runId, prompt) => {
    assert.equal(
      (
        await request('/runs', {
          runId,
          prompt,
          context: { project: { id: 'p' }, environment: { id: 'e' } },
          history: [],
          attachments: [],
        })
      ).status,
      202,
    )
    const response = await fetch(`${base}/runs/${runId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    const events = (await response.text())
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
    check(`${prompt} SSE 不透传原始提供方错误`, secretAbsent(events))
    return events
  }
  for (const prompt of ['completed-error', 'notification-error']) {
    const events = await run(prompt, prompt)
    check(
      `${prompt} 映射明确失败终态`,
      events.at(-1)?.type === 'failed' && events.at(-1).payload.code === 'MODEL_FAILED',
    )
  }
  check('失败不标记模型已验证', (await request('/health')).body.modelVerified === false)
  assert.equal(
    (
      await request('/runs', {
        runId: 'hold',
        prompt: 'hold',
        context: { project: { id: 'p' }, environment: { id: 'e' } },
      })
    ).status,
    202,
  )
  let records = []
  for (let i = 0; i < 100; i++) {
    records = (await readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse)
    if (records.filter((r) => r.method === 'turn/start').length === 3) break
    await new Promise((r) => setTimeout(r, 10))
  }
  const steering = await request('/runs/hold/steer', {
    requestId: 'steer-error',
    text: '调整',
    expectedRunnerTurnId: 'turn_thread_3',
  })
  check(
    'RPC provider 错误仅返回静态安全分类',
    steering.status === 502 && steering.body.code === 'RUNNER_ERROR' && secretAbsent(steering),
  )
  await request('/runs/hold/stop', { requestId: 'stop', expectedRunnerTurnId: 'turn_thread_3' })
  const successful = await run('success', 'success')
  check(
    '只有 completed 才标记模型已验证（此处为注入模拟）',
    successful.at(-1)?.type === 'completed' &&
      (await request('/health')).body.readiness === 'verified',
  )
  records = (await readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse)
  check('CPA 完整过程从未调用 account/read', !records.some((r) => r.method === 'account/read'))
  check(
    'thread/start 固定 CPA 模型并禁止自动切换',
    records
      .filter((r) => r.method === 'thread/start')
      .every(
        (r) =>
          r.params.modelProvider === 'cpa' &&
          r.params.model === 'grok-4.6' &&
          r.params.allowProviderModelFallback === false &&
          r.params.dynamicTools.length === 6,
      ),
  )
  check(
    '引导继续使用真实协议 turn/steer 与 expectedTurnId',
    records.some((r) => r.method === 'turn/steer' && r.params.expectedTurnId === 'turn_thread_3'),
  )
  evidence.childEnvironmentKeys = inspection.envKeys
  evidence.methodNames = [...new Set(records.map((r) => r.method))]
  await bridge.close()
  bridge = null
  let cleaned = false
  try {
    await access(childHome)
  } catch {
    cleaned = true
  }
  check('停止桥接后删除自有临时运行目录', cleaned)
  const invalidFiles = [
    ['missing', path.join(directory, 'missing')],
    ['public', path.join(directory, 'public')],
    ['symlink', path.join(directory, 'symlink')],
  ]
  await writeFile(invalidFiles[1][1], key, { mode: 0o644 })
  await chmod(invalidFiles[1][1], 0o644)
  await symlink(keyFile, invalidFiles[2][1])
  for (const [label, providerKeyFile] of invalidFiles) {
    bridge = await createCodexBridge({
      ...configuration,
      enabled: true,
      token,
      binary,
      providerKeyFile,
    })
    const address = await bridge.listen(0)
    const result = await (
      await fetch(`http://127.0.0.1:${address.port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()
    check(`拒绝 ${label} 密钥文件且错误无密钥`, !result.liveAvailable && secretAbsent(result))
    await bridge.close()
    bridge = null
  }
  evidence.passed = true
} catch (error) {
  evidence.error = {
    name: error.name,
    message: String(error.message).replaceAll(key, '<synthetic-redacted>'),
  }
  process.exitCode = 1
} finally {
  await bridge?.close()
  await rm(directory, { recursive: true, force: true })
  evidence.bridgeSha256 = createHash('sha256')
    .update(await readFile(new URL('../agent-demo/codex-bridge.mjs', import.meta.url)))
    .digest('hex')
  evidence.testSha256 = createHash('sha256')
    .update(await readFile(new URL(import.meta.url)))
    .digest('hex')
  evidence.limit = '假 CLI 验证配置、环境和错误转译；不能证明真实模型、真实密钥或运行时隔离有效。'
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(evidence, null, 2))
  console.log(
    JSON.stringify({
      passed: evidence.passed,
      checks: evidence.checks.length,
      report: output,
      error: evidence.error,
    }),
  )
}
