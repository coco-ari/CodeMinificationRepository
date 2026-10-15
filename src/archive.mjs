import { spawn } from 'node:child_process';
import { mkdir, stat, rename, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { HttpError } from './security.mjs';

export function validateRepository(value) {
  if (typeof value !== 'string' || !/^https:\/\/gitee\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) {
    throw new HttpError(400, '仓库地址必须是 https://gitee.com/组织/仓库.git，不包含账号、密码或参数');
  }
  if (value.slice('https://gitee.com/'.length).split('/').some(part => part === '.' || part === '..')) throw new HttpError(400, '仓库路径无效');
  return value;
}
export function validateBranch(value) {
  if (typeof value !== 'string' || value.length > 200 || !value || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value)
      || value.includes('..') || value.includes('@{') || value.startsWith('-') || value === '@'
      || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new HttpError(400, '分支名称无效，请填写明确的分支名，例如 main 或 release/customer-a');
  }
  return value;
}

export function sourceKey(project) {
  return `${project.id}:${createHash('sha256').update(JSON.stringify([project.repository, project.branch])).digest('hex')}`;
}

export function archiveKey(project) {
  return `${sourceKey(project)}:${project.revision || 'latest'}`;
}
export function validateRevision(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new HttpError(400, '请选择完整的 Git commit');
  return value;
}

export class ArchiveBuilder {
  constructor(directory, { timeoutMs = 180000, maxArchiveBytes = 1024 * 1024 * 1024, allowLocal = false } = {}) {
    this.directory = directory;
    this.timeoutMs = timeoutMs;
    this.maxArchiveBytes = maxArchiveBytes;
    this.allowLocal = allowLocal;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.askpass = path.join(this.directory, 'askpass.sh');
    this.gitConfig = path.join(this.directory, 'empty.gitconfig');
    this.hooks = path.join(this.directory, 'empty-hooks');
    await mkdir(this.hooks, { recursive: true });
    await writeFile(this.gitConfig, '', { mode: 0o600 });
    await writeFile(this.askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$CMR_GIT_USERNAME" ;;\n  *) printf "%s\\n" "$CMR_GIT_PASSWORD" ;;\nesac\n', { mode: 0o700 });
  }
  async git(args, credential, signal) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: this.gitConfig,
      GIT_ASKPASS: this.askpass.replaceAll('\\', '/'), GIT_LFS_SKIP_SMUDGE: '1',
      CMR_GIT_USERNAME: credential?.username || '', CMR_GIT_PASSWORD: credential?.password || '' };
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-c', 'credential.helper=', '-c', 'http.followRedirects=false',
        '-c', `core.hooksPath=${this.hooks}`, '-c', `protocol.file.allow=${this.allowLocal ? 'always' : 'never'}`,
        '-c', 'protocol.ext.allow=never', ...args], { env, windowsHide: true, signal });
      let output = '';
      // 不收集 Git 错误原文，避免远端返回的内容或凭证进入日志和客户端响应。
      child.stdout.on('data', data => {
        output += data.toString();
        if (output.length > 4 * 1024 * 1024) child.kill();
      });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
  }
  root(project) { return path.join(this.directory, project.id, sourceKey(project).split(':')[1]); }
  async cachedCommitSubject(project, revision) {
    validateRevision(revision);
    // 历史发布只读取准确提交的本地对象，不拉取分支或用最新提交代替。
    const result = await this.git(['--git-dir', path.join(this.root(project), 'repository.git'),
      'show', '-s', '--format=%s', revision, '--'], null, AbortSignal.timeout(3000));
    return result.code === 0 ? result.output.trim().slice(0, 500) : null;
  }
  async history(project, credential, refresh = false) {
    if (!this.allowLocal) validateRepository(project.repository);
    validateBranch(project.branch);
    const root = this.root(project), repository = path.join(root, 'repository.git');
    const file = path.join(root, 'history.json');
    if (!refresh) {
      try { return JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return { commits: [], refreshedAt: null }; }
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const run = async args => {
      const result = await this.git(args, credential, controller.signal);
      if (result.code !== 0) throw new HttpError(502, '更新提交记录失败，请检查仓库、分支、凭证和网络');
      return result.output;
    };
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      try { await stat(repository); } catch (e) { if (e.code !== 'ENOENT') throw e; await run(['init', '--bare', repository]); }
      const args = ['--git-dir', repository];
      await run([...args, 'fetch', '--depth=100', '--no-tags', '--force', project.repository, `+refs/heads/${project.branch}:refs/heads/source`]);
      const log = await run([...args, 'log', '-100', '--format=%H%x00%an%x00%aI%x00%s', 'refs/heads/source', '--']);
      const commits = log.trim().split('\n').filter(Boolean).map(line => {
        const [revision, author, at, subject] = line.split('\0');
        return { revision: validateRevision(revision), author: (author || '').slice(0, 200), at, subject: (subject || '').slice(0, 500) };
      });
      const value = { commits, refreshedAt: new Date().toISOString() };
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file);
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw new HttpError(504, '更新代码超时，请重试');
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '更新代码失败，请检查 Git 和存储');
    } finally { clearTimeout(timer); }
  }
  async build(project, credential, onPhase = async () => {}) {
    if (!this.allowLocal) validateRepository(project.repository);
    validateBranch(project.branch);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const root = this.root(project);
    const repository = path.join(root, 'repository.git');
    const temporary = path.join(root, `${randomUUID()}.tmp.zip`);
    const run = async args => {
      const result = await this.git(args, credential, controller.signal);
      if (result.code !== 0) throw new HttpError(502, '拉取或打包失败，请检查 Gitee 凭证、仓库地址、分支和网络');
      return result.output.trim();
    };
    const inRepo = args => ['--git-dir', repository, ...args];
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      try { await stat(repository); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await run(['init', '--bare', repository]); }
      await onPhase('source_fetch');
      if (!project.revision) await run(inRepo(['fetch', '--depth=100', '--no-tags', '--force', project.repository,
        `+refs/heads/${project.branch}:refs/heads/source`]));
      else validateRevision(project.revision);
      await onPhase('source_resolve');
      const revision = await run(inRepo(['rev-parse', '--verify', `${project.revision || 'refs/heads/source'}^{commit}`]));
      const commitSubject = (await run(inRepo(['show', '-s', '--format=%s', revision, '--']))).slice(0, 500);
      await onPhase('source_archive');
      const file = path.join(root, `${revision}.zip`);
      let cached = false;
      try { await stat(file); cached = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!cached) {
        const entries = await run(inRepo(['ls-tree', '-r', revision]));
        if (/^160000 /m.test(entries)) throw new HttpError(422, '该项目包含子模块，当前版本不支持打包子模块，请先将交付源码整合到当前仓库');
        const lfs = await this.git(inRepo(['grep', '-l', '-E', '^version https://git-lfs[.]github[.]com/spec/v1\r?$', revision, '--']), credential, controller.signal);
        if (lfs.code === 0) throw new HttpError(422, '该项目包含 Git LFS 指针，当前版本不支持 LFS，请先将交付文件整合为普通 Git 文件');
        if (lfs.code !== 1) throw new HttpError(502, '源码完整性检查失败');
        await run(inRepo(['archive', '--format=zip', '-1', `--output=${temporary}`, `${revision}^{tree}`]));
        const details = await stat(temporary);
        if (details.size > this.maxArchiveBytes) throw new HttpError(413, '源码包超过服务配置的大小上限');
        await rename(temporary, file);
      }
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) {
        if (controller.signal.aborted) throw new Error('同步超时');
        hash.update(chunk);
      }
      const details = await stat(file);
      if (details.size > this.maxArchiveBytes) throw new HttpError(413, '源码包超过服务配置的大小上限');
      // 只保留当前压缩包和最近的文件，给已经开始的下载留出时间。
      for (const name of await readdir(root)) {
        if (!/^[a-f0-9]{40,64}\.zip$/.test(name) || name === `${revision}.zip`) continue;
        const old = path.join(root, name);
        if (Date.now() - (await stat(old)).mtimeMs > 3600000) await rm(old, { force: true }).catch(() => {});
      }
      if (controller.signal.aborted) throw new Error('同步超时');
      return { file, revision, commitSubject, sha256: hash.digest('hex'), size: details.size, cached };
    } catch (error) {
      if (controller.signal.aborted) throw new HttpError(504, '同步超时，请稍后重试或调整服务超时配置');
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '同步失败，请检查 Git 安装、网络和磁盘空间');
    } finally {
      clearTimeout(timer);
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
