import { mkdir } from 'node:fs/promises';

// 模拟 Docker 测试不验证 Linux UID 挂载权限。普通用户运行测试时，
// 仅替换两处真实 chown；真实 Docker 验收仍执行生产实现。
export function fakeOwnership(executor) {
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    executor.mountDirectory = directory => mkdir(directory, { recursive: true, mode: 0o755 });
    executor.makeSourceWritable = async () => {};
  }
  return executor;
}
