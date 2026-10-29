import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 只允许在无宿主 Docker Socket 的一次性 Linux 容器中验证安装恢复。
test('安装分阶段失败不遗留身份，已有身份不覆盖，启动结果未知时保留核对材料', async t => {
  assert.equal(process.platform, 'linux')
  assert.equal(process.getuid(), 0)
  assert(existsSync('/.dockerenv'))
  for (const path of ['/var/run/docker.sock', '/opt/cmr-agent', '/opt/cmr-agent-static']) assert(!existsSync(path), path)
  const root = '/tmp/autoops-installer-isolated'
  assert(!existsSync(root))
  mkdirSync(`${root}/bin`, { recursive: true })
  mkdirSync(`${root}/bundle`)
  writeFileSync(`${root}/bundle/Dockerfile`, 'FROM scratch\n')
  assert.equal(spawnSync('tar', ['-czf', `${root}/bundle.tar.gz`, '-C', `${root}/bundle`, '.']).status, 0)
  const executable = (name, content) => { const path = `${root}/bin/${name}`; writeFileSync(path, '#!/bin/bash\nset -eu\n' + content); chmodSync(path, 0o755) }
  executable('docker', `case "$1" in
version|compose) exit 0 ;;
container) [[ "$INSTALL_CASE" == existing-container ]] ;;
build) [[ "$INSTALL_CASE" != build-failed ]] ;;
run) [[ "$INSTALL_CASE" != start-unknown ]] ;;
*) exit 2 ;;
esac\n`)
  executable('curl', `[[ "$INSTALL_CASE" != download-failed ]] || exit 22
while (($#)); do if [[ "$1" == -o ]]; then cp '${root}/bundle.tar.gz' "$2"; exit 0; fi; shift; done
exit 2\n`)
  executable('mkdir', 'if [[ "$INSTALL_CASE" == directory-failed && "${@: -1}" == /opt/cmr-agent-static ]]; then exit 1; fi\nexec /bin/mkdir "$@"\n')
  const socket = createServer()
  await new Promise((resolve, reject) => socket.once('error', reject).listen('/var/run/docker.sock', resolve))
  t.after(async () => { await new Promise(resolve => socket.close(resolve)); rmSync(root, { recursive: true, force: true }); for (const path of ['/opt/cmr-agent', '/opt/cmr-agent-static']) rmSync(path, { recursive: true, force: true }) })
  const script = fileURLToPath(new URL('../agent/install.sh', import.meta.url))
  assert.equal(spawnSync('bash', ['-n', script]).status, 0)
  const run = scenario => spawnSync('bash', [script, '--url', 'https://center.example.invalid', '--token', 'isolated_fixture_token_12345678901234567890'], { env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, INSTALL_CASE: scenario }, encoding: 'utf8' })
  for (const scenario of ['download-failed', 'build-failed', 'directory-failed', 'existing-container']) {
    const result = run(scenario)
    assert.notEqual(result.status, 0, scenario)
    assert(!existsSync('/opt/cmr-agent'), scenario)
    assert(!existsSync('/opt/cmr-agent-static'), scenario)
    assert(!readdirSync('/tmp').some(name => name.startsWith('cmr-agent-install.')), scenario)
  }
  mkdirSync('/opt/cmr-agent')
  writeFileSync('/opt/cmr-agent/identity', '原有隔离身份')
  assert.notEqual(run('existing-identity').status, 0)
  assert.equal(readFileSync('/opt/cmr-agent/identity', 'utf8'), '原有隔离身份')
  rmSync('/opt/cmr-agent', { recursive: true })
  const unknown = run('start-unknown')
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /启动结果需要核对/)
  assert(existsSync('/opt/cmr-agent/registration-token'))
  assert(existsSync('/opt/cmr-agent-static/.cmr-static-root'))
  for (const path of ['/opt/cmr-agent', '/opt/cmr-agent-static']) rmSync(path, { recursive: true })
  const success = run('success')
  assert.equal(success.status, 0, success.stderr)
  for (const stage of ['[1/4]', '[2/4]', '[3/4]', '[4/4]']) assert(success.stdout.includes(stage))
  assert.match(success.stdout, /返回平台确认节点在线/)
})
