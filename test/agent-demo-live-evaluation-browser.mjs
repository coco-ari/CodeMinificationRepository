import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client, quantiles } from './agent-demo-helpers.mjs'
import { startBrowser, until, wait } from './helpers/prototype-browser.mjs'

// This script deliberately has no scenario / synthetic runner path. Running it
// sends eight real model turns through the currently configured deployed Demo.
if (process.env.AGENT_DEMO_LIVE_EVALUATION_BROWSER !== '1')
  throw new Error(
    '需显式设置 AGENT_DEMO_LIVE_EVALUATION_BROWSER=1；先与基线测试协调真实模型串行执行',
  )
const origin = (process.env.AGENT_DEMO_URL || 'http://172.29.22.6:8787').replace(/\/$/, '')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const evidence = path.resolve('.test-artifacts/agent-demo-real-evaluation/browser', runId)
await mkdir(evidence, { recursive: true })
process.env.PROTOTYPE_URL = `${origin}/agent-demo.html`
const report = {
  runId,
  startedAt: new Date().toISOString(),
  origin,
  mode: 'real-configured-model-browser',
  providerConfigurationChanged: false,
  networkExperiment:
    'Only this Chrome target is disconnected for five seconds; server and runner stay online.',
  concurrentLoad:
    process.env.AGENT_DEMO_LIVE_EVALUATION_LOAD ||
    'This browser conversation is run alone after the sequential native-session benchmark has completed.',
  rounds: [],
  checks: [],
  failures: [],
}
const client = new Client('admin', origin)
let browser,
  cid,
  offline = false
const fact = `F-${randomUUID().slice(0, 12)}`
const color = `蓝紫-${randomUUID().slice(0, 7)}`
const firstLine = `第一行：甲-${randomUUID().slice(0, 12)}`
const secondLine = `第二行：乙-${randomUUID().slice(0, 12)}`
const fileName = `真实附件-${runId.slice(-8)}.txt`
const fixturePath = path.join(evidence, fileName)
await writeFile(fixturePath, `${firstLine}\n${secondLine}\n`, 'utf8')
report.testFacts = { fact, color, firstLine, secondLine, fileName }
const save = () => writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
const read = () =>
  client
    .api('GET', `/conversations/${cid}`, undefined, { timeout: 5000 })
    .then((r) => r.conversation)
const compactTurn = (turn) => ({
  id: turn.id,
  status: turn.status,
  phase: turn.phase,
  startedAt: turn.startedAt,
  completedAt: turn.completedAt,
  runnerThreadId: turn.runnerThreadId,
  runnerTurnId: turn.runnerTurnId,
  error: turn.error,
  usage: turn.usage,
  runtimeTimings: turn.runtimeTimings,
  steps: (turn.steps || []).map((step) => ({
    name: step.name,
    status: step.status,
    input: step.input,
    outputCharacters: JSON.stringify(step.output ?? '').length,
    ...(step.status === 'failed' || step.status === 'error' ? { failureOutput: step.output } : {}),
  })),
  timeline: (turn.timeline || []).map((part) => ({
    id: part.id,
    type: part.type,
    itemId: part.itemId,
    messagePhase: part.messagePhase,
    status: part.status,
    characters: part.text?.length,
    createdAt: part.createdAt,
    updatedAt: part.updatedAt,
  })),
})
const answerOf = (conversation, turn) =>
  conversation.messages.find((message) => message.id === turn.assistantMessageId)?.content || ''
const textLength = (turn) =>
  (turn?.timeline || []).reduce((total, part) => total + (part.text?.length || 0), 0)

async function enterPrompt(prompt) {
  await browser.click('[aria-label="输入问题"]')
  await browser.command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    commands: ['selectAll'],
  })
  await browser.command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    windowsVirtualKeyCode: 65,
  })
  await browser.command('Input.insertText', { text: prompt })
  assert.equal(
    await browser.evaluate('document.querySelector(\'[aria-label="输入问题"]\').value'),
    prompt,
  )
}

async function uploadFile(filePath, name) {
  const document = await browser.command('DOM.getDocument')
  const input = await browser.command('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: '[aria-label="选择会话附件"]',
  })
  await browser.command('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [filePath] })
  await browser.visible(`[aria-label="移除附件 ${name}"]`)
}

// Start time is the actual pointer click, rather than the test helper's scroll
// and animation wait. Text samples are DOM commits, not inferred model tokens.
async function installMetrics() {
  await browser.evaluate(`(() => {
    window.__realEvaluation?.stop?.();
    const known = new Set([...document.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId));
    const m = window.__realEvaluation = { started:null, userMessageMs:null, waitingFeedbackMs:null,
      firstCommittedTextMs:null, firstVisibleTextMs:null, updates:[], frames:0 };
    let frame=0, previous='';
    const inspect=()=>{
      frame=0;
      if(m.started===null) return;
      const elapsed=performance.now()-m.started;
      const rows=[...document.querySelectorAll('.workbench-demo-message')].filter(n=>!known.has(n.dataset.messageId));
      if(m.userMessageMs===null && rows.some(n=>n.classList.contains('is-user')))m.userMessageMs=elapsed;
      const feedback=document.querySelector('.workbench-demo-live-state');
      if(m.waitingFeedbackMs===null && feedback?.getClientRects().length)m.waitingFeedbackMs=elapsed;
      const nodes=rows.filter(n=>n.classList.contains('is-assistant')).flatMap(n=>[...n.querySelectorAll('[data-part-type="text"] .workbench-demo-markdown')]);
      const shown=nodes.filter(n=>!n.closest('[aria-hidden="true"]'));
      const text=shown.map(n=>n.textContent).join('\\n');
      if(text.trim() && m.firstCommittedTextMs===null)m.firstCommittedTextMs=elapsed;
      if(m.firstVisibleTextMs===null && shown.some(n=>{
        const r=n.getBoundingClientRect(),s=document.querySelector('.workbench-demo-messages').getBoundingClientRect();
        return n.textContent.trim()&&r.bottom>s.top&&r.top<s.bottom&&r.height>0;
      }))m.firstVisibleTextMs=elapsed;
      if(text && text!==previous){m.updates.push({atMs:elapsed,characters:text.length});previous=text;}
      m.frames++;
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(inspect)};
    const click=(event)=>{if(m.started===null && event.target.closest('[aria-label="发送"]')){m.started=performance.now();schedule()}};
    const observer=new MutationObserver(schedule);
    observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-status','class','aria-hidden']});
    document.addEventListener('click',click,true);
    m.stop=()=>{observer.disconnect();document.removeEventListener('click',click,true);if(frame)cancelAnimationFrame(frame)};
    return true;
  })()`)
}
const metrics = () =>
  browser.evaluate(`(()=>{const m=window.__realEvaluation;return m?{
  userMessageMs:m.userMessageMs,waitingFeedbackMs:m.waitingFeedbackMs,firstCommittedTextMs:m.firstCommittedTextMs,
  firstVisibleTextMs:m.firstVisibleTextMs,updates:m.updates,frames:m.frames}:null})()`)
const scrollState = () =>
  browser.evaluate(`(()=>{const n=document.querySelector('.workbench-demo-messages');return{
  top:n.scrollTop,height:n.scrollHeight,client:n.clientHeight,gap:n.scrollHeight-n.clientHeight-n.scrollTop}})()`)
const network = async (isOffline) => {
  await browser.command('Network.emulateNetworkConditions', {
    offline: isOffline,
    latency: 0,
    downloadThroughput: isOffline ? 0 : -1,
    uploadThroughput: isOffline ? 0 : -1,
  })
  offline = isOffline
}

async function stopOwnTurn(record) {
  const current = await read()
  if (current.activeTurnId) {
    await client.stop(cid, current.activeTurnId)
    record.stopRequestedForTimeoutOrRecovery = true
    await until(async () => !(await read()).activeTurnId, '停止本测试自己的未完成轮次', 300)
  }
}

async function runRound(label, prompt, { verify, scrolling = false, disconnect = false } = {}) {
  const record = {
    index: report.rounds.length + 1,
    label,
    prompt,
    startedAt: new Date().toISOString(),
    observations: [],
    serverSamples: [],
  }
  report.rounds.push(record)
  record.healthAtStart = await client.api('GET', '/health', undefined, { timeout: 5000 })
  const before = await read()
  assert.equal(before.activeTurnId, null, '真实请求必须串行')
  const knownTurns = new Set(before.turns.map((turn) => turn.id))
  let turn,
    current,
    started = performance.now(),
    scrollExperiment = null
  try {
    await enterPrompt(prompt)
    await installMetrics()
    started = performance.now()
    await browser.click('[aria-label="发送"]')
    while (performance.now() - started < 120000) {
      current = await read()
      turn = current.turns.find((candidate) => !knownTurns.has(candidate.id))
      if (!turn) {
        await wait(250)
        continue
      }
      record.turnId = turn.id
      const m = await metrics()
      const elapsed = performance.now() - started
      const sample = {
        elapsedMs: elapsed,
        observedAt: new Date().toISOString(),
        status: turn.status,
        phase: turn.phase,
        timeline: (turn.timeline || []).map((part) => ({
          id: part.id,
          type: part.type,
          status: part.status,
          characters: part.text?.length || 0,
        })),
      }
      const previous = record.serverSamples.at(-1)
      if (
        !previous ||
        previous.phase !== sample.phase ||
        previous.status !== sample.status ||
        JSON.stringify(previous.timeline) !== JSON.stringify(sample.timeline) ||
        elapsed - previous.elapsedMs >= 2000
      )
        record.serverSamples.push(sample)
      if (
        scrolling &&
        !scrollExperiment &&
        current.activeTurnId === turn.id &&
        m.firstVisibleTextMs !== null
      ) {
        const geometry = await scrollState()
        if (geometry.height > geometry.client + 200) {
          const point = await browser.evaluate(
            "(()=>{const r=document.querySelector('.workbench-demo-messages').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()",
          )
          await browser.command('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            ...point,
            deltaX: 0,
            deltaY: -420,
          })
          await wait(250)
          scrollExperiment = {
            before: await scrollState(),
            startedAtMs: elapsed,
            sourceCharacters: textLength(turn),
            samples: [],
          }
          await browser.screenshot(`round-${record.index}-reading-history`)
        }
      }
      if (scrollExperiment && !scrollExperiment.finished && current.activeTurnId === turn.id) {
        const geometry = await scrollState()
        scrollExperiment.samples.push({
          elapsedMs: elapsed,
          top: geometry.top,
          sourceCharacters: textLength(turn),
        })
        if (
          elapsed - scrollExperiment.startedAtMs >= 3000 &&
          textLength(turn) > scrollExperiment.sourceCharacters
        ) {
          scrollExperiment.finished = true
          scrollExperiment.readingTopDelta = geometry.top - scrollExperiment.before.top
          scrollExperiment.preservedWhileSourceGrew = Math.abs(scrollExperiment.readingTopDelta) < 8
          await browser.click('[aria-label="回到最新消息"]')
          await wait(300)
          scrollExperiment.afterReturnToLatest = await scrollState()
          scrollExperiment.returnedNearEnd = scrollExperiment.afterReturnToLatest.gap < 24
        }
      }
      if (
        disconnect &&
        !record.offlineExperiment &&
        current.activeTurnId === turn.id &&
        (m.firstVisibleTextMs !== null || elapsed >= 3000)
      ) {
        const experiment = (record.offlineExperiment = {
          requestedMs: 5000,
          before: compactTurn(turn),
          startedAtMs: elapsed,
        })
        const offlineStarted = performance.now()
        await network(true)
        await wait(600)
        experiment.browserFeedback = await browser.evaluate(
          "document.querySelector('.workbench-demo-chat-connection')?.textContent || document.querySelector('.workbench-demo-global-connection')?.textContent || ''",
        )
        experiment.browserHttpProbe = await browser.evaluate(`(async()=>{
          try {const r=await fetch('/api/agent-demo/health',{signal:AbortSignal.timeout(1000)});return{navigatorOnline:navigator.onLine,reachedServer:true,status:r.status}}
          catch(error){return{navigatorOnline:navigator.onLine,reachedServer:false,error:error.message}}
        })()`)
        await browser.screenshot(`round-${record.index}-browser-offline`)
        const hostHealth = await client.api('GET', '/health', undefined, { timeout: 5000 })
        experiment.serverStayedOnline = hostHealth.ok === true
        const remaining = Math.max(0, 5000 - (performance.now() - offlineStarted))
        await wait(remaining)
        await network(false)
        experiment.actualMs = performance.now() - offlineStarted
        const during = await read()
        experiment.after = compactTurn(during.turns.find((candidate) => candidate.id === turn.id))
        experiment.sourceCharactersBefore = textLength(turn)
        experiment.sourceCharactersAfter = textLength(
          during.turns.find((candidate) => candidate.id === turn.id),
        )
      }
      if (!current.activeTurnId) break
      if (turn.status === 'waiting' && turn.question?.status === 'pending') {
        record.observations.push('模型请求澄清，未自动编造答案；记录后停止本测试轮次。')
        record.unsolicitedClarification = turn.question.prompt
        await stopOwnTurn(record)
        current = await read()
        turn = current.turns.find((candidate) => candidate.id === turn.id)
        break
      }
      await wait(350)
    }
    if (!turn || current?.activeTurnId) {
      record.timeoutAt120Seconds = true
      await stopOwnTurn(record)
      current = await read()
      turn = current.turns.find((candidate) => !knownTurns.has(candidate.id))
    }
    if (offline) await network(false)
    record.totalMs = performance.now() - started
    record.turn = turn ? compactTurn(turn) : null
    record.answer = turn ? answerOf(current, turn) : ''
    record.completed = turn?.status === 'completed'
    if (turn) {
      await until(
        () =>
          browser.evaluate(
            `Boolean(document.querySelector('.is-assistant[data-turn-id="${turn.id}"]'))`,
          ),
        '终态助手消息回到DOM',
        300,
      )
      await wait(250)
      record.render = await browser.evaluate(`(()=>{
        const rows=[...document.querySelectorAll('.is-assistant[data-turn-id="${turn.id}"]')];
        const parts=rows.flatMap(n=>[...n.querySelectorAll('[data-part-id]')]);
        const bodies=rows.flatMap(n=>[...n.querySelectorAll('[data-part-type="text"] .workbench-demo-markdown')]).filter(n=>!n.closest('[aria-hidden="true"]'));
        const ids=parts.map(n=>n.dataset.partId);
        return{messageIds:rows.map(n=>n.dataset.messageId),uniqueMessageIds:new Set(rows.map(n=>n.dataset.messageId)).size,
          partIds:ids,uniquePartIds:new Set(ids).size,text:bodies.map(n=>n.textContent).join('\\n'),
          tables:bodies.reduce((sum,n)=>sum+n.querySelectorAll('table').length,0),codes:bodies.reduce((sum,n)=>sum+n.querySelectorAll('pre code').length,0)};
      })()`)
      record.render.noDuplicateIds =
        record.render.messageIds.length === record.render.uniqueMessageIds &&
        record.render.partIds.length === record.render.uniquePartIds
    }
    record.metrics = await metrics()
    record.finalScroll = await scrollState()
    const updates = record.metrics?.updates || []
    record.metrics.visibleCommitIntervalsMs = quantiles(
      updates.slice(1).map((sample, index) => sample.atMs - updates[index].atMs),
    )
    if (scrollExperiment) {
      record.scroll = scrollExperiment
      if (!scrollExperiment.finished)
        record.observations.push(
          '执行结束前未获得足够的上翻后新增输出重叠窗口；不宣称已验证持续阅读稳定性。',
        )
    } else if (scrolling)
      record.observations.push('本轮未出现足够长的实时溢出内容，未覆盖上翻阅读检查。')
    if (disconnect && !record.offlineExperiment)
      record.observations.push('本轮过快结束或未启动，未制造执行中的浏览器断网。')
    if (verify) record.assessment = verify(record)
    await browser.screenshot(`round-${record.index}-completed`)
  } catch (error) {
    record.harnessError = { message: error.message, stack: error.stack }
    if (offline) await network(false).catch(() => {})
    await browser.screenshot(`round-${record.index}-error`).catch(() => {})
    await stopOwnTurn(record).catch((cleanup) => {
      record.recoveryError = cleanup.message
    })
  }
  record.finishedAt = new Date().toISOString()
  record.healthAtEnd = await client
    .api('GET', '/health', undefined, { timeout: 5000 })
    .catch((error) => ({ error: error.message }))
  await save()
  console.log(
    JSON.stringify({
      round: record.index,
      label,
      completed: record.completed,
      totalMs: record.totalMs,
      assessment: record.assessment,
      harnessError: record.harnessError?.message,
      timeout: record.timeoutAt120Seconds,
    }),
  )
  return record
}

try {
  await client.login()
  report.runtime = client.bootstrap.runtime
  report.health = await client.api('GET', '/health')
  assert.equal(report.runtime.liveAvailable, true, '当前配置必须有真实可用运行器')
  browser = await startBrowser(`../agent-demo-real-evaluation/browser/${runId}`)
  await browser.command('Network.enable')
  await browser.viewport(1280, 900)
  await browser.fill('[aria-label="用户名"]', 'admin')
  await browser.fill('[aria-label="密码"]', process.env.AGENT_DEMO_PASSWORD || 'Demo123!')
  await browser.clickText('登录')
  await browser.visible('[aria-label="账号菜单"]')
  report.assets = await browser.evaluate('[...document.scripts].map(n=>n.src).filter(Boolean)')
  const created = await client.create({
    mode: 'live',
    visibility: 'private',
    title: `真实浏览器评估 ${runId}`,
  })
  assert.equal(created.mode, 'live')
  cid = created.id
  report.conversationId = cid
  await browser.evaluate(`location.hash='conversation=${cid}'`)
  await browser.visible('[aria-label="输入问题"]')
  await until(
    () =>
      browser.evaluate(
        "Boolean(document.querySelector('.workbench-demo-global-connection .is-connected'))",
      ),
    '真实SSE连接',
  )

  await runRound(
    '写入随机会话事实',
    `这是一次真实交互验收。请记住两条本会话事实：项目口令为 ${fact}，发布颜色为 ${color}。本轮只回复“已记住”，不要重复具体值，不读项目资料，不调用工具。`,
    {
      verify: (record) => ({
        acknowledged: record.answer.includes('已记住'),
        unexpectedTools: (record.turn?.steps || []).map((step) => step.name),
      }),
    },
  )
  await runRound(
    '跨轮读取随机事实',
    '刚才约定的项目口令与发布颜色分别是什么？只回答两个具体值，不查资料。',
    {
      verify: (record) => ({
        factRecalled: record.answer.includes(fact),
        colorRecalled: record.answer.includes(color),
      }),
    },
  )

  await uploadFile(fixturePath, fileName)
  const attachmentFirst = await runRound(
    '通过网页上传TXT且只读第一行',
    `请读取本轮上传的 ${fileName}。只回复文件第一行原文，不引用第二行，不概述全文，不读项目资料。`,
    {
      verify: (record) => ({
        firstLineMatched: record.answer.includes(firstLine),
        secondLineLeaked: record.answer.includes(secondLine),
        attachmentToolCalled: (record.turn?.steps || []).some(
          (step) => step.name === 'read_attachment',
        ),
      }),
    },
  )
  const priorAnswers = report.rounds.map((round) => round.answer || '').join('\n')
  await runRound(
    '不重新附文件读取上一轮TXT第二行',
    `请读取上一轮上传的 ${fileName} 的第二行，只回复第二行原文。本轮没有重新上传附件，可以使用读取附件工具，不要猜测，不读项目资料。`,
    {
      verify: (record) => ({
        previousAttachmentSecondLineMatched: record.answer.includes(secondLine),
        uncontaminatedProbe:
          !priorAnswers.includes(secondLine) &&
          attachmentFirst.assessment?.firstLineMatched === true,
        attachmentToolCalled: (record.turn?.steps || []).some(
          (step) => step.name === 'read_attachment',
        ),
      }),
    },
  )
  const pdfPath = path.resolve(
    '.test-artifacts/agent-demo-real-evaluation/fixtures/verification.pdf',
  )
  const pdfExpected = JSON.parse(
    await readFile(
      path.resolve('.test-artifacts/agent-demo-real-evaluation/fixtures/verification.json'),
      'utf8',
    ),
  )
  await uploadFile(pdfPath, 'verification.pdf')
  await runRound(
    '网页上传PDF后读取文件中的核验码',
    '请读取本轮上传的 verification.pdf，输出其中的 verification code 原文。如果目前不支持读取PDF，请明确说明，不要猜测，不读项目资料。',
    {
      verify: (record) => ({
        uploadAccepted: true,
        verificationCodeRead: record.answer.includes(pdfExpected.marker),
        explicitlyReportedUnsupported: /不支持|无法读取|不能读取|415|暂不支持|读取失败/.test(
          record.answer,
        ),
        attachmentToolCalled: (record.turn?.steps || []).some(
          (step) => step.name === 'read_attachment',
        ),
        failedToolSteps: (record.turn?.steps || []).filter(
          (step) => step.status === 'failed' || step.status === 'error',
        ),
      }),
    },
  )
  const marker = `EVAL-END-${randomUUID().slice(0, 8)}`
  await runRound(
    '真实长回复、可见更新与上翻阅读',
    `请直接写一篇1000至1500个中文字符的“测试环境发布前核查说明”，无需读取资料或调用工具。分成12个短段落，逐段解释检查目的与失败后的处理，包含一个至少5行的Markdown表格和一个闭合的JSON代码块。不要省略正文。最后一行必须单独写 ${marker}。`,
    {
      scrolling: true,
      verify: (record) => ({
        chineseCharacters: [...record.answer.matchAll(/[\u3400-\u9fff]/g)].length,
        tableRendered: record.render?.tables > 0,
        codeRendered: record.render?.codes > 0,
        finalMarkerPersisted: record.answer.includes(marker),
        finalMarkerVisible: record.render?.text.includes(marker) || false,
        finalMarkerSingleInRenderedAnswer: record.render?.text.split(marker).length === 2,
      }),
    },
  )
  const offlineMarker = `NETWORK-END-${randomUUID().slice(0, 8)}`
  const disconnected = await runRound(
    '真实执行中浏览器断网5秒后恢复',
    `请直接写1000至1300个中文字符的“WebUI网络断开与恢复验收记录”，不调用工具。用10个短段落描述观察步骤和判定标准，包含4行Markdown表格与闭合JSON代码块。最后一行单独写 ${offlineMarker}。`,
    {
      disconnect: true,
      verify: (record) => ({
        finalMarkerPersisted: record.answer.includes(offlineMarker),
        finalMarkerVisible: record.render?.text.includes(offlineMarker) || false,
        noDuplicateIds: record.render?.noDuplicateIds === true,
        finalMarkerSingleInRenderedAnswer: record.render?.text.split(offlineMarker).length === 2,
      }),
    },
  )

  const beforeRefresh = await read()
  await browser.command('Page.reload')
  await browser.visible('[aria-label="输入问题"]')
  await until(
    () =>
      browser.evaluate(
        "Boolean(document.querySelector('.workbench-demo-global-connection .is-connected'))",
      ),
    '刷新后SSE恢复',
    600,
  )
  const afterRefresh = await read()
  const refreshedText = await browser.evaluate(
    `(()=>{const rows=[...document.querySelectorAll('.is-assistant[data-turn-id="${disconnected.turnId}"]')];return rows.flatMap(n=>[...n.querySelectorAll('[data-part-type="text"] .workbench-demo-markdown')]).filter(n=>!n.closest('[aria-hidden="true"]')).map(n=>n.textContent).join('\\n')})()`,
  )
  report.refresh = {
    turnsBefore: beforeRefresh.turns.length,
    turnsAfter: afterRefresh.turns.length,
    sameMessageIds:
      JSON.stringify(beforeRefresh.messages.map((m) => m.id)) ===
      JSON.stringify(afterRefresh.messages.map((m) => m.id)),
    lastAnswerSameRenderedText: refreshedText === disconnected.render?.text,
    finalMarkerVisible: refreshedText.includes(offlineMarker),
  }
  await runRound(
    '刷新并经过长上下文后再读初始事实',
    '现在再次确认本会话最开始约定的项目口令与发布颜色。请只输出这两个原始值，不调用工具，不要把文件内容当作答案。',
    {
      verify: (record) => ({
        factRecalled: record.answer.includes(fact),
        colorRecalled: record.answer.includes(color),
      }),
    },
  )
  await browser.viewport(390, 844)
  await browser.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await wait(200)
  report.mobileSimulation = await browser.evaluate(
    "({kind:'Chrome 390px viewport and touch emulation; not a physical phone',width:innerWidth,scrollWidth:document.documentElement.scrollWidth,coarsePointer:matchMedia('(any-pointer:coarse)').matches,composerBottom:document.querySelector('[aria-label=\"输入问题\"]').getBoundingClientRect().bottom})",
  )
  await browser.screenshot('mobile-390-touch-simulation')
  await browser.command('Emulation.setTouchEmulationEnabled', { enabled: false })
  await browser.viewport(1280, 900)
  await browser.screenshot('desktop-real-final')
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
  await browser?.screenshot('fatal-error').catch(() => {})
} finally {
  if (browser && offline) await network(false).catch(() => {})
  if (cid) {
    try {
      const cleanup = {}
      await stopOwnTurn(cleanup)
      const own = await read()
      await writeFile(
        path.join(evidence, 'own-conversation-results.json'),
        JSON.stringify(
          {
            id: own.id,
            mode: own.mode,
            messages: own.messages.map(({ id, role, content, turnId, kind, attachments }) => ({
              id,
              role,
              content,
              turnId,
              kind,
              attachments,
            })),
            turns: own.turns.map(compactTurn),
          },
          null,
          2,
        ),
      )
      await client.api('DELETE', `/conversations/${cid}`)
      report.cleanup = { onlyOwnConversationRemoved: true, conversationId: cid, ...cleanup }
    } catch (error) {
      report.cleanup = { error: error.message, conversationId: cid }
    }
  }
  report.runtimeErrors = browser?.errors || []
  report.finishedAt = new Date().toISOString()
  report.harnessErrorCount = report.rounds.filter((round) => round.harnessError).length
  report.executionCompleted =
    report.rounds.length === 8 &&
    !report.failures.length &&
    !report.harnessErrorCount &&
    !report.cleanup?.error
  report.modelAndUIOutcomesRequireReadingAssessments = true
  report.executionCompletedMeaning =
    'The harness finished and cleaned up; this does not mean every requested behavior passed.'
  await save()
  await browser?.close()
}
console.log(
  JSON.stringify({
    evidence,
    executionCompleted: report.executionCompleted,
    rounds: report.rounds.length,
    runtimeErrors: report.runtimeErrors.length,
    failures: report.failures,
    cleanup: report.cleanup,
  }),
)
if (!report.executionCompleted) process.exitCode = 1
