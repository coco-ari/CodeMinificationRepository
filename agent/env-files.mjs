import path from 'node:path';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';

const within = (value, root) => value === root || value.startsWith(`${root}${path.sep}`);
const protectedPath = value => ['/etc', '/root', '/home', '/proc', '/sys', '/dev', '/run', '/var/run', '/agent'].some(root => value === root || value.startsWith(`${root}/`));

export function normalizeEnvFiles(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw new Error('环境文件必须为最多 8 个路径的数组');
  const files = value.map(file => {
    if (typeof file !== 'string' || file.length > 512 || !/^\/[a-zA-Z0-9_./-]+$/.test(file)
      || path.posix.normalize(file) !== file || file.split('/').some(part => part === '.' || part === '..') || protectedPath(file)) throw new Error('环境文件必须使用独立业务目录下规范的 Linux 绝对路径');
    return file;
  });
  if (new Set(files).size !== files.length) throw new Error('环境文件路径不能重复');
  return files;
}

export function assertEnvFileAgent(config, capabilities = []) {
  if (config?.envFiles?.length && !capabilities.includes('env-file-v1')) throw new Error('请先升级目标 Agent，使其支持环境文件（env_file）');
}

export async function preflightEnvFiles(files, agentRoot) {
  for (const file of files) {
    let info, resolved;
    try { info = await lstat(file); resolved = await realpath(file); await access(file, constants.R_OK); }
    catch { throw new Error('环境文件不存在或不可读取，请检查 Agent 可访问的路径和权限'); }
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('环境文件必须是不超过 1 MiB 的普通文件，不能使用符号链接');
    if (protectedPath(resolved.replaceAll('\\', '/'))) throw new Error('环境文件实际路径不能位于系统目录');
    const root = await realpath(agentRoot), allowed = path.join(root, 'env-files');
    if (within(resolved, root) && !within(resolved, allowed)) throw new Error('Agent 工作目录内的环境文件只能放在 env-files 子目录，不能读取身份或任务文件');
  }
}
