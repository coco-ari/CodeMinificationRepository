import { spawn } from 'node:child_process';

export class Docker {
  constructor({ binary = 'docker' } = {}) { this.binary = binary; }
  async run(args, { timeoutMs = 900000, onOutput, allowFailure = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let output = '', timedOut = false, outputError = null, chain = Promise.resolve();
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs); timer.unref();
      const collect = chunk => {
        const text = chunk.toString(); output = `${output}${text}`.slice(-2 * 1024 * 1024);
        if (onOutput) {
          // 等待日志落盘时暂停读取，防止构建输出快于磁盘造成无界内存积压。
          child.stdout.pause(); child.stderr.pause();
          chain = chain.then(() => onOutput(text)).catch(error => { outputError = error; child.kill('SIGKILL'); })
            .finally(() => { child.stdout.resume(); child.stderr.resume(); });
        }
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', async code => {
        clearTimeout(timer); await chain;
        if (outputError) return reject(outputError);
        if (timedOut) return reject(new Error('Docker 操作超时'));
        if (code !== 0 && !allowFailure) return reject(new Error(`Docker 操作失败（退出码 ${code}）：${output.slice(-2000)}`));
        resolve({ code, output });
      });
    });
  }
  async inspect(name, kind = 'container') {
    const result = await this.run([kind, 'inspect', name], { allowFailure: true, timeoutMs: 15000 });
    if (result.code !== 0) {
      if (/No such (?:object|container|image|network|volume)/i.test(result.output)
        || (kind === 'network' && result.output.includes(`network ${name} not found`))) return null;
      throw new Error(`无法检查 Docker ${kind}，拒绝将连接错误解释为资源不存在`);
    }
    const objects = JSON.parse(result.output); if (!Array.isArray(objects) || !objects[0]) throw new Error('Docker inspect 返回格式无效');
    return objects[0];
  }
}
