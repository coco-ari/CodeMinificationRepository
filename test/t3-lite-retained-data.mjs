import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { T3LiveClient } from './helpers/t3-live-client.mjs'

// Only reads pre-existing IDs recorded before the release. No model or command.
const label = process.env.T3_RETAINED_TARGET || 'stage'
assert(['stage', 'production'].includes(label))
const origin = process.env.AGENT_DEMO_URL || `http://192.168.31.157:${label === 'stage' ? 18887 : 8787}`
const mode = process.env.T3_RETAINED_MODE || 'capture'
assert(['capture', 'check'].includes(mode))
const base = `.test-artifacts/t3-lite/${label}`
const initial = JSON.parse(await readFile(base + '-before.json', 'utf8'))
const previous = mode === 'check' ? JSON.parse(await readFile(base + '-retained.json', 'utf8')) : undefined
const c = new T3LiveClient(origin), report = { origin, mode, rows: [], advanced: { plans: 0, subagents: 0, htmlTools: 0 } }
try {
  await c.login(); await c.connect()
  for (const threadId of [...new Set([...initial.threadIds, ...initial.archivedIds])]) {
    const p = await c.projection(threadId)
    const immutable = Object.fromEntries(['messages', 'runs', 'plans', 'subagents', 'turnItems', 'checkpoints'].map(key => [key, p[key]]))
    const row = { threadId, sha256: createHash('sha256').update(JSON.stringify(immutable)).digest('hex'), messages: p.messages.length, runs: p.runs.length }
    if (previous) assert.equal(row.sha256, previous.rows.find(old => old.threadId === threadId)?.sha256, 'Stored history changed: ' + threadId)
    report.rows.push(row)
    report.advanced.plans += p.plans?.length || 0
    report.advanced.subagents += p.subagents?.length || 0
    report.advanced.htmlTools += p.turnItems.filter(item => /html_(render|preview)/.test(item.toolName || '')).length
  }
  report.profile = c.bootstrap.productProfile?.id || 't3-demo-full-v1'
  report.status = 'passed'
  await writeFile(base + (mode === 'capture' ? '-retained.json' : '-retained-check.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, profile: report.profile, histories: report.rows.length, advanced: report.advanced }))
} finally { c.close() }
