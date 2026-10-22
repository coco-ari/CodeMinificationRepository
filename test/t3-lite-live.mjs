import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { T3LiveClient } from './helpers/t3-live-client.mjs'
import { liteNegativeCases } from './helpers/t3-lite-negative-cases.mjs'

if (process.env.T3_LITE_LIVE !== '1') throw Error('T3_LITE_LIVE=1 required for actual configured-model acceptance')
const origin = new URL(process.env.AGENT_DEMO_URL || 'http://192.168.31.157:18887').origin
assert.notEqual(new URL(origin).port, '8787', 'Use isolated acceptance data')
const output = process.env.T3_LITE_LIVE_OUTPUT || '.test-artifacts/t3-lite/live.json'
const client = new T3LiveClient(origin), other = new T3LiveClient(origin)
const report = { origin, kind: 'real-configured-model-lite', steps: [], startedAt: new Date().toISOString() }
const save = () => writeFile(output, JSON.stringify(report, null, 2))
const terminal = run => ['completed', 'failed', 'interrupted', 'cancelled'].includes(run.status)
const command = (threadId, type, extra = {}) => client.rpc('orchestration.dispatchCommand', { threadId, type, commandId: randomUUID(), ...extra })
const signature = projection => createHash('sha256').update(JSON.stringify({ messages: projection.messages, runs: projection.runs, subagents: projection.subagents, plans: projection.plans, turnItems: projection.turnItems })).digest('hex')
async function finish(threadId, count = 1) {
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    const projection = await client.projection(threadId)
    if (projection.runs.length >= count && projection.runs.every(terminal)) {
      assert(projection.runs.every(run => run.status === 'completed'), JSON.stringify(projection.runs.map(({ status, failure }) => ({ status, failure }))))
      return projection
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw Error('Real native turn did not complete within acceptance timeout')
}
async function step(name, fn) {
  const row = { name }; report.steps.push(row)
  try { row.result = await fn(); row.status = 'passed' }
  catch (error) { row.status = 'failed'; row.error = error.message; row.detail = error.detail; process.exitCode = 1 }
  await save(); console.log(JSON.stringify({ name, status: row.status, error: row.error }))
}
let threadId, previousHistories = []
try {
  await mkdir('.test-artifacts/t3-lite', { recursive: true })
  await client.login(); await client.connect(); await other.login('lin')
  assert.equal(client.bootstrap.productProfile.id, 'project-assistant-lite-v1')
  await step('effective-server-policy-and-old-histories', async () => {
    const settings = await client.rpc('server.getSettings')
    assert.equal(settings.responseStreamingMode, 'paragraph')
    for (const key of ['autoResumeLimitedThreads', 'snoozeLimitedThreads', 'compactIdleThreads', 'continueThreadsAfterServerUpdate', 'sidebarAutoSettleOnMerge']) assert.equal(settings[key], false)
    assert.equal(settings.sidebarAutoSettleAfterDays, null)
    const shell = await client.http('/api/orchestration/shell')
    const archived = await client.rpc('orchestration.getArchivedShellSnapshot', {})
    const candidates = [...shell.threads, ...archived.threads].slice(0, 12)
    for (const thread of candidates) {
      const projection = await client.projection(thread.id)
      previousHistories.push({ threadId: thread.id, signature: signature(projection), plans: projection.plans?.filter(plan => plan.kind === 'proposed_plan').length || 0, subagents: projection.subagents?.length || 0 })
    }
    return { effectivePolicy: true, existingReadable: previousHistories.length, existingPlans: previousHistories.reduce((sum, row) => sum + row.plans, 0), existingSubagents: previousHistories.reduce((sum, row) => sum + row.subagents, 0) }
  })
  await step('project-materials-snapshot-and-real-report', async () => {
    ;({ threadId } = await client.createThread('这是精简项目助手真实验收。请实际调用 list_project_materials，从真实ID读取环境检查手册，并调用 query_environment 读取当前会话固定的测试环境快照。根据这些资料调用 create_report 生成 Markdown 文件，名称“精简交互验收.md”，正文包含“精简验收：只分析，不执行生产发布”，以及实际资料标题、快照时间、一项风险。最后给出报告下载链接。不要启动子Agent，不生成HTML，不执行发布或修改资源。', { title: '精简版资料及报告验收（自动清理）' }))
    report.threadId = threadId; await save()
    const projection = await finish(threadId)
    const tools = []
    for (const item of projection.turnItems.filter(item => item.type === 'dynamic_tool')) tools.push(item.outputOmitted ? (await client.rpc('orchestration.getTurnItem', { threadId, itemId: item.id })).item : item)
    for (const name of ['list_project_materials', 'read_project_document', 'query_environment', 'create_report']) assert(tools.some(item => item.toolName?.includes(name) && item.status === 'completed'), 'Missing successful real ' + name)
    assert.equal(projection.subagents?.length || 0, 0)
    const reportId = JSON.stringify(tools).match(/report-[a-f0-9]{64}/)?.[0]
    assert(reportId)
    const filePath = '/api/agent-demo/t3/autoops/files/' + reportId
    const response = await fetch(origin + filePath, { headers: { cookie: client.cookie } })
    assert.equal(response.status, 200)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert(bytes.toString().includes('精简验收'))
    const denied = await fetch(origin + filePath, { headers: { cookie: other.cookie } })
    assert([403, 404].includes(denied.status))
    await writeFile(output.replace(/\.json$/, '.md'), bytes)
    return { tools: tools.map(({ toolName, status }) => ({ toolName, status })), bytes: bytes.length, privateDownloadRejected: denied.status, nativeId: projection.providerThreads[0]?.nativeThreadRef?.nativeId, reportId }
  })
  await step('disabled-direct-rpc-cannot-mutate-history', async () => {
    assert(threadId)
    const before = await client.projection(threadId), checkpoint = before.checkpoints?.[0]
    const requests = liteNegativeCases(threadId, checkpoint, before.thread.updatedAt)
    const rejected = []
    for (const [method, payload] of requests) {
      let failure
      try { await client.rpc(method, payload) } catch (error) { failure = error }
      assert(failure, 'Disabled request succeeded: ' + method)
      assert.match(JSON.stringify(failure.detail), /精简版/, 'Not rejected by the product policy: ' + method + ': ' + JSON.stringify(failure.detail))
      rejected.push(payload.type || method)
    }
    assert.equal(signature(await client.projection(threadId)), signature(before))
    return { rejected, historyUnchanged: true }
  })
  await step('normal-followup-and-basic-organization', async () => {
    assert(threadId)
    await client.send(threadId, '刚才的报告中最值得注意的是哪项风险？只用一句话回答，沿用本会话资料，不再生成文件。')
    const projection = await finish(threadId, 2)
    assert(projection.messages.some(item => item.role === 'assistant' && item.runId === projection.runs.at(-1).id && item.text))
    await command(threadId, 'thread.pin'); await command(threadId, 'thread.unpin')
    await command(threadId, 'thread.archive'); await command(threadId, 'thread.unarchive')
    await command(threadId, 'thread.unsnooze', { reason: 'user' }); await command(threadId, 'thread.unsettle', { reason: 'user' })
    await command(threadId, 'thread.metadata.update', { title: '精简验收已完成（自动清理）' })
    assert.equal((await client.projection(threadId)).runs.length, 2)
    return { realMultiTurn: true, pinArchiveRenameAndReverseTransitions: true }
  })
  await step('existing-histories-unchanged', async () => {
    for (const row of previousHistories) assert.equal(signature(await client.projection(row.threadId)), row.signature)
    return { checked: previousHistories.length, contentUnchanged: true }
  })
} finally {
  if (threadId) {
    try {
      const projection = await client.projection(threadId)
      if (projection.runs.some(run => !terminal(run))) await command(threadId, 'thread.stop')
      if (!process.exitCode) { await command(threadId, 'thread.delete'); report.testThreadDeleted = true }
    } catch (error) { report.cleanupError = error.message; process.exitCode = 1 }
  }
  client.close(); other.close(); report.completedAt = new Date().toISOString(); await save()
}
