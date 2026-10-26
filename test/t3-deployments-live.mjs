// Opt-in validation harness for the independent VM deployment installation.
// This file never controls services, containers, source files, or model runs.
import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {mkdir, lstat, realpath, open, rename, readFile, rm, chmod} from 'node:fs/promises'
import {join, resolve} from 'node:path'

const expectedRoot = '/home/tao/autoops-deployment-validation'
const root = resolve(process.env.VALIDATION_ROOT || expectedRoot)
const origin = process.env.BASE_URL || 'http://127.0.0.1:28887'
const parsedOrigin = new URL(origin)
if (process.env.T3_DEPLOYMENT_VALIDATION !== '1') throw new Error('须显式设置 T3_DEPLOYMENT_VALIDATION=1 才能运行独立部署验证')
if (parsedOrigin.href !== 'http://127.0.0.1:28887/' || parsedOrigin.username || parsedOrigin.password) throw new Error('部署验证仅允许 http://127.0.0.1:28887')
if (root !== expectedRoot) throw new Error('部署验证只允许独立的 /home/tao/autoops-deployment-validation 目录')
const base = parsedOrigin.origin
const mode = process.argv[2]
if (process.argv.length !== 3 || !['--prepare', '--verify', '--enqueue-failure', '--verify-failure'].includes(mode)) throw new Error('请选择 --prepare、--verify、--enqueue-failure 或 --verify-failure')
const projectId = 'p-autoops', environmentId = 'env-test'
const prefix = `/autoops/projects/${projectId}`
const terminal = new Set(['succeeded', 'failed', 'rolled_back', 'interrupted'])
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex')
const stamp = () => new Date().toISOString()
const credentials = new Set([process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!'])
const redacted = (value) => {
  let result = String(value)
  for (const secret of credentials) if (secret) result = result.split(secret).join('[已隐藏]')
  return result.replace(/(?:demo_session=)[a-f0-9]+/g, 'demo_session=[已隐藏]')
}
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n')
let state, report

async function ordinary(file) {
  const info = await lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('验证文件必须是独立目录中的普通文件')
  return info
}
async function initializeRoot() {
  await mkdir(root, {recursive:true, mode:0o700})
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('验证目录不能通过符号链接映射到其他位置')
  const agentRoot = join(root, 'agent')
  await mkdir(agentRoot, {recursive:true, mode:0o700})
  const agentInfo = await lstat(agentRoot)
  if (!agentInfo.isDirectory() || agentInfo.isSymbolicLink() || await realpath(agentRoot) !== agentRoot) throw new Error('验证 Agent 目录不能使用符号链接')
  await chmod(agentRoot, 0o700)
}
async function readJson(name) {
  const file = join(root, name)
  if (!await ordinary(file)) return null
  return JSON.parse(await readFile(file, 'utf8'))
}
async function writeJson(name, value) {
  assert.ok(['state.json', 'report.json'].includes(name))
  const file = join(root, name); await ordinary(file)
  // Authentication material is held in memory or in the one dedicated token
  // file, never serialized alongside the validation evidence.
  const json = JSON.stringify(value, (key, item) => {
    if (/cookie|csrf|password|secret|authorization|registrationToken|tokenHash|registrationHash/i.test(key)) throw new Error('拒绝把认证材料写入验证状态或报告')
    return typeof item === 'string' ? redacted(item) : item
  }, 2) + '\n'
  const temporary = join(root, `.${name}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(json); await handle.sync() } finally { await handle.close() }
  try { await rename(temporary, file) } finally { await rm(temporary, {force:true}) }
}
async function saveState() { await writeJson('state.json', state) }
async function recordCase(name, evidence) {
  report.cases = report.cases.filter((item) => item.name !== name)
  report.cases.push({name, at:stamp(), ...evidence})
  report.status = report.cases.some((item) => item.name === 'verify-failure' && item.status === 'passed') ? 'passed' : 'in_progress'
  report.updatedAt = stamp(); await writeJson('report.json', report)
}
class Client {
  async login(username = 'admin') {
    const response = await fetch(base + '/api/agent-demo/login', {method:'POST', redirect:'error', signal:AbortSignal.timeout(15000), headers:{'Content-Type':'application/json'}, body:JSON.stringify({username, password:process.env.AGENT_DEMO_TEST_PASSWORD || 'Demo123!'})})
    assert.equal(response.status, 200, `${username} 登录未成功`)
    this.cookie = response.headers.get('set-cookie')?.split(';')[0]
    assert.ok(this.cookie, '登录响应缺少会话 Cookie')
    credentials.add(this.cookie); credentials.add(this.cookie.split('=').slice(1).join('='))
    const login = await response.json()
    this.csrf = login.csrf; credentials.add(this.csrf)
    const bootstrap = await this.request('/autoops/bootstrap')
    this.csrf = bootstrap.csrfToken; assert.ok(this.csrf, '工作台未返回 CSRF 校验信息'); credentials.add(this.csrf)
    return this
  }
  async raw(path, method = 'GET', input) {
    assert.ok(path.startsWith('/autoops/'), '验证只能访问固定 AutoOps 业务接口')
    const response = await fetch(base + '/api/agent-demo/t3' + path, {method, redirect:'error', signal:AbortSignal.timeout(30000), headers:{Cookie:this.cookie, Origin:base, 'Content-Type':'application/json', 'X-T3-Orchestration-Protocol':'2', ...(this.csrf ? {'X-Demo-CSRF':this.csrf} : {})}, ...(input === undefined ? {} : {body:JSON.stringify(input)})})
    const body = await response.json().catch(() => null)
    return {status:response.status, body}
  }
  async request(path, method = 'GET', input) {
    const result = await this.raw(path, method, input)
    if (result.status < 200 || result.status >= 300) throw new Error(`验证 API ${method} ${path.split('?')[0]} 返回 HTTP ${result.status}：${redacted(result.body?.error || result.body?.code || '请求未完成')}`)
    return result.body
  }
  async packageBytes(packageId) {
    const path = `${prefix}/workspaces/packages/${encodeURIComponent(packageId)}/frontend/download`
    const response = await fetch(base + '/api/agent-demo/t3' + path, {redirect:'error', signal:AbortSignal.timeout(30000), headers:{Cookie:this.cookie, Origin:base, 'X-T3-Orchestration-Protocol':'2'}})
    assert.equal(response.status, 200, '实际源码包下载未成功')
    const chunks = []; let size = 0
    for await (const chunk of response.body || []) { size += chunk.length; assert.ok(size <= 64 * 1024 * 1024, '验证源码包超过 64 MiB'); chunks.push(chunk) }
    return Buffer.concat(chunks)
  }
}
const api = new Client()
const deployments = (suffix = '') => `${prefix}/deployments${suffix}`
const workspace = () => api.request(`${prefix}/workspaces`)
async function overview() {
  const result = await api.request(deployments('?environmentId=' + environmentId))
  assert.equal(result.enabled, true, '独立部署验证未启用')
  return result
}
function checkedState() {
  assert.equal(state?.schemaVersion, 1, '请先执行 --prepare')
  assert.equal(state?.base, base); assert.equal(state?.root, root)
  assert.equal(state?.projectId, projectId); assert.equal(state?.environmentId, environmentId)
  return state
}
async function checkedTarget() {
  checkedState()
  const current = await overview(), target = current.targets.find((item) => item.id === state.targetId)
  assert.ok(target, '已保存的验证目标不存在；禁止自动创建替代身份')
  assert.equal(target.serverId, state.serverId); assert.equal(target.environmentId, environmentId)
  assert.equal(target.configKey, state.configKey, '验证目标配置已变化；禁止静默覆盖原配置快照')
  return {current, target}
}
function taskEvidence(task, logs = []) {
  return {id:task.id, targetId:task.targetId, action:task.action, status:task.status, stage:task.stage, stageHistory:task.stageHistory, createdAt:task.createdAt, startedAt:task.startedAt, finishedAt:task.finishedAt, revision:task.revision, sourceIdentity:task.sourceIdentity, error:task.error, result:task.result, logs}
}
async function waitTask(id, purpose, timeoutMs = 360000) {
  const end = Date.now() + timeoutMs, logs = []
  let after = 0, previous = '', nextProgress = 0, last
  while (Date.now() < end) {
    const details = await api.request(deployments(`/tasks/${encodeURIComponent(id)}?after=${after}`)); last = details.task
    assert.equal(last.id, id); assert.equal(last.targetId, state.targetId)
    for (const item of details.logs) { assert.ok(item.seq > after, '日志增量序号发生倒退'); logs.push(item); after = item.seq }
    assert.ok(details.nextSeq >= after + 1, '日志游标无效')
    const progress = `${last.status}:${last.stage}`
    if (progress !== previous || Date.now() >= nextProgress) { output({mode, purpose, taskId:id, status:last.status, stage:last.stage}); previous = progress; nextProgress = Date.now() + 30000 }
    if (terminal.has(last.status) && after >= (last.lastSeq || 0)) {
      report.tasks = report.tasks.filter((item) => item.id !== id)
      report.tasks.push({...taskEvidence(last, logs), purpose, observedAt:stamp()}); await writeJson('report.json', report)
      return last
    }
    await delay(1000)
  }
  if (last) { report.tasks = report.tasks.filter((item) => item.id !== id); report.tasks.push({...taskEvidence(last, logs), purpose, observedAt:stamp(), timedOut:true}); await writeJson('report.json', report) }
  throw new Error(`部署任务 ${id} 未在限定时间内结束`)
}
async function waitPackage(taskId) {
  const end = Date.now() + 120000
  while (Date.now() < end) {
    const current = await workspace(), task = current.tasks.find((item) => item.id === taskId)
    assert.ok(task, '源码包生成任务不存在')
    if (!['queued', 'running'].includes(task.status)) { assert.equal(task.status, 'completed', '源码包生成任务失败'); return current.releases.find((item) => item.id === task.releaseId) }
    await delay(500)
  }
  throw new Error('源码包生成超时')
}
async function siteEvidence(release) {
  const artifactId = release.artifactId || release.id
  const markerUrl = new URL('http://127.0.0.1:28890/__cmr_release.txt'); markerUrl.searchParams.set('version', release.id)
  const markerResponse = await fetch(markerUrl, {redirect:'error', signal:AbortSignal.timeout(10000), headers:{'Cache-Control':'no-cache'}})
  assert.equal(markerResponse.status, 200, '真实站点版本标记未返回 200')
  const marker = (await markerResponse.text()).trim(); assert.equal(marker, artifactId, '真实站点标记与当前发布产物不一致')
  const pageUrl = new URL('http://127.0.0.1:28890/'); pageUrl.searchParams.set('cmr_check', release.id)
  const response = await fetch(pageUrl, {redirect:'error', signal:AbortSignal.timeout(10000), headers:{'Cache-Control':'no-cache'}})
  assert.equal(response.status, 200, '真实站点首页健康检查未返回 200')
  const html = await response.text(); assert.ok(html.includes('AutoOps'), '真实站点内容与前端示例不符')
  return {httpStatus:response.status, marker, releaseId:release.id, artifactId, htmlSha256:checksum(html), bytes:Buffer.byteLength(html)}
}
function assertSource(release) {
  assert.equal(release.sourceIdentity?.projectId, projectId)
  assert.equal(release.sourceIdentity?.packageId, state.packageId)
  assert.equal(release.sourceIdentity?.sourceVersionId, state.sourceVersionId)
  assert.equal(release.sourceIdentity?.contentHash, state.sourceContentHash)
  assert.equal(release.sourceIdentity?.service, 'frontend')
}
async function assertStatus(client, suffix, method, input, status) {
  const result = await client.raw(suffix, method, input); assert.equal(result.status, status, `授权／配置校验预期 ${status}，实际 ${result.status}`)
  return {status:result.status, code:result.body?.code}
}
function deployInput(requestId) { return {targetId:state.targetId, action:'deploy', packageId:state.packageId, service:'frontend', configKey:state.configKey, requestId} }

async function prepare() {
  if (!state) { state = {schemaVersion:1, base, root, projectId, environmentId, createdAt:stamp(), nodeRegistrationScope:'global', requests:{package:randomUUID(), server:randomUUID(), target:randomUUID()}}; await saveState() }
  checkedState()
  let workspaces = await workspace()
  const internal = state.sourceVersionId ? workspaces.internalVersions.find((item) => item.id === state.sourceVersionId) : workspaces.internalVersions.find((item) => item.isExample && item.status === 'published')
  assert.ok(internal && internal.isExample && internal.type === 'internal' && internal.status === 'published', '需要已发布的内部示例工作区，不允许操作真实项目来源')
  if (!state.sourceVersionId) { state.sourceVersionId = internal.id; state.sourceContentHash = internal.source.contentHash; state.repositories = internal.source.repositories; await saveState() }
  assert.equal(internal.source.contentHash, state.sourceContentHash)
  if (!state.packageId) {
    const task = await api.request(`${prefix}/workspaces/packages`, 'POST', {sourceVersionId:state.sourceVersionId, services:['frontend'], requestId:state.requests.package})
    const pack = await waitPackage(task.id); assert.ok(pack, '包任务完成但缺少固定发布清单')
    const frontend = pack.manifest.services.find((item) => item.service === 'frontend')
    assert.equal(frontend.context.workingDirectory, '.', '该示例包不是独立根构建上下文')
    state.packageId = pack.id; state.packageSha256 = frontend.sha256; state.packageSize = frontend.size; await saveState()
  }
  workspaces = await workspace()
  const pack = workspaces.releases.find((item) => item.id === state.packageId)
  assert.ok(pack, '已保存的固定源码包不存在；不允许自动替换')
  assert.equal(pack.sourceVersionId, state.sourceVersionId)
  assert.equal(pack.services.find((item) => item.service === 'frontend')?.sha256, state.packageSha256)
  const packageBytes = await api.packageBytes(state.packageId)
  assert.equal(checksum(packageBytes), state.packageSha256, '实际下载的源码 ZIP 与固定清单校验值不符')
  assert.equal(packageBytes.length, state.packageSize)
  let current = await overview()
  const tokenFile = join(root, 'agent', 'registration-token')
  if (!state.serverId) {
    let server
    if (state.nodeRegistrationScope !== 'global') {
      // 旧状态先核对原收据；只有明确未接受，才能改用全局登记入口。
      const previous = await api.raw(deployments('/servers'), 'POST', {environmentId, name:'部署验证节点', requestId:state.requests.server})
      if (previous.status === 410 && previous.body?.code === 'DEPLOYMENT_NODE_ROUTE_RETIRED') {
        state.nodeRegistrationScope = 'global'; await saveState()
      } else {
        assert.ok(previous.status >= 200 && previous.status < 300, `原节点登记收据未能核对：HTTP ${previous.status}；禁止建立替代节点`)
        server = previous.body
      }
    }
    if (!server) server = await api.request('/autoops/deployment-servers', 'POST', {name:'部署验证节点', requestId:state.requests.server})
    const existing = await ordinary(tokenFile)
    if (server.registrationToken) {
      credentials.add(server.registrationToken)
      if (existing) throw new Error('接入口令文件已存在，禁止覆盖；请先核对独立验证状态')
      const handle = await open(tokenFile, 'wx', 0o600)
      try { await handle.writeFile(server.registrationToken + '\n'); await handle.sync() } finally { await handle.close() }
      assert.equal((await lstat(tokenFile)).mode & 0o777, 0o600, '接入口令文件必须为 0600')
    } else {
      assert.ok(existing, '原服务器接入口令未保存；重复请求不能重发口令，已停止且不会新建服务器')
      assert.equal(existing.mode & 0o777, 0o600, '已有接入口令文件权限不是 0600')
    }
    state.serverId = server.server.id; await saveState()
  }
  if (state.nodeRegistrationScope === 'global') {
    if (!state.nodeAccess) {
      const catalog = await api.request('/autoops/deployment-servers')
      assert.ok(catalog.servers.some((item) => item.id === state.serverId && !item.revoked), '原全局节点不存在或接入已撤销；禁止建立替代节点')
      const projectAccess = catalog.projectAccess.find((item) => item.projectId === projectId)
      // 项目尚无部署映射时，准入接口会建立修订 1；发送前固定本次条件与请求。
      state.nodeAccess = {requestId:randomUUID(), expectedRevision:projectAccess?.revision ?? 1}
      await saveState()
    }
    if (!state.nodeAccess.completed) {
      const grant = await api.request(`/autoops/deployment-servers/${encodeURIComponent(state.serverId)}/projects/${encodeURIComponent(projectId)}`, 'POST', {allowed:true, expectedRevision:state.nodeAccess.expectedRevision, requestId:state.nodeAccess.requestId})
      assert.equal(grant.serverId, state.serverId); assert.equal(grant.projectId, projectId); assert.equal(grant.allowed, true)
      state.nodeAccess.completed = true; await saveState()
    }
    if (!state.requests.nodeBinding) { state.requests.nodeBinding = randomUUID(); await saveState() }
    const binding = await api.request(deployments(`/servers/${encodeURIComponent(state.serverId)}/bind`), 'POST', {environmentId, requestId:state.requests.nodeBinding})
    assert.equal(binding.server.id, state.serverId)
    assert.notEqual(binding.server.projectAllowed, false, '节点准入已撤回，原绑定收据不能当作当前使用许可')
  }
  current = await overview(); assert.ok(current.servers.some((item) => item.id === state.serverId && item.projectAllowed !== false), '已保存的验证服务器不存在或项目准入已撤回')
  if (!state.targetId) {
    const config = {module:'.', artifactPath:'dist', buildImage:'public.ecr.aws/docker/library/node:24-alpine', packageManager:'npm', packageManagerVersion:'11.19.1', buildScript:'build', health:{url:'http://127.0.0.1:28890/', bodyIncludes:'AutoOps', timeoutSeconds:10, intervalSeconds:2}}
    const {target} = await api.request(deployments('/targets'), 'POST', {name:'前端部署验证', environmentId, serverId:state.serverId, config, requestId:state.requests.target})
    state.targetId = target.id; state.configKey = target.configKey; state.config = target.config; await saveState()
  }
  await checkedTarget()
  await recordCase('prepare', {status:'passed', projectId, environmentId, serverId:state.serverId, targetId:state.targetId, sourceVersionId:state.sourceVersionId, packageId:state.packageId, packageSha256:state.packageSha256, packageSize:state.packageSize})
  output({mode, status:'prepared', targetId:state.targetId, serverId:state.serverId, packageId:state.packageId, sourceVersionId:state.sourceVersionId})
}

async function verify() {
  const {current} = await checkedTarget()
  state.verify ||= {secondRequestId:randomUUID(), rollbackRequestId:randomUUID()}; await saveState()
  if (!state.verify.firstTaskId) {
    const first = current.tasks.filter((item) => item.targetId === state.targetId && item.action === 'deploy' && item.status === 'succeeded').sort((a,b) => a.createdAt.localeCompare(b.createdAt))[0]
    assert.ok(first, '请先通过浏览器完成至少一次真实发布，再执行 --verify')
    state.verify.firstTaskId = first.id; await saveState()
  }
  const first = await waitTask(state.verify.firstTaskId, 'browser-first-deploy')
  assert.equal(first.status, 'succeeded'); assertSource(first)
  const secondInput = deployInput(state.verify.secondRequestId)
  const [left, right] = await Promise.all([api.request(deployments('/tasks'), 'POST', secondInput), api.request(deployments('/tasks'), 'POST', secondInput)])
  assert.equal(left.task.id, right.task.id, '同 UUID 并发提交创建了重复任务')
  state.verify.secondTaskId = left.task.id; await saveState()
  const second = await waitTask(left.task.id, 'api-idempotent-second-deploy')
  assert.equal(second.status, 'succeeded'); assertSource(second)
  const afterSecond = await checkedTarget()
  let secondSite
  if (afterSecond.target.currentRelease?.id === second.id) {
    assertSource(afterSecond.target.currentRelease)
    secondSite = await siteEvidence(afterSecond.target.currentRelease)
    state.verify.secondSite = secondSite; await saveState()
  } else {
    assert.equal(afterSecond.target.currentRelease?.id, state.verify.rollbackTaskId, '第二次发布后的当前版本既非本次发布，也非已保存的手动回退任务')
    assert.ok(state.verify.secondSite, '缺少第二次发布的既有站点验证记录，不能推测其历史结果')
    secondSite = state.verify.secondSite
  }
  const {releases} = await api.request(deployments(`/targets/${state.targetId}/releases`))
  const initialRelease = releases.find((item) => item.id === state.verify.firstTaskId)
  assert.ok(initialRelease?.available, '首个真实成功版本不可回退'); assertSource(initialRelease)
  const rollbackInput = {targetId:state.targetId, action:'rollback', releaseId:initialRelease.id, service:'frontend', configKey:state.configKey, requestId:state.verify.rollbackRequestId}
  const {task} = await api.request(deployments('/tasks'), 'POST', rollbackInput)
  state.verify.rollbackTaskId = task.id; await saveState()
  const rollback = await waitTask(task.id, 'manual-rollback-to-first')
  assert.equal(rollback.status, 'succeeded'); assertSource(rollback)
  const afterRollback = await checkedTarget(), selected = afterRollback.target.currentRelease
  assert.equal(selected?.id, rollback.id); assert.equal(selected.restoredFromReleaseId, initialRelease.id)
  assert.equal(selected.revision, initialRelease.revision); assertSource(selected)
  const rollbackSite = await siteEvidence(selected)
  const tasksBefore = afterRollback.current.tasks.length
  const staleKey = (state.configKey[0] === '0' ? '1' : '0') + state.configKey.slice(1)
  const staleConfig = await assertStatus(api, deployments('/tasks'), 'POST', {...deployInput(randomUUID()), configKey:staleKey}, 409)
  const guest = await new Client().login('guest')
  const guestGet = await assertStatus(guest, deployments(), 'GET', undefined, 403)
  const guestPost = await assertStatus(guest, deployments('/tasks'), 'POST', deployInput(randomUUID()), 403)
  const crossProjectGet = await assertStatus(api, `/autoops/projects/p-cabinet/deployments/targets/${state.targetId}/releases`, 'GET', undefined, 404)
  const crossProjectPost = await assertStatus(api, '/autoops/projects/p-cabinet/deployments/tasks', 'POST', deployInput(randomUUID()), 404)
  assert.equal((await checkedTarget()).current.tasks.length, tasksBefore, '被拒绝的请求产生了部署任务')
  state.verify.completedAt = stamp(); state.verify.baselineReleaseId = selected.id; state.verify.baselineArtifactId = selected.artifactId || selected.id; await saveState()
  await recordCase('verify', {status:'passed', firstTaskId:first.id, secondTaskId:second.id, rollbackTaskId:rollback.id, duplicateTaskIds:[left.task.id, right.task.id], packageSha256:state.packageSha256, sourceIdentity:second.sourceIdentity, secondSite, rollbackSite, permissionChecks:{staleConfig, guestGet, guestPost, crossProjectGet, crossProjectPost}})
  output({mode, status:'passed', firstTaskId:first.id, secondTaskId:second.id, rollbackTaskId:rollback.id, marker:rollbackSite.marker})
}

async function enqueueFailure() {
  const {target} = await checkedTarget()
  assert.ok(state.verify?.completedAt && target.currentRelease, '先完成正常发布与手动回退验证')
  if (!state.failure) { state.failure = {requestId:randomUUID(), baselineReleaseId:target.currentRelease.id, baselineArtifactId:target.currentRelease.artifactId || target.currentRelease.id, baselineRevision:target.currentRelease.revision, baselineSite:await siteEvidence(target.currentRelease)}; await saveState() }
  assert.equal(target.currentRelease.id, state.failure.baselineReleaseId, '故障验证基线已变化，禁止覆盖')
  const result = await api.request(deployments('/tasks'), 'POST', deployInput(state.failure.requestId))
  state.failingTaskId = result.task.id; state.failure.taskId = result.task.id; await saveState()
  assert.ok(['preparing', 'queued'].includes(result.task.status) || (state.failure.completedAt && result.task.status === 'rolled_back'), '故障任务已运行；请先停止本轮独立部署 Agent 后按步骤配置故障')
  await recordCase('enqueue-failure', {status:'queued', taskId:result.task.id, baselineReleaseId:state.failure.baselineReleaseId, baselineArtifactId:state.failure.baselineArtifactId})
  output({mode, status:result.task.status, failingTaskId:state.failingTaskId})
}

async function verifyFailure() {
  await checkedTarget()
  assert.ok(state.failingTaskId && state.failure, '请先执行 --enqueue-failure')
  const failed = await waitTask(state.failingTaskId, 'real-health-failure-auto-recovery')
  assert.equal(failed.status, 'rolled_back', '真实健康检查失败后未成功恢复旧版本')
  assert.equal(failed.result?.rollback?.status, 'succeeded'); assert.ok(failed.result?.error, '缺少实际健康检查失败原因')
  assertSource(failed)
  const {target} = await checkedTarget(), selected = target.currentRelease
  assert.equal(selected?.id, state.failure.baselineReleaseId, '故障恢复后中心当前版本发生变化')
  assert.equal(selected.artifactId || selected.id, state.failure.baselineArtifactId)
  assert.equal(selected.revision, state.failure.baselineRevision); assertSource(selected)
  const site = await siteEvidence(selected)
  assert.equal(site.marker, state.failure.baselineSite.marker, '故障前后真实站点标记不一致')
  assert.equal(site.htmlSha256, state.failure.baselineSite.htmlSha256)
  state.failure.completedAt = stamp(); await saveState()
  await recordCase('verify-failure', {status:'passed', taskId:failed.id, rollbackStatus:failed.result.rollback.status, error:failed.result.error, baselineReleaseId:state.failure.baselineReleaseId, baselineArtifactId:state.failure.baselineArtifactId, beforeSite:state.failure.baselineSite, afterSite:site, sourceIdentity:failed.sourceIdentity})
  output({mode, status:'passed', taskId:failed.id, rollbackStatus:failed.result.rollback.status, marker:site.marker})
}

try {
  await initializeRoot()
  state = await readJson('state.json')
  report = await readJson('report.json') || {schemaVersion:1, base, root, projectId, environmentId, createdAt:stamp(), cases:[], tasks:[]}
  assert.equal(report.base, base); assert.equal(report.root, root)
  if (mode !== '--prepare') checkedState()
  await api.login()
  await ({'--prepare':prepare, '--verify':verify, '--enqueue-failure':enqueueFailure, '--verify-failure':verifyFailure}[mode])()
} catch (error) {
  process.exitCode = 1
  const message = redacted(error?.message || '验证失败')
  if (report) { report.status = 'failed'; report.errors ||= []; report.errors.push({mode, at:stamp(), message}); await writeJson('report.json', report).catch(() => {}) }
  output({mode, status:'failed', error:message})
}
