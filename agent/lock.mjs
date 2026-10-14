import { spawn } from 'node:child_process';
import path from 'node:path';

// 使用宿主机文件系统上的内核锁；即使处于不同 PID 命名空间，也不会重复执行同一身份的任务。
export async function acquireAgentLock(root, { onLost = () => {} } = {}) {
  if (process.platform !== 'linux') return { held: true, async release() { this.held = false; } };
  const code = 'process.stdout.write("CMR_LOCK_READY\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));';
  const child = spawn('flock', ['--nonblock', '--no-fork', path.join(root, '.agent.lock'), process.execPath, '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lock = { held: false, closing: false };
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  child.once('close', () => { const wasHeld = lock.held; lock.held = false; resolveClosed(); if (wasHeld && !lock.closing) onLost(); });
  await new Promise((resolve, reject) => {
    let output = '', settled = false;
    const done = (error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else { lock.held = true; resolve(); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(new Error('等待 Agent 工作目录锁超时')); }, 5000);
    child.once('error', error => done(new Error(`无法获取 Agent 内核锁：${error.message}`)));
    child.once('close', () => done(new Error('该工作目录已有 Agent 运行，拒绝重复接入')));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { output += data; if (output.includes('CMR_LOCK_READY\n')) done(); });
    child.stderr.resume();
  });
  lock.release = async () => { lock.closing = true; child.stdin.end(); await closed; };
  return lock;
}
